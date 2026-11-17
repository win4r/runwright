/** What each node kind does when it runs (plan 3.11); `WorkflowExecutor.run` wraps every call in its memo. */
import { MAX_TIMER_MS } from "../../core/clock.ts";
import { canonicalJson, isJsonObject, type Json, type JsonObject } from "../../core/json.ts";
import { isControlSignal, mapLimit, settleAll } from "../../engine/control.ts";
import type { AgentLoopParams, ModelStepRequest } from "../../engine/types.ts";
import type { JournalRecord } from "../../store/types.ts";
import { checkDecisionValue, decisionSchema } from "../decision.ts";
import { evalCondition, renderTemplate, resolveArgs, resolveValue, type RefScope } from "../refs.ts";
import { bundleSchema } from "../schemas.ts";
import type {
  AgentNode, CallNode, DecideNode, DecisionSpec, LoopNode, MapNode, ModelNode, RetryPolicy, ToolNode, WorkflowDocument,
  WorkflowNode,
} from "../types.ts";
import { pathIndex, pathProperty } from "../../schema/validate.ts";
import {
  asNodeFailure, errorCode, errorMessage, isRetryable, nodeFailure, providerWaitMs, toolAttemptError, type NodePlace,
} from "./errors.ts";
import type { Frame, WorkflowExecutor } from "./executor.ts";
import { DECISION_OUTPUT_FIELDS, RESOLVE_VALUE_FIELDS } from "./value-fields.ts";

/** Sub-workflow calls nest at most this deep. */
export const MAX_CALL_DEPTH = 16;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
/** The most attempts a node's retry makes (the validator's bound on `retry.maxAttempts`). */
export const MAX_NODE_ATTEMPTS = 10;

/** `retry.maxAttempts` as a whole number from 1 to MAX_NODE_ATTEMPTS, whatever number it is (NaN gives 1). */
export function attemptLimit(retry: RetryPolicy | undefined): number {
  if (retry === undefined) return 1;
  const wanted = Math.floor(retry.maxAttempts);
  return wanted >= 1 ? Math.min(MAX_NODE_ATTEMPTS, wanted) : 1;
}

/**
 * Delay before attempt n + 1: min(cap, backoffMs × factor^(n − 1)), where cap is maxBackoffMs (60000 when it is
 * absent or not a finite number >= 0), never more than MAX_TIMER_MS. Holds for any numbers, validated or not:
 * a backoffMs that is not > 0 (zero, negative, NaN) gives 0, an infinite or NaN product gives the cap, so the
 * result is always a finite number in [0, MAX_TIMER_MS].
 */
export function retryDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  const max = policy.maxBackoffMs;
  const cap = Math.min(typeof max === "number" && Number.isFinite(max) && max >= 0 ? max : DEFAULT_MAX_BACKOFF_MS, MAX_TIMER_MS);
  if (!(policy.backoffMs > 0)) return 0;
  const raw = policy.backoffMs * (policy.factor ?? 2) ** (failedAttempt - 1);
  return Number.isNaN(raw) ? cap : Math.max(0, Math.min(cap, raw));
}

/**
 * The wait before the next attempt that a `node.retry` record fixes: its journalled `delayMs` when that is a finite
 * number >= 0, else `computed` (the delay this session works out, for a record that does not carry a usable one).
 */
export function journalledDelayMs(record: JournalRecord, computed: number): number {
  const journalled = record.data["delayMs"];
  return typeof journalled === "number" && Number.isFinite(journalled) && journalled >= 0 ? journalled : computed;
}

/**
 * Runs `attempt(1 … maxAttempts)`; each attempt uses its own step keys, so replay sees the earlier attempts'
 * journalled outcomes and continues with the next one. Between attempts it journals `node.retry` once, with the
 * delay: the node's backoff, or at least what is left of a provider's retry-after wait when the failed attempt
 * was a model step that ended while that wait was outstanding (`providerWaitMs`). The wait before attempt n + 1
 * ends at that record's `ts + delayMs`, in every session: a session that replays the record (after a restart, a
 * takeover, a pause or a resume) waits only what is left of it, and not at all once that instant has passed. The
 * engine caps the wait at `delayMs` from the call, so a clock that stepped back cannot make it longer.
 */
async function withNodeRetry<T>(
  ex: WorkflowExecutor, retry: RetryPolicy | undefined, key: string, place: NodePlace, attempt: (n: number) => Promise<T>,
): Promise<T> {
  const maxAttempts = attemptLimit(retry);
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      if (isControlSignal(error)) throw error;
      if (retry === undefined || n >= maxAttempts || !isRetryable(error)) throw asNodeFailure(error, place);
      const computed = Math.max(retryDelayMs(retry, n), providerWaitMs(error));
      const record = await ex.ctx.emit(`${key}#retry${n}`, "node.retry", {
        nodeId: place.nodeId, attempt: n, delayMs: computed, error: { code: errorCode(error), message: errorMessage(error) },
      });
      const delayMs = journalledDelayMs(record, computed);
      await ex.ctx.sleepUntil(record.ts + delayMs, { maxMs: delayMs });
    }
  }
}

function deadline(node: { deadlineMs?: number }): { deadlineMs?: number } {
  return node.deadlineMs === undefined ? {} : { deadlineMs: node.deadlineMs };
}

function systemPrompt(ex: WorkflowExecutor, template: string | undefined, scope: RefScope): string {
  return template === undefined ? ex.ctx.definition.instructions : renderTemplate(template, scope);
}

/**
 * The system prompt of a model or decide node's call: `base`, then, in a run that was given learned items, the
 * learning section (the same text an agent loop gets), after a blank line. Without a section `base` is returned
 * unchanged. Agent nodes do not use this: their loop adds the section itself.
 */
function withLearning(ex: WorkflowExecutor, base: string): string {
  const section = (ex.ctx.learning?.promptSection ?? "").trim();
  if (section === "") return base;
  return base.trim() === "" ? section : `${base.trim()}\n\n${section}`;
}

/** The fixed sentence appended to a decision question. */
function answerInstruction(spec: DecisionSpec): string {
  switch (spec.type) {
    case "yes_no":
      return "Answer with \"value\" true for yes or false for no, a \"confidence\" between 0 and 1, and a short \"reason\".";
    case "pick_one":
      return `Answer with "value" set to exactly one of ${spec.options.map((o) => JSON.stringify(o)).join(", ")}, a "confidence" between 0 and 1, and a short "reason".`;
    case "score":
      return `Answer with "value" a number from ${spec.min} to ${spec.max}, a "confidence" between 0 and 1, and a short "reason".`;
  }
}

function iterationFrame(frame: Frame, scopeSuffix: string, turn: number, vars: JsonObject, loop?: { id: string; index: number; last: Json }): Frame {
  const scope: RefScope = {
    input: frame.scope.input,
    steps: { ...frame.scope.steps },
    vars: { ...frame.scope.vars, ...vars },
    loop: loop === undefined ? { ...frame.scope.loop } : { ...frame.scope.loop, [loop.id]: { index: loop.index, last: loop.last } },
    run: frame.scope.run,
  };
  return { doc: frame.doc, scope, scopeKey: frame.scopeKey + scopeSuffix, turn, depth: frame.depth };
}

async function toolNode(ex: WorkflowExecutor, node: ToolNode, frame: Frame, key: string, place: NodePlace): Promise<Json> {
  const args = resolveArgs(node.args, frame.scope);
  if (node.retry !== undefined && node.idempotent !== true && !ex.toolRetrySafe(node.tool)) {
    throw nodeFailure(place, `tool "${node.tool}" is not safe to retry: it is not read-only or idempotent and the node is not marked idempotent`);
  }
  return withNodeRetry(ex, node.retry, key, place, async (attempt) => {
    const result = await ex.ctx.tool(`${key}#${attempt}`, { name: node.tool, args, ...deadline(node) });
    const output: JsonObject = { ok: !result.isError, content: result.content, data: result.data };
    if (!result.isError || node.onError === "continue") return output;
    throw toolAttemptError(node.tool, result.outcome, result.content, result.data);
  });
}

async function modelNode(ex: WorkflowExecutor, node: ModelNode, frame: Frame, key: string, place: NodePlace): Promise<Json> {
  const request: ModelStepRequest = {
    purpose: "step",
    step: node.id,
    turn: frame.turn,
    system: withLearning(ex, systemPrompt(ex, node.system, frame.scope)),
    messages: [{ role: "user", content: renderTemplate(node.prompt, frame.scope) }],
    output: { name: node.output, schema: bundleSchema(frame.doc, node.output) },
    countsAsTurn: true,
    ...deadline(node),
  };
  return withNodeRetry(ex, node.retry, key, place, async (attempt) => (await ex.ctx.model(`${key}#${attempt}`, request)).output);
}

async function decideNode(ex: WorkflowExecutor, node: DecideNode, path: string, frame: Frame, key: string, place: NodePlace): Promise<Json> {
  const spec = node.decision;
  const request: ModelStepRequest = {
    purpose: "decision",
    step: node.id,
    turn: frame.turn,
    system: withLearning(ex, ex.ctx.definition.instructions),
    messages: [{ role: "user", content: `${renderTemplate(node.question, frame.scope)}\n\n${answerInstruction(spec)}` }],
    output: { name: "decision", schema: decisionSchema(spec) },
    outputFields: DECISION_OUTPUT_FIELDS,
    countsAsTurn: true,
    ...deadline(node),
  };
  const answer = await withNodeRetry(ex, node.retry, key, place, async (attempt) => (await ex.ctx.model(`${key}#${attempt}`, request)).output);
  const record = isJsonObject(answer) ? answer : {};
  const value = record["value"] ?? null;
  const confidence = typeof record["confidence"] === "number" ? record["confidence"] : 0;
  const reason = typeof record["reason"] === "string" ? record["reason"] : "";
  if (!checkDecisionValue(spec, value)) {
    throw nodeFailure(place, `the decision value ${canonicalJson(value)} does not fit the ${spec.type} decision`);
  }
  const low = node.lowConfidence;
  if (low === undefined || !(confidence < low.below)) {
    return { value, confidence, reason, route: "confident", fallback: null };
  }
  const lowPath = pathProperty(path, "lowConfidence");
  const fallback = await ex.run(low.run, pathProperty(lowPath, "run"), frame);
  let finalValue: Json = value;
  if (low.value !== undefined) {
    finalValue = resolveValue(low.value, { ...frame.scope, fallback });
    if (!checkDecisionValue(spec, finalValue)) {
      throw nodeFailure({ ...place, path: pathProperty(lowPath, "value") },
        `the fallback value ${canonicalJson(finalValue)} does not fit the ${spec.type} decision`);
    }
  }
  return { value: finalValue, confidence, reason, route: "low_confidence", fallback };
}

async function mapNode(ex: WorkflowExecutor, node: MapNode, path: string, frame: Frame, place: NodePlace): Promise<Json> {
  const items = resolveValue(node.over, frame.scope);
  if (!Array.isArray(items)) throw nodeFailure(place, `"over" resolved to ${canonicalJson(items)}, not an array`);
  if (items.length > node.maxItems) throw nodeFailure(place, `"over" has ${items.length} items, more than maxItems ${node.maxItems}`);
  const bodyPath = pathProperty(path, "run");
  return mapLimit(items, node.concurrency, (item, index) => {
    const child = iterationFrame(frame, `${node.id}[${index}]/`, index + 1, { [node.as]: item, [`${node.as}_index`]: index });
    return ex.run(node.run, bodyPath, child);
  });
}

async function loopNode(ex: WorkflowExecutor, node: LoopNode, path: string, frame: Frame, place: NodePlace): Promise<Json> {
  const bodyPath = pathProperty(path, "run");
  let last: Json = null;
  for (let index = 0; index < node.maxIterations; index++) {
    const child = iterationFrame(frame, `${node.id}#${index}/`, index + 1, {}, { id: node.id, index, last });
    last = await ex.run(node.run, bodyPath, child);
    const after: RefScope = { ...child.scope, loop: { ...child.scope.loop, [node.id]: { index, last } } };
    if (evalCondition(node.until, after)) return { iterations: index + 1, completed: true, last };
  }
  if (node.onLimit === "fail") {
    throw nodeFailure(place, `the loop reached maxIterations ${node.maxIterations} before "until" held`);
  }
  return { iterations: node.maxIterations, completed: false, last };
}

async function callNode(ex: WorkflowExecutor, node: CallNode, frame: Frame, key: string, place: NodePlace): Promise<Json> {
  if (frame.depth >= MAX_CALL_DEPTH) throw nodeFailure(place, `sub-workflow calls nest deeper than ${MAX_CALL_DEPTH}`);
  const inline = frame.doc.workflows;
  let target: WorkflowDocument;
  if (inline !== undefined && Object.hasOwn(inline, node.workflow)) {
    target = inline[node.workflow] as WorkflowDocument;
  } else {
    const pinned = await ex.ctx.memo(`${key}/resolve`, {
      recordType: "step", name: "workflow.resolve", info: { workflow: node.workflow }, valueFields: RESOLVE_VALUE_FIELDS,
    }, async () => {
      const saved = await ex.deps.store.getWorkflow(node.workflow);
      return { version: saved === null ? null : saved.version };
    });
    const version = pinned.version;
    if (typeof version !== "number") throw nodeFailure(place, `unknown workflow "${node.workflow}": not inline and not saved`);
    const saved = await ex.deps.store.getWorkflow(node.workflow, version);
    if (saved === null) throw nodeFailure(place, `saved workflow "${node.workflow}" version ${version} no longer exists`);
    ex.checkDocument(saved.document, node.workflow);
    target = saved.document;
  }
  const input = resolveValue(node.input, frame.scope);
  return ex.runDocument(target, input, { scopeKey: `${frame.scopeKey}${node.id}>/`, depth: frame.depth + 1, caller: place });
}

async function agentNode(ex: WorkflowExecutor, node: AgentNode, frame: Frame, key: string): Promise<Json> {
  const params: AgentLoopParams = {
    instructions: systemPrompt(ex, node.instructions, frame.scope),
    message: renderTemplate(node.message, frame.scope),
    maxTurns: node.maxTurns,
    step: node.id,
  };
  if (node.tools !== undefined) params.toolNames = [...node.tools];
  if (node.output !== undefined) params.output = { name: node.output, schema: bundleSchema(frame.doc, node.output) };
  const result = await ex.deps.agentLoop(ex.ctx.child(key), params);
  return { text: result.text, data: result.data };
}

/** Executes one node's own work (children through `ex.run`). Throws a node failure when the node fails. */
/** `expiresAt`: for a wait node, the instant at which its question is closed unanswered (its deadline). */
export async function execNode(
  ex: WorkflowExecutor, node: WorkflowNode, path: string, frame: Frame, key: string, place: NodePlace, expiresAt?: number,
): Promise<Json> {
  const scope = frame.scope;
  switch (node.kind) {
    case "tool":
      return toolNode(ex, node, frame, key, place);
    case "model":
      return modelNode(ex, node, frame, key, place);
    case "decide":
      return decideNode(ex, node, path, frame, key, place);
    case "branch": {
      const value = canonicalJson(resolveValue(node.on, scope));
      const index = node.cases.findIndex((entry) => canonicalJson(entry.when) === value);
      if (index >= 0) {
        const chosen = node.cases[index] as { when: Json; run: WorkflowNode };
        return ex.run(chosen.run, pathProperty(pathIndex(pathProperty(path, "cases"), index), "run"), frame);
      }
      if (node.default !== undefined) return ex.run(node.default, pathProperty(path, "default"), frame);
      return null;
    }
    case "sequence": {
      let last: Json = null;
      for (const [index, step] of node.steps.entries()) {
        last = await ex.run(step, pathIndex(pathProperty(path, "steps"), index), frame);
      }
      return last;
    }
    case "parallel": {
      const outputs = await settleAll(node.branches.map((branch, index) => ex.run(branch, pathIndex(pathProperty(path, "branches"), index), frame)));
      const out: JsonObject = {};
      node.branches.forEach((branch, index) => {
        out[branch.id] = outputs[index] as Json;
      });
      return out;
    }
    case "map":
      return mapNode(ex, node, path, frame, place);
    case "loop":
      return loopNode(ex, node, path, frame, place);
    case "call":
      return callNode(ex, node, frame, key, place);
    case "agent":
      return agentNode(ex, node, frame, key);
    case "wait": {
      const question = renderTemplate(node.question, scope);
      const { answer } = await ex.ctx.ask(key, {
        question,
        ...(node.choices === undefined ? {} : { choices: [...node.choices] }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      return { answer };
    }
    case "fail":
      throw nodeFailure(place, renderTemplate(node.message, scope));
  }
}
