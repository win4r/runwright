import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createServer } from "../../src/server/index.ts";
import { toGraph } from "../../src/workflow/graph.ts";
import type { WorkflowDocument } from "../../src/workflow/types.ts";
import { startTestServer } from "../server/support.ts";

const CONSOLE_PATH = fileURLToPath(new URL("../../src/console/index.html", import.meta.url));
const PAGE = readFileSync(CONSOLE_PATH, "utf8");
const SVG_NS = "http://www.w3.org/2000/svg";

function inlineScript(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(PAGE);
  assert.ok(match, "the page has an inline script");
  return match[1] as string;
}

// ------------------------------------------------------------------ a tiny fake DOM that records what is built

type Child = FakeElement | FakeText;
type Listener = (event: unknown) => unknown;

class FakeText {
  readonly nodeType = 3;
  data: string;
  parentNode: FakeElement | null = null;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly attributes = new Map<string, string>();
  readonly childNodes: Child[] = [];
  readonly listeners = new Map<string, Listener[]>();
  parentNode: FakeElement | null = null;
  constructor(tagName: string, namespaceURI: string | null) {
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespaceURI;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  appendChild<T extends Child>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild<T extends Child>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  get firstChild(): Child | null {
    return this.childNodes[0] ?? null;
  }
  contains(node: unknown): boolean {
    for (let n = node as Child | null; n !== null && n !== undefined; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  /** Every element in this subtree, this one included. */
  all(): FakeElement[] {
    return [this, ...this.childNodes.flatMap((c) => (c instanceof FakeElement ? c.all() : []))];
  }
}

interface FakeDocument {
  created: FakeElement[];
  listeners: Map<string, Listener[]>;
  activeElement: FakeElement | null;
  body: FakeElement;
  createElement(tag: string): FakeElement;
  createElementNS(ns: string, tag: string): FakeElement;
  createTextNode(text: string): FakeText;
  getElementById(id: string): FakeElement | null;
  addEventListener(type: string, listener: Listener): void;
}

function fakeDocument(byId: Record<string, FakeElement> = {}): FakeDocument {
  const created: FakeElement[] = [];
  const listeners = new Map<string, Listener[]>();
  return {
    created, listeners, activeElement: null, body: new FakeElement("body", null),
    createElement(tag) {
      const el = new FakeElement(tag, null);
      created.push(el);
      return el;
    },
    createElementNS(ns, tag) {
      const el = new FakeElement(tag, ns);
      created.push(el);
      return el;
    },
    createTextNode(text) {
      return new FakeText(text);
    },
    getElementById(id) {
      return byId[id] ?? null;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
}

interface SseEvent { event: string; data: string; id: string | null }
interface Laid {
  nodes: { id: string; kind: string; label: string; layer: number; x: number; y: number; width: number; height: number }[];
  edges: { from: string; to: string; kind: string; label: string | null; x1: number; y1: number; x2: number; y2: number }[];
  width: number; height: number;
}
interface ConsoleApi {
  h(tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeElement;
  parseSse(text: string): SseEvent[];
  createSseParser(): { push(text: string): SseEvent[] };
  createSseDecoder(): { push(bytes: Uint8Array): SseEvent[] };
  layoutGraph(graph: unknown): Laid;
  formatCost(micros: unknown, unknown?: unknown): string;
  summarize(record: unknown): string;
  typeClass(type: unknown): string;
  pendingDetail(pending: unknown): FakeElement;
  endsStream(type: unknown): boolean;
  promotedWorkflowLine(item: unknown): FakeElement | null;
}

/** Loads the page script in a fresh context with only a fake document: nothing boots, nothing is fetched. */
function loadHelpers(): { api: ConsoleApi; document: FakeDocument } {
  const document = fakeDocument();
  const context: Record<string, unknown> = { document, TextDecoder, URLSearchParams, AbortController };
  context["window"] = context;
  vm.createContext(context);
  vm.runInContext(inlineScript(), context, { filename: "console-script.js" });
  assert.equal(document.listeners.get("DOMContentLoaded")?.length, 1, "the app boots on DOMContentLoaded only");
  return { api: context["RunwrightConsole"] as ConsoleApi, document };
}

/** Cross-realm values compared as plain JSON. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ------------------------------------------------------------------ static checks on the file

test("the page text has none of the forbidden constructs", () => {
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "EventSource", "setTimeout(\"", "setTimeout('", "setInterval(\""]) {
    assert.equal(PAGE.includes(forbidden), false, `the page contains ${forbidden}`);
  }
  assert.doesNotMatch(PAGE, /<[a-zA-Z][^>]*\son[a-z]+\s*=/, "an inline on…= handler attribute in markup");
  assert.doesNotMatch(inlineScript(), /\.on[a-z]+\s*=[^=]/, "an on… handler property assignment");
  assert.doesNotMatch(PAGE, /setAttribute\(\s*["']on/i);
});

test("the page has no external URL other than the SVG namespace", () => {
  const urls = PAGE.match(/https?:\/\/[^\s"'`)]*/g) ?? [];
  assert.deepEqual([...new Set(urls)], [SVG_NS]);
  assert.doesNotMatch(PAGE, /<link\b/i);
  assert.doesNotMatch(PAGE, /<img\b/i);
  const style = /<style>([\s\S]*?)<\/style>/.exec(PAGE)?.[1] ?? "";
  assert.doesNotMatch(style, /@import|url\(/i, "no CSS import or url()");
  assert.doesNotMatch(inlineScript(), /\burl\(\s*["']?(?!#)/, "url() in SVG attributes only for fragments");
  assert.doesNotMatch(PAGE.split(SVG_NS).join(""), /\/\/[a-z0-9.-]+\.[a-z]{2,}\//i, "no protocol-relative URL");
});

test("the page has one inline script, and requests only go to /v1/ with the token in a header", () => {
  const scripts = PAGE.match(/<script\b[^>]*>/gi) ?? [];
  assert.deepEqual(scripts, ["<script>"]);
  const script = inlineScript();
  const tokenMentions = PAGE.match(/token=/g) ?? [];
  assert.equal(tokenMentions.length, 1, "the only token= is the fragment reader");
  assert.match(script, /const TOKEN_FRAGMENT = "#token=";/);
  assert.match(script, /Authorization: "Bearer " \+/);
  const fetchCalls = script.match(/\bfetch\(/g) ?? [];
  assert.equal(fetchCalls.length, 1, "one fetch call site, in the api client");
  assert.match(script, /if \(!path\.startsWith\("\/v1\/"\)\) throw/);
  assert.match(script, /sessionStorage/);
  assert.doesNotMatch(script, /localStorage/);
  for (const name of ["Needs you", "Failed", "Running", "Cost"]) assert.ok(PAGE.includes(`"${name}"`), name);
});

// ------------------------------------------------------------------ the DOM builder

test("h() puts hostile strings into text nodes and attribute values verbatim, never into elements", () => {
  const { api, document } = loadHelpers();
  const hostile = "<img src=x onerror=alert(1)>";
  const breakout = "\"><script>alert(2)</script>";
  const before = document.created.length;
  const el = api.h("div", { class: "x", title: breakout, "data-name": hostile }, hostile, api.h("span", null, breakout), 42, null, false, [hostile]);
  const made = document.created.slice(before);
  assert.deepEqual(made.map((e) => e.tagName).sort(), ["DIV", "SPAN"]);
  assert.equal(el.attributes.get("title"), breakout);
  assert.equal(el.attributes.get("data-name"), hostile);
  const texts = el.childNodes.filter((c): c is FakeText => c instanceof FakeText).map((t) => t.data);
  assert.deepEqual(texts, [hostile, "42", hostile]);
  assert.equal(el.textContent, hostile + breakout + "42" + hostile);
  assert.equal(document.created.some((e) => e.tagName === "IMG" || e.tagName === "SCRIPT"), false);
});

test("h() refuses attributes outside the whitelist and hrefs that are not #/ routes", () => {
  const { api } = loadHelpers();
  for (const attrs of [
    { onclick: "alert(1)" }, { onerror: "x" }, { style: "color:red" }, { src: "x" }, { srcdoc: "<p>" },
    { href: "javascript:alert(1)" }, { href: "https://example.com/" }, { href: "//evil/" }, { href: "#token=x" }, { href: 5 },
    { formaction: "/x" }, { "xlink:href": "#/x" },
  ]) {
    assert.throws(() => api.h("a", attrs), /attribute not allowed/, JSON.stringify(attrs));
  }
  assert.throws(() => api.h("img src=x", null), /bad tag name/);
  assert.throws(() => api.h("svg:rect", { onload: "x" }), /attribute not allowed/);
  assert.throws(() => api.h("div", { viewBox: "0 0 1 1" }), /attribute not allowed/, "SVG geometry only on SVG elements");

  const link = api.h("a", { href: "#/runs/" + encodeURIComponent("<x>") }, "run");
  assert.equal(link.attributes.get("href"), "#/runs/%3Cx%3E");
  let clicked = 0;
  const button = api.h("button", { type: "button", disabled: true, hidden: false, on: { click: () => clicked++ } }, "Go");
  assert.equal(button.attributes.get("disabled"), "");
  assert.equal(button.attributes.has("hidden"), false);
  assert.equal([...button.attributes.keys()].some((k) => k.startsWith("on")), false);
  button.listeners.get("click")?.[0]?.({});
  assert.equal(clicked, 1);
  const rect = api.h("svg:rect", { x: 1, y: 2, width: 3, height: 4, class: "gnode" });
  assert.equal(rect.namespaceURI, SVG_NS);
  assert.equal(rect.tagName, "RECT");
  assert.equal(rect.attributes.get("width"), "3");
});

// ------------------------------------------------------------------ the SSE parser

const SSE_SAMPLE = [
  ": connected\n\n",
  `id: 1\nevent: run.created\ndata: ${JSON.stringify({ seq: 1, type: "run.created", data: { text: "héllo ✓ 😀 <b>" } })}\n\n`,
  `event: delta\ndata: ${JSON.stringify({ key: "t1", text: "stream ü" })}\n\n`,
  ": ping\n\n",
  "id: 2\r\nevent: tool.finished\r\ndata: line one\r\ndata: line two\r\n\r\n",
  "data:no space\rid:3\r\r",
  "event: ignored-without-data\n\n",
  "event: end\ndata: {\"status\":\"completed\"}\n\n",
].join("");

const SSE_EXPECTED: SseEvent[] = [
  { event: "run.created", data: JSON.stringify({ seq: 1, type: "run.created", data: { text: "héllo ✓ 😀 <b>" } }), id: "1" },
  { event: "delta", data: JSON.stringify({ key: "t1", text: "stream ü" }), id: null },
  { event: "tool.finished", data: "line one\nline two", id: "2" },
  { event: "message", data: "no space", id: "3" },
  { event: "end", data: "{\"status\":\"completed\"}", id: null },
];

test("the SSE parser handles comments, CRLF and CR line ends, multi-line data and events without ids", () => {
  const { api } = loadHelpers();
  assert.deepEqual(plain(api.parseSse(SSE_SAMPLE)), SSE_EXPECTED);
});

test("the SSE decoder gives the same events however the bytes are split", () => {
  const { api } = loadHelpers();
  const bytes = new TextEncoder().encode(SSE_SAMPLE);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const decoder = api.createSseDecoder();
    const events = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
    assert.deepEqual(plain(events), SSE_EXPECTED, `split at byte ${cut}`);
  }
  const decoder = api.createSseDecoder();
  const events: SseEvent[] = [];
  for (let i = 0; i < bytes.length; i++) events.push(...decoder.push(bytes.subarray(i, i + 1)));
  assert.deepEqual(plain(events), SSE_EXPECTED, "one byte at a time");
  const partial = api.createSseParser();
  assert.deepEqual(plain(partial.push("id: 9\nevent: x\ndata: half")), []);
  assert.deepEqual(plain(partial.push("\n\n")), [{ event: "x", data: "half", id: "9" }]);
});

// ------------------------------------------------------------------ cost formatting

test("formatCost never shows $0 for an unknown cost and marks a partly unknown cost with ≥", () => {
  const { api } = loadHelpers();
  const unknownCases: [unknown, unknown][] = [[null, true], [0, true], [0, 2], [null, false], [undefined, undefined], [Number.NaN, false], ["12", false], [null, null]];
  for (const [micros, flag] of unknownCases) {
    const text = api.formatCost(micros, flag);
    assert.equal(text, "unknown", `${String(micros)} / ${String(flag)}`);
  }
  assert.equal(api.formatCost(1_500_000, true), "≥ $1.50");
  assert.equal(api.formatCost(4200, 1), "≥ $0.0042");
  assert.equal(api.formatCost(1_500_000, false), "$1.50");
  assert.equal(api.formatCost(1_500_000, 0), "$1.50");
  assert.equal(api.formatCost(123_400, false), "$0.1234");
  assert.equal(api.formatCost(4200, false), "$0.0042");
  assert.equal(api.formatCost(0, false), "$0.00", "a known zero is shown as a known zero");
  for (const [micros, flag] of [...unknownCases, [5, true], [1, 3]] as [unknown, unknown][]) {
    assert.doesNotMatch(api.formatCost(micros, flag), /^\$0(\.0*)?$/);
  }
});

// ------------------------------------------------------------------ graph layout

const DOC = {
  format: "runwright.workflow/v1", name: "triage", schemas: { In: { type: "object" }, Out: { type: "object" }, Summary: { type: "object" } },
  input: "In", output: "Out", result: null,
  root: {
    kind: "sequence", id: "main", steps: [
      { kind: "tool", id: "fetch", tool: "read_file", args: { path: "a.txt" } },
      { kind: "decide", id: "urgent", question: "Urgent?", decision: { type: "yes_no" },
        lowConfidence: { below: 0.7, run: { kind: "agent", id: "fallback", message: "Look", maxTurns: 3 } } },
      { kind: "branch", id: "route", on: { $ref: "urgent.value" }, cases: [
        { when: true, run: { kind: "wait", id: "page", question: "Page someone?" } },
      ], default: { kind: "model", id: "summarise", prompt: "Sum", output: "Summary" } },
      { kind: "parallel", id: "both", branches: [
        { kind: "map", id: "each", over: [1, 2], as: "item", concurrency: 2, maxItems: 10, run: { kind: "tool", id: "write", tool: "write_file", args: {} } },
        { kind: "loop", id: "retry", maxIterations: 3, until: { truthy: true }, run: { kind: "call", id: "sub", workflow: "helper", input: null } },
      ] },
      { kind: "fail", id: "stop", message: "done" },
    ],
  },
} as unknown as WorkflowDocument;

test("layoutGraph gives every node a finite position and puts every next-edge target in a deeper layer", () => {
  const { api } = loadHelpers();
  const graph = toGraph(DOC);
  const laid = plain(api.layoutGraph(graph));
  assert.equal(laid.nodes.length, graph.nodes.length);
  const byId = new Map(laid.nodes.map((n) => [n.id, n]));
  for (const node of laid.nodes) {
    for (const value of [node.x, node.y, node.width, node.height, node.layer]) assert.ok(Number.isFinite(value), `${node.id}: ${value}`);
    assert.ok(node.x >= 0 && node.x + node.width <= laid.width && node.y >= 0 && node.y + node.height <= laid.height, `${node.id} inside the canvas`);
  }
  const nextEdges = graph.edges.filter((e) => e.kind === "next");
  assert.ok(nextEdges.length >= 4);
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    assert.ok(from && to);
    assert.ok(to.layer > from.layer, `${edge.kind} ${edge.from} -> ${edge.to}`);
  }
  for (const a of laid.nodes) {
    for (const b of laid.nodes) {
      if (a !== b && a.layer === b.layer) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x, `${a.id} and ${b.id} overlap`);
    }
  }
  assert.ok(laid.edges.every((e) => [e.x1, e.y1, e.x2, e.y2].every(Number.isFinite)));
});

test("layoutGraph survives cycles, unknown edge ends, duplicates and junk", () => {
  const { api } = loadHelpers();
  const laid = plain(api.layoutGraph({
    nodes: [{ id: "a", kind: "tool", label: "A" }, { id: "b", kind: "tool", label: "B" }, { id: "c", kind: "x", label: "<script>" }, { id: "a", kind: "dup", label: "dup" }],
    edges: [{ from: "a", to: "b", kind: "next", label: null }, { from: "b", to: "a", kind: "next", label: null }, { from: "a", to: "ghost", kind: "next", label: null }, { from: "c", to: "c", kind: "next", label: null }],
  }));
  assert.equal(laid.nodes.length, 3);
  assert.ok(laid.nodes.every((n) => [n.x, n.y, n.layer].every(Number.isFinite)));
  assert.equal(laid.edges.length, 2);
  assert.equal(laid.nodes.find((n) => n.id === "c")?.label, "<script>");
  const none = plain(api.layoutGraph(null));
  assert.deepEqual(none.nodes, []);
  assert.ok(Number.isFinite(none.width) && Number.isFinite(none.height));
});

// ------------------------------------------------------------------ timeline summaries

test("summarize gives a readable line per journal record type and falls back to JSON", () => {
  const { api } = loadHelpers();
  const rec = (type: string, data: unknown) => ({ runId: "r", seq: 1, epoch: 1, ts: 0, type, key: "t1", data });
  assert.match(api.summarize(rec("model.finished", { model: "m", text: "Hello there", toolCalls: [{ id: "c", name: "write_file", args: { path: "x" } }],
    output: null, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 }, costMicros: null, durationMs: 12 })), /Hello there[\s\S]*write_file[\s\S]*unknown/);
  assert.equal(api.summarize(rec("tool.finished", { tool: "read_file", outcome: "ok", content: "<img src=x onerror=alert(1)>", isError: false,
    untrusted: true, truncated: false, fullResultPath: null, durationMs: 3 })), "read_file → ok [untrusted]: <img src=x onerror=alert(1)> (3 ms)");
  assert.match(api.summarize(rec("tool.started", { tool: "shell", args: { command: "npm test" }, effect: "write", attempt: 1 })), /shell\(\{"command":"npm test"\}\)/);
  assert.equal(api.summarize(rec("pending.opened", { pending: { kind: "approval", title: "Approve shell: npm test" } })), "needs you — approval: Approve shell: npm test");
  assert.match(api.summarize(rec("limits.changed", { limits: { maxCostMicros: 2_000_000, maxToolCalls: null, maxTurns: 4, allowUnpriced: false } })), /cost cap \$2\.00, tool calls no limit, turns 4/);
  assert.match(api.summarize(rec("command.applied", { commandId: "c", command: { type: "approve", pendingId: "p1", always: true } })), /approve p1 \(always/);
  assert.equal(api.summarize(rec("run.failed", { error: { code: "model_failed", message: "boom" } })), "failed: model_failed: boom");
  assert.match(api.summarize(rec("learning.applied", { kept: [{}], held: [] })), /1 kept, 0 held/);
  assert.equal(api.summarize(rec("custom.thing", { a: 1 })), "{\"a\":1}");
  assert.equal(typeof api.summarize(rec("model.finished", null)), "string");
  assert.equal(typeof api.summarize(null), "string");
  assert.ok(api.summarize(rec("run.completed", { output: "x".repeat(5000) })).length < 500, "long values are cut");
});

const HOSTILE = "<script>alert(1)</script>";
const rec = (type: string, data: unknown) => ({ runId: "r", seq: 1, epoch: 1, ts: 0, type, key: "t1", data });

test("a repair call's model.started says repair; one written without the field does not", () => {
  const { api } = loadHelpers();
  const base = { model: HOSTILE, purpose: "run", step: null, turn: 2, countsAsTurn: true, inputTokensEstimate: 1500, maxOutputTokens: 256, worstCaseMicros: 4200 };
  const repair = api.summarize(rec("model.started", { ...base, repair: true }));
  assert.equal(repair, `${HOSTILE} (run) repair, turn 2, ~1,500 tokens in, ≤ 256 out, worst case $0.0042`);
  const first = api.summarize(rec("model.started", { ...base, repair: false }));
  assert.equal(first, `${HOSTILE} (run), turn 2, ~1,500 tokens in, ≤ 256 out, worst case $0.0042`);
  assert.equal(api.summarize(rec("model.started", base)), first, "a record written before the repair field existed");
});

test("model.invalid shows the model, the problem count, the first problem, usage and that a repair follows", () => {
  const { api } = loadHelpers();
  const text = api.summarize(rec("model.invalid", {
    model: HOSTILE, purpose: HOSTILE, text: HOSTILE, toolCalls: [], output: { a: HOSTILE },
    problems: [{ path: `$.${HOSTILE}`, message: HOSTILE }, { path: "$.b", message: "is required" }],
    usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, costMicros: 3100, durationMs: 15,
  }));
  assert.equal(text, `${HOSTILE}: output invalid, 2 schema problem(s), first $.${HOSTILE}: ${HOSTILE}\n1,200 in / 40 out, $0.0031, 15 ms; repair follows`);
  const unpriced = api.summarize(rec("model.invalid", { model: "m", problems: [], usage: {}, costMicros: null, durationMs: 1 }));
  assert.equal(unpriced, "m: output invalid, 0 schema problem(s)\n– in / – out, unknown, 1 ms; repair follows");
  assert.equal(api.typeClass("model.invalid"), "t-error");
  assert.equal(api.typeClass("model.failed"), "t-error");
  assert.equal(api.typeClass("model.finished"), "t-model");
});

test("tool.interrupted names its reason; a record without one still renders", () => {
  const { api } = loadHelpers();
  const data = { tool: HOSTILE, args: { path: HOSTILE }, attempt: 2 };
  const expected: [string | undefined, string][] = [
    ["pause", " by a pause"], ["shutdown", " by a forced shutdown"], ["crash", " by a crash"], [undefined, ""], [HOSTILE, ""],
  ];
  for (const [reason, phrase] of expected) {
    const text = api.summarize(rec("tool.interrupted", reason === undefined ? data : { ...data, reason }));
    assert.equal(text, `${HOSTILE}(${JSON.stringify({ path: HOSTILE })}) interrupted${phrase} at attempt 2; waiting for a decision`, String(reason));
  }
});

test("learning.applied counts conflicts when there are any", () => {
  const { api } = loadHelpers();
  const kept = [{ itemId: "li_1", path: "notes/a.md", version: 1 }];
  assert.equal(api.summarize(rec("learning.applied", { kept, held: [] })), "1 kept, 0 held for a person");
  assert.equal(api.summarize(rec("learning.applied", { kept, held: [], conflicts: [] })), "1 kept, 0 held for a person");
  assert.equal(api.summarize(rec("learning.applied", { kept: [], held: [], conflicts: [{ path: HOSTILE, reason: HOSTILE }, { path: "notes/b.md", reason: "retired" }] })),
    `0 kept, 0 held for a person, 2 not written (changed since checked): ${HOSTILE} (${HOSTILE}), notes/b.md (retired)`);
  assert.equal(typeof api.summarize(rec("learning.applied", { kept: [], held: [], conflicts: "junk" })), "string");
});

test("the interrupted pending shows its reason as text and builds no element from hostile fields", () => {
  const { api, document } = loadHelpers();
  const pending = (detail: unknown) => ({ id: "p1", runId: "r", agentId: "a", kind: "interrupted", stepKey: "t1", title: HOSTILE, detail,
    status: "open", resolution: null, createdAt: 0, resolvedAt: null });
  const before = document.created.length;
  const withReason = api.pendingDetail(pending({ tool: HOSTILE, args: { command: HOSTILE }, attempt: 1, reason: "shutdown" }));
  assert.match(withReason.textContent, /^Tool <script>alert\(1\)<\/script> was interrupted by a forced shutdown at attempt 1\. It may or may not have taken effect/);
  assert.ok(withReason.textContent.includes(JSON.stringify({ command: HOSTILE }, null, 2)));
  const old = api.pendingDetail(pending({ tool: "shell", args: {}, attempt: 3 }));
  assert.match(old.textContent, /^Tool shell was interrupted at attempt 3\./);
  const paused = api.pendingDetail(pending({ tool: "shell", args: {}, attempt: 1, reason: "pause" }));
  assert.match(paused.textContent, /interrupted by a pause at attempt 1/);
  const made = document.created.slice(before).map((e) => e.tagName);
  assert.deepEqual([...new Set(made)].sort(), ["CODE", "DIV", "PRE"]);
});

test("the live text of a step is cleared by the records that end a call and by model.retry, which ends an attempt", () => {
  const { api } = loadHelpers();
  for (const type of ["model.invalid", "model.finished", "model.interrupted", "model.failed", "model.retry"]) assert.equal(api.endsStream(type), true, type);
  for (const type of ["model.started", "tool.finished", "message.undelivered", null]) assert.equal(api.endsStream(type), false, String(type));
});

test("model.started names the attempt after the first; attempt 1 and older records do not", () => {
  const { api } = loadHelpers();
  const base = { model: HOSTILE, purpose: "run", step: null, turn: 1, countsAsTurn: true, inputTokensEstimate: 10, maxOutputTokens: 20, worstCaseMicros: 100 };
  const plain = `${HOSTILE} (run), turn 1, ~10 tokens in, ≤ 20 out, worst case $0.0001`;
  assert.equal(api.summarize(rec("model.started", base)), plain);
  assert.equal(api.summarize(rec("model.started", { ...base, attempt: 1 })), plain);
  assert.equal(api.summarize(rec("model.started", { ...base, attempt: 3 })), `${HOSTILE} (run), turn 1, attempt 3, ~10 tokens in, ≤ 20 out, worst case $0.0001`);
  assert.equal(api.summarize(rec("model.started", { ...base, attempt: HOSTILE })), plain, "a hostile attempt value is ignored");
});

test("model.retry shows the attempt, the status or code, what it was charged and the delay; an older record still renders", () => {
  const { api } = loadHelpers();
  const base = { attempt: 1, delayMs: 500, code: "model_transient", message: HOSTILE };
  assert.equal(api.summarize(rec("model.retry", { ...base, status: 429, billing: "none" })),
    `attempt 1 failed (status 429), not charged; next attempt in 500 ms: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.retry", { ...base, attempt: 2, status: null, billing: "unknown", assumedCostMicros: 4200 })),
    `attempt 2 failed (model_transient), charged $0.0042 (assumed); next attempt in 500 ms: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.retry", { ...base, status: null, billing: "unknown", assumedCostMicros: null })),
    `attempt 1 failed (model_transient), charged unknown (assumed); next attempt in 500 ms: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.retry", base)), `attempt 1 failed (model_transient); next attempt in 500 ms: ${HOSTILE}`, "written before round 3");
  assert.equal(api.summarize(rec("model.retry", { ...base, code: HOSTILE, billing: HOSTILE })),
    `attempt 1 failed (${HOSTILE}); next attempt in 500 ms: ${HOSTILE}`, "an unknown billing value is left out");
  assert.equal(api.summarize(rec("model.retry", { ...base, attempt: HOSTILE, status: HOSTILE, billing: "unknown", assumedCostMicros: HOSTILE, delayMs: HOSTILE })),
    `attempt ${HOSTILE} failed (model_transient), charged unknown (assumed); next attempt in –: ${HOSTILE}`, "hostile values render as text");
  assert.equal(api.typeClass("model.retry"), "t-model");
});

test("model.failed shows the attempts and an assumed charge when the record has them", () => {
  const { api } = loadHelpers();
  const error = { code: "model_failed", message: HOSTILE };
  assert.equal(api.summarize(rec("model.failed", { model: "m", error })), `m failed: model_failed: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.failed", { model: "m", error, attempts: 1 })), `m failed after 1 attempt: model_failed: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.failed", { model: HOSTILE, error, attempts: 5, assumedCostMicros: 1500 })),
    `${HOSTILE} failed after 5 attempts, charged $0.0015 (assumed): model_failed: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.failed", { model: "m", error, attempts: 2, assumedCostMicros: null })),
    `m failed after 2 attempts, charged unknown (assumed): model_failed: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.failed", { model: "m", error, attempts: HOSTILE })), `m failed: model_failed: ${HOSTILE}`);
  assert.equal(api.summarize(rec("model.failed", { model: "m", error, attempts: 2, assumedCostMicros: HOSTILE })),
    `m failed after 2 attempts, charged unknown (assumed): model_failed: ${HOSTILE}`);
});

test("message.undelivered and a rejected late message read as one line with the reason", () => {
  const { api } = loadHelpers();
  assert.equal(api.summarize(rec("message.undelivered", { commandId: HOSTILE, reason: HOSTILE })), `message ${HOSTILE} not delivered: ${HOSTILE}`);
  const late = "the run had already finished its work; the message was not delivered";
  assert.equal(api.summarize(rec("command.rejected", { commandId: "cmd_1", command: { type: "message", text: HOSTILE }, reason: late })),
    `message: ${HOSTILE} — rejected: ${late}`);
  assert.equal(typeof api.summarize(rec("message.undelivered", null)), "string");
});

test("the Learning tab shows a promoted workflow with its version, as text, and nothing for an unpromoted item", () => {
  const { api, document } = loadHelpers();
  const before = document.created.length;
  const pinned = api.promotedWorkflowLine({ promotedWorkflow: HOSTILE, promotedWorkflowVersion: 2 });
  assert.ok(pinned !== null);
  assert.equal(pinned.textContent, `Promoted to workflow ${HOSTILE} v2`);
  const link = pinned.all().find((e) => e.tagName === "A");
  assert.equal(link?.attributes.get("href"), `#/workflows/${encodeURIComponent(HOSTILE)}`);
  assert.equal(api.promotedWorkflowLine({ promotedWorkflow: "skill-deploy-01abc", promotedWorkflowVersion: null })?.textContent,
    "Promoted to workflow skill-deploy-01abc", "a pointer without a version (written before round 3)");
  assert.equal(api.promotedWorkflowLine({ promotedWorkflow: "w", promotedWorkflowVersion: HOSTILE })?.textContent, "Promoted to workflow w");
  assert.equal(api.promotedWorkflowLine({ promotedWorkflow: null, promotedWorkflowVersion: null }), null);
  assert.equal(api.promotedWorkflowLine(null), null);
  const made = document.created.slice(before).map((e) => e.tagName);
  assert.deepEqual([...new Set(made)].sort(), ["A", "P"]);
});

// ------------------------------------------------------------------ booting the page in a fake browser

interface FetchCall { url: string; init: { method: string; headers: Record<string, string> } }

async function bootPage(options: { hash: string; respond: (url: string) => { status: number; body: unknown } }): Promise<{
  main: FakeElement; storage: Map<string, string>; calls: FetchCall[]; replaced: string[]; document: FakeDocument; location: { hash: string };
}> {
  const top = new FakeElement("header", null);
  const main = new FakeElement("main", null);
  const document = fakeDocument({ top, main });
  const storage = new Map<string, string>();
  const calls: FetchCall[] = [];
  const replaced: string[] = [];
  const location = { hash: options.hash, pathname: "/", search: "" };
  const context: Record<string, unknown> = {
    document, location, TextDecoder, URLSearchParams, AbortController, console,
    history: { replaceState: (_s: unknown, _t: unknown, url: string) => {
      replaced.push(url);
      location.hash = url.slice(url.indexOf("#"));
    } },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined,
    addEventListener: () => undefined,
    fetch: async (url: string, init: FetchCall["init"]) => {
      calls.push({ url, init });
      const reply = options.respond(url);
      const text = JSON.stringify(reply.body);
      return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: { get: () => "application/json" }, text: async () => text };
    },
  };
  context["window"] = context;
  vm.createContext(context);
  vm.runInContext(inlineScript(), context, { filename: "console-script.js" });
  for (const listener of document.listeners.get("DOMContentLoaded") ?? []) listener({});
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return { main, storage, calls, replaced, document, location };
}

const EMPTY_API = (hostileTitle: string) => (url: string): { status: number; body: unknown } => {
  if (url.startsWith("/v1/pendings")) {
    return { status: 200, body: { pendings: [{ id: "pnd_1", runId: "run_<b>", agentId: "a1", kind: "question", stepKey: "t1", title: hostileTitle,
      detail: { question: hostileTitle, choices: [] }, status: "open", resolution: null, createdAt: 0, resolvedAt: null }], nextCursor: null } };
  }
  if (url.startsWith("/v1/learning")) return { status: 200, body: { items: [] } };
  if (url.startsWith("/v1/runs")) return { status: 200, body: { runs: [], nextCursor: null } };
  if (url.startsWith("/v1/usage")) return { status: 200, body: { groupBy: "day", rows: [] } };
  return { status: 404, body: { error: { code: "not_found", message: "no" } } };
};

test("on load the #token= fragment is stored, removed from the address bar and sent only as a header", async () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const page = await bootPage({ hash: "#token=s3cret%2Bx", respond: EMPTY_API(hostile) });
  assert.equal(page.storage.get("runwright.token"), "s3cret+x");
  assert.deepEqual(page.replaced, ["/#/"]);
  assert.equal(page.location.hash, "#/");
  assert.ok(page.calls.length >= 7, `home loads its panels (${page.calls.length} calls)`);
  for (const call of page.calls) {
    assert.ok(call.url.startsWith("/v1/"), call.url);
    assert.equal(call.url.includes("s3cret"), false);
    assert.equal(call.init.headers["Authorization"], "Bearer s3cret+x");
  }
  const paths = page.calls.map((c) => c.url);
  assert.ok(paths.includes("/v1/pendings?status=open&limit=200"));
  assert.ok(paths.includes("/v1/learning?status=held"));
  assert.ok(paths.includes("/v1/runs?status=failed&limit=20"));
  assert.ok(paths.includes("/v1/runs?status=running%2Cqueued%2Cwaiting%2Cpaused&limit=50"));
  assert.ok(paths.includes("/v1/usage?groupBy=agent") && paths.includes("/v1/usage?groupBy=model"));
  assert.ok(paths.some((p) => /^\/v1\/usage\?groupBy=day&from=\d+$/.test(p)));
  const text = page.main.textContent;
  for (const expected of ["Needs you", "Failed", "Running", "Cost", "No failed runs", "Nothing is running", "No usage yet", hostile]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.equal(page.main.all().some((e) => e.tagName === "IMG" || e.tagName === "SCRIPT"), false);
  const runLinks = page.main.all().filter((e) => e.tagName === "A").map((e) => e.attributes.get("href"));
  assert.ok(runLinks.includes("#/runs/run_%3Cb%3E"));
  assert.ok(runLinks.every((href) => href?.startsWith("#/")));
});

test("a 401 clears the token and shows the sign-in view", async () => {
  const page = await bootPage({ hash: "#token=wrong", respond: () => ({ status: 401, body: { error: { code: "unauthorized", message: "no" } } }) });
  assert.equal(page.storage.has("runwright.token"), false);
  assert.match(page.main.textContent, /Sign in/);
  assert.match(page.main.textContent, /did not accept the token/);
});

test("without a token the page shows sign-in and makes no request", async () => {
  const page = await bootPage({ hash: "", respond: EMPTY_API("x") });
  assert.equal(page.calls.length, 0);
  assert.match(page.main.textContent, /Sign in/);
});

// ------------------------------------------------------------------ served by the real server

test("the real server serves the page at / with its CSP", async (t) => {
  const base = await startTestServer(t);
  const server = createServer({ ...base.deps, consolePath: CONSOLE_PATH });
  const { url } = await server.listen();
  t.after(() => server.close());
  const response = await fetch(`${url}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self'/);
  const text = await response.text();
  assert.equal(text, PAGE);
  for (const name of ["Needs you", "Failed", "Running", "Cost"]) assert.ok(text.includes(name), name);
});

// ------------------------------------------------------------------ "what needs you" pages through every pending
// (finding R09D-spec-07: one request of 200, the rest never shown)

/** An API whose open pendings come in pages of the requested size, `total` of them, oldest first. */
function pagedPendings(total: number): (url: string) => { status: number; body: unknown } {
  return (url: string) => {
    if (!url.startsWith("/v1/pendings")) return EMPTY_API("x")(url);
    const params = new URL(url, "http://console.test").searchParams;
    const start = Number(params.get("cursor") ?? "0");
    const size = Number(params.get("limit"));
    const end = Math.min(total, start + size);
    const pendings = [];
    for (let i = start; i < end; i++) {
      pendings.push({ id: `pnd_${i}`, runId: `run_${i}`, agentId: "a1", kind: "question", stepKey: "t1", title: `Question ${i}`,
        detail: { question: `Question ${i}`, choices: [] }, status: "open", resolution: null, createdAt: i, resolvedAt: null });
    }
    return { status: 200, body: { pendings, nextCursor: end < total ? String(end) : null } };
  };
}

function needsPanel(main: FakeElement): FakeElement {
  const panel = main.all().find((e) => e.tagName === "SECTION" && e.attributes.get("aria-label") === "Needs you");
  assert.ok(panel !== undefined, "the Needs you panel");
  return panel;
}

const NOTICE = "Showing the oldest 2000; more are waiting.";

test("what needs you follows nextCursor and shows every open pending", async () => {
  const page = await bootPage({ hash: "#token=t", respond: pagedPendings(450) });
  const requests = page.calls.map((c) => c.url).filter((u) => u.startsWith("/v1/pendings"));
  assert.deepEqual(requests, ["/v1/pendings?status=open&limit=200", "/v1/pendings?status=open&limit=200&cursor=200", "/v1/pendings?status=open&limit=200&cursor=400"]);
  const panel = needsPanel(page.main);
  const text = panel.textContent;
  for (const i of [0, 199, 200, 449]) assert.ok(text.includes(`Question ${i}`), `pending ${i} is shown`);
  assert.equal(text.includes(NOTICE), false, "no notice when everything is shown");
  assert.ok(inlineScript().includes("nextCursor"));
});

test("what needs you stops at 2000 pendings and says more are waiting", async () => {
  const page = await bootPage({ hash: "#token=t", respond: pagedPendings(2300) });
  const requests = page.calls.map((c) => c.url).filter((u) => u.startsWith("/v1/pendings"));
  assert.equal(requests.length, 10, "ten pages of 200");
  const panel = needsPanel(page.main);
  const text = panel.textContent;
  assert.ok(text.includes(NOTICE), "the cap is visible");
  assert.ok(text.indexOf(NOTICE) < text.indexOf("Question 0"), "the notice is above the list");
  assert.ok(text.includes("Question 1999"));
  assert.equal(text.includes("Question 2000"), false);
  const exactly = await bootPage({ hash: "#token=t", respond: pagedPendings(2000) });
  assert.equal(needsPanel(exactly.main).textContent.includes(NOTICE), false, "exactly 2000: nothing more is waiting");
});

test("the Failed and Running panels say when they show one page of a longer list", async () => {
  const page = await bootPage({ hash: "#token=t", respond: (url) => (url.startsWith("/v1/runs")
    ? { status: 200, body: { runs: [], nextCursor: "c1" } }
    : EMPTY_API("x")(url)) });
  const text = page.main.textContent;
  assert.ok(text.includes("The 20 most recent failures."));
  assert.ok(text.includes("The newest 50 of more."));
  const quiet = await bootPage({ hash: "#token=t", respond: EMPTY_API("x") });
  assert.equal(quiet.main.textContent.includes("most recent failures"), false);
});

// ------------------------------------------------------------------ only the current selection updates the page
// (finding R13D-server-02: a late response of a superseded request overwrote the newer selection)

interface HeldRequest {
  url: string;
  signal: AbortSignal | undefined;
  respond(status: number, body: unknown): void;
  respondWith(response: unknown): void;
}

interface ControlledPage {
  main: FakeElement;
  held: HeldRequest[];
  calls: string[];
  /** Every request with its method and parsed JSON body (null without one), in order. */
  requests: { url: string; method: string; body: unknown }[];
  /** Callbacks given to setTimeout, with their delays; the test runs them. */
  timers: { fn: () => void; ms: number }[];
  /** Callbacks given to setInterval (the page's refresh ticks); the test runs them. */
  intervals: (() => void)[];
  /** The held request whose URL matches, oldest first. */
  take(match: (url: string) => boolean): HeldRequest;
  navigate(hash: string): void;
  settle(): Promise<void>;
}

function jsonReply(status: number, body: unknown): unknown {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => "application/json" }, text: async () => text };
}

/**
 * Boots the page signed in at `hash`. `auto` answers a request at once (return a reply) or holds it (return
 * null) for the test to answer later, in any order. A held request is not rejected when its signal aborts, so a
 * late answer really arrives and the page's own generation check is what is tested.
 */
async function bootControlled(hash: string, auto: (url: string) => { status: number; body: unknown } | null): Promise<ControlledPage> {
  const top = new FakeElement("header", null);
  const main = new FakeElement("main", null);
  const document = fakeDocument({ top, main });
  const storage = new Map<string, string>([["runwright.token", "t"]]);
  const held: HeldRequest[] = [];
  const calls: string[] = [];
  const requests: { url: string; method: string; body: unknown }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const intervals: (() => void)[] = [];
  const windowListeners = new Map<string, Listener[]>();
  const location = { hash, pathname: "/", search: "" };
  const context: Record<string, unknown> = {
    document, location, TextDecoder, URLSearchParams, AbortController, console,
    history: { replaceState: () => undefined },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => undefined, clearTimeout: () => undefined,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    addEventListener: (type: string, listener: Listener) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    fetch: (url: string, init: { signal?: AbortSignal; method?: string; body?: string }) => {
      calls.push(url);
      requests.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      const reply = auto(url);
      if (reply !== null) return Promise.resolve(jsonReply(reply.status, reply.body));
      return new Promise((resolve) => {
        held.push({
          url, signal: init.signal,
          respond: (status, body) => resolve(jsonReply(status, body)),
          respondWith: (response) => resolve(response),
        });
      });
    },
  };
  context["window"] = context;
  vm.createContext(context);
  vm.runInContext(inlineScript(), context, { filename: "console-script.js" });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  for (const listener of document.listeners.get("DOMContentLoaded") ?? []) listener({});
  await settle();
  return {
    main, held, calls, requests, timers, intervals, settle,
    take(match) {
      const index = held.findIndex((r) => match(r.url));
      assert.ok(index >= 0, `a held request matching ${match.toString()}; held: ${held.map((r) => r.url).join(", ")}`);
      return held.splice(index, 1)[0] as HeldRequest;
    },
    navigate(next) {
      location.hash = next;
      for (const listener of windowListeners.get("hashchange") ?? []) listener({});
    },
  };
}

function fire(el: FakeElement, type: string, event: unknown = { preventDefault: () => undefined }): void {
  const listeners = el.listeners.get(type) ?? [];
  assert.ok(listeners.length > 0, `${el.tagName} has a ${type} listener`);
  for (const listener of listeners) listener(event);
}

function byTag(root: FakeElement, tag: string): FakeElement[] {
  return root.all().filter((e) => e.tagName === tag);
}

function button(root: FakeElement, text: string, index = 0): FakeElement {
  const found = byTag(root, "BUTTON").filter((b) => b.textContent === text);
  assert.ok(found.length > index, `button ${text} #${index}`);
  return found[index] as FakeElement;
}

function runRow(id: string): unknown {
  return { id, agentId: "a1", status: "completed", usage: { costMicros: 0, costUnknown: false, toolCalls: 0 }, createdAt: 0 };
}

test("runs list: a late response of a superseded filter is dropped and Load more uses the newest filter's cursor", async () => {
  const page = await bootControlled("#/runs", (url) => (url === "/v1/runs?limit=50" ? { status: 200, body: { runs: [runRow("run_all")], nextCursor: "c_all" } } : null));
  const select = byTag(page.main, "SELECT")[0] as FakeElement & { value: string };
  const tbody = byTag(page.main, "TBODY")[0] as FakeElement;
  assert.ok(tbody.textContent.includes("run_all"));
  select.value = "failed";
  fire(select, "change");
  select.value = "completed";
  fire(select, "change");
  const failed = page.take((u) => u.includes("status=failed"));
  const completed = page.take((u) => u.includes("status=completed"));
  assert.equal(failed.signal?.aborted, true, "the superseded request was aborted");
  completed.respond(200, { runs: [runRow("run_done")], nextCursor: "c_done" });
  await page.settle();
  failed.respond(200, { runs: [runRow("run_bad")], nextCursor: "c_bad" });
  await page.settle();
  assert.ok(tbody.textContent.includes("run_done"));
  assert.equal(tbody.textContent.includes("run_bad"), false, "no row of the old filter");
  assert.equal(tbody.textContent.includes("run_all"), false);
  fire(button(page.main, "Load more"), "click");
  const next = page.take((u) => u.startsWith("/v1/runs?"));
  assert.equal(next.url, "/v1/runs?status=completed&limit=50&cursor=c_done");
});

test("runs list: a filter change supersedes a pending Load more, whose late page is not appended", async () => {
  const page = await bootControlled("#/runs", (url) => (url === "/v1/runs?limit=50" ? { status: 200, body: { runs: [runRow("run_first")], nextCursor: "c1" } } : null));
  const select = byTag(page.main, "SELECT")[0] as FakeElement & { value: string };
  const tbody = byTag(page.main, "TBODY")[0] as FakeElement;
  fire(button(page.main, "Load more"), "click");
  const more = page.take((u) => u.includes("cursor=c1"));
  select.value = "failed";
  fire(select, "change");
  const failed = page.take((u) => u.includes("status=failed"));
  assert.equal(more.signal?.aborted, true);
  failed.respond(200, { runs: [runRow("run_failed")], nextCursor: null });
  await page.settle();
  more.respond(200, { runs: [runRow("run_late")], nextCursor: "c2" });
  await page.settle();
  assert.ok(tbody.textContent.includes("run_failed"));
  assert.equal(tbody.textContent.includes("run_late"), false, "the late page was not appended");
  assert.equal((button(page.main, "Load more") as unknown as { hidden: boolean }).hidden, true, "no cursor of the superseded page");
});

test("agent page: a late Revisions response does not overwrite the Definition tab opened after it", async () => {
  const definition = { name: "DEFINITION-NAME", model: { provider: "scripted", name: "m" }, tools: [] };
  const page = await bootControlled("#/agents/a1", (url) => (url === "/v1/agents/a1"
    ? { status: 200, body: { agent: { id: "a1", currentRevision: 2, updatedAt: 0 }, revision: { revision: 2, definition } } }
    : null));
  fire(button(page.main, "Revisions"), "click");
  const revisions = page.take((u) => u.endsWith("/revisions"));
  fire(button(page.main, "Definition"), "click");
  await page.settle();
  revisions.respond(200, { revisions: [{ revision: 1, createdAt: 0, definitionHash: "REVISIONHASH0000", definition: {} }] });
  await page.settle();
  const text = page.main.textContent;
  assert.ok(text.includes("DEFINITION-NAME"));
  assert.equal(text.includes("REVISIONHAS"), false, "the revisions table did not replace the definition");
  assert.equal(revisions.signal?.aborted, true);
  fire(button(page.main, "Learning"), "click");
  const items = page.take((u) => u.startsWith("/v1/learning?"));
  const metrics = page.take((u) => u.endsWith("/learning/metrics"));
  fire(button(page.main, "Revisions"), "click");
  const again = page.take((u) => u.endsWith("/revisions"));
  again.respond(200, { revisions: [{ revision: 1, createdAt: 0, definitionHash: "SECONDHASH000000", definition: {} }] });
  await page.settle();
  items.respond(200, { items: [] });
  metrics.respond(200, { metrics: { before: {}, after: {} } });
  await page.settle();
  assert.ok(page.main.textContent.includes("SECONDHASH00"), "the newest tab is shown");
  assert.equal(page.main.textContent.includes("Nothing learned yet"), false, "the superseded Learning load did not paint");
});

/** A run page whose run, timeline, learning and file list answer at once; file contents are held. */
function runPageApi(files: string[]): (url: string) => { status: number; body: unknown } | null {
  return (url) => {
    if (url === "/v1/runs/r1") return { status: 200, body: { run: { id: "r1", agentId: "a1", status: "completed", usage: {}, limits: {}, input: {} }, pendings: [] } };
    if (url.startsWith("/v1/runs/r1/timeline")) return { status: 200, body: { records: [], nextAfter: null, archived: true } };
    if (url === "/v1/runs/r1/learning") return { status: 200, body: { uses: [] } };
    if (url.startsWith("/v1/runs/r1/files?")) return { status: 200, body: { files: files.map((path) => ({ path, size: 3, modifiedAt: 0 })), nextCursor: null } };
    return null;
  };
}

/** A raw file response whose body is `chunks`, counting how many were pulled and whether it was cancelled. */
function fileReply(chunks: Uint8Array[], headers: Record<string, string>): { response: unknown; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const response = {
    status: 200, ok: true,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (cancelled || pulled >= chunks.length) return { done: true, value: undefined };
          pulled += 1;
          return { done: false, value: chunks[pulled - 1] };
        },
        cancel: async () => {
          cancelled = true;
        },
      }),
      cancel: async () => {
        cancelled = true;
      },
    },
  };
  return { response, pulled: () => pulled, cancelled: () => cancelled };
}

const TEXT_HEADERS = (length: number): Record<string, string> => ({ "content-type": "text/plain; charset=utf-8", "content-length": String(length) });

function viewerText(main: FakeElement): string {
  return byTag(main, "PRE").map((p) => p.textContent).join("|");
}

test("file viewer: clicking View on A then on B, answered B then A, shows B", async () => {
  const page = await bootControlled("#/runs/r1", runPageApi(["A.txt", "B.txt"]));
  fire(button(page.main, "View", 0), "click");
  fire(button(page.main, "View", 1), "click");
  const a = page.take((u) => u.endsWith("/files/A.txt"));
  const b = page.take((u) => u.endsWith("/files/B.txt"));
  assert.equal(a.signal?.aborted, true, "the first selection's request was aborted");
  b.respondWith(fileReply([new TextEncoder().encode("CONTENT-B")], TEXT_HEADERS(9)).response);
  await page.settle();
  const late = fileReply([new TextEncoder().encode("CONTENT-A")], TEXT_HEADERS(9));
  a.respondWith(late.response);
  await page.settle();
  assert.ok(viewerText(page.main).includes("CONTENT-B"));
  assert.equal(viewerText(page.main).includes("CONTENT-A"), false);
  assert.ok(page.main.textContent.includes("B.txt"));
  assert.equal(page.main.all().some((e) => e.attributes.get("role") === "alert"), false, "no error box for the superseded request");
});

test("file preview: a 1 MiB file is read only up to 200 KB, a cut character is dropped, and the notice uses Content-Length", async () => {
  const page = await bootControlled("#/runs/r1", runPageApi(["big.txt", "small.txt"]));
  const bytes = new TextEncoder().encode("a" + "é".repeat(524_287) + "a");
  assert.equal(bytes.length, 1024 * 1024);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 16 * 1024) chunks.push(bytes.subarray(i, i + 16 * 1024));
  fire(button(page.main, "View", 0), "click");
  const big = fileReply(chunks, TEXT_HEADERS(bytes.length));
  page.take((u) => u.endsWith("/files/big.txt")).respondWith(big.response);
  await page.settle();
  assert.equal(big.cancelled(), true, "the reader was cancelled");
  assert.ok(big.pulled() <= 14, `pulled ${big.pulled()} of ${chunks.length} chunks`);
  const shown = viewerText(page.main);
  assert.equal(shown, "a" + "é".repeat(102_399), "exactly the first 200 KB, without the character cut at the end");
  assert.equal(shown.includes("�"), false);
  assert.ok(page.main.textContent.includes("Showing the first 200 KB of 1,048,576 bytes."));

  fire(button(page.main, "View", 1), "click");
  const small = fileReply([new TextEncoder().encode("hel"), new TextEncoder().encode("lo é")], TEXT_HEADERS(8));
  page.take((u) => u.endsWith("/files/small.txt")).respondWith(small.response);
  await page.settle();
  assert.equal(viewerText(page.main), "hello é");
  assert.equal(page.main.textContent.includes("Showing the first"), false, "no notice for a short file");
  assert.equal(small.cancelled(), false);
});

test("file preview: leaving the run page aborts the file request", async () => {
  const page = await bootControlled("#/runs/r1", (url) => (url.startsWith("/v1/runs/r1/files/") ? null : runPageApi(["A.txt"])(url) ?? { status: 200, body: {} }));
  fire(button(page.main, "View", 0), "click");
  const request = page.take((u) => u.endsWith("/files/A.txt"));
  assert.equal(request.signal?.aborted, false);
  page.navigate("#/agents");
  assert.equal(request.signal?.aborted, true);
});

test("run page: a forced reload superseded by a timeline-driven one still repaints the pendings a person was typing in", async () => {
  let runReads = 0;
  const question = { id: "pnd_q", runId: "r1", agentId: "a1", kind: "question", stepKey: "t1", title: "QUESTION-TITLE",
    detail: { question: "Which?", choices: [] }, status: "open", resolution: null, createdAt: 0, resolvedAt: null };
  const page = await bootControlled("#/runs/r1", (url) => {
    if (url === "/v1/runs/r1") {
      runReads += 1;
      return runReads === 1 ? { status: 200, body: { run: { id: "r1", agentId: "a1", status: "waiting", usage: {}, limits: {}, input: {} }, pendings: [question] } } : null;
    }
    if (url.startsWith("/v1/runs/r1/timeline")) return { status: 200, body: { records: [{ runId: "r1", seq: 1, epoch: 1, ts: 0, type: "run.created", key: null, data: {} }], nextAfter: null, archived: false } };
    if (url === "/v1/pendings/pnd_q/answer") return { status: 202, body: { command: {} } };
    if (url === "/v1/runs/r1/events") return null;
    return runPageApi([])(url);
  });
  const panel = page.main.all().find((e) => e.tagName === "SECTION" && e.attributes.get("aria-label") === "Needs you") as FakeElement;
  assert.ok(panel.textContent.includes("QUESTION-TITLE"));
  fire(panel, "input", {});
  const form = byTag(panel, "FORM")[0] as FakeElement;
  const answer = byTag(form, "INPUT")[0] as FakeElement & { value: string };
  answer.value = "this one";
  fire(form, "submit");
  await page.settle();
  const after = page.timers.find((timer) => timer.ms === 800);
  const debounce = page.timers.find((timer) => timer.ms === 300);
  assert.ok(after !== undefined && debounce !== undefined, "the reload after the answer and the timeline's debounce were scheduled");
  after.fn();
  const forced = page.take((u) => u === "/v1/runs/r1");
  debounce.fn();
  const unforced = page.take((u) => u === "/v1/runs/r1");
  assert.equal(forced.signal?.aborted, true);
  unforced.respond(200, { run: { id: "r1", agentId: "a1", status: "running", usage: {}, limits: {}, input: {} }, pendings: [] });
  await page.settle();
  assert.ok(panel.textContent.includes("Nothing needs you on this run"), "the answered pending is gone although the panel had input");
});

// ------------------------------------------------------------------ the run controls follow the loaded limits (R15D-server-01)

/** What a browser shows for an input: its value property once set, else its value attribute. */
function shownValue(input: FakeElement): string {
  const value = (input as unknown as { value?: string }).value;
  return value !== undefined ? value : input.getAttribute("value") ?? "";
}

function shownChecked(input: FakeElement): boolean {
  const checked = (input as unknown as { checked?: boolean }).checked;
  return checked !== undefined ? checked : input.attributes.has("checked");
}

function labelled(root: FakeElement, label: string): FakeElement & { value: string } {
  const found = byTag(root, "INPUT").filter((e) => e.attributes.get("aria-label") === label);
  assert.equal(found.length, 1, `one input labelled ${label}`);
  return found[0] as FakeElement & { value: string };
}

/**
 * A run page whose run stays `running` and whose n-th load of the run answers `limits[n]` (the last one after
 * that). Everything else answers at once; the event stream is held.
 */
async function limitsPage(limits: Record<string, unknown>[]): Promise<{ page: ControlledPage; reads: () => number; tick: () => Promise<void> }> {
  let reads = 0;
  const page = await bootControlled("#/runs/r1", (url) => {
    if (url === "/v1/runs/r1") {
      const current = limits[Math.min(reads, limits.length - 1)];
      reads += 1;
      return { status: 200, body: { run: { id: "r1", agentId: "a1", status: "running", usage: {}, limits: current, input: {} }, pendings: [] } };
    }
    if (url === "/v1/runs/r1/limits") return { status: 202, body: { command: {} } };
    if (url.startsWith("/v1/runs/r1/timeline")) return { status: 200, body: { records: [], nextAfter: null, archived: false } };
    if (url === "/v1/runs/r1/events") return null;
    return runPageApi([])(url);
  });
  const tick = async (): Promise<void> => {
    for (const interval of page.intervals) interval();
    await page.settle();
  };
  return { page, reads: () => reads, tick };
}

function limitsForm(main: FakeElement): FakeElement {
  const form = byTag(main, "FORM").find((f) => f.textContent.includes("Raise limits"));
  assert.ok(form !== undefined, "the limits form");
  return form;
}

function limitBodies(page: ControlledPage): unknown[] {
  return page.requests.filter((r) => r.url === "/v1/runs/r1/limits").map((r) => r.body);
}

const BASE = { maxCostMicros: 500_000, maxToolCalls: 10, maxTurns: 3, allowUnpriced: false };

test("(R15D-server-01) a load that brings allowUnpriced: true checks the box, and unchecking it sends allowUnpriced: false", async () => {
  const { page, reads, tick } = await limitsPage([BASE, { ...BASE, allowUnpriced: true }]);
  const unpriced = byTag(page.main, "INPUT").find((e) => e.attributes.get("id") === "run-unpriced") as FakeElement & { checked: boolean };
  assert.equal(shownChecked(unpriced), false);
  await tick();
  assert.equal(reads(), 2, "the refresh tick loaded the run again");
  assert.equal(shownChecked(unpriced), true, "the box shows the loaded permission");
  unpriced.checked = false;
  fire(unpriced, "change", {});
  fire(limitsForm(page.main), "submit");
  await page.settle();
  assert.deepEqual(limitBodies(page), [{ allowUnpriced: false }], "the permission the form now knows about is revoked");
  assert.equal(page.main.textContent.includes("Nothing changed."), false);
});

test("(R15D-server-01) a limits change that arrives one load after the forced reload updates the cap input", async () => {
  const { page, reads, tick } = await limitsPage([BASE, BASE, { ...BASE, maxCostMicros: 2_000_000 }]);
  const cap = labelled(page.main, "Cost cap in US dollars");
  assert.equal(shownValue(cap), "0.5");
  cap.value = "2";
  fire(cap, "input", {});
  fire(limitsForm(page.main), "submit");
  await page.settle();
  assert.deepEqual(limitBodies(page), [{ maxCostMicros: 2_000_000 }]);
  assert.equal(reads(), 2, "the 202 was followed by a forced reload, which still has the old cap");
  assert.equal(shownValue(labelled(page.main, "Cost cap in US dollars")), "0.5", "submitting ends the edit: the input shows what was loaded");
  await tick();
  assert.equal(reads(), 3);
  assert.equal(shownValue(labelled(page.main, "Cost cap in US dollars")), "2", "the cap the runner applied is shown");
  fire(limitsForm(page.main), "submit");
  await page.settle();
  assert.equal(limitBodies(page).length, 1, "nothing is sent: the form compares against the new baseline");
  assert.ok(page.main.textContent.includes("Nothing changed."));
});

test("(R15D-server-01) an input the person edited is kept across loads and is sent against the newest baseline", async () => {
  const { page, tick } = await limitsPage([BASE, { ...BASE, maxToolCalls: 12, maxTurns: 5 }, { ...BASE, maxToolCalls: 12, maxTurns: 5 }, { ...BASE, maxToolCalls: 12, maxTurns: 6 }]);
  const turns = labelled(page.main, "Turn limit");
  const tools = labelled(page.main, "Tool-call limit");
  turns.value = "9";
  fire(turns, "input", {});
  await tick();
  assert.equal(shownValue(turns), "9", "what the person typed is not overwritten");
  assert.equal(shownValue(tools), "12", "an input nobody edited shows the loaded value");
  turns.value = "5";
  fire(turns, "input", {});
  await tick();
  assert.equal(shownValue(turns), "5", "typed and loaded agree");
  await tick();
  assert.equal(shownValue(turns), "6", "once the typed value was loaded the input follows the loads again");
  turns.value = "9";
  fire(turns, "input", {});
  fire(limitsForm(page.main), "submit");
  await page.settle();
  assert.deepEqual(limitBodies(page), [{ maxTurns: 9 }], "only the edited limit, compared against the newest baseline");
});

test("(R15D-server-01) the status buttons still follow the run's status", async () => {
  let reads = 0;
  const statuses = ["running", "paused", "paused", "completed"];
  const page = await bootControlled("#/runs/r1", (url) => {
    if (url === "/v1/runs/r1") {
      const status = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      return { status: 200, body: { run: { id: "r1", agentId: "a1", status, usage: {}, limits: BASE, input: {} }, pendings: [] } };
    }
    if (url.startsWith("/v1/runs/r1/timeline")) return { status: 200, body: { records: [], nextAfter: null, archived: false } };
    if (url === "/v1/runs/r1/events") return null;
    return runPageApi([])(url);
  });
  const tick = async (): Promise<void> => {
    for (const interval of page.intervals) interval();
    await page.settle();
  };
  assert.equal(button(page.main, "Pause").attributes.has("disabled"), false);
  assert.equal(button(page.main, "Resume").attributes.has("disabled"), true);
  const turns = labelled(page.main, "Turn limit");
  turns.value = "8";
  fire(turns, "input", {});
  await tick();
  assert.equal(button(page.main, "Pause").attributes.has("disabled"), true, "paused: Pause is off");
  assert.equal(button(page.main, "Resume").attributes.has("disabled"), false, "paused: Resume is on");
  assert.equal(shownValue(labelled(page.main, "Turn limit")), "8", "a status change keeps what was typed");
  await tick();
  await tick();
  assert.ok(page.main.textContent.includes("This run is finished."));
  assert.equal(byTag(page.main, "FORM").some((f) => f.textContent.includes("Raise limits")), false);
});

test("(R15D-server-02) the agent page's Workflow tab graphs the embedded workflow with embedded: true", async () => {
  const workflow = { format: "runwright.workflow/v1", name: "helper", root: { id: "sub", kind: "call", workflow: "helper", input: {} } };
  const definition = { name: "Embeds", model: { provider: "scripted", name: "m" }, tools: [], workflow };
  const page = await bootControlled("#/agents/a1", (url) => {
    if (url === "/v1/agents/a1") return { status: 200, body: { agent: { id: "a1", currentRevision: 1, updatedAt: 0 }, revision: { revision: 1, definition } } };
    if (url === "/v1/workflows/graph") {
      return { status: 200, body: { graph: { nodes: [{ id: "sub", kind: "call", label: "helper" }], edges: [] }, mermaid: "flowchart TD\n" } };
    }
    return null;
  });
  fire(button(page.main, "Workflow"), "click");
  await page.settle();
  const graphs = page.requests.filter((r) => r.url === "/v1/workflows/graph");
  assert.equal(graphs.length, 1);
  assert.deepEqual(graphs[0]?.body, { document: workflow, embedded: true });
  assert.equal(graphs[0]?.method, "POST");
});
