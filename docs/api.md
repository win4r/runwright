# HTTP API reference (`/v1`)

The API is JSON over HTTP, served by `runwright serve` (default `http://127.0.0.1:7411`). The route table in
`src/server/routes/` is the source of truth; `GET /v1/api` returns a machine-readable description generated from
that same table. The TypeScript client in `src/client/index.ts` and the [CLI](cli.md) cover every operation.
The client's `requestTimeoutMs` option (default 30000 ms; a finite number from 1 to 2147483647, otherwise
`bad_request` when the client is created) limits every request, its body included, except the event stream; a
request over the limit fails with `unavailable` ("the Runwright server at <url> did not answer within <n> ms").
`waitForRun(id, {timeoutMs, pollMs, signal})` gives each request the signal and at most the time left of
`timeoutMs` (a finite number >= 0), polls every `pollMs` (a finite number > 0, default 100), and
rejects with `aborted` when the signal aborts and `unavailable` once `timeoutMs` has passed, even if a settled
run arrives after it.

## Conventions

**Authentication.** Every route needs `Authorization: Bearer <token>` except `GET /`, `GET /v1/health`,
`GET /v1/ready` and `POST /v1/hooks/:id` (which is authenticated by its [signature](#webhooks)). The token is in
`<data dir>/token` (or `RUNWRIGHT_TOKEN`) and is compared in constant time. A missing or wrong token gets 401
`unauthorized` with `WWW-Authenticate: Bearer`.

**Requests.** Bodies are JSON objects sent with `Content-Type: application/json` (another content type: 415 with
code `bad_request`); an empty body counts as `{}`. Bodies larger than `server.bodyBytes` (1 MiB) get 413
`body_too_large`. Parsing is strict: a syntax error, trailing text, a duplicate key, a `__proto__` key or nesting
deeper than 64 gets 400 `invalid_json`. Each body is checked against the route's schema (shown below and in
`GET /v1/api`); a mismatch gets 400 `validation_failed` with `details.problems: [{path, keyword, message}]`.
Unknown body fields are refused.

**Responses.** JSON (`application/json; charset=utf-8`) unless noted. Every response carries `X-Request-Id`,
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. Every JSON body, error bodies included, is
redacted for every secret the server knows before it is serialized: each string, each object key, and each
number whose digits hold a stored secret, which is returned as the placeholder string (`"maxCostMicros":
"[redacted]"` when `12345678` is a stored secret). The body is always valid JSON. A consumer that needs such a
number must not store that number as a secret; the stored value itself is unchanged (the engine keeps working
with the number). Commands to runs answer **202 Accepted** with the stored command: 202 means the
command was accepted, not that it took effect. A runner applies it shortly after, and the run's timeline says what
happened to it (`command.applied`, `command.rejected` with a reason, or `message.undelivered`; see
[architecture.md](architecture.md#commands)). The free text of a command (a message's `text`, an answer, the
`reason` of a deny or a cancel, the `result` of a skip) is redacted for every known secret before it is stored
([security.md](security.md#redaction)).

**Times** are epoch milliseconds. **Money** is integer micro-dollars (`1_000_000` = 1 USD).

**Integers** in a request body (limits, revisions, token counts in a definition) are at most 9007199254740991
(`Number.MAX_SAFE_INTEGER`); a millisecond delay in a scripted model's script (`delayMs`, `fail.retryAfterMs`) is at
most 2147483647. A larger value, `1e308` included, is 400 `validation_failed` with the field's path.

## Errors

Every error has one shape:

```json
{ "error": { "code": "run_terminal", "message": "run run_01J... is already completed", "details": { "runId": "run_01J...", "status": "completed" } } }
```

`details` is present only when there is something to add (for example `problems` for validation errors). The
message and `details` are redacted like any body: strings, keys, and numbers that hold a stored secret.

| Code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 (415 for a wrong content type) | malformed request: bad query parameter, conflicting idempotency keys, an idempotency key that is not well-formed Unicode, body not an object, a webhook body without a valid `delivery` or an `X-Runwright-Delivery` header that does not match it |
| `invalid_json` | 400 | the body is not strict JSON |
| `validation_failed` | 400 | the body or a definition does not match its schema; `details.problems` |
| `cron_invalid` | 400 | a cron expression outside the supported subset |
| `workflow_invalid` | 422 from the workflow routes (400 elsewhere) | the workflow document has errors; `details.problems` |
| `config_invalid` | 400 | invalid configuration |
| `reference_unresolved` | 400 | a workflow reference could not be resolved |
| `unauthorized` | 401 | missing or wrong bearer token |
| `webhook_signature` | 401 | missing, malformed or wrong webhook signature or timestamp |
| `webhook_replay` | 401 | the webhook timestamp is outside the replay window |
| `not_found` | 404 | no such route, run, agent, pending, workflow, item, trigger or file |
| `tool_unknown`, `model_unknown`, `secret_missing` | 404 | an unknown tool or model provider, a secret that is not set |
| `method_not_allowed` | 405 | the path exists with other methods (`Allow` header lists them) |
| `conflict` | 409 | a learning item is in the wrong status for the change; a trigger kept changing while a `PATCH`, a fire or a delivery was being handled |
| `run_terminal` | 409 | the run is already completed, failed or cancelled |
| `pending_not_open` | 409 | the pending is resolved, of another kind than the command resolves, or past its `detail.expiresAt` |
| `idempotency_mismatch` | 409 | an idempotency key reused with a different request |
| `illegal_transition` | 409 | a run state change the state machine forbids |
| `lease_lost`, `commands_pending`, `learning_conflict` | 409 | store fencing outcomes and a learning write whose expected item version no longer holds (internal; handled by the runner, not normally seen by API clients) |
| `trigger_disabled` | 409 | the trigger is turned off |
| `limit_reached` | 409 | a limit stopped an operation that may not pause |
| `etag_mismatch` | 412 | `If-Match` does not match the item's current ETag |
| `body_too_large` | 413 | the body is over the size limit |
| `precondition_required` | 428 | the change needs an `If-Match` header |
| `unavailable` | 503 | the store, the console page or a webhook secret is not available |
| `internal` and every other code (`schema_too_new`, `store_error`, `tool_failed`, `workspace_escape`, `ssrf_blocked`, `fetch_failed`, `model_transient`, `model_failed`, `model_output_invalid`, `workflow_failed`, `deadline_exceeded`, `seal_failed`, `aborted`) | 500 | unexpected failures; the message of a non-Runwright error is not sent, only logged |

## Pagination

`GET /v1/runs` and `GET /v1/pendings` are paged by cursor: `limit` (1–200, default 50) and `cursor` (the
`nextCursor` of the previous page, opaque). `nextCursor` is `null` on the last page. Runs come newest first,
pendings oldest first. Pagination is keyset-based, so new rows never shift a page.

`GET /v1/runs/:id/files` is paged the same way with its own bounds: `limit` 1–1000, default 200, files ordered by
path. Its `cursor` is the base64url of the last path returned; a cursor that does not decode to a path is 400
`bad_request`. No listing is ever cut short silently: either it is complete or it has a `nextCursor`.

The client (`src/client`) follows every page by itself only for `listFiles`, whose list the run's workspace
bounds; runs, pendings and the journal grow without bound over time, so `listRuns`, `listPendings` and
`timeline` return one page and leave the next to the caller, and so does the CLI (see
[cli.md](cli.md#lists-and-paging)).

## Idempotency

`POST /v1/runs` accepts an idempotency key in the `Idempotency-Key` header or as `idempotencyKey` in the body
(1–200 characters of well-formed Unicode; if both are given they must be equal, else 400). A key that holds an
unpaired surrogate (in JSON, a lone `\ud800` escape) is refused with 400 `bad_request` before anything is read:
UTF-8 would encode every unpaired surrogate the same way, so two different keys would share a digest. The first request with a key creates the run
(201, `created: true`); a repeat returns the same run (200, `created: false`); a repeat whose agent, input or
limits differ gets 409 `idempotency_mismatch`.

- A key is stored, and returned in `run.idempotencyKey`, only as `sha256:<hex digest of the key>` (the SHA-256 of
  the key's UTF-8 bytes, lower-case hex; `idempotencyDigest` in `src/store/idempotency.ts`). The key's text is
  never stored. For example the key `k-1` is reported as
  `sha256:7c35c5a1785d20704e44d5de4beb81c1fce91b6fe48ed7c3159af6f7f832078b`.
- Two requests are the same request when the key's digest is equal and the fingerprint of the request **as
  sent** is equal: the SHA-256 of the canonical JSON of `{agentId, revision, input: {message, data}, limits}`,
  with `revision` as sent and `limits` as the limit fields sent (each `null` when omitted), `message` defaulting
  to `""` and `data` to `null`, taken before the input is redacted (`requestFingerprint`). Adding, deleting or
  rotating a secret, or restarting the server, never changes whether two requests are the same.
- **The key is looked up first.** With a key, the server computes the fingerprint from the body as sent and asks
  the store for the run this key already started (`findIdempotentRun`, which reads the run's row by the key's
  digest and nothing else) before it reads the agent, its revision, its workflow or the secrets. A request whose
  key already has a run is answered with that run (200, `created: false`), or with 409 `idempotency_mismatch`
  when the fingerprints differ, and nothing else is read or checked. Only a request with an unused key goes on:
  the revision is read (404), the input is redacted, `data` is validated against that revision's workflow input
  schema (400), and the run is created on that revision. If that validation refuses the request but an identical
  request with the same key created a run in the meantime, that run is returned (200) instead of the error.
- So a repeat returns the same run whatever changed in between: secrets added, deleted or rotated, a new agent
  revision, another workflow input schema, a restart. The run stays pinned to the revision it started with.
- A run whose stored request hash is empty (a run migrated from schema version 3 whose stored input had been
  redacted, see [architecture.md](architecture.md#the-store)) is returned for its key without comparing the
  request.
- Triggers start runs with keys of their own, stored the same way: `cron:<trigger>:<time>`,
  `webhook:<trigger>:<delivery>` and `manual:<trigger>:<request id>` (one per `POST /v1/triggers/:id/fire`
  request). A trigger fire never gets
  `idempotency_mismatch`: a repeated fire returns the run its key started the first time.

## Records

Shapes are defined in `src/store/types.ts`. The ones most responses carry:

- **RunRecord** `{id, agentId, revision, status, input: {message, data}, output, error: {code, message} | null,
  limits: {maxCostMicros, maxToolCalls, maxTurns, allowUnpriced}, idempotencyKey (`"sha256:<64 hex>"`, the
  digest of the key the run was created with, never its text; `null` without a key), trigger: {id, kind} | null,
  epoch, leaseOwner, leaseExpiresAt, journalSeq, openPendings, usage: {inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens, costMicros, costUnknown, toolCalls, turns}, createdAt, startedAt, finishedAt, updatedAt,
  journalArchivedAt}`. When `usage.costUnknown` is true the cost must be shown as unknown, not as `costMicros`.
- **PendingRecord** `{id, runId, agentId, kind, stepKey, title, detail, status: "open" | "resolved", resolution,
  createdAt, resolvedAt}`. `kind` is `question`, `approval`, `spend_cap`, `tool_budget`, `turn_limit` or
  `interrupted`; the `detail` of each kind is listed in [architecture.md](architecture.md#pendings). An
  `interrupted` pending's detail is `{tool, args, attempt, reason}`, with `reason` `"crash"`, `"pause"` or
  `"shutdown"` (absent on pendings opened by older versions). A pending of any kind opened inside a node deadline
  also carries `detail.expiresAt` (optional, ms since epoch): the instant by which it must be answered. A pending
  that was not answered by then is resolved `{expired: true, expiresAt}` ([Pendings](#pendings-what-needs-you)).
- **CommandRecord** `{id, runId, command, createdAt, consumedAt}`.
- **JournalRecord** `{runId, seq, epoch, ts, type, key, data}`; the record types (among them `model.started`,
  `model.invalid`, `model.finished`, `tool.started`, `tool.finished`, `tool.interrupted`) are listed in
  [architecture.md](architecture.md#journal-records).
- **AgentRecord** `{id, name, currentRevision, createdAt, updatedAt}`; **AgentRevision** `{agentId, revision,
  definition, definitionHash, createdAt}`.
- **LearningItem** `{id, agentId, kind, name, title, description, body, status, version, etag, sourceRunId,
  promotedWorkflow, promotedWorkflowVersion, promotionAttempts, createdAt, updatedAt}`; `promotedWorkflowVersion`
  is the version of `promotedWorkflow` the skill was promoted to (`null` when it is not promoted, or for a
  pointer an upgrade could not match); see [learning.md](learning.md#skill-promotion).
- **TriggerRecord** `{id, name, kind, agentId, enabled, cron: {expression, timeZone} | null, webhook:
  {secretName} | null, message, limits, lastFiredAt, nextFireAt, createdAt, updatedAt}`.
- **SecretStatus** `{name, set, updatedAt}`; never a value.
- **UsageRow** `{key, runs, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicros,
  unknownCostCalls}`.

## Routes

### System

| Method and path | Auth | Parameters / body | Success |
|---|---|---|---|
| `GET /` | none | – | the web console (HTML with a strict Content-Security-Policy, `X-Frame-Options: DENY`) |
| `GET /v1/health` | none | – | `{status: "ok", version}` |
| `GET /v1/ready` | none | – | `{status: "ready", schemaVersion, runner: {id, active} \| null}`, or 503 `unavailable` |
| `GET /v1/api` | bearer | – | the [API description](#api-description) |

### Agents

| Method and path | Parameters / body | Success |
|---|---|---|
| `GET /v1/agents` | – | `{agents: [{agent, definition}]}` (current definitions) |
| `POST /v1/agents` | `{id?, definition}`; `id` matches `^[a-z0-9][a-z0-9_-]{0,63}$`, else derived from `definition.name` (lower-cased, other characters as `-`) | 201 (new agent or revision) or 200 (unchanged) `{agent, revision, created}` |
| `PUT /v1/agents/:id` | `{definition}` | 201 or 200 `{agent, revision, created}` |
| `GET /v1/agents/:id` | – | `{agent, revision}` (current revision) |
| `GET /v1/agents/:id/revisions` | – | `{revisions}`, newest first |
| `GET /v1/agents/:id/revisions/:n` | `n` ≥ 1 | `{revision}` |
| `GET /v1/agents/:id/learning/metrics` | – | `{metrics: {agentId, before, after}}`, each `{runs, avgCostMicros, avgInputTokens, avgOutputTokens, avgDurationMs}` |

The definition is validated in full: its shape (`name`, `instructions`, `model`, `tools`, `limits`, `learning`,
optional `workflow` and `secrets`), that every listed tool is registered (or is `recall` / `run_workflow`), and
that an embedded workflow has no errors. An embedded workflow is not a saved workflow: its own `name` is not an
identity, so a `call` to a saved workflow of the same name calls that saved workflow. Problems come back as 400 `validation_failed` with paths under
`$.definition`. Saving an unchanged definition returns the current revision; a changed one creates the next.

Agent definition:

```json
{
  "name": "ask-and-write",
  "instructions": "Ask for a name, then write a greeting to greeting.txt.",
  "model": { "provider": "scripted", "name": "scripted-1", "script": { "turns": [] } },
  "tools": [ { "name": "ask_person" }, { "name": "write_file", "policy": "allow" } ],
  "limits": { "maxCostMicros": 50000, "maxToolCalls": 10, "maxTurns": 8 },
  "learning": false
}
```

`model` is `{provider: "scripted" | "anthropic" | "openai-compatible", name, baseUrl?, apiKeySecret?,
maxOutputTokens?, contextTokens?, script?}`. `secrets` lists names of sealed secrets the run is handed.

### Runs

| Method and path | Parameters / body | Success |
|---|---|---|
| `POST /v1/runs` | `{agentId, message?, data?, limits?: {maxCostMicros?, maxToolCalls?, maxTurns?, allowUnpriced?}, revision?, idempotencyKey?}`; header `Idempotency-Key` | 201 new / 200 existing `{run, created}` |
| `GET /v1/runs` | query `agentId`, `status` (comma list of statuses), `triggerId`, `limit`, `cursor` | `{runs, nextCursor}` |
| `GET /v1/runs/:id` | – | `{run, pendings}`: every open pending of the run, oldest first (the server reads the store page by page until the last one, so the list is never one page of a longer one) |
| `POST /v1/runs/:id/cancel` | `{reason?}` | 202 `{command}` |
| `POST /v1/runs/:id/pause` | `{}` | 202 `{command}` |
| `POST /v1/runs/:id/resume` | `{}` | 202 `{command}` |
| `POST /v1/runs/:id/messages` | `{text}` (1 character to 1 000 000) | 202 `{command}` |
| `POST /v1/runs/:id/limits` | at least one of `{maxCostMicros, maxToolCalls, maxTurns, allowUnpriced}` | 202 `{command}` |
| `GET /v1/runs/:id/timeline` | query `after` (seq, default 0), `limit` (1–1000, default 500) | `{records, nextAfter, archived}` |
| `GET /v1/runs/:id/events` | header `Last-Event-ID` or query `after` | an [SSE stream](#server-sent-events) |
| `GET /v1/runs/:id/files` | query `limit` (1–1000, default 200), `cursor` (the `nextCursor` of the previous page) | `{files: [{path, size, modifiedAt}], nextCursor}`, ordered by path; `nextCursor` is `null` on the last page (see [Pagination](#pagination)); the client's `listFiles` and `runwright runs files` follow it to the end |
| `GET /v1/runs/:id/files/<path>` | the file's path inside the workspace | the file's bytes |
| `GET /v1/runs/:id/learning` | – | `{uses: [{runId, itemId, version, mode: "full" \| "line", opened}]}` |

Notes:

- `message` defaults to `""` and `data` to `null`. `revision` pins an older revision; the default is the current
  one. With an idempotency key the key is looked up first, and a key that already started a run is answered
  with that run before anything below happens ([Idempotency](#idempotency)). For a new request the revision is
  read (404 when the agent or the revision does not exist), the input is redacted (every known secret in
  `message` and in every string and key of `data` becomes `[redacted]`), then, for an agent with a `workflow`,
  `data` is validated against that revision's workflow input schema (400 `validation_failed`), then the run is
  created, so the stored input is exactly what was validated. The run is pinned to the revision its data was
  validated against, also when no `revision` was sent: an agent saved in between does not change it. The
  idempotency fingerprint is taken from the request as sent, before redaction.
- `messages`: a message is delivered at the agent loop's next turn boundary. A message that is applied after
  the run's last turn, once the run has recorded its output, is not delivered: the timeline shows it as
  `command.rejected` (reason "the run had already finished its work; the message was not delivered"), or as
  `message.undelivered` when it was applied earlier but the driver never took it (a workflow run). `cancel` and
  `pause` sent while the last step is finishing still take effect: the run ends `cancelled` or `paused` instead of
  `completed`.
- A `waiting` run leaves that state when a command arrives or when a node deadline passes: a run waiting on a
  pending that carries `detail.expiresAt` is woken at that instant (within one poll interval, `runner.pollMs`,
  of the instant when a runner has a free slot; a runner whose slots are all busy does not look for work, so the
  wake-up then waits until a slot is free) with no command sent, closes the pending as expired and fails the step
  ([workflows.md](workflows.md#retry-and-deadlines)). A `paused` run is not woken; when it is resumed after the
  instant, the node fails.
- Limits, in `limits` of `POST /v1/runs` and in the body of `POST /v1/runs/:id/limits`: `maxCostMicros`,
  `maxToolCalls` and `maxTurns` are whole numbers from 0 to 9007199254740991 and `allowUnpriced` is a boolean.
  A limit cannot be removed over the API, only changed: `null` (or any other value) is 400 `validation_failed`,
  and a run started without a limit keeps none until one is set. The client's `RunLimitsInput` type allows
  exactly these fields, without `null`.
- Commands (`cancel`, `pause`, `resume`, `messages`, `limits`) need the run to exist (404) and not to be terminal
  (409 `run_terminal`). Raising a limit resolves a `spend_cap`, `tool_budget` or `turn_limit` pending when the
  check passes. `allowUnpriced: true` lets calls to unpriced models run under a cap and counts their cost as
  zero; it does not switch the cap off: every priced call is still admitted only when `known spend + reservations
  + its worst case <= cap` ([architecture.md](architecture.md#policy-caps-and-budgets)).
- `timeline`: `nextAfter` is the seq to pass as `after` for the next page, or `null` at the end. A run whose
  journal was archived answers `archived: true` with no records.
- Files are confined to the run's workspace (traversal and symlink escapes get 404). Text-like files are sent
  as `text/plain; charset=utf-8` inline, images with their image type, PDF and unknown types as attachments; every
  file response has `Content-Security-Policy: sandbox; default-src 'none'`.

### Pendings ("what needs you")

| Method and path | Parameters / body | Success |
|---|---|---|
| `GET /v1/pendings` | query `status` (`open` \| `resolved`, default `open`), `runId`, `agentId`, `kind`, `limit`, `cursor` | `{pendings, nextCursor}`, oldest first |
| `GET /v1/pendings/:id` | – | `{pending}` |
| `POST /v1/pendings/:id/answer` | `{answer}` | 202 `{command}` (kind `question`) |
| `POST /v1/pendings/:id/approve` | `{always?}` | 202 `{command}` (kind `approval`; `always` also approves, in the same commit, every other open approval of that tool in the run that had not expired when the command was created, and the tool's later calls; a call already denied stays denied) |
| `POST /v1/pendings/:id/deny` | `{reason?}` | 202 `{command}` (kind `approval`; the reason is the tool result the model sees) |
| `POST /v1/pendings/:id/resolve` | `{action: "retry" \| "skip" \| "cancel", result?}` | 202 `{command}` (kind `interrupted`; `retry` runs the call again after checking the server deny list, `result` is the tool result used by `skip`) |

A command for a pending that is resolved or of another kind gets 409 `pending_not_open`; for a finished run, 409
`run_terminal`. A pending whose `detail.expiresAt` (ms since epoch, set when it was opened inside a node deadline,
see [workflows.md](workflows.md#retry-and-deadlines)) has passed also gets 409 `pending_not_open`, with the message
`pending <id> expired at <ISO 8601 time>` and `details: {pendingId, status, kind, expiresAt}`. That check is the
early answer only: the run's own rule is the authority, so a command created at or after the instant that still
reaches the run is not applied and shows up in the run's timeline as `command.rejected` with the same reason. An
answer the server accepted before the instant counts, however late the run takes it. A pending nobody answered in
time is resolved `{expired: true, expiresAt}` by the run itself (a waiting run is woken at the instant for that)
and the step that opened it fails with `deadline_exceeded`. `spend_cap`, `tool_budget` and `turn_limit` pendings are resolved through
`POST /v1/runs/:id/limits`.

### Workflows

| Method and path | Parameters / body | Success |
|---|---|---|
| `POST /v1/workflows/validate` | `{document, embedded?}` | 200 `{ok, problems}` (also when invalid) |
| `POST /v1/workflows/dry-run` | `{document, embedded?, input?, decisions?: {<nodeId>: {value, confidence}}}` | `{report: DryRunReport}` (see [workflows.md](workflows.md#dry-run)); `report.problems` can hold warnings with code `placeholder_dependent` while `report.ok` is true, because warnings never change `ok`; 422 `workflow_invalid` with `details.problems` if the document has errors |
| `POST /v1/workflows/graph` | `{document, embedded?}` | `{graph, mermaid}`; 422 if invalid |
| `GET /v1/workflows` | – | `{workflows: [{name, version, source, createdAt}]}` (latest version of each) |
| `PUT /v1/workflows/:name` | `{document}`; `name` matches `^[a-z][a-z0-9_-]{0,63}$`. The document is validated as `:name` (a `call` to `:name` is the document itself, whatever its own `name` says), inside the save's transaction, against the stored workflows as that transaction sees them | 201 (new version) or 200 (unchanged) `{workflow, created}`; 422 `workflow_invalid` with `details.problems` if invalid, including a direct or indirect sub-workflow cycle (a `call_cycle` problem), also one that two concurrent saves would close together (one of them is refused); 409 `conflict` with `details: {reason: "promoted_workflow", name, skillItemId}` when the name belongs to a promoted skill (nothing is saved) |
| `GET /v1/workflows/:name` | query `version` (default latest) | `{workflow: {name, version, document, documentHash, source, skillItemId, createdAt}}` |
| `GET /v1/workflows/:name/graph` | – | `{graph, mermaid}` |

Validation uses the server's tool registry and saved workflows. Formats are described in
[workflows.md](workflows.md).

`validate`, `dry-run` and `graph` check a document that is not being saved. By default it is checked as the
saved workflow of the `name` it carries: a `call` to that name is a call to the document itself. With
`embedded: true` (a boolean; default `false`) it is checked exactly as an agent's embedded workflow is checked when
the agent is saved (`POST /v1/agents`, `PUT /v1/agents/:id`): it is not a saved workflow, so no `call` resolves to
it by its own name, and the dry run's own validation uses the same identity. So an embedded workflow `helper`
whose root calls the saved workflow `helper` saves with its agent and graphs with `embedded: true`, while without
it the same document is a `call_cycle`. The console's agent page sends `embedded: true` for its Workflow tab.

### Learning

| Method and path | Parameters / body | Success |
|---|---|---|
| `GET /v1/learning` | query `agentId`, `status` (`active` \| `held` \| `retired`), `kind` (`note` \| `skill`) | `{items}` |
| `GET /v1/learning/:id` | – | `{item}` and an `ETag` header |
| `GET /v1/learning/:id/history` | – | `{history: [{itemId, version, action, title, description, body, status, actor, note, at}]}`, oldest first |
| `POST /v1/learning/:id/retire` | header `If-Match`; body `{note?}` | `{item}` + `ETag` (active or held → retired) |
| `POST /v1/learning/:id/restore` | header `If-Match`; body `{note?}` | `{item}` + `ETag` (retired → active) |
| `POST /v1/learning/:id/approve` | header `If-Match`; body `{note?}` | `{item}` + `ETag` (held → active) |
| `PATCH /v1/learning/:id` | header `If-Match`; body at least one of `{title, description, body}`, plus `note?` | `{item}` + `ETag` |

The ETag is `"<version>-<8 hex>"`; `If-Match` accepts it with or without quotes. Missing `If-Match`: 428
`precondition_required`; a stale one: 412 `etag_mismatch`; a change not allowed from the item's status: 409
`conflict`. A `title`, `description`, `body` or `note` that contains a stored secret, a credential-shaped string
or a hidden or bidirectional-control character is refused with 400 `validation_failed`, `details.problems:
[{path, keyword, message}]` with the field's path (`$.title`, `$.description`, `$.body`, `$.note`), keyword
`secret` or `hidden_character`, and a message that names the field and the kind of problem, never the text;
nothing is stored.

### Triggers and webhooks

| Method and path | Parameters / body | Success |
|---|---|---|
| `GET /v1/triggers` | – | `{triggers}` |
| `POST /v1/triggers` | `TriggerInput` | 201 `{trigger}` |
| `GET /v1/triggers/:id` | – | `{trigger}` |
| `PATCH /v1/triggers/:id` | any `TriggerInput` fields (`enabled: false` turns it off). Applied as a compare-and-set: a change another request made meanwhile is merged, not overwritten (409 `conflict` if the trigger keeps changing); 404 when the trigger is gone, even if it was deleted while the change was being handled; a change that leaves an enabled cron trigger's expression and time zone as they are keeps its `nextFireAt`, a changed schedule or turning it on stores the next fire time after now | `{trigger}` |
| `DELETE /v1/triggers/:id` | – | 204 |
| `POST /v1/triggers/:id/fire` | `{data?}` | 202 `{run, created}` |
| `POST /v1/hooks/:id` | a JSON object with a `delivery` string; signature headers, `X-Runwright-Delivery` optional ([Webhooks](#webhooks)) | 202 `{runId, duplicate}` |

`TriggerInput`:

```json
{
  "name": "nightly report",
  "kind": "cron",
  "agentId": "reporter",
  "enabled": true,
  "cron": { "expression": "0 6 * * 1-5", "timeZone": "Europe/Berlin" },
  "message": "Write the nightly report",
  "limits": { "maxCostMicros": 200000, "maxToolCalls": 20, "maxTurns": 10 }
}
```

`kind` is `cron` (with `cron: {expression, timeZone?}`, time zone default `UTC`) or `webhook` (with `webhook:
{secretName}` naming a sealed secret that holds the signing key). `limits.maxCostMicros` is required and must be
positive: every trigger starts its runs with a cap. `message` is at most 65 536 characters. The trigger's
`message` and `name` are redacted for every known secret when the trigger is saved (created or changed), and a
webhook payload, which becomes the run's `data`, is redacted like any run input. Problems come back as
400 `validation_failed` with paths. A webhook delivery that already started a run is answered
`202 {runId, duplicate: true}` with that run also after the trigger was turned off: the delivery's key is looked
up before the trigger's `enabled` flag is read. A new delivery to a disabled trigger, and every
`POST /v1/triggers/:id/fire` on a disabled trigger (each such request has a key of its own), get 409
`trigger_disabled`. A fire starts a run only from the trigger as it is stored at that moment: when the trigger
is turned off, deleted or changed while `POST /v1/triggers/:id/fire` or a delivery is being handled, the request
gets 409 `trigger_disabled`, 404, or is handled again under the new definition (409 `conflict` if the trigger
keeps changing). See [configuration.md](configuration.md#triggers) for the cron subset.

A run a cron trigger starts has `input.data = {scheduledFor, missedFires, missedFiresCapped}`: `scheduledFor` is
the fire time it ran for (ISO 8601), `missedFires` the fire times missed beyond it, and `missedFiresCapped` is
`true` when counting stopped at its bound, so `missedFires` (then 999) is a lower bound
([configuration.md](configuration.md#triggers)).

### Secrets

| Method and path | Parameters / body | Success |
|---|---|---|
| `GET /v1/secrets` | – | `{secrets: [{name, set, updatedAt}]}` |
| `GET /v1/secrets/:name` | – | `{secret: {name, set, updatedAt}}` (`set: false` when missing) |
| `PUT /v1/secrets/:name` | `{value}` | `{secret}` |
| `DELETE /v1/secrets/:name` | – | 204 |

Names match `^[A-Z][A-Z0-9_]{0,63}$`; values are 8 to 16 384 bytes. No route ever returns a value.

### Usage

| Method and path | Parameters | Success |
|---|---|---|
| `GET /v1/usage` | `groupBy` (`day` \| `agent` \| `model`, default `day`; days are UTC), `from` (inclusive), `to` (exclusive), `agentId` | `{groupBy, rows: UsageRow[]}` |

`unknownCostCalls` counts the model calls with no known price; when it is above zero the group's real cost is
unknown and `costMicros` is only the priced part.

## Server-Sent Events

`GET /v1/runs/:id/events` answers `Content-Type: text/event-stream` and streams the run's journal:

```
id: 7
event: tool.finished
data: {"runId":"run_...","seq":7,"epoch":1,"ts":1763020800000,"type":"tool.finished","key":"t1.c0","data":{...}}

event: delta
data: {"runId":"run_...","key":"t2","text":"Hel"}

: ping

event: end
data: {"status":"completed"}
```

- One event per journal record with `seq` greater than the `Last-Event-ID` header (or the `after` query
  parameter; default 0): `id` is the record's `seq`, `event` its type, `data` the whole record as JSON,
  redacted as a value like a response body (a number whose digits hold a stored secret is the placeholder
  string; `data` always parses). The `id:` and `event:` lines are not redacted.
- To resume after a disconnect, send the last `id` you received as `Last-Event-ID`: you get every later record,
  with no gap and no duplicate.
- `event: delta` (no `id`) carries model text as it streams. Deltas come only from the server's in-process
  runner, are not stored, and are not replayed on resume. Their text is already redacted by the run's redactor
  (the secrets the run was handed and the credentials of the models it has called), across delta boundaries ([security.md](security.md#redaction)), so the text of one step's
  deltas can lag slightly behind the provider's. The deltas of one step key end with its `model.finished`,
  `model.failed` or `model.interrupted` record, with `model.retry` (a failed attempt; the next attempt's deltas
  follow under the same key, starting from its beginning), or with `model.invalid`, after which the deltas of the
  step's repair call follow under the same key.
- A comment line `: ping` is sent every `server.ssePingMs` (15 s).
- When the run is terminal and every record has been sent: `event: end` with the final status, then the stream
  closes.
- Records committed in this process are pushed immediately; a poll every `runner.pollMs` picks up records
  written by runners in other processes. Whenever a poll, a commit or another client connecting shows a later
  record or the end of the run, every open stream of that run that is behind is caught up, so each one gets every
  record and `end`.
- Backpressure: when the socket's buffer passes its high-water mark the server stops writing to that client and
  continues from the client's last record once the buffer drains, so a client that reads at a normal pace gets
  every record however large the backlog or a single commit is. Journal records are complete and ordered for
  every client. Deltas and pings are best effort: they are not journalled, so the ones that fall while a client's
  buffer is full are not sent to it. A client whose buffer stays full for 30 s is disconnected as too slow (one
  warning in the log) and can resume with `Last-Event-ID`.

The bearer token is required as a header, so browsers read this stream with `fetch`, not `EventSource`.

## Webhooks

A webhook trigger's endpoint is `POST /v1/hooks/<triggerId>`. The body is a JSON object whose string member
`delivery` is the delivery id: 1 to 128 visible ASCII characters (`!` to `~`), the same on every redelivery of
one event. The rest of the object is the sender's payload. Each delivery carries:

| Header | Value |
|---|---|
| `X-Runwright-Timestamp` | the current time in unix seconds |
| `X-Runwright-Signature` | `sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>` |
| `X-Runwright-Delivery` | optional; when it is sent (not empty after trimming) it must equal the body's `delivery` |

The delivery id is the `delivery` member of the signed JSON body, so it is covered by the signature: a captured
request replayed with another `X-Runwright-Delivery` header is rejected, and replayed unchanged it is the same
delivery and starts no second run.

The checks run in this order. Before the signature is verified only the trigger id in the path, the body's size
and the two signature headers are used; nothing of the body is parsed and no other header is looked at:

1. A body larger than `server.bodyBytes` (1 MiB) gets 413 `body_too_large`.
2. The trigger is looked up (404 for an unknown trigger or one that is not a webhook) and its signing secret is
   revealed (503 `unavailable` when it is not set).
3. The signature is verified over the raw body bytes and compared in constant time: a missing or malformed
   timestamp or signature, or a signature that does not match, gets 401 `webhook_signature`; a timestamp more
   than `triggers.webhookWindowSec` (300 s) from the server's clock gets 401 `webhook_replay`. For a body within
   the size limit sent to an existing webhook trigger whose secret is set, an unsigned or wrongly signed request
   always gets one of these, whatever its body or `X-Runwright-Delivery` header holds.
4. The body is parsed strictly; a body that is not JSON gets 400 `invalid_json`.
5. A body that is not a JSON object, or whose own `delivery` member is missing, not a string or not 1 to 128
   visible ASCII characters, gets 400 `bad_request` with the message
   `the signed body must be a JSON object with a "delivery" string of 1 to 128 visible ASCII characters`.
6. An `X-Runwright-Delivery` header that is sent and differs from the body's `delivery` gets 400 `bad_request`
   with the message `X-Runwright-Delivery does not match the "delivery" of the signed body`.

No run is created by a refused delivery. The run is created with the idempotency key
`webhook:<triggerId>:<delivery>`, so a redelivery (the same `delivery`, signed again with a new timestamp)
returns the first run with `duplicate: true` instead of starting a second one, also when the trigger was turned
off after the first delivery; a new delivery to a disabled trigger gets 409 `trigger_disabled`. When the trigger
changes while a delivery is handled, the delivery is verified again against the signing secret the trigger names
now. The run's `data` is `{delivery, body}`, where `body` is the whole parsed object, `delivery` included.

Signing a delivery with `openssl`:

```sh
SECRET='the webhook signing secret'
TRIGGER=trg_0123456789ABCDEFGHJKMNPQRS
BODY='{"delivery":"build-42-failed","event":"build.failed","build":42}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -sS -X POST "http://127.0.0.1:7411/v1/hooks/$TRIGGER" \
  -H 'Content-Type: application/json' \
  -H "X-Runwright-Timestamp: $TS" \
  -H "X-Runwright-Signature: sha256=$SIG" \
  --data "$BODY"
```

The run this starts has `data` `{"delivery": "build-42-failed", "body": {"delivery": "build-42-failed", "event":
"build.failed", "build": 42}}`. Sending the same `BODY` again, even with a new timestamp and signature, answers
`{"runId": <the same run>, "duplicate": true}`.

Set the secret first (`runwright secrets set HOOK_SECRET`) and create the trigger with `"kind": "webhook",
"webhook": {"secretName": "HOOK_SECRET"}`.

## API description

`GET /v1/api` returns:

```json
{
  "name": "runwright",
  "version": "v1",
  "operations": [
    { "id": "runs.create", "method": "POST", "path": "/v1/runs", "summary": "Start a run of an agent; ...",
      "auth": "bearer", "query": {}, "body": { "type": "object", "required": ["agentId"], "...": "..." },
      "response": "201 new / 200 existing {run, created}" }
  ]
}
```

One operation per route, in the order of the tables above, with `auth` `bearer`, `none` or `signature`, the
query parameters with a short description each, the body's JSON Schema (or `null`), and a short description of
the response. It is generated from the route table, so it cannot drift from the routes.
