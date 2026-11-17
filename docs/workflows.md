# Workflow language reference (`runwright.workflow/v1`)

A workflow is a JSON document that describes repeatable work as a tree of typed nodes: tool calls, model steps
with typed output, decisions with a confidence, branches, bounded parallel maps and loops, sub-workflow calls, a
hand-off to an agent loop and a wait for a person. It runs durably on the same step primitives as the agent loop
(see [architecture.md](architecture.md#durable-steps-and-replay)), so the owning agent's tool policy, caps and
budgets apply inside it.

An agent runs a workflow instead of its loop when its definition has a `workflow` document. The run's `data` is
the workflow input and the workflow's `result` is the run output.

## Document shape

```json
{
  "format": "runwright.workflow/v1",
  "name": "triage",
  "description": "Classify a ticket; unsure ones go to an agent",
  "schemas": {
    "Input":  { "type": "object", "required": ["ticket"], "properties": { "ticket": { "type": "string" } } },
    "Output": { "type": "object", "required": ["urgent"], "properties": { "urgent": { "type": "boolean" } } }
  },
  "input": "Input",
  "output": "Output",
  "root": { "id": "main", "kind": "sequence", "steps": [
    { "id": "urgent", "kind": "decide", "question": "Is this urgent?\n{{input.ticket}}",
      "decision": { "type": "yes_no" },
      "lowConfidence": { "below": 0.7,
        "run": { "id": "review", "kind": "agent", "message": "Decide urgency: {{input.ticket}}", "maxTurns": 4,
                 "output": "Output" },
        "value": { "$ref": "fallback.data.urgent" } } }
  ] },
  "result": { "urgent": { "$ref": "steps.urgent.value" } }
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | exactly `"runwright.workflow/v1"` |
| `name` | yes | the workflow's name |
| `description` | no | free text |
| `schemas` | yes | named JSON Schemas (the [subset the project's validator supports](#schemas)) |
| `input` | yes | name of the input schema; the input is validated against it before the first node |
| `output` | yes | name of the output schema; the built `result` is validated against it |
| `workflows` | no | inline sub-workflows by name, for `call` nodes |
| `root` | yes | the top node |
| `result` | yes | an [expression](#references-and-templates) built after `root` finishes |

Unknown document fields are reported as warnings.

## Nodes

Every node has an `id` matching `^[a-z][a-z0-9_]{0,63}$`, unique in its document, a `kind`, an optional
`title` (used as the graph label) and an optional `deadlineMs`, accepted on every kind: it bounds each call of a
`tool`, `model` or `decide` node, the whole node on the composite kinds and `agent`, the time a person has to
answer on `wait`, and nothing on `fail` (see [Retry and deadlines](#retry-and-deadlines)). After a node runs, its
output is available as `steps.<id>`.

| Kind | Fields | Output (`steps.<id>`) |
|---|---|---|
| `tool` | `tool`, `args`, `idempotent?`, `onError?`, `deadlineMs?`, `retry?` | `{ok, content, data}` |
| `model` | `prompt`, `system?`, `output`, `deadlineMs?`, `retry?` | the typed answer: any JSON value its schema allows |
| `decide` | `question`, `decision`, `lowConfidence?`, `deadlineMs?`, `retry?` | `{value, confidence, reason, route, fallback}` |
| `branch` | `on`, `cases`, `default?`, `deadlineMs?` | output of the node that ran, or `null` |
| `sequence` | `steps`, `deadlineMs?` | output of the last step |
| `parallel` | `branches`, `deadlineMs?` | object: branch node id → its output |
| `map` | `over`, `as`, `concurrency`, `maxItems`, `run`, `deadlineMs?` | array of outputs, in input order |
| `loop` | `maxIterations`, `until`, `run`, `onLimit?`, `deadlineMs?` | `{iterations, completed, last}` |
| `call` | `workflow`, `input`, `deadlineMs?` | the sub-workflow's result |
| `agent` | `message`, `maxTurns`, `instructions?`, `tools?`, `output?`, `deadlineMs?` | `{text, data}` |
| `wait` | `question`, `choices?`, `deadlineMs?` | `{answer}` |
| `fail` | `message`, `deadlineMs?` | never returns: the workflow fails |

### `tool`

Calls a registered tool through the same path as an agent's tool call: policy, approval, tool-call budget,
argument validation against the tool's schema, the started/finished protocol. `args` is a map from argument name
to [expression](#references-and-templates): each argument is resolved on its own, and every name, `__proto__` and
`constructor` included, reaches the tool as an argument of that name. A `$ref` or `$literal` form in place of the
map is the validation error `shape` at `args` (`` `args` must be an object of argument expressions, not a reference
or a literal form ``), at save time and when the run starts; to pass the fields of a value, name each argument.
`ok` is false when the tool reported an error. With `onError: "fail"` (the default) an error fails
the node; with `"continue"` the node returns `{ok: false, ...}` and the workflow goes on. `content` and `data` are
the tool result as journalled, under the result size limit (`tools.resultBytes`): content over the limit is cut
with a note, and when the canonical JSON of `data` is over the limit, `data` is `null` and the content carries
the note `[data omitted: <bytes> bytes of structured data; saved to <path>]`, with the full data saved in the
workspace ([architecture.md](architecture.md#tool-calls-started-finished-interrupted)).

```json
{ "id": "save", "kind": "tool", "tool": "write_file",
  "args": { "path": "report.md", "content": "{{steps.summary.text}}" } }
```

### `model`

One model call with structured output. `prompt` and `system` are templates (`system` defaults to the agent's
instructions). `output` names a schema; the answer is validated against it (one automatic repair attempt), and
the typed answer is the node's output. The schema may describe any JSON value, not only an object: an array, a
string, a number, a boolean, `null` or a union of them works as well (see [Schemas](#schemas) for how such a schema
reaches the model). A reply that carries no structured output at all is an invalid answer and gets the repair
attempt; it is never read as `null`. The call uses purpose `step` and counts as a turn.

In a run of a learning agent that was given learned items, the system prompt is followed by the learning section
(`## Learned from earlier runs`, see [learning.md](learning.md#giving-items-to-the-next-run)) after a blank line,
whether `system` was written or defaulted. Without items the system prompt is exactly the agent's instructions or
the rendered `system`.

```json
{ "id": "summary", "kind": "model", "prompt": "Summarise:\n{{input.text}}", "output": "Summary" }
```

### `decide`

A typed decision with a confidence. `decision` is one of:

- `{"type": "yes_no"}` → `value` is a boolean;
- `{"type": "pick_one", "options": ["a", "b", ...]}` → `value` is one of the options (at least two, unique);
- `{"type": "score", "min": 0, "max": 10}` → `value` is a number in `[min, max]` (`min` and `max` finite numbers,
  `min < max`).

The model answers `{value, confidence, reason}` with `confidence` in `[0, 1]` (purpose `decision`, counts as a
turn). A value that does not fit the decision type fails the node. The system prompt is the agent's
instructions, followed by the learning section when the run was given learned items (as for `model`).

**Threshold rule.** `lowConfidence.below` is a finite number in `(0, 1]`. If `lowConfidence` is set and
`confidence < lowConfidence.below`, the node runs
`lowConfidence.run`, sets `route: "low_confidence"` and `fallback` to that node's output. If
`lowConfidence.value` is given, it is evaluated with `fallback` in scope and replaces `value`; it must fit the
decision type, else the node fails. Otherwise `route` is `"confident"` and `fallback` is `null`.

```json
{ "id": "lang", "kind": "decide", "question": "Which language is this?\n{{input.text}}",
  "decision": { "type": "pick_one", "options": ["en", "de", "fr"] },
  "lowConfidence": { "below": 0.6,
    "run": { "id": "ask_lang", "kind": "wait", "question": "Which language is: {{input.text}}", "choices": ["en", "de", "fr"] },
    "value": { "$ref": "fallback.answer" } } }
```

### `branch`

Evaluates `on` and runs the first case whose `when` (a literal JSON value) equals it (canonical JSON equality),
else `default`, else nothing (`null`).

```json
{ "id": "route", "kind": "branch", "on": { "$ref": "steps.lang.value" },
  "cases": [ { "when": "en", "run": { "id": "reply_en", "kind": "model", "prompt": "...", "output": "Reply" } } ],
  "default": { "id": "reply_other", "kind": "model", "prompt": "...", "output": "Reply" } }
```

### `sequence` and `parallel`

`sequence` runs `steps` in order. `parallel` runs `branches` concurrently and waits for all of them (a failing or
suspended branch does not abandon the others).

```json
{ "id": "both", "kind": "parallel", "branches": [
  { "id": "a", "kind": "tool", "tool": "read_file", "args": { "path": "a.txt" } },
  { "id": "b", "kind": "tool", "tool": "read_file", "args": { "path": "b.txt" } } ] }
```

### `map`

Runs `run` once per element of `over` (which must resolve to an array) with at most `concurrency` (1 to 64,
required) iterations in flight. `maxItems` (required, an integer from 0 to 1 000 000) is a hard bound: a longer
array fails the node. Inside
the body, `vars.<as>` is the element and `vars.<as>_index` its index; `steps.<id>` of a body node is this
iteration's value.

```json
{ "id": "each", "kind": "map", "over": { "$ref": "input.files" }, "as": "file", "concurrency": 4, "maxItems": 50,
  "run": { "id": "check", "kind": "tool", "tool": "read_file", "args": { "path": { "$ref": "vars.file" } } } }
```

### `loop`

Runs `run`, then evaluates `until` (a [condition](#conditions)); stops when it holds or after `maxIterations`
(required, an integer from 0 to 1 000 000). `loop.<id>.index` (0-based) and `loop.<id>.last` (the previous iteration's output) are in
scope. When the bound is reached first, `onLimit: "continue"` (the default) returns `completed: false`;
`"fail"` fails the node.

```json
{ "id": "retry_build", "kind": "loop", "maxIterations": 3,
  "until": { "eq": [ { "$ref": "steps.build.ok" }, true ] },
  "run": { "id": "build", "kind": "tool", "tool": "shell", "args": { "command": "npm test" }, "onError": "continue" } }
```

### `call`

Runs another workflow with `input` (an expression). The name is looked up in the document's inline `workflows`
first, then among saved workflows (the latest version at the time of the call, pinned in the journal so a later
save does not change a running call). The callee sees only its own `input` and `run`. Calls nest at most 16
deep, and the validator rejects call cycles (see [Saving and call cycles](#saving-and-call-cycles)).

```json
{ "id": "notify", "kind": "call", "workflow": "send-summary", "input": { "text": { "$ref": "steps.summary.text" } } }
```

### `agent`

Hands off to the agent loop: `message` (template) is the first message, `instructions` (template) replaces the
agent's instructions, `tools` restricts the hand-off to a subset of the agent's tools: the model is shown only those,
and a call to any other tool made inside the hand-off — by the loop itself, by a workflow it starts with
`run_workflow`, or by a nested hand-off — is refused and returned to the model as a denied result. `output` (a schema name) asks for a
typed final answer, and `maxTurns` (required, an integer from 1 to 10 000) bounds the loop. As for `model`, the output schema may describe
any JSON value, not only an object. Output: `{text, data}` (`data` is the typed answer, or `null` when the node
has no `output`). The loop's system prompt is built as for any agent run: the instructions, the learning
section when the run was given learned items, and the workspace note.

```json
{ "id": "investigate", "kind": "agent", "message": "Find why {{input.service}} is slow", "maxTurns": 8,
  "tools": ["read_file", "list_files"], "output": "Finding" }
```

### `wait`

Asks a person (`question` is a template, `choices` optional) and waits; the run shows a `question` pending.
Output: `{answer}`.

With `deadlineMs`, the question must be answered within that time of the node's start. When it is not, the
pending is closed as expired and the node fails with `deadline_exceeded`. The pending's `detail.expiresAt` is the
instant (ms since epoch). An answer that reaches the server before it counts even when the run resumes later
(see [Retry and deadlines](#retry-and-deadlines)).

```json
{ "id": "confirm", "kind": "wait", "question": "Send the reply to {{input.customer}}?", "choices": ["yes", "no"] }
```

### `fail`

Fails the workflow with `message` (a template). Steps after a `fail` in the same sequence are reported as
unreachable.

```json
{ "id": "stop", "kind": "fail", "message": "No data for {{input.customer}}" }
```

## References and templates

An expression is any JSON value. Inside it:

- `{"$ref": "<path>"}` is replaced by the referenced value, keeping its type. `{"$ref": "<path>", "default":
  <json>}` uses the default when the value is missing.
- `{"$literal": <json>}` is replaced by `<json>` untouched (nothing inside it is resolved).
- In a string, `{{<path>}}` is replaced by the value as text: strings as they are, other values as canonical
  JSON. A `{{` without a closing `}}` is plain text.

A **path** is dot-separated segments; a segment is an identifier (`[A-Za-z_][A-Za-z0-9_-]*`) or a non-negative
integer (an array index). Roots:

| Root | Value |
|---|---|
| `input` | the workflow's input |
| `steps.<nodeId>` | a node's output |
| `vars.<name>`, `vars.<name>_index` | a `map` variable and its index |
| `loop.<loopId>.index`, `loop.<loopId>.last` | the current loop iteration (0-based) and the previous iteration's output |
| `run.id`, `run.agentId` | the run |
| `fallback` | only inside `lowConfidence.value`: the low-confidence node's output |

A numeric segment reads an array's element and an object's own property of that name (`input.0` is `"valid"` for
the input `{"0": "valid"}` and `1` for `[1]`). So when the schema at that point allows both an array and an
object (a schema with `properties` and no `type` allows both), a numeric segment is not statically typed: the validator and the dry run treat its value as unknown,
unless `items` and the property's schema are the same schema, or one of the two readings is impossible (the object
allows no property of that name).

**Safety rules.** Resolution walks own properties only. The segments `__proto__`, `constructor` and `prototype`
are rejected when the path is parsed. There are no functions, operators or evaluation of any kind: a reference
selects a value, a template inserts text. A missing value without a default is the error
`reference_unresolved`.

### Conditions

Used by `loop.until`:

| Form | True when |
|---|---|
| `{"eq": [a, b]}`, `{"ne": [a, b]}` | the resolved values are (not) equal as canonical JSON |
| `{"gt"\|"gte"\|"lt"\|"lte": [a, b]}` | both are numbers or both are strings and the comparison holds (otherwise false) |
| `{"and": [c, ...]}`, `{"or": [c, ...]}` | all / any of the conditions hold |
| `{"not": c}` | `c` does not hold |
| `{"exists": "<path>"}` | the path resolves |
| `{"truthy": expr}` | the resolved value is truthy |

### Visibility

Whether a field may reference `steps.X` depends on where X sits relative to the node the field belongs to (the
*referencing node*; the document's `result` belongs to no node and looks from `root`). The validator decides it
by these rules:

- **Visible.** X lies in an earlier step of a `sequence` that encloses the referencing node (X is that step or is
  inside it), and X is reached unconditionally from that step: every node between the step and X is a `sequence`
  or a `parallel`. From the document's `result`, X is visible when it is reached unconditionally from `root`.
- **Conditional.** X lies in such an earlier step (or, from `result`, anywhere), but on the way from it to X there
  is a `branch` case or `default`, a `lowConfidence.run`, a `map` or a `loop` that the referencing node is not
  inside: X may not have run. Such a reference needs a `default` (`{"$ref": ..., "default": ...}`); without one the
  validator reports `conditional_reference`.
- **Hidden.** These are always the error `unknown_reference`, with or without a `default`, and the message gives
  the reason:
  - X is the referencing node itself: `a node cannot reference its own output` (for example a `wait` node `w`
    whose `question` uses `{{steps.w.answer}}`; its output exists only once it has finished);
  - X encloses the referencing node: `node "X" encloses this node and has not finished yet`;
  - X is inside the referencing node: `node "X" runs inside this node, after this value is needed`;
  - X is a later step of an enclosing sequence, or inside one: `node "X" runs later in the sequence "S"`;
  - X is in another branch of an enclosing `parallel` group, or in another case (or the `default`) of an enclosing
    `branch`: `node "X" runs in a different part of parallel "P"` (or `branch "B"`).
- **Two fields see inside their own node.** In `loop.until`, the nodes of the loop's body are visible as this
  iteration's values (conditional, as above, when a `branch`, `lowConfidence.run`, `map` or `loop` inside the body
  lies on the way to them). In `lowConfidence.value`, the nodes of `lowConfidence.run` are visible by the same rule,
  and `fallback` is the output of `lowConfidence.run` itself.

Inside a `loop` or `map` body, `steps.X` for a body node means this iteration's value.

## Schemas

`schemas` maps names to JSON Schemas in the subset the project's validator supports: `type` (one or a list of
`null`, `boolean`, `integer`, `number`, `string`, `array`, `object`), `properties`, `required`,
`additionalProperties` (boolean or schema), `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`,
`maxLength`, `minItems`, `maxItems`, `pattern`, `anyOf`, `oneOf` and `$ref`. Annotation keywords (`title`,
`description`, `default`, `examples`, `$schema`, `$id`, `$defs`, `definitions`) are ignored by validation; any other
keyword is reported as `invalid_schema`. `default` and `examples` are still read by the placeholder generator of the
[dry run](#how-a-placeholder-is-chosen), which tries them right after `const`.

- **Reference cycles.** A chain of `$ref`, `anyOf` and `oneOf` that leads from a schema back to itself without
  stepping into a property or an item consumes no input and could never finish; it is rejected as
  `invalid_schema` (`reference cycle without progress: <ref> -> ... -> <ref>`).
- **A bounded amount of work.** One validation evaluates at most 100 000 schema nodes, across all branches. Beyond
  that it stops with the problem `validation stopped: the schema needed more than 100000 evaluations` (keyword
  `limit`) and the value counts as invalid.
- **Patterns.** `pattern` is compiled as a JavaScript regular expression (`new RegExp(pattern, "u")`) and runs on
  a backtracking engine: a pattern with nested quantifiers, such as `^(a+)+$`, can take exponential time on a
  crafted value. Schemas are written by the operator, so write patterns without nested quantifiers.

A schema refers to another named schema with `{"$ref": "#/schemas/Name"}`; local `#/$defs/Name` and
`#/definitions/Name` also work. One rule decides what a reference means, and run-time validation, the schema check,
placeholders, the static checks and bundling all apply it:

> A local reference is resolved against the schema document it is written in. `#/$defs/N` and `#/definitions/N`
> look first in the `$defs` / `definitions` of that document and then among the workflow's named schemas;
> `#/schemas/N` names a workflow schema. Following a reference that lands on a named schema makes that named
> schema the document for the references inside it.

So when schema `Input` defines `$defs.X` as a string and refers to `A`, and `A` defines its own `$defs.X` as a
number, a `#/$defs/X` written inside `A` is `A`'s number, and one written in `Input` is `Input`'s string.

When a schema is passed to a model as structured output (or checks a tool argument, a decision or a run's input
and output), it is bundled into a self-contained copy that validates exactly like the named schema: every named
schema a reference reaches is placed under the bundle's `$defs` (as `N`, or `N__schema` when the entry schema's own
`$defs` already uses that key) and its references rewritten to it, and the `$defs` / `definitions` a bundled named
schema brings with it are hoisted to unique top-level keys (`<schema>__<definition>`), with the references written
inside that named schema rewritten to them. The entry schema's own definitions keep their keys. The bundle walks schemas, not objects: the keys
of `properties`, `$defs` and `definitions` are names (a property may be called `const` or `enum`), `items`,
`additionalProperties`, `anyOf` and `oneOf` hold schemas, and `const`, `enum`, `default` and `examples` hold data
that is copied exactly as written, even when it looks like a reference. The Anthropic and OpenAI-compatible providers
carry the answer as the arguments of an output tool, and a tool's arguments are always a JSON object. So an
object schema (top-level `"type": "object"`) is sent as the tool's argument schema as it is, and every other schema
is sent wrapped as `{"type": "object", "additionalProperties": false, "required": ["value"], "properties":
{"value": <schema>}}`, with the schema's `$defs` and `definitions` moved onto the wrapper so its references still
resolve. The provider unwraps the answer, so the step sees the value itself; a model that leaves the wrapper out
and sends the bare array or scalar is understood too, and a plain-text JSON answer is read as the value itself.
Details are in [architecture.md](architecture.md#model-calls-reservations-interruption-and-repair).

## Retry and deadlines

- `deadlineMs` (positive integer) is accepted by the validator on every node kind. On `tool`, `model` and `decide`
  nodes it bounds each attempt's call: when it passes, the call is aborted (`deadline_exceeded`; a model call is
  charged at its worst case, a tool call finishes with `outcome: "timeout"`). On a `fail` node it has no effect,
  and the validator says so with a `bad_deadline` warning: `"deadlineMs" has no effect on a fail node`.
- **A deadline on a composite node bounds the whole node.** On `sequence`, `parallel`, `branch`, `map`, `loop`,
  `call` and `agent` nodes, the node must finish within `deadlineMs` of its start, everything inside it included:
  every iteration of a `map` or `loop` together, every branch of a `parallel`, the whole sub-workflow of a
  `call`, every turn and tool call of an `agent`'s hand-off. When it passes, calls in flight inside the node are
  aborted and journalled as timeouts (a tool call `tool.finished {outcome: "timeout"}`, a model call
  `model.interrupted {reason: "deadline"}`, charged at its worst case), no further step of the node starts, and
  the node fails with `deadline_exceeded`: the run then fails with the error code `workflow_failed` and the
  message `node "<id>" failed: deadline_exceeded: the deadline of <n> ms passed`. Nodes inside it that finished
  before the deadline stay finished in the journal. Step keys are the same with or without a deadline.
- **A deadline on a `wait` node bounds the answer.** The question must be answered within `deadlineMs` of the
  node's start. An answer the server accepted before that instant counts, however late the run resumes. When
  nobody answers in time, the run is woken at the instant with no command sent, the pending is resolved
  `{expired: true, expiresAt}`, and the node fails: the run fails with the error code `workflow_failed` and the
  message `node "<id>" failed: deadline_exceeded: the question was not answered before its deadline`.
- **Nested deadlines: the earliest one wins.** A deadline inside another (a node inside a composite node, a
  sub-workflow's own node deadlines inside a `call`, a call's deadline inside a composite node) can only shorten
  the time left; the failure names the node whose deadline passed first.
- **A deadline stops nested work.** On a `tool` node that calls `run_workflow`, or any tool built from durable
  steps, the deadline covers everything the tool does: once it passes, no further nested step starts (the nested
  primitive throws `deadline_exceeded` before it journals anything), a nested model call in flight is aborted
  and journalled `model.interrupted {reason: "deadline"}` with its worst case as an assumed cost, a nested tool
  call in flight is aborted and journalled `tool.finished {outcome: "timeout"}`, and the call itself is journalled
  `tool.finished {outcome: "timeout"}`. A nested handler that ignores its signal finishes and is journalled
  normally, and the next nested step does not start. This composes to any depth. A finished call is never run
  again.
- **A node deadline is an instant, not a timer.** For a composite node, an `agent` hand-off and a `wait`, the
  deadline is the node's start as journalled (`node.started`) plus `deadlineMs`. It is the same instant in every
  session, so it holds across everything that interrupts a run: time waiting for a person, time paused, a
  release at shutdown, a crash and a restart all count. A run that is waiting when the instant passes is woken
  (within one poll interval, `runner.pollMs`, of the instant when a runner has a free slot; a runner whose slots
  are all busy does not look for work, so the wake-up then waits until a slot is free) and the node fails; a run that is paused stays paused and
  the node fails when the run is resumed; a run that comes back after the instant starts nothing more inside the
  node. Children that finished before stay finished in the journal.
- **A call deadline is per call.** On `tool`, `model` and `decide` nodes `deadlineMs` measures one execution of
  the call: a call that is attempted again (a retry, a resume after a suspend or a crash) gets a fresh bound, and
  the time a tool call waits for an approval comes before the call and is not counted.
- **Pendings carry the instant.** A pending opened inside a node deadline (a question, an approval, a cap or
  budget pause, an interrupted call) carries `detail.expiresAt`, the earliest enclosing instant in ms since
  epoch. A command that names it (an answer, an approval or a denial, a decision on an interrupted call) and is
  created at or after that instant is rejected: the API answers 409 `pending_not_open`, and a command that still
  reaches the run is journalled `command.rejected` with the reason `pending <id> expired at <ISO 8601 time>`.
- `retry: {maxAttempts, backoffMs, factor?, maxBackoffMs?}` is allowed on `model` and `decide` nodes, and on
  `tool` nodes that are safe to retry: the node says `idempotent: true`, or the tool is declared `effect:
  "read"` or `idempotent`. `maxAttempts` is 1 to 10. The delay before attempt n + 1 is `min(maxBackoffMs,
  backoffMs × factor^(n − 1))` with `factor` defaulting to 2 and `maxBackoffMs` to 60 000. When the failed
  attempt was a model step that ended while a provider's retry-after wait was outstanding (its last provider
  attempt failed with a hint, or the node's deadline passed during the wait), the delay is at least what is left
  of that wait. The same holds for a `tool` node that calls `run_workflow` when the nested workflow failed in
  such a model step: the call's error result carries `data.providerWait` (`{retryAfterMs, retryAfterOverLimit?}`),
  and the node's retry reads it. Each attempt has its
  own step key, and each retry is journalled once as `node.retry` with its `delayMs`; the next attempt starts at
  that record's time plus `delayMs`. So after a restart or a resume, a node waits only what is left of its
  backoff: a session that comes back after that instant does not wait at all (an attempt that already finished is
  not run again), and the waits of all sessions together are never longer than `delayMs`, also when the clock
  stepped back in between. A node's `retry` repeats the whole step; transient provider errors inside one model step are already
  retried by the engine attempt by attempt (`models.retry`, see
  [architecture.md](architecture.md#model-calls-reservations-interruption-and-repair)).
- **Durations are bounded by what one timer holds.** `deadlineMs` is a positive integer of at most 2147483647 ms
  (about 24.8 days, the longest wait one timer holds); a larger value, `Infinity` or `NaN` is the `bad_deadline`
  problem. `retry.backoffMs` and `retry.maxBackoffMs` are numbers from 0 to 2147483647, and `retry.factor` is a
  finite number of at least 1. The delay between attempts is never more than 2147483647 ms.
- **A tool declared `idempotent` must succeed when it is run again after it already took effect**: a node's
  `retry` repeats it after a finished failure, and the engine may run an unfinished call of it again by itself.
  **Rule R.** A tool call left unfinished (a `tool.started` with no `tool.finished`, after a crash, a pause or a
  forced shutdown) is run again by the engine itself only when repeating it cannot undo finished work: a read-only
  tool always; a resumable tool always (it replays its own steps); a tool declared `idempotent` with `effect:
  "write"` only if no write call of the run finished after this call started. Otherwise the call is journalled
  `tool.interrupted` and waits for a person (retry, skip, cancel), like any other write. An unfinished call of a
  tool declared `idempotent` is run again by itself only when no write call of the run finished after it started;
  otherwise repeating it could undo that finished work, so it waits for a person as an interrupted call. A write
  call counts when its `tool.finished` comes after this call's latest `tool.started` in the journal, whatever its
  outcome, also inside `run_workflow`, a hand-off or a `call` node; a call whose handler never ran (denied, an
  unknown tool, invalid arguments) does not count. (A node's own `idempotent: true` only permits `retry` on a tool
  that is not declared retry-safe; it does not change what happens after a crash, which follows the tool's
  declaration.) The built-in `delete_file` keeps the promise: **deleting a file that is already absent gives
  `{ok: true}` with `data: {path, deleted: false}`**, so a workflow that was killed right after the deletion
  resumes and carries on instead of failing.
- Errors that another attempt cannot change are not retried: `workflow_invalid`, `reference_unresolved`,
  `validation_failed`, `limit_reached`, `workflow_failed`, and tool outcomes other than `error` and
  `timeout` (a denial, invalid arguments, an unknown tool), and a model call the engine stopped because the
  provider asked for a wait longer than `models.retry.maxRetryAfterMs` ([configuration.md](configuration.md#models-and-keys)),
  also when it was a model step of a workflow that a `tool` node ran with `run_workflow`.
- A pause or a forced shutdown is not a node failure and uses no retry attempt. A tool call it aborts gets no
  result: when the run continues, rule R decides. A read-only or resumable tool is run again under the same step
  key, a tool declared `idempotent` is run again only when no write call of the run finished after it started, and
  any other tool call waits as an `interrupted` pending for a person (retry, skip with a result, or cancel), by the
  same rules as in an agent run ([architecture.md](architecture.md#tool-calls-started-finished-interrupted)).

## Validator

`validateWorkflow(document, {tools?, resolveWorkflow?, savedAs?})` (`POST /v1/workflows/validate`, `runwright
workflows validate`) reports every problem it finds, each `{path, code, message, severity, nodeId?}` with `path` a
JSON path into the document such as `$.root.steps[2].args.url`. A document with any `error` is invalid; warnings
do not block saving or running.

| Code | Meaning |
|---|---|
| `format` | `format` is not `runwright.workflow/v1` |
| `shape` | a field is missing or of the wrong type (unknown fields are warnings), including a `tool` node's `args` given as a `$ref` or `$literal` form instead of a map of argument expressions |
| `unknown_kind` | a node kind that does not exist |
| `duplicate_id` | a node id is used twice or does not match the id pattern |
| `unknown_schema` | `input`, `output` or a node's `output` names a schema that is not in `schemas` |
| `invalid_schema` | a schema uses an unsupported keyword, a wrong keyword type, a bad regex or an unresolved `$ref` |
| `unknown_reference` | a reference names a node that does not exist or is not visible from here |
| `conditional_reference` | a reference to a node that may not have run, without a `default` |
| `bad_reference` | a malformed reference or template path (bad segment, forbidden segment, unknown root, `fallback` outside `lowConfidence.value`) |
| `schema_mismatch` | a mismatch that no run can avoid ([what the validator can and cannot see](#what-the-validator-can-and-cannot-see)): a `result`, a tool argument or a `call` input that never fits its schema (or a missing required argument), a reference path that a value's shape does not have, a `when` of the wrong type for `on`, `over` that is never an array, `over` written with more elements than `maxItems` (or a reference that always has more), a decision problem (fewer than two or duplicate options, `min >= max`, `lowConfidence.below` outside `(0, 1]`, a fallback value that never fits the decision) |
| `unknown_tool` | a `tool` node or an `agent` node's `tools` names a tool that is not registered |
| `unknown_workflow` | a `call` names a workflow that is neither inline nor saved (a warning instead of an error when the validator is given no saved-workflow lookup) |
| `call_cycle` | `call` nodes form a cycle |
| `missing_bound` | a required bound is missing or out of range: `map.concurrency` (1–64), `map.maxItems` (0–1000000), `loop.maxIterations` (0–1000000), `agent.maxTurns` (1–10000), `retry.maxAttempts` (1–10), `retry.backoffMs` (0–2147483647) |
| `unreachable` | a node that can never run: a step after a `fail` in a sequence, a `branch` case whose `when` repeats an earlier case or can never match the decision it branches on, a `default` after exhaustive `yes_no` cases, the body of a `loop` with `maxIterations: 0` or a `map` with `maxItems: 0` |
| `retry_unsafe` | `retry` on a node kind that does not allow it, or on a tool node whose tool is not read-only or idempotent and which is not marked `idempotent: true` (a warning when the tool catalogue is not known) |
| `bad_deadline` | `deadlineMs` that is not an integer from 1 to 2147483647 (an error, on every node kind), or a valid `deadlineMs` on a `fail` node, where it has no effect (a warning) |
| `placeholder_dependent` | only from the [dry run](#dry-run), and always a warning: a problem that depends on a value the dry run made up, which a real run may or may not have (see [What a dry run checks](#what-a-dry-run-checks)) |

### What the validator can and cannot see

The validator reports a mismatch only when it is certain. It looks at each part of an expression on its own
(a literal, a reference, the default of a reference) and reports the part when **no run that reads that part
could make it fit**:

- A **literal** (an expression without references, or a `$literal`) is checked in full against the schema.
- A **reference** is compared by the shape of what it names: the schema of the input, a model's output schema,
  the fixed fields of a node's output (a `wait` node's `{answer}` is always a string), a called workflow's output
  schema. It is reported when none of the JSON types it can have is allowed (an `integer` fits a `number`; a
  `number` may be a whole number, so it may fit an `integer`), when it never has a property the schema requires,
  when a property it always has never fits (its value never fits, or `additionalProperties` refuses the property),
  or when every value of its `const` or `enum` is refused.
- A **template string** (a string with `{{ }}`) always renders a string: its text parts as written, in order,
  with whatever the references render between them.
- An **object or array written in the document** that holds references is checked part by part: a key the schema
  does not allow, a required key that is not written, and each part against its own schema by these rules. An
  array written in the document always has exactly as many elements as it is written with.
- A reference with a `default` is checked like any other reference: whenever it resolves, its value has the
  referenced shape, so a shape that never fits is reported at the reference. The default is the value only when
  the reference is missing, so it is checked, in full (path `<expression>.default`), only when the reference may
  be missing. A reference that always resolves never reads its default: `input` and the properties its schema
  requires, `run.id`, a map variable, a loop's `index` and `last`, the output of a node that always ran before
  and the fields that output always has. A `branch` on, or a `map` over, a reference with a default uses the
  referenced shape for its own checks only when the reference always resolves.

Keyword by keyword, for each form of expression (a schema reached through `$ref` applies together with the
keywords next to the `$ref`, and every schema on the chain is checked):

| Keyword | Template string | Array written in the document | Object written in the document | Reference |
|---|---|---|---|---|
| `type` | reported when `string` is not allowed | reported when `array` is not allowed | reported when `object` is not allowed | reported when none of its types is allowed |
| `const`, `enum` | reported when no allowed value is a string the template can render (one that starts and ends with its leading and trailing text and holds its other text parts in order) | reported when no allowed value is an array of the written length whose elements can each be what is written there | reported when no allowed value is an object with exactly the written keys whose values can each be what is written there | reported when no allowed value is a value its shape can have |
| `minimum`, `maximum` | | | | reported when it only holds numbers and its own range lies wholly outside (its `minimum` above the `maximum`, or its `maximum` below the `minimum`) |
| `minLength`, `maxLength` | reported when the text parts alone are longer than `maxLength` | | | reported when it only holds strings and its own length range lies wholly outside |
| `pattern` | left to run time | | | reported when every value of its own `const` or `enum` fails |
| `minItems`, `maxItems` | | reported when the written length is below `minItems` or above `maxItems` | | reported when it only holds arrays and its own length range lies wholly outside |
| `items` | | each element by these rules | | when it is an array that is never empty (`minItems` of 1 or more), its item shape is compared at `<path>[0]` |
| `properties`, `required`, `additionalProperties` | | | each key and each required key, as above | as above |
| `anyOf`, `oneOf` | reported when every alternative is certainly wrong by these rules (`never matches any of the <n> schemas (anyOf)`); the keywords next to the union are checked too | the same | the same | the same; and a reference whose own schema is a union is reported only when every one of its alternatives is certainly wrong |

An empty cell is a keyword that does not constrain a value of that JSON type (a wrong type is the `type` row's
report). Inside a written object or array checked against one alternative of a union, a reference with a
`default` that may be missing counts against that alternative only when its shape and its default are both wrong
for it, because some runs read the one and some the other.

Anything that cannot be decided is left to the run-time checks, which fail the node or the workflow with the
usual errors:

- `pattern` and `minLength` of a template string;
- a value of unknown shape: a tool's `data`, a `branch` node's output, `loop.<id>.last` (which is `null` in the
  first iteration);
- a schema that does not pin its types (a schema with only `properties` also accepts a string);
- a type that may fit;
- the length and the items of a `map` node's output list;
- a union only some of whose alternatives are certainly wrong.

Example: with the input schema `{"type": "number"}`, the output schema
`{"type": "array", "items": {"type": "number"}, "minItems": 2}` and the result `[{"$ref": "input"}]`, every run
would fail its output check, so the validator returns the error `does not fit schema "Out": must have at least 2
items, got 1` at `$.result` (the output schema is named `Out`), and a dry run stops there and calls nothing.

The destinations are the document's `result` (against the output schema), every tool argument (against the
tool's parameter schema), a `call` node's `input` (against the called workflow's input schema), `map.over` (an
array no longer than `maxItems`), a `branch` case's `when` (against the shape of `on`) and `lowConfidence.value`
(against the decision).

### Saving and call cycles

A document is resolved by the name it is **stored** under, at save time and at run time alike; its own `name`
field never stands in for that. `savedAs` says what that name is:

- a string: the name the document is, or is about to be, saved under. A `call` to that name resolves to the
  document being validated, whatever its `name` field says, and a call to it from a saved workflow it calls closes
  a cycle (`a -> b -> a`). The server passes the name in the URL when it saves a workflow; a run passes the saved
  name when it runs a saved workflow (`run_workflow`, a `call` to a saved workflow).
- `null`: the document is not a saved workflow (the workflow embedded in an agent definition), so no `call`
  resolves to it by name: a call resolves inline or to a saved workflow only. Saving an agent and running its
  workflow pass `null`.
- absent: the document's own `name` field plays that part (a document checked before it is saved under that
  name, such as the validate and dry-run endpoints).

So a workflow saved as `main` whose `name` is `helper` may call the saved workflow `helper`; a workflow saved as
`loop` that calls `loop` is a cycle, when it is saved and when it runs.
Sub-workflow cycles are refused when a workflow is saved; anything that still gets through is stopped at run time
by the nesting bound of 16 calls.

## Dry run

`dryRunWorkflow(document, {input?, decisions?, resolveWorkflow?, maxSteps?, savedAs?})` (`POST /v1/workflows/dry-run`,
`runwright workflows dry-run`) walks the same control flow as a run and **calls nothing**: no model, no tool, no
person, no step primitive. Wherever a run would get a value from outside, the walk makes one up (a
*placeholder*), and it reports what it walked and what it found. It takes no time, so no `deadlineMs` ever
passes in it: a document dry-runs exactly as the same document without its deadlines.

| Node | Placeholder |
|---|---|
| `tool` | `{ok: true, content: "", data: null}` |
| `model` | a placeholder of its output schema, chosen by the [rules below](#how-a-placeholder-is-chosen) |
| `decide` | the first option / `true` / `min`, with confidence 1; override per node id with `decisions: {"<id>": {value, confidence}}` to exercise the low-confidence route |
| `wait` | `{answer: ""}`, or the first choice |
| `agent` | `{text: "", data: <placeholder of its output schema> or null}` |
| input | the given `input` (validated against the input schema), or a placeholder of the input schema |

The report is `{ok, steps, wouldCall, output, problems, truncated}`: `steps` lists every node entered, in order
(`{nodeId, kind, path, scope, note}`); `wouldCall` lists every call a real run would make (`{nodeId, type:
"tool" | "model" | "decision" | "agent" | "person" | "workflow", name, detail}`); `output` is the built result;
`problems` holds errors and warnings (`{path, code, message, severity, nodeId?}`). An invalid document returns
`ok: false` with the validator's problems and no steps. The walk stops after `maxSteps` (default 10 000) entered
nodes with `truncated: true`.

### How a placeholder is chosen

The same generator (`generatePlaceholder` in `src/schema/placeholder.ts`) makes the placeholders of the dry run
and the answer of the scripted model to an unscripted structured step. For a schema, and again for every
subschema inside it, it tries candidates in this order and takes the first one that validates against that
schema: its `const`; its `default`; each of its `examples`, in order; each value of its `enum`, in order; for a
`$ref`, a placeholder of the referenced schema together with the sibling keywords next to the `$ref`, then of the
referenced schema alone; for each branch of `anyOf`, then of `oneOf`, a placeholder of the branch together with
the sibling keywords, then of the branch alone; and last, by type, for each type the schema allows, in the order
it lists them (a schema without `type` counts as an object when it has `properties` or `required`, as an array
when it has `items`, else as `null`):

- string: a sample of its `pattern` within `minLength` and `maxLength`, when it has a pattern; then `"x"` repeated
  `minLength` times (the empty string without `minLength`);
- integer and number: `minimum`, else 0, or `maximum` when that is below 0; an integer is rounded up, and down to
  `maximum` when rounding up overshoots it; a number also tries that value plus 0.5;
- boolean: `false`; null: `null`;
- array: `minItems` copies of a placeholder of `items` (`[]` without `minItems`);
- object: every `required` property, with a placeholder of its schema in `properties`, else of an object-valued
  `additionalProperties`, else `null`.

Every candidate is validated against its schema before it is taken, and the whole placeholder is validated once
more at the end: the generator reports `satisfied: true` only when it validates. When no candidate of a schema
validates, the generator keeps its first by-type candidate (else the first candidate it tried, else `null`) and
reports `satisfied: false`.

**Patterns.** A pattern sample is built for this subset of the syntax (the validator compiles a pattern as
`new RegExp(pattern, "u")`): literal characters and punctuation escaped with a backslash (`\.`, `\/`, `\\`, `\(`
and the like, and `\-` inside brackets); `.`; the classes `\d`, `\w` and `\s`, on their own and inside brackets;
bracket classes with single characters, ranges (`a-z`) and negation (`[^...]`); groups `( )` and non-capturing
groups `(?: )`; alternation `|`, tried in order; the quantifiers `?`, `*`, `+`, `{n}`, `{n,}` and `{n,m}` and their
lazy forms; and the anchors `^` and `$`. Anything else gives no sample: look-ahead and look-behind,
back-references, named groups, `\b` and `\B`, `\p{...}` and `\P{...}`, `\D`, `\W`, `\S`, and control and code
escapes such as `\n`, `\t`, `\uXXXX` and `\xHH`. A class contributes one character: an upper-case letter, else a
lower-case letter, else a digit, else the first printable ASCII character it contains. Every sample is tested
against the compiled pattern and the length bounds before it is used.

**Limits.** A generated string is at most 4 096 characters and a generated array at most 256 items; a larger
`minLength` or `minItems` gives a cut value, which does not validate. One placeholder holds at most 100 000 array
values in all (a string counts one more per 64 characters). Nesting deeper than 64 gives `null`. After 5 000
visited schemas, every further schema takes its first by-type candidate without trying others. For a `$ref` and
for each `anyOf` or `oneOf` branch, at most four values that satisfy the referenced schema or the branch are tried
against the schema around it. A pattern longer than 1 000 characters gives no sample.

**When no placeholder can be generated**, give the schema a `default` or an `examples` entry that fits it: these
are tried first. For the scripted model, add a script entry for the step instead: its unscripted answer is the
placeholder, and a placeholder that does not validate is an invalid answer (the step is repaired once and then
fails with `model_output_invalid`).

### What counts as made up

The walk knows, for every value a reference can name, whether it was made up:

| Source | Made up when |
|---|---|
| `input` | no `input` was given; inside a called sub-workflow: the `call` node's `input` expression uses a made-up value |
| `steps.<id>` of a `tool`, `model`, `agent` or `wait` node | always |
| `steps.<id>` of a `decide` node | no `decisions["<id>"]` was given; with one: only when the low-confidence route ran and its fallback node's output is made up |
| `steps.<id>` of a `branch`, `sequence`, `parallel`, `map` or `loop` | its own `on`, `over` or `until` uses a made-up value, or any node walked inside it is made up |
| `steps.<id>` of a `call` | its `input` uses a made-up value, or the called workflow's root or `result` does |
| `steps.<id>` of any node walked on an [assumed path](#branches-maps-and-loops-on-made-up-values) | always |
| `vars.<as>` in a `map` body | the map's `over` uses a made-up value (`vars.<as>_index` never is made up) |
| `loop.<id>.last` | the loop body's output in an iteration already walked is made up (`loop.<id>.index` never is) |
| `fallback` | the fallback node's output is made up |
| `run.*` | never |

An expression or a condition uses a made-up value when any reference in it names a made-up source: a `$ref`
(with or without `default`), a `{{path}}` in a template string, or the operand of `exists`.

### What a dry run checks

A problem that a real run has whatever values it produces is an **error**: an invalid document, a given input that
does not fit its schema, a problem in values the document or the caller supplied, a mismatch that the shapes of
the values make certain, a limit (`limit_exceeded`), a workflow that cannot be resolved (`unknown_workflow`), and a
`fail` that every run reaches. A problem that depends on a value the walk made up is a **warning** with code
`placeholder_dependent`.

**Placeholders that do not validate.** When no placeholder that satisfies a `model` or `agent` output schema, or
the input schema, can be generated, one warning is added at the node's path (for the input, at path `input`):
`no placeholder that satisfies schema "<name>" could be generated; values that depend on it are not checked`. For
the item of a map over an empty made-up list the message is `no placeholder that satisfies the item schema of
"over" could be generated; values that depend on it are not checked`.

**Values against their schemas.** The workflow output is validated against the output schema, a `call` node's
input against the called workflow's input schema, and a called workflow's result against its output schema. Each
problem found is traced back to the part of the expression that built the value:

- a `$literal`, or a part that uses no made-up value: the problem is certain, an error (`schema_mismatch`);
- a template string that uses a made-up value: certain only for a wrong `type` (a template always renders a
  string), else a warning. Example: `"https://{{input.id}}"` into an output property with `minLength: 12` is a
  warning when no input is given, and the error `must be at least 12 characters, got 9` with the input
  `{"id": "a"}`;
- a plain object or array written in the document that holds a made-up value somewhere inside: certain for a
  wrong `type`, a missing `required` property and a property that `additionalProperties` forbids, and for an
  array also its length (`minItems`, `maxItems`), found on that object or array itself (the document fixes
  them), else a warning;
- a reference to a made-up value: certain for a wrong `type` only when what the reference names has exactly one
  JSON type other than `number`, by its schema or its node kind, and the value found has that type; certain for a
  missing `required` property only when it names a node output with a fixed set of fields that lacks it (for
  example a `wait` node's `{answer}`), and for a forbidden property only when that set has it. Every other problem
  is a warning, and so is every problem of a reference with a `default` (a real run may read the default; a
  reference whose shape never fits is the validator's error before the walk starts). A
  mismatch the shapes make certain is usually [proved by the validator](#what-the-validator-can-and-cannot-see)
  already, and then the dry run returns the validator's error and walks nothing. Example: a person's answer,
  `{"$ref": "steps.w.answer"}` (always a string), into a boolean output property is the validator's error `does
  not fit schema "Out": is string, but expected boolean` at `$.result.<property>`; a model's answer, a string,
  into an output property with an `enum` is a warning.

A warning for a value check reads `not checked against a real value: <the validator's message>`, at the same path
the error would have (for example `output.code`). The walk goes on after a value check that has only warnings: a
`call` is entered, the output is reported.

**References into made-up values.** A reference that cannot be resolved, has no `default`, names a made-up source
and misses inside that source's value (the source itself exists) reads as `null`, with a warning at the
expression's path: `reference "<path>" cannot be resolved in a placeholder value; it reads as null here`. This is
what happens to `steps.t.data.count` after a `tool` node `t` (its placeholder `data` is `null`) and to an optional
property of a model's answer (the placeholder has the required properties only). A reference with a `default`
reads its default, as in a real run, with no warning. Every other unresolvable reference is the error
`reference_unresolved`.

**Decisions.** A `lowConfidence.value` that does not fit the decision is the error `schema_mismatch` when its
expression uses no made-up value. When it does, the decision keeps its own value and the warning reads `the
fallback value depends on a placeholder and was not checked`.

### Branches, maps and loops on made-up values

- **`branch`** whose `on` uses a made-up value follows rule D (below). The step note is `case <i> (<value>,
  placeholder)`, `default (<value>, placeholder)` or, when no case was taken and there is no default, `no case
  matched (<value>, placeholder)`, for example `case 0 ("", placeholder)` for a model's string answer `""`; it ends
  with `, unreachable branches skipped` when the declared schema of `on` rules out at least one case or the
  default. A `branch` whose `on` uses no made-up value runs as in a real run (note `case <i> (<value>)`,
  `default (<value>)` or `no case matched (<value>)`).
- **`map`** whose `over` uses a made-up value: a value that is not an array counts as an empty list; a list longer
  than `maxItems` is cut to `maxItems` (note `placeholder list cut to maxItems <n>`); an empty list with
  `maxItems` above 0 runs the body once with a placeholder item (note `over is an empty placeholder list; the body
  runs once with a placeholder item`). The body of an item that every valid run has is walked as certain, the
  others on an assumed path (rule A, below). A `map` whose `over` uses no made-up value checks it as a real run
  does: a value that is not an array and a list longer than `maxItems` are errors.
- **`loop`** whose `until` uses a made-up value: when `until` can never hold ([rule V](#rule-v-what-a-condition-can-be)),
  every run goes on to its bound: with `onLimit: "fail"` the walk fails after the first iteration, as every run
  fails at the bound; otherwise it walks every iteration up to `maxIterations`, none of them assumed, and the note
  is `until cannot hold for the declared schemas; stopped at maxIterations <n>` and the output `{iterations:
  <maxIterations>, completed: false, last}`. Like a loop whose `until` uses no made-up value and never holds, a
  long one can reach `maxSteps` and end the dry run truncated. Otherwise, when it does
  not hold after an iteration, the walk assumes it holds and stops the loop there, with the note `until depends on
  placeholder values; assumed to hold after iteration <n>` and the output `{iterations: <n>, completed: true,
  last}`. A `loop` whose `until` uses no made-up value, one without any reference included, evaluates it after
  every iteration as a real run does and never assumes it.

**Rule D: only reachable branches.** A placeholder the walk happened to pick never fails a workflow, and a branch no
real value can select never rescues one:

When the value a branch switches on is a placeholder, the dry run considers only the outcomes a real value
could select: a case is reachable when its `when` value is valid for the declared schema of `on`; the default
is reachable unless the schema allows only a finite set of values (`const`, `enum`, a `boolean`, a `null`) and
every one of them is some case's `when`; with no default, "no case matched" is an outcome under the same
condition. When the schema of `on` is not statically known, every branch is reachable. The declared schema of a map
variable `vars.<as>` is the item schema of the enclosing map's `over`, and `vars.<as>_index` is a non-negative integer.

A node *cannot succeed* when its structure alone makes every run through it fail: a `fail` node; a sequence
or a parallel group with a step that cannot succeed; a map whose `over` always has an item (rule A) and whose body
cannot succeed; a loop with `maxIterations` of 1 or more whose body cannot succeed, or whose `onLimit` is
`"fail"` and whose `until` can never hold (rule V); a branch all of whose reachable outcomes are
nodes that cannot succeed; a `call` whose target's root cannot succeed. Every other node can succeed.

The walk takes the branch the placeholder selects if it can succeed, otherwise the first reachable branch that
can succeed (cases in order, then the default). When more than one outcome is reachable, the path taken is
marked as assumed, and a failure met on it is a warning. When only one outcome is reachable, or no reachable
branch can succeed, the walk takes it as a real run would and a failure on it is certain: the dry run is not
ok.

A loop whose `until` depends on a placeholder is assumed to hold after an iteration only when it can hold (rule
V). When it can never hold, the loop ends at `maxIterations` (and fails for certain when `onLimit` is `"fail"`).

How the walk applies it: "no case matched" is an outcome but not a branch, so when the placeholder matches no case
(and there is no default) the walk takes the first reachable case that can succeed, and ends the branch with no
case matched only when no reachable case can. With no outcome that can succeed it takes the placeholder's own
choice when that is reachable, else the first reachable outcome. A branch whose `on` has no reference has one
value, so only the outcome a run selects for it is reachable. A `call` is followed through inline workflows and
saved ones, at most 16 levels deep. The walk inside a called
workflow uses that workflow's schemas.

**Rule A: assumed paths.** A path is *assumed* only when a real run with valid values might not take it; a node
that every valid run executes is never on an assumed path, whatever values were made up on the way. So the walk
marks as assumed only the node a `branch` chose among more than one reachable outcome because of a made-up value,
and the body of a `map` over a made-up list for an item that a valid list may not have; everything walked from
there is assumed too, called workflows included. A `map` over a list that is always non-empty (a reference without
`default` that is always present and whose schema is a plain array schema with `minItems` of 1 or more, or a list
written in the document) runs its body for certain for the first `minItems` items (every written item); a union,
an optional property or a schema with several types guarantees nothing. A loop's first iteration is never assumed,
and a later one only after a made-up `until` that can hold (the walk then assumes it holds and stops there).

**Assumed paths and `fail`.** A `fail` node, or a `loop` that reaches `maxIterations` with `onLimit: "fail"`, ends the walk with the note `would
fail: <message>` (for the loop, `would fail: reached maxIterations <n>`). Off an assumed path every run reaches it,
so the dry run is not ok. On an assumed path it adds a warning at the node's path, `a run that takes this path
fails here; the walk took it because of placeholder values`, and leaves `ok` as it is; the report's `output` is
then `null`.

A warning with the same path and message is reported once per dry run.

#### Rule V: what a condition can be

A condition is decided statically as *always* (it holds in every run), *never* (it holds in no run) or *unknown*,
by one rule that the walk and the *cannot succeed* check both apply:

- **A condition without references has its run-time value.** A condition, or any part of one, with no `$ref`, no
  `{{path}}` and no `exists` in it is never assumed: it is evaluated exactly as a run evaluates it (canonical JSON
  for equality). So `{"ne": [1, 1]}`, `{"gt": [1, 2]}`, `{"truthy": false}` and `{"not": {"eq": [1, 1]}}` never
  hold, and `{"eq": [{"a": 1, "b": 2}, {"b": 2, "a": 1}]}` always holds.
- **`and`, `or` and `not` combine by logic.** `and` never holds when one part never holds, and always holds when
  every part always does; `or` always holds when one part always does, and never holds when every part never
  does; `not` turns always into never and never into always.
- **References, by their declared schemas.** `eq` of the same reference (without `default`) on both sides always
  holds and `ne` never does. `eq` of a reference and a literal never holds when the literal is not valid for the
  reference's declared schema; when that schema allows only a finite set of values (`const`, `enum`, a `boolean`,
  a `null`), `eq` always holds when every one of them equals the literal and never holds when none does. `ne` is
  the opposite of `eq`. `truthy` of such a reference always or never holds when all or none of its values are
  truthy.
- **Everything else is unknown**: `gt`, `gte`, `lt`, `lte` and `exists` with a reference, a reference whose schema
  is not statically known, a reference with a `default`. An unknown condition can hold.

So a loop with `onLimit: "fail"` and `until: {"and": [{"ne": [1, 1]}, {"truthy": {"$ref": "input.go"}}]}` is
reported as failing at its bound (`would fail: reached maxIterations <n>`, the dry run is not ok), whatever the
schema of `input.go`, exactly as every real run of it fails.

### What `ok` means

`ok` is true exactly when the document is valid, no problem has `severity: "error"`, the walk was not truncated,
and it did not end at a `fail` that every run reaches. Warnings never change `ok`: a report can be `ok: true` and
still list `placeholder_dependent` warnings in `problems`.

## Graph export

`toGraph(document)` returns `{nodes: [{id, kind, label}], edges: [{from, to, kind, label}]}`. Edge kinds: `next`
(between steps of a sequence), `contains` (a sequence to its first step, a parallel to each branch, a map or loop
to its body, labelled `each <as>` / `max <n>`), `case` (labelled with the `when` value), `default`,
`low_confidence` (labelled `< <below>`), and `call` (to a `workflow:<name>` node). `toMermaid(graph)` renders it
as a Mermaid `flowchart TD` with every label quoted and escaped. Both are served by `POST /v1/workflows/graph`
and `GET /v1/workflows/:name/graph` and printed by `runwright workflows graph [--mermaid]`.

## Durability inside workflows

The executor wraps every node in `ctx.memo("wf/<scope><nodeId>")`, which journals `node.started` and
`node.finished` with the node's output. `<scope>` encodes the enclosing map indexes (`<mapId>[i]/`), loop
iterations (`<loopId>#i/`) and sub-workflow calls (`<callId>>/`), so every iteration has its own keys. Tool,
model, decide, wait and agent nodes use `ctx.tool`, `ctx.model`, `ctx.ask` and the agent loop under child keys.
Consequences:

- A workflow run that crashes resumes mid-flight; finished nodes return their journalled output and are not run
  again (inside a parallel group or a map too).
- It can be paused, resumed and cancelled like any run. A pause or a forced shutdown that aborts a tool node's
  call does not fail the node: the call is run again or waits for a person, as described under
  [Retry and deadlines](#retry-and-deadlines).
- The owning agent's tool policy (including `ask` approvals and the server deny list), spend cap, tool-call budget
  and turn limit apply to every node (`model` and `decide` calls count as turns).

### How node outputs are stored

Secrets are redacted before anything is journalled ([security.md](security.md#redaction)), and a resumed run
continues with what was stored. A node's output is therefore journalled field by field, so that `steps.<id>.route`
or `steps.<id>.completed` reads the same after a resume as in the run that wrote it. The field names the executor
wrote are stored as they are, whatever secrets exist: `ok`, `content`, `data` (tool); `value`, `confidence`,
`reason`, `route`, `fallback` (decide); `iterations`, `completed`, `last` (loop); `answer` (wait); `text`, `data`
(agent); and the branch ids of a parallel group. What is inside each field is redacted by what it holds:

| Field | Stored as |
|---|---|
| `ok`, `route`, `iterations`, `completed` | as computed (the executor's own booleans, counters and words) |
| `content`, `reason`, `answer`, `text` | text: a secret inside is replaced by its placeholder |
| `data`, `value`, `confidence`, a model node's output | redacted whole: strings, object keys too, and a number whose digits hold a secret becomes the placeholder text |

A composite's output follows what it encloses: a sequence's is stored as its last step's, a map's as a list of its
body's, a parallel group's with one field per branch, a loop's `last` and a decision's `fallback` as the enclosed
node's, and a branch's as its cases' when they all end in nodes of one shape (otherwise it is redacted whole). A
composite also journals a copy of the outputs of the nodes it encloses, by node id, so that a later reference to one
of them resolves after a resume; that copy is stored by the same rules.

The output of a `call` node, of a `model` node and a workflow's result are built by the author's schema or
expression, and are redacted whole: a reference through such a value to a name that is, or contains, a secret's
value does not resolve (for example `steps.<call>.confidence` when the sub-workflow returns a whole decision and a
secret's value is `confidence`). A reference to the decide node's own output is not affected. Node ids are stored as
they are (they are part of every node record's key): do not put a secret value in a node id.

## TypeScript builder

`src/workflow/builder.ts` (package export `runwright/workflow`) builds typed documents in code. `build()` runs the
validator and throws `workflow_invalid` with every problem when there is an error.

```ts
import { node, ref, tpl, workflow } from "../src/workflow/builder.ts";

const triage = workflow("triage")
  .describe("Classify a ticket; unsure ones go to an agent")
  .input("Input", { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } } })
  .output("Output", { type: "object", required: ["urgent"], properties: { urgent: { type: "boolean" } } })
  .root(node.sequence("main",
    node.decide("urgent", {
      question: `Is this urgent?\n${tpl("input.ticket")}`,
      decision: { type: "yes_no" },
      lowConfidence: {
        below: 0.7,
        run: node.agent("review", { message: `Decide urgency: ${tpl("input.ticket")}`, maxTurns: 4, output: "Output" }),
        value: ref("fallback.data.urgent"),
      },
    }),
  ))
  .result({ urgent: ref("steps.urgent.value") })
  .build();
```

Helpers: `ref(path, default?)`, `literal(value)`, `tpl(path)` (a `{{path}}` fragment), and `node.tool`,
`node.model`, `node.decide`, `node.branch`, `node.sequence`, `node.parallel`, `node.map`, `node.loop`,
`node.call`, `node.agent`, `node.wait`, `node.fail`. `node.tool(id, tool, args)` takes `args` as a record of
argument expressions: a `ref(...)` or `literal(...)` in place of the record is a type error. Every node builder accepts `deadlineMs` (and `title`): in
its options object (`tool`, `model`, `decide`, `map`, `loop`, `agent`), as a last options argument (`node.branch(id,
on, cases, otherwise?, options?)`, `node.call(id, workflow, input, options?)`, `node.wait(id, question, choices?,
options?)`, `node.fail(id, message, options?)`), or as an options object right after the id (`node.sequence(id,
{deadlineMs}, ...steps)`, `node.parallel(id, {deadlineMs}, ...branches)`); `retry` is accepted only where the
kind has it. The builder also has `.schema(name, schema)` and
`.sub(name, document)` for inline sub-workflows; `build(options)` takes the same `{tools, resolveWorkflow}` as the
validator.

## Saved workflows and `run_workflow`

- `PUT /v1/workflows/:name` (`runwright workflows save <name> <file>`) validates and saves a document under a
  name matching `^[a-z][a-z0-9_-]{0,63}$`. It is validated as that name ([Saving and call
  cycles](#saving-and-call-cycles)). Saving a changed document creates a new version; an unchanged one
  returns the current version.
- Learning's skill promotion saves workflows with `source: "promotion"` under a name that is unique per skill
  (`promotedWorkflowName`, see [learning.md](learning.md#skill-promotion)). Such a name belongs to its skill:
  `PUT /v1/workflows/:name` on it answers 409 `conflict` (`details.reason: "promoted_workflow"`) and saves
  nothing, so no operator version can change what the skill runs.
- A `call` node can call saved workflows by name.
- The `run_workflow` tool (`{name, version?, input}`) runs a saved workflow as one tool call from an agent loop.
  With `version` (an integer from 1) exactly that version runs, and an unknown one is an error result `unknown
  workflow "<name>" version <n>`; without it, the latest version runs. Either way the version is resolved once
  per call and journalled, so a version saved later never changes a running call. It is resumable: after a
  suspend or crash it replays the workflow's finished nodes and continues. It honours its call's signal: when the
  call is aborted (for example by its deadline) it stops, see [Retry and deadlines](#retry-and-deadlines). When
  the workflow fails, the call returns an error result `workflow "<name>" failed: <message>`; when it failed in a
  model step that left a provider's retry-after wait outstanding, the result's `data` is `{providerWait:
  {retryAfterMs, retryAfterOverLimit?}}` (the part of the wait still to pass, and `true` when the engine stopped
  the call over `models.retry.maxRetryAfterMs`). List it in an agent's `tools` like any tool.

## Versioning

The format string `runwright.workflow/v1` names this version of the language and is required in every
document. A document with any other format string is rejected with the `format` problem. Saved workflows are
versioned separately: every changed document saved under a name gets the next version number, and runs pin the
version they resolved.
