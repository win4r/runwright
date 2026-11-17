import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../core/json.ts";
import { isRunwrightError, type RunwrightError } from "../core/errors.ts";
import { pathIndex, pathProperty, validateSchema, type JsonSchema } from "../schema/validate.ts";
import { generatePlaceholder, generateSubschemaPlaceholder, type PlaceholderResult } from "../schema/placeholder.ts";
import { isLiteralExpr } from "./assign.ts";
import { checkDecisionValue } from "./decision.ts";
import {
  classifyProblem, conditionVerdict, copySources, emptySources, finiteDomain, isConditionFabricated, isExprFabricated, shapeMayBe,
  unresolvedInsideFabricated, type ConditionVerdict, type FabricatedSources,
} from "./dry-check.ts";
import {
  copyJson, evalCondition, parseRefPath, refForm, renderTemplate, resolveArgs, resolveValue, type RefScope, type ResolveOptions,
} from "./refs.ts";
import { bundleSchema } from "./schemas.ts";
import { validateWorkflow } from "./validate.ts";
import {
  UNKNOWN_SHAPE, ancestorsOf, guaranteedLength, indexNodes, itemShape, namedShape, nodeShape, pathAlwaysPresent, plainShape, walkShape,
  type NodeIndex, type Shape,
} from "./walk.ts";
import type {
  DryRunCall, DryRunReport, DryRunStep, Expr, WorkflowDocument, WorkflowNode, WorkflowProblem,
} from "./types.ts";

export interface DryRunOptions {
  input?: Json;
  decisions?: { [nodeId: string]: { value: boolean | string | number; confidence: number } };
  resolveWorkflow?: (name: string) => WorkflowDocument | null;
  maxSteps?: number;
  /**
   * The name the document is, or is about to be, saved under (`ValidateOptions.savedAs`, passed to the validation
   * the dry run does first): a `call` to that name resolves to the document being dry-run. `null`: the document is
   * not a saved workflow, so no call resolves to it by name. Absent: the document's own `name` field is used.
   */
  savedAs?: string | null;
}

/** The dry-run problem code (always a warning) of a problem that depends on a value the walk made up. */
export const PLACEHOLDER_DEPENDENT = "placeholder_dependent";

const DEFAULT_MAX_STEPS = 10_000;
const MAX_CALL_DEPTH = 16;
const ASSUMED_FAIL_MESSAGE = "a run that takes this path fails here; the walk took it because of placeholder values";
const FALLBACK_VALUE_MESSAGE = "the fallback value depends on a placeholder and was not checked";
const UNREACHABLE_SKIPPED = ", unreachable branches skipped";
const EMPTY_SCOPE: RefScope = { input: null, steps: {}, vars: {}, loop: {}, run: { id: "", agentId: "" } };

/** The fixed value of a literal expression (no reference, no template path), or undefined. */
function literalOf(expr: unknown): Json | undefined {
  if (!isLiteralExpr(expr as Json)) return undefined;
  try {
    return resolveValue(expr as Expr, EMPTY_SCOPE);
  } catch {
    return undefined;
  }
}

/** One way a branch can end: a case, the default, or (without a default) no case matched. */
interface Outcome { label: string; run: WorkflowNode | null; path: string; reachable: boolean }

/** Ends the walk: with an error problem, or with none (a `fail` reached, its note already set). */
class Stop {
  readonly problem: WorkflowProblem | null;
  constructor(problem: WorkflowProblem | null) {
    this.problem = problem;
  }
}

class Truncated {}

interface Frame {
  doc: WorkflowDocument;
  scope: RefScope;
  scopeKey: string;
  /** Which sources hold made-up values. */
  sources: FabricatedSources;
  /**
   * True on a path the walk took only because of made-up values. Rule A: a path is assumed only when a real run
   * with valid values might not take it; a node every valid run executes is never on an assumed path, whatever
   * values were made up on the way. Per construct, the child frame is assumed when (else it inherits this flag):
   *
   * | construct                   | the child is assumed when                               | the line that does it                     |
   * |-----------------------------|---------------------------------------------------------|-------------------------------------------|
   * | map body, item i            | `over` is made up and its static shape does not          | `map`: `child.assumed = frame.assumed ||  |
   * |                             | guarantee more than i items (`certainItems`)             | i >= certain`                             |
   * | loop body, iteration 1      | never (a valid loop has `maxIterations >= 1`)            | `loop`: `iterationScope(frame, …)`        |
   * | loop body, iteration n > 1  | the `until` after iteration n - 1 was made up and is not | `loop`: such an iteration is not walked   |
   * |                             | statically "never" (the walk assumes it held and stops)  | (`assumed to hold`); a "never" one goes on |
   * | branch case or default      | `on` is made up and more than one outcome is reachable  | `branch`: `assumed ? {...frame, assumed:  |
   * |                             |                                                         | true} : frame`                            |
   * | decide low-confidence route | never (the route is taken only for a supplied decision)  | `decide`: `this.runOut(low.run, …, frame)` |
   * | sequence, parallel children | never                                                   | `exec`: `this.run(child, …, frame)`       |
   * | call (sub-workflow root)    | never                                                   | `call`: `assumed: frame.assumed`          |
   *
   * The root frame is not assumed (`dryRunWorkflow`). A made-up item or value stays a made-up source
   * (`sources`), so problems that depend on its value stay warnings; only control flow becomes certain.
   */
  assumed: boolean;
  depth: number;
}

/** A node's output and whether it was made up. */
interface Out { value: Json; fabricated: boolean }

/** Where a value check reports: the path prefix of its problems and the node it belongs to. */
interface ValueCheck { schema: JsonSchema; value: Json; expression: Expr; sources: FabricatedSources; document: WorkflowDocument; prefix: string }

function problemPath(prefix: string, path: string): string {
  return prefix + path.slice(1);
}

class Walker {
  readonly options: DryRunOptions;
  readonly steps: DryRunStep[] = [];
  readonly calls: DryRunCall[] = [];
  readonly problems: WorkflowProblem[];
  readonly maxSteps: number;
  readonly placeholders = new Map<WorkflowDocument, Map<string, PlaceholderResult>>();
  readonly warned = new Set<string>();
  readonly root: WorkflowDocument;
  readonly indexes = new Map<WorkflowDocument, NodeIndex>();
  /** `cannotSucceed` per node (a node belongs to one document); a node being decided counts as able to succeed. */
  readonly verdicts = new Map<WorkflowNode, boolean>();
  /** How many node runs so far produced a made-up output (a container compares it before and after its children). */
  fabricatedRuns = 0;
  failed = false;

  constructor(document: WorkflowDocument, options: DryRunOptions, problems: WorkflowProblem[]) {
    this.root = document;
    this.options = options;
    this.problems = problems;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  enter(node: WorkflowNode, path: string, frame: Frame): DryRunStep {
    if (this.steps.length >= this.maxSteps) throw new Truncated();
    const step: DryRunStep = { nodeId: node.id, kind: node.kind, path, scope: frame.scopeKey, note: null };
    this.steps.push(step);
    return step;
  }

  stop(path: string, code: string, message: string, nodeId?: string): never {
    const problem: WorkflowProblem = { path, code, message, severity: "error" };
    if (nodeId !== undefined) problem.nodeId = nodeId;
    throw new Stop(problem);
  }

  /** Adds a `placeholder_dependent` warning, once per path and message. */
  warn(path: string, message: string, nodeId?: string): void {
    const key = `${path}\u0000${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    const problem: WorkflowProblem = { path, code: PLACEHOLDER_DEPENDENT, message, severity: "warning" };
    if (nodeId !== undefined) problem.nodeId = nodeId;
    this.problems.push(problem);
  }

  /** Resolve options whose hook reads a reference into a made-up value as null, with a warning at `path`. */
  resolveOptions(path: string, nodeId: string | undefined, sources: FabricatedSources): ResolveOptions {
    return {
      onUnresolved: (refPath: string, error: RunwrightError): Json | undefined => {
        if (!unresolvedInsideFabricated(refPath, error, sources)) return undefined;
        this.warn(path, `reference ${JSON.stringify(refPath)} cannot be resolved in a placeholder value; it reads as null here`, nodeId);
        return null;
      },
    };
  }

  /**
   * Runs `fn` with resolve options that warn at `expressionPath` (default: `path`); anything it throws (other than
   * ending the walk) is an error at `path`.
   */
  guard<T>(path: string, nodeId: string, sources: FabricatedSources, fn: (options: ResolveOptions) => T, expressionPath: string = path): T {
    try {
      return fn(this.resolveOptions(expressionPath, nodeId, sources));
    } catch (error) {
      if (error instanceof Stop || error instanceof Truncated) throw error;
      const code = isRunwrightError(error) ? error.code : "internal";
      return this.stop(path, code, error instanceof Error ? error.message : String(error), nodeId);
    }
  }

  /** A copy of the placeholder for a named schema of `doc` (generated once per document and name), warning at `path` when it does not satisfy the schema. */
  placeholder(doc: WorkflowDocument, name: string, path: string, nodeId?: string): Json {
    let byName = this.placeholders.get(doc);
    if (byName === undefined) {
      byName = new Map();
      this.placeholders.set(doc, byName);
    }
    let result = byName.get(name);
    if (result === undefined) {
      result = generatePlaceholder(bundleSchema(doc, name));
      byName.set(name, result);
    }
    if (!result.satisfied) {
      this.warn(path, `no placeholder that satisfies schema ${JSON.stringify(name)} could be generated; values that depend on it are not checked`, nodeId);
    }
    return copyJson(result.value);
  }

  /**
   * Validates a value and classifies each problem: a certain one is an error (code `schema_mismatch`), a dependent
   * one a `placeholder_dependent` warning. Returns the certain errors.
   */
  checkValue(check: ValueCheck, nodeId?: string): WorkflowProblem[] {
    const errors: WorkflowProblem[] = [];
    for (const p of validateSchema(check.schema, check.value)) {
      const path = problemPath(check.prefix, p.path);
      if (classifyProblem(p, check.value, check.expression, check.sources, check.document) === "certain") {
        const problem: WorkflowProblem = { path, code: "schema_mismatch", message: p.message, severity: "error" };
        if (nodeId !== undefined) problem.nodeId = nodeId;
        errors.push(problem);
      } else {
        this.warn(path, `not checked against a real value: ${p.message}`, nodeId);
      }
    }
    return errors;
  }

  /** Ends the walk at a `fail` (or a loop bound with onLimit "fail"): certain off an assumed path, a warning on one. */
  failHere(step: DryRunStep, note: string, path: string, node: WorkflowNode, frame: Frame): never {
    step.note = note;
    if (frame.assumed) this.warn(path, ASSUMED_FAIL_MESSAGE, node.id);
    else this.failed = true;
    throw new Stop(null);
  }

  run(node: WorkflowNode, path: string, frame: Frame): Json {
    const step = this.enter(node, path, frame);
    const before = this.fabricatedRuns;
    const out = this.exec(node, path, frame, step);
    const inner = this.fabricatedRuns > before;
    const fabricated = frame.assumed || out.fabricated || (isContainer(node) && inner);
    frame.scope.steps[node.id] = out.value;
    if (fabricated) {
      frame.sources.steps.add(node.id);
      this.fabricatedRuns++;
    } else {
      frame.sources.steps.delete(node.id);
    }
    return out.value;
  }

  /** Runs a node and reports whether its output is made up (as `run` records it). */
  runOut(node: WorkflowNode, path: string, frame: Frame): Out {
    const value = this.run(node, path, frame);
    return { value, fabricated: frame.sources.steps.has(node.id) };
  }

  exec(node: WorkflowNode, path: string, frame: Frame, step: DryRunStep): Out {
    const scope = frame.scope;
    const g = <T>(at: string, fn: (options: ResolveOptions) => T): T => this.guard(path, node.id, frame.sources, fn, at);
    switch (node.kind) {
      case "tool": {
        const args = g(pathProperty(path, "args"), (o) => resolveArgs(node.args, scope, o));
        this.calls.push({ nodeId: node.id, type: "tool", name: node.tool, detail: { args } });
        return { value: { ok: true, content: "", data: null }, fabricated: true };
      }
      case "model": {
        const detail: JsonObject = { prompt: g(pathProperty(path, "prompt"), (o) => renderTemplate(node.prompt, scope, o)), output: node.output };
        if (node.system !== undefined) {
          const system = node.system;
          detail["system"] = g(pathProperty(path, "system"), (o) => renderTemplate(system, scope, o));
        }
        this.calls.push({ nodeId: node.id, type: "model", name: node.output, detail });
        return { value: this.placeholder(frame.doc, node.output, path, node.id), fabricated: true };
      }
      case "decide":
        return this.decide(node, path, frame, step);
      case "branch":
        return this.branch(node, path, frame, step);
      case "sequence": {
        let last: Json = null;
        node.steps.forEach((child, i) => {
          last = this.run(child, pathIndex(pathProperty(path, "steps"), i), frame);
        });
        return { value: last, fabricated: false };
      }
      case "parallel": {
        const out: JsonObject = {};
        node.branches.forEach((child, i) => {
          out[child.id] = this.run(child, pathIndex(pathProperty(path, "branches"), i), frame);
        });
        return { value: out, fabricated: false };
      }
      case "map":
        return this.map(node, path, frame, step);
      case "loop":
        return this.loop(node, path, frame, step);
      case "call":
        return this.call(node, path, frame);
      case "agent": {
        const detail: JsonObject = { message: g(pathProperty(path, "message"), (o) => renderTemplate(node.message, scope, o)) };
        if (node.instructions !== undefined) {
          const instructions = node.instructions;
          detail["instructions"] = g(pathProperty(path, "instructions"), (o) => renderTemplate(instructions, scope, o));
        }
        if (node.tools !== undefined) detail["tools"] = [...node.tools];
        if (node.output !== undefined) detail["output"] = node.output;
        detail["maxTurns"] = node.maxTurns;
        this.calls.push({ nodeId: node.id, type: "agent", name: "agent", detail });
        const data = node.output === undefined ? null : this.placeholder(frame.doc, node.output, path, node.id);
        return { value: { text: "", data }, fabricated: true };
      }
      case "wait": {
        const detail: JsonObject = { question: g(pathProperty(path, "question"), (o) => renderTemplate(node.question, scope, o)) };
        if (node.choices !== undefined) detail["choices"] = [...node.choices];
        this.calls.push({ nodeId: node.id, type: "person", name: "wait", detail });
        return { value: { answer: node.choices?.[0] ?? "" }, fabricated: true };
      }
      case "fail": {
        const message = g(pathProperty(path, "message"), (o) => renderTemplate(node.message, scope, o));
        return this.failHere(step, `would fail: ${message}`, path, node, frame);
      }
    }
  }

  branch(node: Extract<WorkflowNode, { kind: "branch" }>, path: string, frame: Frame, step: DryRunStep): Out {
    const value = this.guard(path, node.id, frame.sources, (o) => resolveValue(node.on, frame.scope, o), pathProperty(path, "on"));
    const key = canonicalJson(value);
    const casePath = (i: number): string => pathProperty(pathIndex(pathProperty(path, "cases"), i), "run");
    const index = node.cases.findIndex((entry) => canonicalJson(entry.when) === key);
    const onFabricated = isExprFabricated(node.on, frame.sources);
    if (!onFabricated || (node.cases.length === 0 && node.default === undefined)) {
      if (index >= 0) {
        step.note = `case ${index} (${key})`;
        return { value: this.run((node.cases[index] as { run: WorkflowNode }).run, casePath(index), frame), fabricated: onFabricated };
      }
      if (node.default !== undefined) {
        step.note = `default (${key})`;
        return { value: this.run(node.default, pathProperty(path, "default"), frame), fabricated: onFabricated };
      }
      step.note = `no case matched (${key})`;
      return { value: null, fabricated: onFabricated };
    }
    // Rule D: only the outcomes a real value could select. The case or default the placeholder selects if it can
    // succeed, else the first reachable one that can (cases in order, then the default), else "no case matched"
    // when a real value can match no case; with one reachable outcome, or none that can succeed, as a real run.
    const outcomes = this.branchOutcomes(node, path, frame.doc);
    const selected = (index >= 0 ? outcomes[index] : outcomes.at(-1)) as Outcome;
    const reachable = outcomes.filter((outcome) => outcome.reachable);
    const canSucceed = (outcome: Outcome): boolean => outcome.run === null || !this.cannotSucceed(outcome.run, frame.doc, frame.depth);
    let chosen: Outcome | undefined;
    if (reachable.length > 1) {
      chosen = selected.run !== null && selected.reachable && canSucceed(selected)
        ? selected
        : reachable.find((outcome) => outcome.run !== null && canSucceed(outcome)) ?? reachable.find((outcome) => outcome.run === null);
    }
    const assumed = chosen !== undefined;
    chosen ??= selected.reachable ? selected : (reachable[0] ?? selected);
    const skipped = outcomes.some((outcome) => !outcome.reachable && outcome.run !== null);
    step.note = `${chosen.label} (${key}, placeholder)${skipped ? UNREACHABLE_SKIPPED : ""}`;
    if (chosen.run === null) return { value: null, fabricated: true };
    return { value: this.run(chosen.run, chosen.path, assumed ? { ...frame, assumed: true } : frame), fabricated: true };
  }

  /** The node index of a document (built once per document). */
  indexOf(doc: WorkflowDocument): NodeIndex {
    let index = this.indexes.get(doc);
    if (index === undefined) {
      index = indexNodes(doc.root, "$.root");
      this.indexes.set(doc, index);
    }
    return index;
  }

  /**
   * The document a `call` in `doc` runs: `doc`'s inline workflow of that name, else the document being dry-run when
   * the name is its storage name (`savedAs`), else a saved workflow; null when it does not resolve.
   */
  resolveCall(doc: WorkflowDocument, name: string): WorkflowDocument | null {
    const inline = doc.workflows;
    if (inline !== undefined && Object.hasOwn(inline, name)) return inline[name] ?? null;
    if (typeof this.options.savedAs === "string" && this.options.savedAs === name) return this.root;
    return this.options.resolveWorkflow?.(name) ?? null;
  }

  /**
   * The statically known shape of an expression of `doc`: a `{$ref}` into `input…` or `steps.<id>…` gets the
   * declared shape at that path; anything else, or anything that does not resolve, is unknown.
   */
  exprShape(doc: WorkflowDocument, expr: Expr, at: WorkflowNode): Shape {
    const form = isJsonObject(expr) ? refForm(expr) : null;
    if (form?.kind !== "ref") return UNKNOWN_SHAPE;
    const base = this.refBase(doc, form.path, at);
    return base === null ? UNKNOWN_SHAPE : walkShape(base.shape, base.rest).shape;
  }

  /**
   * The declared shape of a reference's root value, evaluated at node `at` of `doc`, and the segments after it:
   * `input` (the input schema); `steps.<id>` (the node's output shape); `vars.<as>` (the item shape of the `over` of
   * the enclosing map that defines it) and `vars.<as>_index` (a non-negative integer). Null for anything else.
   */
  refBase(doc: WorkflowDocument, path: string, at: WorkflowNode): { shape: Shape; rest: (string | number)[] } | null {
    let segments: (string | number)[];
    try {
      segments = parseRefPath(path);
    } catch {
      return null;
    }
    const index = this.indexOf(doc);
    const name = segments[1];
    switch (segments[0]) {
      case "input":
        return { shape: namedShape(doc.schemas, doc.input), rest: segments.slice(1) };
      case "steps": {
        const entry = typeof name === "string" ? index.byId.get(name) : undefined;
        if (entry === undefined) return null;
        const context = {
          index,
          schemas: doc.schemas,
          callShape: (workflow: string): Shape => {
            const target = this.resolveCall(doc, workflow);
            return target === null ? UNKNOWN_SHAPE : namedShape(target.schemas, target.output);
          },
        };
        return { shape: nodeShape(context, entry), rest: segments.slice(2) };
      }
      case "vars": {
        const entry = index.byId.get(at.id);
        if (typeof name !== "string" || entry === undefined || entry.node !== (at as unknown as JsonObject)) return null;
        const map = ancestorsOf(index, entry).find((candidate) => candidate.kind === "map" &&
          (candidate.node["as"] === name || `${String(candidate.node["as"])}_index` === name));
        if (map === undefined) return null;
        const mapNode = map.node as unknown as Extract<WorkflowNode, { kind: "map" }>;
        const shape = mapNode.as === name ? itemShape(this.valueShape(doc, mapNode.over, mapNode)) : plainShape({ type: "integer", minimum: 0 });
        return { shape, rest: segments.slice(2) };
      }
      default:
        return null;
    }
  }

  /** `exprShape` for a value that must be the referenced one: a reference with a `default` may be the default, so unknown. */
  valueShape(doc: WorkflowDocument, expr: Expr, at: WorkflowNode): Shape {
    const form = isJsonObject(expr) ? refForm(expr) : null;
    return form?.kind === "ref" && form.fallback !== undefined ? UNKNOWN_SHAPE : this.exprShape(doc, expr, at);
  }

  /**
   * How many items of a map's `over` every valid run has (rule A): the length of a list written in the document
   * (references inside it included: each element is one item or the run fails), else, for a reference without a
   * `default` that is always present (`pathAlwaysPresent`), the `minItems` its declared shape guarantees
   * (`guaranteedLength`); 0 for anything else. At most `maxItems` (a longer list fails the run at the map).
   */
  certainItems(doc: WorkflowDocument, node: Extract<WorkflowNode, { kind: "map" }>): number {
    const over = node.over;
    const form = isJsonObject(over) ? refForm(over) : null;
    let count = 0;
    if (Array.isArray(over)) count = over.length;
    else if (form?.kind === "literal") count = Array.isArray(form.value) ? form.value.length : 0;
    else if (form?.kind === "ref" && form.fallback === undefined) {
      const base = this.refBase(doc, form.path, node);
      if (base !== null && pathAlwaysPresent(base.shape, base.rest)) count = guaranteedLength(walkShape(base.shape, base.rest).shape);
    }
    return Math.min(count, node.maxItems);
  }

  /**
   * The outcomes of a branch (cases in order, then the default or "no case matched") and which of them a real value
   * of the declared schema of `on` can select: a case whose `when` is valid for it; the default (or no match) unless
   * the schema allows only a finite set of values that the cases cover. Unknown schema: all of them. An `on` without
   * references has one value, so exactly the outcome a run selects for it (the same comparison) is reachable.
   */
  branchOutcomes(node: Extract<WorkflowNode, { kind: "branch" }>, path: string, doc: WorkflowDocument): Outcome[] {
    const fixed = literalOf(node.on);
    const fixedIndex = fixed === undefined ? -1 : node.cases.findIndex((entry) => canonicalJson(entry.when) === canonicalJson(fixed));
    const shape = this.valueShape(doc, node.on, node);
    const domain = finiteDomain(shape);
    const keys = new Set(node.cases.map((entry) => canonicalJson(entry.when)));
    const covered = domain !== null && domain.every((value) => keys.has(canonicalJson(value)));
    const outcomes: Outcome[] = node.cases.map((entry, i) => ({
      label: `case ${i}`, run: entry.run, path: pathProperty(pathIndex(pathProperty(path, "cases"), i), "run"),
      reachable: fixed === undefined ? shapeMayBe(shape, entry.when) : i === fixedIndex,
    }));
    const rest = fixed === undefined ? !covered : fixedIndex < 0;
    if (node.default !== undefined) outcomes.push({ label: "default", run: node.default, path: pathProperty(path, "default"), reachable: rest });
    else outcomes.push({ label: "no case matched", run: null, path, reachable: rest });
    return outcomes;
  }

  /**
   * True when a node's structure alone makes every run through it fail (rule D, agreeing with rule A): a `fail` node;
   * a sequence or a parallel group with a step that cannot succeed; a map whose `over` guarantees an item
   * (`certainItems`) and whose body cannot succeed; a loop with `maxIterations >= 1` whose body cannot succeed, or
   * whose `onLimit` is "fail" and whose `until` can never hold (`untilVerdict` is "never"); a branch all of whose reachable outcomes are nodes that
   * cannot succeed; a `call` whose target's root cannot succeed (followed at most MAX_CALL_DEPTH levels; a target
   * that does not resolve can succeed). Static: it never reads run-time values.
   */
  cannotSucceed(node: WorkflowNode, doc: WorkflowDocument, depth: number): boolean {
    const known = this.verdicts.get(node);
    if (known !== undefined) return known;
    this.verdicts.set(node, false);
    let verdict: boolean;
    switch (node.kind) {
      case "fail":
        verdict = true;
        break;
      case "sequence":
        verdict = node.steps.some((child) => this.cannotSucceed(child, doc, depth));
        break;
      case "parallel":
        verdict = node.branches.some((child) => this.cannotSucceed(child, doc, depth));
        break;
      case "map":
        verdict = this.certainItems(doc, node) >= 1 && this.cannotSucceed(node.run, doc, depth);
        break;
      case "loop":
        verdict = (node.maxIterations >= 1 && this.cannotSucceed(node.run, doc, depth)) ||
          (node.onLimit === "fail" && this.untilVerdict(node, doc) === "never");
        break;
      case "branch":
        verdict = this.branchOutcomes(node, "$", doc).filter((outcome) => outcome.reachable)
          .every((outcome) => outcome.run !== null && this.cannotSucceed(outcome.run, doc, depth));
        break;
      case "call": {
        const target = depth + 1 >= MAX_CALL_DEPTH ? null : this.resolveCall(doc, node.workflow);
        verdict = target !== null && this.cannotSucceed(target.root, target, depth + 1);
        break;
      }
      default:
        verdict = false;
    }
    this.verdicts.set(node, verdict);
    return verdict;
  }

  /** The static verdict of a loop's `until` (`conditionVerdict`), reading the declared shapes of its references. */
  untilVerdict(node: Extract<WorkflowNode, { kind: "loop" }>, doc: WorkflowDocument): ConditionVerdict {
    return conditionVerdict(node.until, (expr) => this.valueShape(doc, expr, node));
  }

  decide(node: Extract<WorkflowNode, { kind: "decide" }>, path: string, frame: Frame, step: DryRunStep): Out {
    const scope = frame.scope;
    const question = this.guard(path, node.id, frame.sources, (o) => renderTemplate(node.question, scope, o), pathProperty(path, "question"));
    this.calls.push({ nodeId: node.id, type: "decision", name: node.decision.type, detail: { question, decision: node.decision as unknown as Json } });
    const override = this.options.decisions !== undefined && Object.hasOwn(this.options.decisions, node.id) ? this.options.decisions[node.id] : undefined;
    const spec = node.decision;
    const value: boolean | string | number = override?.value ?? (spec.type === "yes_no" ? true : spec.type === "pick_one" ? (spec.options[0] as string) : spec.min);
    const confidence = override?.confidence ?? 1;
    if (!checkDecisionValue(spec, value)) this.stop(path, "schema_mismatch", `the decision value ${canonicalJson(value)} does not fit the ${spec.type} decision`, node.id);
    const madeUp = override === undefined;
    const low = node.lowConfidence;
    if (low === undefined || !(confidence < low.below)) {
      if (low !== undefined) step.note = `confident (${confidence} >= ${low.below})`;
      return { value: { value, confidence, reason: "", route: "confident", fallback: null }, fabricated: madeUp };
    }
    step.note = `low confidence (${confidence} < ${low.below})`;
    const lowPath = pathProperty(path, "lowConfidence");
    const fallback = this.runOut(low.run, pathProperty(lowPath, "run"), frame);
    let finalValue: Json = value;
    let fabricated = madeUp || fallback.fabricated;
    if (low.value !== undefined) {
      const valueExpr = low.value;
      const valuePath = pathProperty(lowPath, "value");
      const sources = { ...frame.sources, fallback: fallback.fabricated };
      const resolved = this.guard(valuePath, node.id, sources, (o) => resolveValue(valueExpr, { ...scope, fallback: fallback.value }, o));
      const valueFabricated = isExprFabricated(valueExpr, sources);
      fabricated = fabricated || valueFabricated;
      if (checkDecisionValue(spec, resolved)) {
        finalValue = resolved;
      } else if (valueFabricated) {
        this.warn(valuePath, FALLBACK_VALUE_MESSAGE, node.id);
      } else {
        this.stop(valuePath, "schema_mismatch", `the fallback value ${canonicalJson(resolved)} does not fit the ${spec.type} decision`, node.id);
      }
    }
    return { value: { value: finalValue, confidence, reason: "", route: "low_confidence", fallback: fallback.value }, fabricated };
  }

  iterationScope(frame: Frame, key: string, vars: JsonObject, loop?: { id: string; index: number; last: Json }): Frame {
    const scope: RefScope = {
      input: frame.scope.input,
      steps: { ...frame.scope.steps },
      vars: { ...frame.scope.vars, ...vars },
      loop: loop === undefined ? { ...frame.scope.loop } : { ...frame.scope.loop, [loop.id]: { index: loop.index, last: loop.last } },
      run: frame.scope.run,
    };
    return { ...frame, scope, sources: copySources(frame.sources), scopeKey: frame.scopeKey + key };
  }

  /** A placeholder item for a map over an empty made-up list (null when the item's schema is not statically known). */
  itemPlaceholder(node: Extract<WorkflowNode, { kind: "map" }>, path: string, frame: Frame): Json {
    const item = itemShape(this.exprShape(frame.doc, node.over, node));
    if (item.t !== "schema") return null;
    const result = generateSubschemaPlaceholder(item.root, item.schema, { definitions: item.defs });
    if (!result.satisfied) {
      this.warn(path, "no placeholder that satisfies the item schema of \"over\" could be generated; values that depend on it are not checked", node.id);
    }
    return result.value;
  }

  map(node: Extract<WorkflowNode, { kind: "map" }>, path: string, frame: Frame, step: DryRunStep): Out {
    const overPath = pathProperty(path, "over");
    const items = this.guard(overPath, node.id, frame.sources, (o) => resolveValue(node.over, frame.scope, o));
    const fabricated = isExprFabricated(node.over, frame.sources);
    let list: Json[];
    if (!fabricated) {
      if (!Array.isArray(items)) this.stop(overPath, "schema_mismatch", `"over" resolved to ${canonicalJson(items)}, not an array`, node.id);
      if (items.length > node.maxItems) {
        this.stop(overPath, "limit_exceeded", `"over" has ${items.length} items, more than maxItems ${node.maxItems}`, node.id);
      }
      list = items;
    } else {
      list = Array.isArray(items) ? items : [];
      if (list.length > node.maxItems) {
        list = list.slice(0, node.maxItems);
        step.note = `placeholder list cut to maxItems ${node.maxItems}`;
      } else if (list.length === 0 && node.maxItems > 0) {
        list = [this.itemPlaceholder(node, path, frame)];
        step.note = "over is an empty placeholder list; the body runs once with a placeholder item";
      }
    }
    const outputs: Json[] = [];
    const certain = fabricated ? this.certainItems(frame.doc, node) : list.length;
    list.forEach((item, i) => {
      const child = this.iterationScope(frame, `${node.id}[${i}]/`, { [node.as]: item, [`${node.as}_index`]: i });
      if (fabricated) {
        child.sources.vars.add(node.as);
        child.assumed = frame.assumed || i >= certain;
      } else {
        child.sources.vars.delete(node.as);
      }
      child.sources.vars.delete(`${node.as}_index`);
      outputs.push(this.run(node.run, pathProperty(path, "run"), child));
    });
    return { value: outputs, fabricated };
  }

  loop(node: Extract<WorkflowNode, { kind: "loop" }>, path: string, frame: Frame, step: DryRunStep): Out {
    let last: Json = null;
    let lastFabricated = false;
    const untilPath = pathProperty(path, "until");
    let never: boolean | undefined;
    let neverHeld = false;
    for (let i = 0; i < node.maxIterations; i++) {
      const child = this.iterationScope(frame, `${node.id}#${i}/`, {}, { id: node.id, index: i, last });
      if (lastFabricated) child.sources.loops.add(node.id);
      else child.sources.loops.delete(node.id);
      const out = this.runOut(node.run, pathProperty(path, "run"), child);
      last = out.value;
      lastFabricated = lastFabricated || out.fabricated;
      const iterationScope = { ...child.scope, loop: { ...child.scope.loop, [node.id]: { index: i, last } } };
      const sources = copySources(child.sources);
      if (lastFabricated) sources.loops.add(node.id);
      const done = this.guard(untilPath, node.id, sources, (o) => evalCondition(node.until, iterationScope, o));
      const untilFabricated = isConditionFabricated(node.until, sources);
      // A made-up `until` is trusted, or assumed to hold, only when it can hold at all. One that never holds lets
      // every run go on to the next iteration, so the walk does too, off an assumed path (rule A), up to the bound;
      // with onLimit "fail" every run fails at the bound, so the walk ends there at once.
      if (untilFabricated) never ??= this.untilVerdict(node, frame.doc) === "never";
      if (untilFabricated && never === true) {
        if (node.onLimit === "fail") return this.failHere(step, `would fail: reached maxIterations ${node.maxIterations}`, path, node, frame);
        neverHeld = true;
        continue;
      }
      if (done) {
        step.note = `until held after ${i + 1} iteration${i === 0 ? "" : "s"}`;
        return { value: { iterations: i + 1, completed: true, last }, fabricated: untilFabricated };
      }
      if (untilFabricated) {
        step.note = `until depends on placeholder values; assumed to hold after iteration ${i + 1}`;
        return { value: { iterations: i + 1, completed: true, last }, fabricated: true };
      }
    }
    if (node.onLimit === "fail") return this.failHere(step, `would fail: reached maxIterations ${node.maxIterations}`, path, node, frame);
    step.note = neverHeld
      ? `until cannot hold for the declared schemas; stopped at maxIterations ${node.maxIterations}`
      : `stopped at maxIterations ${node.maxIterations}`;
    return { value: { iterations: node.maxIterations, completed: false, last }, fabricated: neverHeld };
  }

  call(node: Extract<WorkflowNode, { kind: "call" }>, path: string, frame: Frame): Out {
    if (frame.depth >= MAX_CALL_DEPTH) this.stop(path, "limit_exceeded", `sub-workflow calls nest deeper than ${MAX_CALL_DEPTH}`, node.id);
    const target = this.resolveCall(frame.doc, node.workflow);
    if (target === null) {
      this.stop(pathProperty(path, "workflow"), "unknown_workflow", `workflow ${JSON.stringify(node.workflow)} cannot be resolved`, node.id);
    }
    const inputPath = pathProperty(path, "input");
    const input = this.guard(inputPath, node.id, frame.sources, (o) => resolveValue(node.input, frame.scope, o));
    this.calls.push({ nodeId: node.id, type: "workflow", name: node.workflow, detail: { input } });
    const inputFabricated = isExprFabricated(node.input, frame.sources);
    const inputErrors = this.checkValue({
      schema: bundleSchema(target, target.input), value: input, expression: node.input, sources: frame.sources, document: frame.doc, prefix: inputPath,
    }, node.id);
    if (inputErrors.length > 0) throw new Stop(inputErrors[0] as WorkflowProblem);
    const sub: Frame = {
      doc: target,
      scope: { input, steps: {}, vars: {}, loop: {}, run: frame.scope.run },
      scopeKey: `${frame.scopeKey}${node.id}>/`,
      sources: emptySources(inputFabricated),
      assumed: frame.assumed,
      depth: frame.depth + 1,
    };
    const root = this.runOut(target.root, "$.root", sub);
    const result = this.guard("$.result", node.id, sub.sources, (o) => resolveValue(target.result, sub.scope, o));
    const resultErrors = this.checkValue({
      schema: bundleSchema(target, target.output), value: result, expression: target.result, sources: sub.sources, document: target,
      prefix: pathProperty(path, "workflow"),
    }, node.id);
    if (resultErrors.length > 0) throw new Stop(resultErrors[0] as WorkflowProblem);
    return { value: result, fabricated: inputFabricated || root.fabricated || isExprFabricated(target.result, sub.sources) };
  }
}

function isContainer(node: WorkflowNode): boolean {
  switch (node.kind) {
    case "branch": case "sequence": case "parallel": case "map": case "loop": return true;
    default: return false;
  }
}

/**
 * Walks a workflow's control flow with schema-shaped placeholder values. It calls no model, no tool and
 * nothing on a run context; it reports the steps taken in order and every call a real run would make.
 *
 * `ok` is true exactly when the document is valid, no problem is an error, the walk was not truncated and it did
 * not end at a certain failure (a `fail` node, or a loop bound with onLimit "fail", reached off an assumed path).
 * A problem that depends on a value the walk made up (a placeholder, a reference into one, a path taken because
 * of one) is a warning with code `placeholder_dependent` and never changes `ok`.
 */
export function dryRunWorkflow(document: WorkflowDocument, options?: DryRunOptions): DryRunReport {
  const opts = options ?? {};
  const validation = validateWorkflow(document, {
    ...(opts.resolveWorkflow === undefined ? {} : { resolveWorkflow: opts.resolveWorkflow }),
    ...(opts.savedAs === undefined ? {} : { savedAs: opts.savedAs }),
  });
  const problems: WorkflowProblem[] = [...validation.problems];
  if (!validation.ok) return { ok: false, steps: [], wouldCall: [], output: null, problems, truncated: false };

  const inputSchema = bundleSchema(document, document.input);
  const supplied = Object.hasOwn(opts, "input") && opts.input !== undefined;
  const walker = new Walker(document, opts, problems);
  let input: Json;
  if (supplied) {
    input = opts.input as Json;
    const inputProblems = validateSchema(inputSchema, input).map((p): WorkflowProblem => ({
      path: problemPath("input", p.path), code: "schema_mismatch", message: p.message, severity: "error",
    }));
    if (inputProblems.length > 0) return { ok: false, steps: [], wouldCall: [], output: null, problems: [...problems, ...inputProblems], truncated: false };
  } else {
    input = walker.placeholder(document, document.input, "input");
  }

  const frame: Frame = {
    doc: document,
    scope: { input, steps: {}, vars: {}, loop: {}, run: { id: "run_dry", agentId: "agent_dry" } },
    scopeKey: "",
    sources: emptySources(!supplied),
    assumed: false,
    depth: 0,
  };
  const hasError = (): boolean => problems.some((p) => p.severity === "error");
  const report = (output: Json, truncated: boolean): DryRunReport => ({
    ok: !truncated && !walker.failed && !hasError(), steps: walker.steps, wouldCall: walker.calls, output, problems, truncated,
  });
  try {
    walker.run(document.root, "$.root", frame);
  } catch (error) {
    if (error instanceof Truncated) return report(null, true);
    if (error instanceof Stop) {
      if (error.problem !== null) problems.push(error.problem);
      return report(null, false);
    }
    throw error;
  }
  let output: Json;
  try {
    output = resolveValue(document.result, frame.scope, walker.resolveOptions("$.result", undefined, frame.sources));
  } catch (error) {
    problems.push({ path: "$.result", code: isRunwrightError(error) ? error.code : "internal", message: error instanceof Error ? error.message : String(error), severity: "error" });
    return report(null, false);
  }
  const outputErrors = walker.checkValue({
    schema: bundleSchema(document, document.output), value: output, expression: document.result, sources: frame.sources, document, prefix: "output",
  });
  for (const problem of outputErrors) problems.push(problem);
  return report(output, false);
}
