# Architecture and the durability model

This document describes how Runwright is put together and what it guarantees when processes crash. The
[README](../README.md) has the short version; the [API](api.md), [CLI](cli.md), [workflow](workflows.md),
[learning](learning.md), [security](security.md) and [configuration](configuration.md) references cover the
surfaces.

## Module map

| Path | What it holds |
|---|---|
| `bin/runwright.ts` | CLI entry: silences the one `node:sqlite` experimental warning, then runs `src/cli/main.ts` |
| `src/core/` | errors with stable codes, strict JSON parsing and canonical JSON, ids, clock, redactor, ephemeral events |
| `src/schema/` | the project's JSON Schema validator (`validate.ts`), the placeholder generator that checks every value it makes against its schema (`placeholder.ts`), and the sampler that builds strings for a `pattern` (`pattern-sample.ts`) |
| `src/agents/definition.ts` | the agent definition type, its schema and validation |
| `src/store/` | the `Store` interface, the SQLite backend, migrations, the run state machine |
| `src/log/` | structured JSON logger (one object per line on stderr) |
| `src/models/` | provider interface, scripted / Anthropic / OpenAI-compatible providers, how a structured output of any JSON type travels through a provider's output tool (`output-transport.ts`), retry, price table |
| `src/tools/` | tool registry, workspace confinement, file tools, `ask_person`, `web_fetch` and its SSRF guard, `shell` |
| `src/engine/` | runner, session (durable step primitives), replay state, policy, budgets, command application |
| `src/agent/` | the agent loop driver and context compaction |
| `src/workflow/` | workflow types, references, validator, dry run (`dryrun.ts`, with `dry-check.ts` deciding which values were made up and whether a problem is certain), graph export, builder |
| `src/workflow/exec/` | the durable workflow executor and the `run_workflow` tool |
| `src/learning/` | learning hooks: selection, proposal checks, provenance, grader, promotion, `recall` |
| `src/triggers/` | cron parser, webhook signatures, trigger service and scheduler |
| `src/security/` | seal (AES-256-GCM), API token, secrets service, redaction at intake (`redactingStore`) |
| `src/config/` | configuration types, defaults, loading, data directory setup |
| `src/ops/` | journal retention and archival |
| `src/server/` | HTTP core, router, routes, SSE hub, API description, console and file serving |
| `src/client/` | dependency-free TypeScript client and local server discovery |
| `src/app/` | composition root that wires store, runner, server and scheduler |
| `src/cli/` | the `runwright` command line |
| `src/console/index.html` | the web console (one static page) |
| `src/bench/` | the benchmark behind `npm run bench` |

Nothing below `src/` keeps global mutable state: clocks, id sources, randomness, `fetch`, DNS lookup and loggers
are passed in, which is how the tests make time and ids deterministic.

## The store

One SQLite database, `<data dir>/runwright.db`, opened with `journal_mode=WAL`, `synchronous=NORMAL` (or `FULL`,
see [durability limits](#durability-guarantees-and-limits)), `busy_timeout=5000` and `foreign_keys=ON`. Every
statement is prepared once per store handle and every write is one short `BEGIN IMMEDIATE … COMMIT`. Times are
epoch milliseconds; JSON columns are text.

Code talks to it only through the `Store` interface in `src/store/types.ts`, so another backend could be added;
only SQLite is implemented.

**One commit per step.** A claimed run changes only through `commit(lease, batch)` (see
[fencing](#leases-epochs-and-fencing)). One `CommitBatch` carries everything a step writes, and all of it is
applied in one transaction after one lease check, or none of it is:

- `records`: the journal records;
- `transition`: a status change, with the run's output or error;
- `openPendings` and `resolvePendings`;
- `usage`: usage and cost rows, also added to the run's totals;
- `counters`: tool-call and turn increments;
- `setLimits`: the new effective limits;
- `consumeCommands`: the commands this step applied;
- `learning` (`LearningEffects`): the run's learning writes, namely conditional item writes (`puts`, each with
  the item version it expects, or `null` for "must not exist yet"), the items the run was `given`, the items it
  `opened`, and skill `promotions` (the attempt counter, and on success the saved workflow and the link to it).
  A put or promotion whose expected version no longer holds throws `learning_conflict` and rolls the whole batch
  back, journal records included.

Because learning writes travel in the same commit as the journal record of their step, the lease fence covers
them, and a crash can never apply them twice or without that record.

| Table | Contents |
|---|---|
| `schema_version` | one row per applied migration |
| `agents` | agent id, name, current revision |
| `agent_revisions` | immutable definitions, one per revision, with a hash of the canonical JSON |
| `runs` | status, pinned revision, input, output, error, limits, idempotency key, trigger, lease (`lease_owner`, `lease_epoch`, `lease_expires_at`), journal length, open-pending count, usage counters, archive markers |
| `journal` | the append-only per-run journal, keyed `(run_id, seq)` |
| `commands` | messages, answers, approvals, denials, limit changes, interrupted-call decisions, cancel, pause, resume; consumed by a runner |
| `pendings` | everything that waits for a person |
| `usage` | one row per model call: tokens, cost (NULL when unknown), whether the cost was assumed |
| `learning_items`, `learning_history`, `run_learning` | learned notes and skills, every version, and which run was given / opened what |
| `triggers` | cron and webhook triggers |
| `secrets`, `secret_history` | sealed secret blobs, and sealed retired values of replaced or deleted secrets (the store never sees plaintext) |
| `runners` | live runner processes (id, pid, host, concurrency, last seen) |
| `workflows` | saved workflow documents, versioned |

Indexes cover the claim query (`runs_claim_queued` on queued runs by `available_at`, `runs_claim_orphaned` on
running runs by `lease_expires_at`), run listings (keyset pagination on `created_at, id`), open pendings and
usage by day and by run. `journal` is `WITHOUT ROWID` with the primary key `(run_id, seq)`, so a timeline read is
one range scan.

**Migrations.** `src/store/migrations.ts` holds numbered migrations: `1 core`, `2 workflows-and-archive`, `3
promotion-pointer`, `4 idempotency-digest`, `5 wake-at`, `6 usage-saturation`, `7 secret-history` and `8
command-seq` (the current schema version is 8). Migration 3 adds `learning_items.promoted_workflow_version` and sets it, for
every promoted skill, to the highest version of the workflow row with that name that the skill owns
(`skill_item_id` = the item's id), or leaves it null when there is none. Migration 4 makes every stored idempotency key a digest, in one transaction:

1. a stored key of the form `redacted-sha256:<64 lower-case hex>` (what schema version 3 wrote for a key that
   held a known secret; its hex is already the SHA-256 of the original key) becomes `sha256:<the same hex>`;
2. every other stored key (the key's literal text) becomes `sha256:<hex SHA-256 of that text>`;
3. when several runs end up with the same digest (the old behaviour could store one key once as text and once as
   a digest), the run created first (by `created_at`, then `id`) keeps it and the others get no key; nothing
   else of those runs changes;
4. the request hash is cleared for every run whose stored input contains the text `[redacted]`, because it was
   taken over redacted text and cannot be reproduced from a request; a repeat of such a run's key returns the
   run without comparing the request. All other hashes stay valid, because the formula is unchanged;
5. the unique index `runs_idempotency` is rebuilt over the digests.

Migration 5 adds the nullable column `runs.wake_at` (the instant from which a waiting run is claimable again
although no command arrived, set by a node deadline; existing rows get NULL) and the partial index `runs_wake` on
it for waiting runs that have one.

Migration 6 clamps every usage counter of `runs` (tokens, cost micros, tool calls, turns) and of `usage` (tokens,
cost micros) to an integer from 0 to 2^53 − 1, touching only rows outside that range (a NULL cost stays NULL), so
a counter an older build let pass the limit reads back as the saturated total.

Migration 7 adds the table `secret_history` (`id`, `name`, `sealed`, `retired_at`) with an index on `name`: a
replaced or deleted secret value is kept there sealed, in the same transaction as the change, for as long as a run
that started before the change is unfinished, so it can still be redacted (see
[security.md](security.md#redaction)).

Migration 8 adds `commands.seq`, the order in which commands are applied: existing rows are numbered in the order
they were listed before (`created_at`, then `id`), a new command gets `MAX(seq) + 1` inside the write
transaction that inserts it, a unique index `commands_seq` covers it, and the index of unconsumed commands is
rebuilt as `(run_id, seq)`. So commands are applied in arrival order (the order their inserts committed), not in
the order of a clock that two processes may read differently.

Known limit: a caller's own key that literally had the form `redacted-sha256:<64 hex>` is read as a digest
written by schema version 3, so after the migration it no longer matches the same key sent again.
Opening a database with no `schema_version` table applies all of them; a database at an older version gets the
missing ones applied in order, each in its own transaction; a database newer than the code refuses to open with
`schema_too_new`.

**Idempotent run creation.** The store looks a key up, and stores it in `runs.idempotency_key`, only as
`idempotencyDigest(key)` = `sha256:<hex SHA-256 of the key>` (`src/store/idempotency.ts`); the key's text is
never stored. `runs.request_hash` is the fingerprint of the request as the caller sent it, before any redaction
(`requestFingerprint`: SHA-256 of the canonical JSON of agent id, revision, input and limits); `POST /v1/runs`
computes it from the request's fields as sent, before redacting them, and the store wrapper computes it from the input it receives before redacting
it. A run created with a key whose digest already exists returns the existing run with `created: false`; if the
fingerprints differ, the API answers 409 `idempotency_mismatch` (a stored hash that is empty is never compared).
Both inputs depend only on the request, so adding, deleting or rotating a secret, or a restart, never changes
the outcome. Next to `createRun` the store has `findIdempotentRun({idempotencyKey, requestFingerprint?,
strictIdempotency?})`: it returns the run the key already started, or `null`, reading only the `runs` row with
that digest (no agent, revision, workflow or secret), and throws `idempotency_mismatch` exactly when `createRun`
would for the same key and fingerprint; both use one lookup, and `createRun` repeats it inside its own
transaction so two concurrent first requests still create one run. The route `POST /v1/runs` and the store
wrapper `redactingStore` call `findIdempotentRun` before anything else, and the store's `fireTrigger` begins its
transaction with the same lookup (invariant I2): **nothing that
can change between two identical requests (which secrets exist, the agent's current revision, its workflow or
schema, whether a trigger is enabled) is read before the key lookup**, and a request whose key already has a run
is answered with that run (or 409 when the fingerprints differ) and with nothing else. A new request is then
validated against one revision and created with that revision's number, so the run is pinned to the revision
its input was validated against. Triggers use the same mechanism with keys like `cron:<trigger>:<time>` and
`webhook:<trigger>:<delivery>`, stored the same way, without the mismatch check.

**Saved workflows are validated inside the save.** `Store.saveWorkflow` takes an optional `check` that runs
inside the save's transaction, before anything is written, with `resolve(name)`: the latest stored document of
that name as of this transaction. A throw from `check` rolls the save back and is rethrown unchanged.
`PUT /v1/workflows/:name` validates the document only there, under the name it is saved as (`savedAs: name`, so
a `call` to `:name` is the document itself, whatever its own `name` field says) and against the stored workflows
that transaction sees. So a direct or indirect sub-workflow cycle is refused with 422 `workflow_invalid` (a
`call_cycle` problem) even when it would be closed by an update of the called workflow, and two concurrent saves
that would form a cycle together cannot both pass: the second one's check sees the first one's version. A
promotion checks its draft before its commit and saves under a skill-owned name that no stored workflow can
call yet; a later `PUT` that would close a cycle through a promoted workflow is refused by the same check.

## The run state machine

States: `queued`, `running`, `waiting` (blocked on a person: at least one open pending), `paused` (an operator
paused it), `completed`, `failed`, `cancelled`. The last three are terminal. The table is
`TRANSITIONS` in `src/store/state-machine.ts`; the store rejects every other transition with
`illegal_transition`. The store also refuses (`commands_pending`) every transition out of `running` to
`waiting`, `paused`, `completed`, `failed` or `cancelled` while the run has a command that is neither consumed nor
consumed by that same commit; only a release back to `queued` keeps unconsumed commands, for the next claim (see
[Commands](#commands)).

| From | To | Who | When |
|---|---|---|---|
| (none) | `queued` | `createRun` | the run is created (journal record `run.created`, epoch 0) |
| `queued` | `running` | `claimRuns` | a runner claims it (epoch + 1) |
| `running` | `running` | `claimRuns` | the lease expired and another runner claimed it (epoch + 1); not a status change |
| `running` | `waiting` | lease holder | a step opened a pending and nothing else can progress |
| `running` | `paused` | lease holder | a `pause` command was applied |
| `running` | `queued` | lease holder | graceful shutdown released the run |
| `running` | `completed` | lease holder | the driver returned (after learning, when enabled) |
| `running` | `failed` | lease holder | the driver threw an error |
| `running` | `cancelled` | lease holder | a `cancel` command was applied (or an interrupted call was resolved with `cancel`) |
| `waiting` | `queued` | `enqueueCommand`, `claimRuns` | any command arrives, or the run's wake time passed (a node deadline) |
| `paused` | `queued` | `enqueueCommand` | a `resume` or `cancel` command arrives |
| `completed`, `failed`, `cancelled` | – | – | terminal: no transitions |

Only the lease holder appends to the journal or changes state while a run is `running`. When nobody holds a run,
the only change the store makes by itself is the re-queue on an incoming command. Every command, including the
cancel of a waiting run, is applied by a runner after it claims the run, so a journal has exactly one writer at a
time.

## Journal records

Envelope: `{runId, seq, epoch, ts, type, key, data}`. `seq` is 1-based and dense, assigned inside the commit,
and is the SSE event id. `key` is the step key for step records and `null` for run-level records. Data shapes
are in `src/engine/journal-types.ts`.

| Type | Key | Written by | Meaning |
|---|---|---|---|
| `run.created` | – | `createRun`, or the store's `fireTrigger` for a trigger run | agent, revision, input, limits, trigger |
| `run.claimed` | – | session | a runner took the run at this epoch |
| `command.applied` / `command.rejected` | – | session | a command from the inbox, in arrival order (rejected with a reason, e.g. a pending of another kind, or a message that arrived after the run recorded its output: "the run had already finished its work; the message was not delivered") |
| `limits.changed` | – | session | the new effective limits |
| `inbox.taken` | step | `ctx.inbox` | messages people sent, handed to the driver |
| `model.started` | step | `ctx.model` | one provider attempt, written before it is sent: model, purpose, turn, worst-case input tokens, `maxOutputTokens`, worst-case cost; `repair: true` for the repair call of a structured-output step (absent in older records); `attempt`, the 1-based attempt of this call (absent in records written by an earlier version: attempt 1) |
| `model.invalid` | step | `ctx.model` | the first reply of a structured-output step did not match its schema: text, tool calls, output, `problems` (`{path, message}`), usage, cost; billed, and a repair call follows |
| `model.finished` | step | `ctx.model` | text, tool calls, structured output, usage, cost |
| `model.interrupted` | step | `ctx.model` | the attempt did not finish (`crash`, `pause`, `cancel`, `shutdown`, `deadline`); `assumedCostMicros`, its worst case, charged as an assumed cost; `attempt`, the attempt that was in flight (absent in older records) |
| `model.failed` | step | `ctx.model` | the call failed for good; replay rethrows the same error. From the attempt loop it carries `attempts` (the provider attempts the call made) and, exactly when the last attempt's billing was `"unknown"`, `assumedCostMicros` (its worst case, charged; `null` for an unpriced model). Both are absent in records written by an earlier version and in failures that are not provider attempts (the model could not be resolved, output still invalid after the repair); `retryAfterMs`, present when the call ended while a provider's retry-after wait was outstanding (the part still to pass, in ms from the record's time), and `retryAfterOverLimit: true`, present exactly when the call was not retried because that wait was longer than `models.retry.maxRetryAfterMs` |
| `model.retry` | step | `ctx.model` | a provider attempt failed with a transient error and another attempt follows: `{attempt, delayMs, code, message, status, billing, assumedCostMicros?}`, written when the attempt fails, in one commit with its charge; `assumedCostMicros` is present exactly when `billing` is `"unknown"`. `status`, `billing` and `assumedCostMicros` are absent in records written by an earlier version, which are ignored when a call resumes; `retryAfterMs`, the provider's retry-after hint in ms, present exactly when it gave one (`delayMs` then equals it) |
| `tool.started` | step | `ctx.tool` | tool, arguments, effect, attempt |
| `tool.finished` | step | `ctx.tool` | outcome, content, data, `untrusted`, truncation and the path of the full result (`fullResultPath`); when a full result was saved, also `fullResultSha256` (lower-case hex SHA-256 of the saved file's bytes) and `fullResultBytes` (its length), absent in older records; when the structured data was over the size limit and saved (`data` is then `null`), also `fullDataPath` (the workspace-relative path of the file holding its canonical JSON), `fullDataSha256` (lower-case hex SHA-256 of that file's bytes) and `fullDataBytes` (its length), absent otherwise and in records written by an earlier version |
| `tool.interrupted` | step | `ctx.tool` | a call left unfinished that is not run again by itself (any tool that is not read-only or resumable, and an idempotent write held back by [rule R](#tool-calls-started-finished-interrupted)): `{tool, args, attempt, reason}` with `reason` `crash` (found started but unfinished on replay, also for an idempotent write that a pause or a shutdown aborted and rule R then held back), `pause` or `shutdown` (aborted by a pause or a forced shutdown); older records have no `reason` and were all crashes |
| `pending.opened` / `pending.resolved` | step | primitives / command application | see [Pendings](#pendings) |
| `step.started` / `step.finished` | step | `ctx.memo`, `ctx.effect` (`step.finished` only) | a composite step (learning phases, workflow helpers) and its recorded value |
| `node.started` / `node.finished` | step | `ctx.memo` | a workflow node and its output |
| `node.retry` | step | `ctx.emit` | a workflow node attempt failed and will be retried after `delayMs`; the next attempt starts at the record's `ts + delayMs` in every session, so after a restart or a resume a node waits only what is left of its backoff (`ctx.sleepUntil`), never longer than `delayMs` in all |
| `context.compacted` | step | `ctx.emit` | older turns were summarised (`throughTurn`, tokens before and after) |
| `learning.given`, `learning.checked`, `learning.graded`, `learning.applied`, `learning.skipped`, `learning.promotion` | step | `ctx.emit` | learning, see [learning.md](learning.md); `learning.applied` is `{kept, held, conflicts}`, where `conflicts` (`{path, reason}`, absent in older records) lists the items not written because they changed after the run checked them |
| `message.undelivered` | – | session | `{commandId, reason}`: a message that was applied but that the driver never took before the run recorded its output (a workflow run, or a message between the last inbox check and the output); written in the same commit as `run.output`, or in the final commit of a run that ends without one; `reason` is "the run finished before the message could be delivered" |
| `run.output` | – | session | the driver's result (learning may follow) |
| `run.waiting` / `run.paused` / `run.released` | – | session | the run left `running` without finishing |
| `run.completed` / `run.failed` / `run.cancelled` | – | session | terminal |

Every record's `data` passes through the run's redactor before the commit, and then, in the store wrapper, through
the process-wide set of known secrets (`redactCommitBatch`, [security.md](security.md#redaction)). Both redact field
by field: free text as text; caller, model, tool and driver values whole (strings, object keys and numbers whose
digits hold a secret); Runwright's own field names, enumerated values, generated ids and numbers are written as they
are, because a resume reads them back. The value of a step or node, a model's structured output and a tool's data
are redacted whole unless the code that writes them declares their field specification, which both passes then use
([security.md](security.md#redaction)). `run.created`, which
`createRun` writes before any runner holds the run, carries the input as redacted at intake
([security.md](security.md#redaction)). All records of one step,
plus the pending rows, usage rows, counters and the status change that go with them, are written in one
transaction.

## Durable steps and replay

A run is executed by a **driver**, an async function of a `RunContext`. There are two: the agent loop
(`src/agent/loop.ts`) and the workflow executor (`src/workflow/exec/`). A driver never touches the store, a model
or a tool directly; it calls the step primitives on its context, each identified by a key that is unique within
the run and the same every time the driver reaches that point:

| Primitive | What it does |
|---|---|
| `ctx.model(key, request)` | a model call (caps, turn limit, structured output with one repair attempt) |
| `ctx.tool(key, call)` | a tool call (policy, approval, budget, argument validation, started/finished protocol) |
| `ctx.ask(key, question)` | a question to a person |
| `ctx.memo(key, meta, fn)` | a composite step whose result is recorded once; `fn` is told the journalled start of its step (`{startedAt}`, the `ts` of its `*.started` record, the same in every session); a cancel, pause or stop applied while its `*.started` record is written stops it before `fn` runs |
| `ctx.effect(key, meta, plan)` | a recorded step whose store writes (`learning` effects) commit in the same fenced transaction as its `<type>.finished` record, so both happen exactly once or neither does; `plan` only reads, and runs again after a crash before the commit or when the commit throws `learning_conflict` (at most three plans, then the conflict is rethrown); on replay the recorded value is returned and `plan` is not called |
| `ctx.inbox(key)` | the messages people sent since the last take; each message is handed to exactly one key |
| `ctx.emit(key, type, data)` | an informational record, written at most once per key and type; returns the stored record (the one just written, or the one found on replay), so its `ts` is the same instant in every session |
| `ctx.sleepUntil(at, {maxMs?})` | waits until the engine clock reads `at` (at once when it already does), never longer than `maxMs` from the call; ends early like `ctx.sleep` on a cancel, pause, stop or shutdown, and with `deadline_exceeded` in a deadline scope. A wait that ends at a journalled instant is waited once in all, across sessions |
| `ctx.child(prefix)` | the same run with every key prefixed by `prefix + "/"` |
| `ctx.deadline(deadlineMs, body, {startedAt?})` | runs `body` with a context whose steps share one deadline (see [Deadline scopes](#deadline-scopes)) |
| `ctx.withTools(names)` | the same run and key prefix restricted to the tools in `names`: every tool call made through it, its children and whatever those calls run is denied unless the tool is in `names`; scopes nest by intersection (see [policy](#policy-caps-and-budgets)) |
| `ctx.toolPolicy(tool, {assumeGranted?})` | the policy a call of `tool` would get through this context now (`deny` for an unregistered tool), from the same resolver as a real call; `assumeGranted` answers as if the learning context granted the tool; journals nothing |

Each primitive looks its key up in the journal first. If the journal holds the finished result, the primitive
returns it and does nothing else. **Resume is replay**: on claim a runner reads the run's journal once, builds an
in-memory index (`src/engine/state.ts`, a pure reducer over the records), calls the driver from the top, and
every finished step returns from the index until the driver reaches the first unfinished step.

Drivers must therefore be deterministic: given the same journal they issue the same keys in the same order. They
use no clock, no randomness and no store or file reads for control flow except through a primitive. Keys are
built from structure, for example `t3` (turn 3's model call), `t3.c0` (its first tool call), `t3.compact`, or
`wf/<scope><nodeId>` for a workflow node. A primitive that must stop the run (waiting on a person, paused,
cancelled, released at shutdown, lease lost) throws a control signal; drivers never swallow it, and code that runs
steps concurrently waits for every branch to settle before rethrowing the strongest signal.

## Leases, epochs and fencing

A lease is the triple `(lease_owner, lease_epoch, lease_expires_at)` on the run row; `lease_epoch` never
decreases.

1. **Claim.** `claimRuns` runs in one `BEGIN IMMEDIATE` transaction. It first requeues waiting runs whose
   `wake_at` passed (at most 100 per call, earliest first: `waiting → queued` with `available_at = wake_at`,
   `wake_at` cleared, a `run.queued` event and no journal record). Then it picks running runs whose lease expired
   (orphans, oldest expiry first), then queued runs that are available (oldest first), up to the runner's free
   slots. For each it sets `status = running`, `lease_owner = runner`, `lease_epoch = lease_epoch + 1`,
   `lease_expires_at = now + leaseMs`, and returns the lease `{runId, runnerId, epoch}`.
2. **Heartbeat.** One timer per runner renews all its leases every `heartbeatMs` (default a third of `leaseMs`);
   the store returns the run ids whose lease was not renewed (owner or status changed). A lost lease aborts that
   session at once and it writes nothing more.
3. **Commit.** `commit(lease, batch)` is the only way to append journal records or change a claimed run. In one
   transaction it checks `lease_epoch = lease.epoch AND lease_owner = lease.runnerId AND status = 'running'`;
   otherwise it throws `lease_lost` and writes nothing.

**Why a zombie cannot write.** A runner that was frozen (or partitioned from the database for longer than the
lease) still believes it holds the run. Meanwhile another runner claimed it, which raised the epoch. Every late
commit from the zombie carries the old epoch and is rejected, journal records included. Epoch equality is the
rule; expiry alone does not reject a write, so a runner that was merely slow and was not overtaken keeps going and
its next heartbeat renews the lease. A commit that moves the run out of `running` clears the owner and expiry.

**The workspace half.** The store fences journal writes; a file a stale runner renames into the workspace is not
a store write, and a check of the lease before the rename does not help, because the process can freeze right
after the check. So the workspace is fenced by the epoch too (**rule F**, `src/tools/workspace-stage.ts`): every
change the built-in file tools and the engine make inside a workspace has, as its one effective system call, a
`rename` or `link` with one end in `<workspace>/.runwright/stage/<epoch>`, the staging folder of the writer's own
epoch. `write_file` and `edit_file` write a temp file there and rename it into place, `delete_file` renames the
file into it, and a saved tool result is linked from a synced temp file there. A session claims the stage right
after it creates the workspace, before it replays the journal or runs a step:

1. it creates `stage/<epoch>` (`mkdir -p` of `stage/`, then `mkdir` of its own folder);
2. it lists `stage/`; a folder of a higher epoch means the run was taken over again, and the session ends like a
   fenced commit (no record written, `runner.fenced` logged). If the store still shows this session's lease, no
   claim made that folder (a claim creates it only after its store claim; `shell` or a host tool wrote it), and
   the run fails with an `internal` error instead of being claimed and fenced again after every lease period;
3. it renames every other entry to `.runwright/unstage/<random>` with one atomic rename and deletes it there.

A stale runner's late system call then fails with `ENOENT`, whether it was opening its temp file, renaming it or
linking it, and the call ends with `lease_lost` (a fenced result save is the `lease_lost` control signal, not an
`internal` error). The order of the steps is what makes this hold for every interleaving: an older claim whose
step 2 comes after a newer claim's step 1 sees the newer folder and stops; an older claim that passed step 2
earlier created its folder before the newer claim's step 1, so the newer claim's step 3 renames it away; a folder
once renamed away is never created again, because only step 1 creates it and no writer ever creates it. The
highest folder is kept, also after the run ends (it is what makes a late step 2 of an older epoch fail), so at
most one stays per workspace. The one effect that is not staged is the creation of a write's missing parent
directories, which happens after its temp file exists: a fenced writer can leave empty directories behind, never
content. Inside one process the file tools also share one queue per workspace, and a queued mutation whose call
was aborted while it waited does not start. `shell` and host tools are outside rule F: they get
`context.signal`, but a stale runner's shell command that is still running can still write.

Default lease: 30 s (`runner.leaseMs`, `RUNWRIGHT_LEASE_MS`, `--lease-ms`). Another runner takes over a dead
runner's runs once the lease expires; tests use leases of a few hundred milliseconds.

## Tool calls: started, finished, interrupted

`ctx.tool(key, {name, args})`, in order:

1. The journal has `tool.finished` for the key: return that result, with no further check.
2. The journal has `tool.started` with no finish (a crash happened mid-call, or a pause or a forced shutdown
   aborted the call), or `tool.interrupted`:
   - a **resumable** tool (built from durable steps: `ask_person`, `run_workflow`) is invoked again and replays
     its own inner steps;
   - a **read-only** tool (`effect: "read"`) is journalled `tool.started` with `attempt + 1` and run again;
   - a tool declared **`idempotent`** with `effect: "write"` (such as `write_file` and `delete_file`) is journalled
     `tool.started` with `attempt + 1` and run again **only under rule R** (below): when no write call of the run
     finished after this call's latest `tool.started`. Otherwise it is handled like the next bullet. **Declaring a
     tool `idempotent` is a promise about exactly this case: run again with the same arguments after it already
     took effect, it returns a result that is not an error and leaves the same end state.** `write_file` writes
     the same bytes again; **`delete_file` reports a file that is already absent as a success (`deleted: false`),
     not as an error**;
   - any other tool gets `tool.interrupted` (`reason: "crash"` when found on replay) and an `interrupted` pending,
     once per attempt. The run waits. A person resolves it one of three ways: **retry** (a new `tool.started` with
     the next attempt, then the call runs), **skip** (`tool.finished` with `outcome: "skipped"` and the result the
     person supplied, **cut by the same size limit as any other result**), or **cancel** (the run is cancelled). It is never re-run without that decision.
   **Rule R (recovery order).** An unfinished call of a tool declared `idempotent` is run again by itself only when
   no write call of the run finished after it started; otherwise repeating it could undo that finished work, so it
   waits for a person as an interrupted call. The promise above is about the call alone; it says nothing about
   other calls. In a workflow, parallel branches call tools at the same time: a `delete_file x` that removed `x`
   and had not yet committed its finish, then a `write_file x` in another branch that finished, then a crash:
   running the delete again would remove the file a finished step wrote. "A write call finished after it" is read
   from the journal alone (the replay state's `lastWriteFinishedSeq`): a `tool.finished` with a higher `seq` than
   this call's latest `tool.started`, whose own key has a `tool.started` with an `effect` other than `"read"` (a
   missing `effect` counts as a write). Every outcome of such a finish counts (`ok`, `error`, `timeout`,
   `aborted`, `skipped`); a finish with no `tool.started` under its key (denied, unknown tool, invalid
   arguments: no handler ran) does not. Calls nested in `run_workflow`, a hand-off or a `call` node are in the
   same journal and count the same way. The check is made each time the step is entered again, on the journal
   as it is then, after a crash, a pause or a forced shutdown alike, so a write that finished earlier in the same
   session counts too. A workflow node's `retry` after a finished failure is not covered by this rule: it is a
   new call under a new key (`#<attempt>`), not an unfinished one. After a crash in the middle of parallel write
   calls this can leave a call waiting for a person although repeating it would have been harmless; Runwright
   cannot tell, so it asks.
3. A new call: an unknown tool finishes with `outcome: "unknown_tool"`. Then the [policy](#policy-caps-and-budgets):
   `deny` finishes with `outcome: "denied"`. Then the call's own approval: when an `approval` pending was opened
   for this call, its resolution decides it, whatever the policy says now: still open, the call waits; denied, it
   finishes `denied` with the person's reason, which is the tool result the model sees; approved, it goes on.
   Only a call with no approval of its own is decided by the policy: `allow` goes on, `ask` opens an `approval`
   pending and waits (unless "approve always" for the tool was applied while it was about to open it: then it
   opens nothing and runs). Then the tool-call budget (may open a `tool_budget` pending). Then the arguments are validated against the tool's JSON
   Schema (`outcome: "invalid_args"` with the problem paths). Then `tool.started` is committed, **then** the
   handler runs with an `AbortSignal`, then `tool.finished` is committed.

**The deny list on every path.** Every handler invocation goes through one function that first checks the
server deny list (`tools.deny`, `RUNWRIGHT_DENY_TOOLS`): first attempts, automatic retries of unfinished
read-only calls and of idempotent calls that rule R lets run again, resumed resumable calls and a person's retry
of an interrupted call. A denied call is
journalled `tool.finished` with `outcome: "denied"` and the handler does not run. Only a step that already has
`tool.finished` is returned without any check.

**Aborts.** A call's `AbortSignal` is aborted by a cancel, a pause, a forced shutdown (the grace period is over),
a lost lease, the call's own deadline and the deadline of an enclosing call or [deadline scope](#deadline-scopes).
A graceful stop inside the grace period does not abort it. When the handler throws after an abort, the cause
decides what is written:

| Cause | Journal | Then |
|---|---|---|
| cancel | `tool.finished` with `outcome: "aborted"` | the run ends `cancelled` |
| deadline | `tool.finished` with `outcome: "timeout"` | the step returns that result |
| lost lease | nothing | the session stops writing |
| pause, forced shutdown | **no `tool.finished`**. A read-only, idempotent or resumable tool keeps its unfinished `tool.started`; any other tool gets `tool.interrupted` (`reason: "pause"` or `"shutdown"`) and an `interrupted` pending in the same commit | the run leaves `running` as `paused` (pause) or `queued` (shutdown); when it runs again, step 2 applies: a read-only or resumable call runs again, an idempotent write runs again only under rule R (else it is journalled `tool.interrupted` with `reason: "crash"` and waits), any other waits for a person |

The built-in file tools follow the table like any tool. `read_file` and `list_files` stop when their signal is
aborted: they are read tools, and the call runs again on resume. `write_file`, `edit_file` and `delete_file`
wait on nothing but the file system: they never open a path in a way that can block (see
[security.md](security.md#workspace-confinement)), their reads are bounded by the size limit, and they finish
rather than leave a half-made change.

**Nothing starts after an abort was observed.** The cause is read once more after `tool.started` was committed.
When the call was already aborted by then (a cancel, a lost lease, a pause, a forced shutdown or a deadline that
arrived while `tool.started` was being written), the handler is **not invoked** and the call ends exactly as the
same cause ends a call in flight, by the table above: a cancel journals `tool.finished {outcome: "aborted"}` and
the run ends `cancelled`; a deadline journals `tool.finished {outcome: "timeout"}` and the step returns it; a lost
lease writes nothing; a pause or a forced shutdown leaves the call unfinished. One function decides both cases. A
handler that ignores the signal and returns normally is journalled `tool.finished` as usual; the pause or the stop
then takes effect at the next step boundary.

**Nested steps belong to their call.** A resumable tool's handler (`run_workflow`, or any host tool built from
durable steps) starts its own durable steps through `ToolContext.steps` (and contexts derived from it). Those
steps belong to the enclosing tool call, so once that call is aborted (its `deadlineMs`, a pause, a cancel, a
shutdown):

1. no further nested step starts: the step primitive throws before it journals anything (`deadline_exceeded` for
   a deadline, the control signal otherwise);
2. a nested model call, tool call or sleep in flight is aborted with the same cause and journalled exactly as if
   the cause had hit it directly: a deadline gives the nested model call `model.interrupted {reason: "deadline"}`
   with its assumed cost and the nested tool call `tool.finished {outcome: "timeout"}`. A nested handler that
   ignores its signal finishes and is journalled normally; the next nested step does not start;
3. `ToolContext.steps.signal` is the enclosing call's signal. Nesting composes to any depth.

A tool or model step's own `deadlineMs` measures one execution of the call: a call that is attempted again
after a suspend or a crash gets a fresh bound.

### Deadline scopes

`ctx.deadline(deadlineMs, body, {startedAt?})` runs `body(scoped)` under a deadline that covers every step started through
`scoped` and through any context derived from it with `child`, at any depth. `scoped` uses the same key prefix as
`ctx`, so the steps inside have the keys they would have without the scope. `deadlineMs` must be a finite number
of milliseconds greater than 0 (`bad_request` otherwise; the same rule applies to the `deadlineMs` of a tool or
model step). When the deadline passes, the steps behave as nested steps of an aborted call (above): no further
step starts (`deadline_exceeded`, before anything is journalled), a tool call in flight is journalled
`tool.finished {outcome: "timeout"}`, a model call in flight `model.interrupted {reason: "deadline"}` with its
worst case charged, and a sleep or the wait between model attempts ends with `deadline_exceeded`. `deadline` then
rejects with `deadline_exceeded` ("the deadline of <n> ms passed") whatever `body` returned or threw, except a
control signal (waiting, paused, cancelled, released, lease lost), which always passes through unchanged. When
the scope's own deadline did not pass, `deadline` returns or throws what `body` did.

Scopes nest with each other and with tool calls (a scope inside a scope, inside a resumable tool's
`ToolContext.steps`, a tool call with its own `deadlineMs` inside a scope): the earliest deadline wins. The scope
itself journals nothing.

A scope's deadline is an instant: `startedAt + deadlineMs`, where `startedAt` is the journalled start of the step
that owns the scope (a workflow node passes the `ts` of its `node.started` record). Every session that runs the
step computes the same instant, so it holds across waits, pauses, releases, crashes and restarts. "Expired" means
`now >= expiresAt` everywhere:

- **Entry.** A scope entered at or after its instant does not call `body`: the session closes the expired
  pendings (below) and `deadline` rejects with `deadline_exceeded`. Otherwise its timer runs for what is left.
- **Waiting.** When `body` leaves with the `waiting` signal after the instant, `deadline` closes the expired
  pendings and rejects with `deadline_exceeded` instead of passing `waiting` on; every other control signal
  passes through unchanged.
- **Pendings.** Every pending opened inside a scope carries `detail.expiresAt`, the earliest enclosing instant
  (for a question with its own `expiresAt`, the earlier of the two); a pending whose instant has already passed is
  not opened (`deadline_exceeded`, "the deadline passed", nothing journalled). `expirePendings` applies the
  commands that arrived, then closes, in one commit built under the session lock, every open pending whose
  `expiresAt` passed: `pending.resolved {resolution: {expired: true, expiresAt}, commandId: null}`. Every reader of
  a pending (question, approval, interrupted call, spend cap, tool budget, turn limit) follows one rule: open and
  not expired, it waits; open and expired, it closes the expired pendings and reads again (a command applied
  meanwhile wins); closed as expired, the step fails with `deadline_exceeded` and does nothing else (an expired
  approval never runs the tool and is not a denial, an expired interrupted call is not a cancel, an expired limit
  pending is not reopened).
- **Commands.** A command that names a pending and was created at or after its `expiresAt` is rejected
  (`command.rejected`, `pending <id> expired at <ISO 8601 time>`); one created before it is applied however late
  the run resumes.
- **Wake.** A session that leaves a run `waiting` stores the earliest `expiresAt` of its open pendings as the
  run's `wake_at`, and the store requeues the run once it passed, so a waiting run is woken to fail the step. A
  due wake is never stored: when an open pending has already expired, the session closes it and runs the driver
  again instead of leaving. A paused run is not woken; it fails the step when it is resumed.

Without `startedAt` the scope is measured from the call, so a driver that enters it again after a suspend gets a
new instant; the pendings opened inside still keep the instant they were opened with, and their readers fail the
step once it passed.

Ids of learning items a tool opened (`ToolOutput.learningOpened`, used by `recall`) are committed with the call's
`tool.finished` record, in the same fenced transaction.

Results are redacted before they are stored. A result over `tools.resultBytes` (16 KiB) is cut with a note, and
the full text is saved in the workspace under `.runwright/tool-results/` (or `.runwright/tool-results/untrusted/`
for untrusted results; `read_file` marks what it reads from that folder as untrusted, whatever the spelling of
the path, because the folder is compared by device and inode). The saved file holds the UTF-8 bytes of the
already redacted full content, and `tool.finished` journals its SHA-256 (`fullResultSha256`) and length
(`fullResultBytes`), which learning uses to verify the file ([learning.md](learning.md#provenance)). The write
tools refuse paths in `.runwright/` ([security.md](security.md#workspace-confinement)); this is not a sandbox,
since `shell` and host tools can still write there. A file found under a saved result's name is read as a
regular file only (no symbolic link followed, no blocking open, at most the result's own length) and is kept
only when it holds exactly the same bytes; anything else under that name is replaced.

The limit covers structured data too. When the canonical JSON of a result's (already redacted) `data` is over
`tools.resultBytes`, its UTF-8 bytes are saved to a `.data.json` file (see "Saved result files" below), `data`
becomes `null`, and this note is appended to the content, after the truncation note when there is one:
`\n[data omitted: <bytes> bytes of structured data; saved to <path>]`. `tool.finished` then journals
`fullDataPath`, `fullDataSha256` and `fullDataBytes` for exactly the bytes written, and learning verifies that
file by the same rules as the saved full text. Outcomes: `ok`, `error`,
`denied`, `invalid_args`, `unknown_tool`, `skipped`, `aborted`, `timeout`. **The limit applies to every
`tool.finished`, also to denied, invalid, unknown and skipped calls.**

**Saved result files.** Both files of a result go to `<folder>`: `.runwright/tool-results/untrusted` for an
untrusted result, else `.runwright/tool-results`. The full text is saved as
**`<folder>/<label>-<key16>-<sha256>.txt`** and over-long structured data as
**`<folder>/<label>-<key16>-<sha256>.data.json`**: `<sha256>` is the lower-case hex SHA-256 of the bytes in the
file, `<key16>` the first 16 hex characters of the SHA-256 of the step key, and `<label>` a readable hint (the
step key with every character other than an ASCII letter, a digit, `.`, `_` and `-` turned into `_`,
lower-cased, cut to its last 40 characters, with leading characters that are not a letter or a digit removed;
`result` when nothing is left). **A file's name contains the digest of its own bytes, so two results share a
file only when they are byte for byte the same**, and results that finish at the same moment cannot overwrite each
other. A file is written under a temporary name, synced and published with **`link()`, which never replaces an
existing file**; when the name already exists with the same bytes (the same call ran again after a crash)
nothing is written, and a file under that name whose bytes do not match is replaced. Then, in each of these cases
(also when the file was already there, because the attempt that linked it may have died before anything was
synced), the folder that holds the file and every directory above it up to `<data dir>/workspaces` are synced; a
failing sync is the same `internal` error. **A name is at most 132
bytes long however long the step key is.** Readers take the path from `tool.finished` and never rebuild it, so
files saved under the `<serial>-<key>` names of earlier versions keep working. **If the file cannot be saved, the
call throws an `internal` error and no cut result is journalled without its file.**

## Model calls: reservations, interruption and repair

Model calls use `model.started` / `model.finished` the same way.

**Worst case and reservation.** The worst case of one call is `W = price(max(input, cacheRead, cacheWrite)) ×
(UTF-8 bytes of the serialized request + 1 024) + price(output) × maxOutputTokens`: every input token is priced
at the highest of the three input-side rates, a rate the price table does not give counting as the input rate
(`worstCaseMicros` in `src/models/prices.ts`, `worstCaseInputTokens` in `src/models/util.ts`,
`FRAMING_ALLOWANCE_TOKENS = 1024`). Before a call the session checks the turn limit and
the spend cap (`spent + reserved + W <= cap`, see [policy](#policy-caps-and-budgets)) and, with no `await` in
between, adds `W` to the run's reservation. The reservation is released when the call's result (`model.invalid`,
`model.finished`, `model.failed` or `model.interrupted`) is applied. A call that counts as a turn also reserves
that turn; how each reservation outlives the end of a session is in the
[reservation table](#policy-caps-and-budgets). `model.started` records the worst-case input
tokens, `maxOutputTokens` and `W`.

**What a provider reply must contain.** A network provider's success reply is accepted only when its envelope is
complete. Anthropic, a JSON reply: an object of `type: "message"` with a `content` array, a `stop_reason` and a
`usage` with numeric `input_tokens` and `output_tokens`; a streamed reply: a `message_start` whose message carries
that usage, a `message_delta` with a `stop_reason` and a `usage.output_tokens` token count (the final count of
what was generated; the count in `message_start` covers only the start), and a `message_stop`. A stream that ends
without that final count is a reply failure with unknown billing, charged its worst case, never billed with the
start's count. In both, a content block is an object
with a `type`, a `tool_use` block has an `id` and a `name`, and a delta belongs to a block that was started. An Anthropic error envelope (`type:
"error"`, or an `error` object, in a reply or as a stream event) keeps its own mapping, so a transient error type
is retried. An OpenAI-compatible error envelope (an `error` object as the whole JSON body or in a stream event
after a 2xx status) is classified the same way, by its status or kind, so a transient one is retried too
([configuration.md](configuration.md) has the table). OpenAI-compatible, a JSON reply: an object with no `error` whose `choices` is an
array, whose `choices[0]` is an object with a `message` object (its `content` a string or null, its `tool_calls`
an array of objects) and a non-empty `finish_reason`; a streamed reply: every event's data is `[DONE]` or a JSON
object with no `error`, every part that is read has the right shape (`choices` an array, the choice and its
`delta` objects, `finish_reason` a non-empty string), some choice carries a `finish_reason`, and the stream ends
with `[DONE]`. A chunk with an empty `choices` array (usage only) and a completion with no text are valid; a tool
call needs a function name (a count the server does not report is charged the bound it was reserved with, never
nothing: see the charge table below). Anything else is a provider failure (`model_failed`) with `billing: "unknown"`: the request may
have been billed, so the attempt is charged its worst case as an assumed cost.

**Attempts.** A model call (the first call of a step, or its repair call) is a sequence of provider
**attempts**, at most `models.retry.maxAttempts` (default 5). A provider never retries by itself: one
`generate` is one request. Every attempt is (1) admitted against the spend cap on its own, (2) journalled as its
own `model.started` (with `attempt`) before it is sent, and (3) ended by exactly one record that says what it was
charged:

| Record | Charge |
|---|---|
| `model.finished`, `model.invalid` | the usage the provider reported; a count the provider did not report: the bound it was reserved with, recorded as assumed (below) |
| `model.retry`, `model.failed` with billing `"none"` (the provider answered with an HTTP error status, or no connection was made) | nothing |
| `model.retry`, `model.failed` with billing `"unknown"` (anything else: a connection that broke after the request was sent, a truncated stream, a body that is not JSON, tool arguments that are not a JSON object) | `W` as an assumed cost (`assumedCostMicros`) |
| `model.interrupted` | `W` as an assumed cost |

An assumed charge is a usage row `{inputTokens: inputTokensEstimate, outputTokens: maxOutputTokens, costMicros:
W, assumed: true}` taken from that attempt's `model.started`, committed with the record that carries
`assumedCostMicros`; the replay reducer adds exactly the same numbers, so the run's totals rebuilt from the
journal equal the run row's.

**A count the provider did not report** (rule U). The Anthropic and OpenAI-compatible adapters never invent a count (the offline scripted model reports
the counts its script names, and a typical count for the others): a reply whose usage
lacks one names it in `usageMissing` (`"input"`, `"output"`). The engine charges it the bound the attempt was
reserved with: a missing input count is the attempt's `inputTokensEstimate` (cache counts 0), priced at the
highest input-side rate as `W` prices it; a missing output count is its `maxOutputTokens`. The record
(`model.finished`, `model.invalid`, and the `model.failed` of a repair reply still invalid) carries that filled
`usage`, its `costMicros` and `usageAssumed: ["input" | "output", …]` (only when non-empty), and the usage row is
written with `assumed: true`. Replay needs no rule of its own: the journalled usage already holds the filled
counts. So a reply is charged at most `W` whenever the provider bills at most `W`, with or without a usage report,
and a missing count is never charged less than its bound. A model with no price stays unknown. Totals saturate: every total of tokens, cost micros, tool calls and turns is an
integer from 0 to 2^53 − 1 (`Number.MAX_SAFE_INTEGER`), in the replay state as in the store; an addition that
would pass it yields exactly that value, a provider's usage count above it is recorded as it, and a spend check
whose sum passes it, or whose spent total has saturated, reports the run over its cap.

**One size limit per reply.** The Anthropic and OpenAI-compatible adapters read at most 64 MiB
(`MAX_REPLY_BYTES`, `src/models/sse-parse.ts`) of one response body, whether it is streamed or one JSON
document. The raw bytes are counted before they are decoded, across the whole response; a body that passes the
limit is cancelled and the attempt is a reply failure with unknown billing (`<provider> sent a reply larger than
<n> bytes`), charged `W` as an assumed cost like any other reply failure. So neither a reply's text and tool
arguments nor the number of its stream events can grow past the limit.

The attempt loop (`callWithAttempts` in `src/engine/context.ts`):

- A failure with code `model_transient` while attempts are left is journalled `model.retry {attempt, delayMs,
  code, message, status, billing, assumedCostMicros?}` with its charge. In the same synchronous step the next
  attempt is admitted against the cap (the call's own reservation is kept and not counted twice). If it does not
  fit, the run pauses with a `spend_cap` pending at the step (or the step throws `limit_reached` when it was
  started with `onLimit: "skip"`); when the cap is raised the step continues with the **next** attempt number. If
  it fits, the engine waits `delayMs` and sends the next attempt, admitted once more as its `model.started` is
  committed (below), so a cap lowered or `allowUnpriced` revoked during the wait stops it.
- **An attempt is admitted by the commit that starts it.** The commit that writes an attempt's `model.started`
  checks, inside itself and with no `await` between the check and the record, the spend cap (and, for a first
  call that counts as a turn, the turn limit, the call's own turn left out) against the run's limits and usage as
  they are then. When the check fails nothing is written, the call's reservations are freed (an open repair keeps
  its turn) and the step pauses with a `spend_cap` or `turn_limit` pending (or throws `limit_reached` with
  `onLimit: "skip"`). This holds for every attempt: a first attempt, one after a backoff, one after a resumed
  provider wait and a repair call. The checks made earlier (on entry, in the `model.retry` commit) only pause
  sooner without journalling an attempt. `delayMs` is the provider's retry-after hint,
  in full, when it gave one (the record then also carries `retryAfterMs`), else `min(maxMs, baseMs × 2^(attempt −
  1))` scaled by a random factor between 0.5 and 1.
- **A hint is waited out in full or the call stops.** A hint longer than `models.retry.maxRetryAfterMs` (default
  300 000 ms; a value too large to represent counts as longer) is not shortened and not waited out: the failure is
  journalled `model.failed {error, attempts, retryAfterMs, retryAfterOverLimit: true}` with its charge and the call
  fails with `model_failed`, message `model call not retried after N attempts (last error: status S | no status):
  the provider asked for a wait of W ms, more than models.retry.maxRetryAfterMs (L ms): <last message>`, whatever
  number of attempts is left. When a call fails on its last attempt, or its deadline passes during the wait, while
  a provider wait is outstanding, `model.failed` carries `retryAfterMs`, the part still to pass; the thrown error
  carries the same in `details.retryAfterMs`, also when it is replayed, so that a workflow node's `retry` can wait
  it out.
- Any other failure, or a transient one on the last attempt, is journalled `model.failed {error, attempts,
  assumedCostMicros?}` with its charge. Exhausted retries fail with `model_failed`, message `model call failed
  after N attempts (last error: status S | no status): <last message>`, and the error's `details` carry
  `attempts`.
- **Between attempts nothing is in flight.** A pause, a stop, a shutdown or a cancel during the wait ends it
  with nothing charged and nothing written; the step later resumes at the next attempt. A step deadline that
  passes during the wait is journalled `model.failed` with code `deadline_exceeded` (no charge).
- **No request is sent once the attempt's abort was observed.** When a cancel, a pause, a forced shutdown or a
  deadline has already aborted the attempt by the time its `model.started` is committed, `generate` is not called:
  the attempt is journalled `model.interrupted {reason}` and charged `W`, exactly as an attempt aborted in flight,
  because after a crash the journal cannot tell a request that was never sent from one that was, and the cap
  bound must hold either way. A lost lease writes nothing.

**Resume** is decided by the last model record of the step's key:

| Last record | What happens |
|---|---|
| `model.retry {attempt: n}` | attempt `n + 1` is admitted and sent |
| `model.started {attempt: n}` with no end (a crash) | settled at the claim (below): the attempt is journalled `model.interrupted` (`reason: "crash"`), charged `W`, and attempt `n` is sent again when the step is entered |
| `model.interrupted {attempt: n}` with reason `pause` or `shutdown` | attempt `n` is sent again |
| `model.interrupted` with reason `deadline` | replay throws `deadline_exceeded`; nothing is sent |
| `model.failed` | replay rethrows the recorded error |
| `model.finished` | replay returns the recorded result |

**Every attempt is closed exactly once** (invariant M): each `model.started` is followed under its key by exactly
one of `model.finished`, `model.invalid`, `model.failed`, `model.retry` with `billing`, or `model.interrupted`, and
an attempt that may have been sent is charged its worst case exactly once. The closing record of a crashed attempt
does not wait for its step to be entered again: when a runner claims a run, the commit that journals `run.claimed`
also journals `model.interrupted {reason: "crash"}` with its assumed usage row for every key whose last model
record is a `model.started` (nothing of the run is in flight at a claim). This happens before the session applies
any command, so a cancel sent while the process was down, a deadline that passed meanwhile and a spend cap all see
the charge, and with an unpriced model the run's cost becomes unknown. A run that ends for good (`completed`,
`failed`, `cancelled`) with an attempt still unfinished (a request sent in this session whose closing commit
failed, or a parallel call still in flight) settles it the same way in its final commit; the store refuses any
later record of that session, so it is not charged twice. A release, a wait or a pause leaves it to the next claim.

A missing `attempt` reads as 1, and a `model.retry` written by an earlier version (no `billing`) is ignored. No attempt
number is ever reused for a provider failure, so a call never makes more than `maxAttempts` failed attempts
however often the run is paused, capped or restarted.

When the `model.retry` record carries `retryAfterMs`, the resumed session first waits whatever is left of that
wait, counted from the record's time, and then sends attempt `n + 1`: a pause, a restart or a takeover never
brings the next request forward. The engine's own backoff (a `model.retry` without `retryAfterMs`) is not served
again after a resume: the resumed session sends attempt `n + 1` at once (admitted as its `model.started` is
committed).

**Structured output and repair.** When a step asks for structured output (`request.output`), the schema may
describe any JSON value: an object, an array, a string, a number, a boolean, `null` or a union of them. The
Anthropic and OpenAI-compatible providers carry the output as the arguments of an output tool, and a tool's
arguments are always a JSON object, so `outputToolSchema` (`src/models/output-transport.ts`) decides what is sent
as the tool's argument schema. The call of the output tool is forced with `tool_choice`, except for the Anthropic
model families that reject a forced choice, which get `tool_choice: auto` and an instruction in the system prompt
to call the tool exactly once. An object schema (top-level `"type": "object"`) is sent as it is, byte for byte.
Every other schema is wrapped in an object with the one required property `value` (`OUTPUT_VALUE_KEY`) and
`additionalProperties: false`; the schema's top-level `$defs` and `definitions` move onto the wrapper, so its
`#/$defs/...` and `#/definitions/...` references still resolve, and the tool description gets the sentence ` Put
the result in the "value" argument.` (the Anthropic instruction, when one is sent, gets ` Put the answer in its
"value" argument.`). The adapter unwraps the answer, and streaming and non-streaming replies are
read by the same function:

- The first call of the output tool decides the output; the text is not consulted then. Under a wrapped schema an
  object with an own `value` property gives that property, and an array, string, number, boolean or `null` sent
  without the wrapper is taken as the value itself. Under an object schema, arguments that are not an object fail
  the reply (`model_failed`, billing `"unknown"`); arguments that are not JSON fail it the same way.
- When the output tool was not called, the trimmed text parsed as JSON is the value itself.
- **No output is not `null`.** A reply whose output tool was not called and whose text is empty or not JSON, or
  whose wrapper has no `value`, carries no structured output (`outputMissing` on the provider's response). The
  engine does not validate a `null` for it: it is one problem, `the reply carried no structured output`, and the
  reply is journalled `model.invalid` and repaired like any other invalid reply. A `null` output is accepted only
  when the model answered `null`. The scripted provider follows the same rule (a turn with no `output` whose text
  is not JSON carries no output).

The arguments of an ordinary tool call are read the same way on both network providers and on both paths: the
JSON the provider sent (for OpenAI-compatible servers the `arguments` string, or the parsed value when a server
sends one instead of a string; for Anthropic the streamed `input_json_delta` text when there is any, else the
block's `input`). Absent arguments and empty text mean `{}`. Arguments that are not a JSON object fail the reply
(`model_failed`, billing `"unknown"`); they are never replaced by `{}`, so a tool never runs with arguments the
model did not send.

A reply that does not match is journalled `model.invalid` with its problems, its usage and its cost (billed), and
the step goes on to its repair phase under the same key:

1. The repair call is a step boundary, so a pause or stop that arrived during the first call takes effect here.
2. It has its own admission check against the cap with its own worst case. When it does not fit, a `spend_cap`
   pending is opened at the step's key (or, for a step with `onLimit: "skip"`, `limit_reached` is thrown).
3. It has its own `model.started` with `repair: true`, then `model.finished`, or `model.failed` with
   `model_output_invalid` ("invalid after one repair").

After a crash, a pause or a raised cap the step resumes in the repair phase: the first call is never issued
again. The turn limit is checked once, before the first call, and the step counts as one turn when it finishes.
**The turn of an open repair stays reserved for as long as its step is unfinished, in every session.** From the
moment its `model.invalid` is applied until its closing record (`model.finished`, `model.failed`, or
`model.interrupted {reason: "deadline"}`) is applied, the step's turn is held in the session's map of open repairs
(one hold per open repair): moved there from the first call's hold when `model.invalid` is applied, or reserved
when a session claims the run (`openRepairs` in `src/engine/context.ts`), before any step is admitted. It is
released only as the closing record is applied, in the same step in which the finished step's turn is counted,
so `usage.turns + reserved turns` never forgets an admitted turn. Every other end of an invocation keeps it: a
`spend_cap` pending of the repair, a pause or stop before the repair, an aborted attempt, a provider wait, a lost
lease, an error that writes no closing record. Another step asking for that turn meanwhile gets a `turn_limit`
pending. A repair whose step is never entered again keeps its turn reserved for the session (the run pauses at
the turn limit and says what it needs). A step whose turn does not count (`countsAsTurn: false`, such as the
learning turn's grader call) reserves nothing.

## Policy, caps and budgets

The rules are summarised in the [README](../README.md#control-and-cost); the code is `src/engine/policy.ts` and
`src/engine/budget.ts`.

- Policy (`resolvePolicy`, the only resolver; tool specs, every call and `ctx.toolPolicy` all go through it),
  first match wins:
  1. the tool is on the server deny list → `deny` ("denied by the server's deny list");
  2. the context has a tool scope and the tool is not in it → `deny` ("not among the tools of this hand-off");
  3. the agent lists the tool → the entry's policy, else the tool's default policy, else `allow`; `ask` becomes
     `allow` after "approve always" for that tool in this run, for a call that has no approval of its own;
  4. the agent does not list the tool and the learning context grants it → `allow` ("granted by the learning
     context");
  5. otherwise → `deny` ("not granted to this agent").

  So a learning grant is only a default for a tool the agent says nothing about: `recall: "deny"` denies and
  `recall: "ask"` asks.
- Approvals. (a) A call whose own approval pending was resolved is decided by that resolution, whatever the
  run-wide "approve always" says: denied gives the `denied` result, approved runs. (b) An `approve` with `always:
  true` resolves, in the same commit and with the same command id, every other open approval pending of that tool
  in the run (that had not expired when the command was created) as `{decision: "approve", always: true}`, so
  none of them stays open while its call runs. A `deny` planned before it in the same batch wins for its own
  pending; one that arrives after it is rejected as already resolved. (c) The server deny list and the tool scope
  still win over everything, an approved pending included. `ctx.toolPolicy` and the tool specs answer for the
  tool, not for one call, so they show `allow` once a tool is approved always. The server deny list is checked once more immediately before every handler invocation
  ([tool calls](#tool-calls-started-finished-interrupted)).
- Tool scope: `ctx.withTools(names)` returns the same run restricted to `names`, and the agent loop runs a
  hand-off with `tools` under it, so the scope holds for every call made inside the hand-off (its model's calls,
  a workflow it starts with `run_workflow`, a nested hand-off, whose scope is the intersection), not only for the
  tools its model is shown; a call outside it is journalled `tool.finished {outcome: "denied"}` and returned to
  the model as the tool result. A call already journalled `tool.started` was admitted and is recovered as usual.
- Spend cap: every provider attempt is sent only if `spent + reserved + worstCase <= cap`, where `reserved` is
  the sum of the worst cases of the run's other calls still in flight (parallel workflow branches, and a
  structured-output step's repair call, which is admitted on its own); a call keeps its reservation while it
  waits between attempts; else a `spend_cap` pending with
  `neededMicros = spent + reserved + worstCase - cap`. Unknown prices count as over any cap (a `spend_cap`
  pending with `reason: "unknown_price"`) unless unpriced models are allowed. Allowing them (`allowUnpriced` in
  the run's limits, or `models.allowUnpricedModels`) makes the unknown part of the cost count as zero and does
  not switch the cap off: the known part, `known spend + reservations + the next call's known worst case` (0 for
  an unpriced next call), is still compared with the cap before every provider attempt, and when it does not
  fit the run pauses with `reason: "cap"` and `neededMicros` = that known total minus the cap
  (`nextCallWorstCaseMicros` is `null` when the next call is unpriced and the known spend alone is over the
  cap). An unknown cost is sticky: a run that already made a call to an unpriced model stays `unknown`, and over a
  cap unless allowed, even if a price is configured later.
- Bound: as long as a provider bills no more than `W` for one request (at most one input token per byte of the
  serialized request plus 1 024 framing tokens, and at most `maxOutputTokens` output tokens) and bills nothing for
  a request it refused with an HTTP error status, a run's spend never exceeds its cap, sequentially or in
  parallel, retries included, which is stronger than "at most one call's worst case over". An attempt
  interrupted by a crash, a pause, a cancel, a shutdown or its deadline, and an attempt that failed with uncertain
  billing, is charged its worst case as an assumed cost; an attempt left unfinished by a crash is charged when the
  run is next claimed, before any command is applied. If a provider reports more than the worst case, the real
  cost is recorded, the run can end above the cap by that excess, and it pauses before its next request. When
  unpriced models are allowed, this is a bound on the known cost: what the unpriced calls cost is not known and
  not counted.
- Tool-call budget: checked before `tool.started` of a first attempt (retries of the same call are not counted
  again), and again inside the commit that writes that `tool.started`, against the limits and usage as they are
  then (the call's own reservation left out), so a budget lowered after the first check stops the call before
  its handler runs. Turn limit: checked before each model call that counts as a turn, and again inside the commit
  of each of its attempts' `model.started`. Both pause with `{limit, used, needed}`, where `used` is what was
  counted (usage plus the other calls being started) and `needed = max(1, used + 1 − limit)`: raising the limit
  by exactly `needed` admits the step, by less does not. After five tool calls with the budget lowered to 2 the
  pending says `{limit: 2, used: 5, needed: 4}`.
- Reservations. Every admission adds to the session's reservation with no `await` between the check and the
  hold. A reservation lives in the session's memory, so each one is listed with how it survives the end of a
  session (a crash, a pause, a release at shutdown):

  | Reservation | Held | When the session ends |
  |---|---|---|
  | turn of a model call's first call (phase 1) | from admission to the call's result | re-checked on entry: the turn is counted only at `model.finished`, so the next session admits the call again against the limit |
  | turn of an open output repair | from `model.invalid` to the step's closing record | carried: reserved again when the run is claimed (`openRepairs`), before any step is admitted |
  | spend of a first call's attempt (phase 1) | from admission to the attempt's record | charged at claim as `model.interrupted {reason: "crash"}` (its worst case) when the attempt was unfinished; otherwise re-checked on entry |
  | spend of a repair call's attempt | from admission to the attempt's record | charged at claim as `model.interrupted {reason: "crash"}` when unfinished; otherwise re-checked on entry |
  | `reserved.toolStarts` | while a first attempt's `tool.started` is being committed | counted at the `tool.started` commit (`usage.toolCalls`); freed with nothing counted when the check inside that commit refuses the call |
  | spend kept for the next attempt during a provider wait (`model.retry`) | from the retry record to the next attempt | re-checked on entry: the step resumes after `model.retry` and admits the next attempt again |
- Effective limits: agent revision limits, overridden by the run's creation limits, then by each
  `limits.changed` record.
- **Cancel** aborts in-flight model and tool calls and ends the run `cancelled`. **Pause** aborts in-flight
  model and tool calls through their `AbortSignal` and stops at the next step boundary: an aborted model call is
  journalled `model.interrupted` and issued again on resume; an aborted tool call follows the
  [abort table](#tool-calls-started-finished-interrupted) (a read-only or resumable tool runs again on resume, an
  idempotent write only under rule R, any other waits as interrupted for a person). A tool that ignores the signal finishes first.
  **Resume** re-queues the run.

## Pendings

One record shape for six kinds:

| Kind | Opened when | `detail` | Resolved by |
|---|---|---|---|
| `question` | `ask_person` or a workflow `wait` node | `{question, choices, expiresAt?}` | `answer` |
| `approval` | a call to an `ask` tool | `{tool, args}` | `approve` (optionally always) or `deny` (optional reason) |
| `spend_cap` | the next model call (a structured-output step's repair call included) does not fit the cap, or the cost is unknown and unpriced models are not allowed | `{capMicros, spentMicros, neededMicros, nextCallWorstCaseMicros, reason: "cap" \| "unknown_price", model}` (`neededMicros` is `null` for `unknown_price`; for `cap` it is the known total minus the cap, also when unpriced models are allowed, and `nextCallWorstCaseMicros` is `null` when the next call is unpriced) | a `limits` command that makes the check pass |
| `tool_budget` | `maxToolCalls` reached | `{limit, used, needed}` with `needed = max(1, used + 1 − limit)` | a `limits` command raising `maxToolCalls` (by `needed` at least) |
| `turn_limit` | `maxTurns` reached | `{limit, used, needed}` with `needed = max(1, used + 1 − limit)` | a `limits` command raising `maxTurns` (by `needed` at least) |
| `interrupted` | a crash, a pause or a forced shutdown left a call unfinished that is not run again by itself: a tool that is not read-only, idempotent or resumable, or an idempotent write that [rule R](#tool-calls-started-finished-interrupted) holds back | `{tool, args, attempt, reason: "crash" \| "pause" \| "shutdown"}` (older pendings have no `reason`) | `resolve_interrupted` with `retry`, `skip` (and a result) or `cancel` |

Any pending opened inside a node deadline (a deadline scope, or a `wait` node's own deadline) carries
`detail.expiresAt` (ms since epoch); unresolved at that instant, it is resolved `{expired: true, expiresAt}` and the
step that waited on it fails with `deadline_exceeded` (see [Deadline scopes](#deadline-scopes)).

A pending is opened by a `pending.opened` record and a row in `pendings` written in the same commit, and resolved
by a `pending.resolved` record and a row update in one commit. Because the journal and the table are the only
state, pendings survive restarts by construction.

**How a run waits.** The primitive that opens (or finds open) a pending throws the `waiting` signal. Once the
driver has unwound, the session commits `running → waiting`; the store refuses it with `commands_pending` while an
unconsumed command exists (the rule holds for every transition out of `running` except a release to `queued`), so
if one slipped in, the session applies it and replays the driver in the same session. A command that arrives later moves the run `waiting → queued`; a runner claims it, applies the
command and replays the driver, and the blocked step now finds its pending resolved. A run whose open pendings
carry `expiresAt` also stores the earliest as its wake time and is requeued when it passes (see the claim step).

## Commands

People change runs by **commands**, never by writing run state: `message`, `answer`, `approve`, `deny`, `limits`,
`resolve_interrupted`, `cancel`, `pause`, `resume`. The API checks that the run exists and is not terminal, and
for pending commands that the pending is open and of the right kind, then stores the command (202 Accepted). The
runner holding the run applies commands in arrival order, as `command.applied` records (or `command.rejected`
with a reason: a pending of another run or kind, an already resolved pending, an invalid limit change), together
with any `pending.resolved` and `limits.changed` records and the consumption of the command, in one commit.
The free text of a command (a message, an answer, a denial's or a cancel's reason, the result of a skip) is
redacted for every known secret before it is stored ([security.md](security.md#redaction)).

**No command is stranded.** A run never leaves `running` for `waiting`, `paused`, `completed`, `failed` or
`cancelled` while a command sent to it is unconsumed: the store refuses that commit with `commands_pending`. Only
a release back to `queued` keeps unconsumed commands, for the next claim. When the final commit is refused, the
session applies the waiting commands and decides again:

- a cancel that arrived before the run completed makes it `cancelled`;
- a pause makes it `paused`; on resume everything replays from the journal and the run completes without
  repeating a step;
- for a run that failed, a late cancel makes it `cancelled`, and anything else leaves it `failed`.

**Messages.** A message is delivered to the agent loop at its next turn boundary: the loop takes its inbox before
each model call, and once more after a reply with no tool calls (a message found then starts another turn). A
message that is applied after the run has recorded its output (`run.output`) is journalled `command.rejected`
with the reason "the run had already finished its work; the message was not delivered" (`MESSAGE_TOO_LATE` in
`src/engine/commands.ts`). A message that was applied earlier but never taken by the driver (a workflow run
outside an `agent` node, or a message that arrived between the last inbox check and the output) is journalled
`message.undelivered {commandId, reason}` in the same commit as `run.output` (or, for a run that fails or is
cancelled without recording an output, in its final commit), with the reason "the run finished before the
message could be delivered" (`MESSAGE_UNDELIVERED`). Either way the command is consumed and the timeline says
what happened to it. A command sent to a run that is already terminal is refused by the API with `run_terminal`.

**Each message is taken once.** A message is handed to exactly one `ctx.inbox` key, also when several keys take
the inbox at the same time (parallel workflow agent nodes share the run's inbox): the `inbox.taken` record is
built inside the session's commit lock, from the messages not yet taken at that moment, so no commit can apply
between reading them and journalling the take. Replay returns each key's recorded take.

**A limit change that races a limit check.** A step whose turn limit, spend cap or tool-call budget check fails
opens its pending inside the commit lock only when the limits are still the ones it checked. When a `limits`
command was applied in between (it found no pending to resolve), no pending is opened and the driver runs again,
so the step is checked under the new limits.

## Wake-ups

- **In one process**, the store handle emits events after each commit (`run.queued`, `command`, `journal`). The
  runner claims on `run.queued` with no sleep in between, and a live session applies commands on `command`.
- **Wake times.** `claimRuns` first requeues waiting runs whose `wake_at` passed. Inside one process the runner
  that left a run waiting holds one timer for the earliest wake time it knows and claims when it fires; every
  runner's poll covers the rest, so a run is woken (within one poll interval, `runner.pollMs`, of the instant when a
  runner has a free slot; a runner whose slots are all busy does not look for work, so the wake-up then waits until
  a slot is free).
- **Across processes**, the runner polls `claimRuns` every `runner.pollMs` (500 ms by default), each live session
  polls its commands at the same interval, and SSE streams poll the journal the same way.

## Graceful shutdown

`App.stop()` (first SIGINT or SIGTERM to `serve` or `runner`):

1. The runner stops claiming.
2. Each session stops at its next step boundary; in-flight steps are allowed to finish. A stopped run is
   committed `running → queued` with a `run.released` record, so any runner can pick it up at once.
3. After `runner.shutdownGraceMs` (10 s), whatever is still in flight is aborted (a forced stop): model calls
   are journalled `model.interrupted` (`shutdown`, charged at worst case); a tool call of a read-only, idempotent
   or resumable tool keeps its unfinished `tool.started` and, when the run continues, runs again (an idempotent
   write only under [rule R](#tool-calls-started-finished-interrupted)); any other tool
   call is journalled `tool.interrupted` (`reason: "shutdown"`) with an `interrupted` pending, so the run waits for
   a person once it is claimed again. A tool that ignores the signal is waited for and journalled as usual. Then
   the runs are released.
4. The trigger scheduler and the HTTP server stop (open SSE streams are ended), `server.json` is removed, and the
   store is closed.

A hard stop (a second signal, or `Runner.abandon()`) fences the runner's sessions, so nothing more is written
under their leases; its runs are taken over once their leases expire. On a second signal `hostApp` then ends the
process at once with exit code 1 (`CliIo.exit`), also while a tool call that ignores its abort signal is still
running.

A start that fails half way leaves nothing behind: when any step of `App.start()` fails (the server's listen,
including writing `server.json` after the socket is bound, the runner's start or the scheduler's start), the same
shutdown as `App.stop()` runs (scheduler, runner, server, store) and `start()` rejects with the original error.
`App.stop()` closes the server whenever one was created, whether or not it ever published a URL, so afterwards
no socket listens, no timer runs and the store is closed.

**Start and stop race.** After `App.stop()` was called nothing is started any more. A `stop()` called while
`start()` is pending (for example while the server's `listen()` is binding) first waits for that start to
settle; the start checks for a stop after every `await`, so it starts neither the runner nor the scheduler and
rejects with `conflict` ("the app was stopped while it was starting"). Then the shutdown runs in the usual order
(scheduler, runner, server, store), and `stop()` resolves only once all four are stopped, including what the
pending start created. Concurrent `start()` calls share one start; `start()` after `stop()` starts nothing and
resolves. A runner's `start()` after its `stop()` or `abandon()` does nothing (no claim, no timer). `hostApp`
installs its signal handlers before it calls `start()`, so a SIGINT or SIGTERM during the start stops the app the
same way: nothing is announced, and the process exits with the stop's code (0, or 1 if stopping fails or a
second signal arrives), not as a failed start.

## Retention and archival

`runwright retention archive --older-than <days> [--limit N]` works directly on the data directory (no server
needed). Only terminal runs are archived, into `<data dir>/archive/<yyyy-mm>/<runId>.jsonl.gz` (gzip-compressed
JSON lines, one journal record per line, mode 0600; `yyyy-mm` is the UTC month the run finished). For each
finished, unarchived run older than the cutoff (`src/ops/retention.ts`):

1. Create the month directory if needed and stream the journal, one page of 4 records (`JOURNAL_PAGE`) at a
   time, through gzip into a file under a temporary name in it (with the file's backpressure). Continue only if
   the journal was complete: exactly `journalSeq` records with seqs `1..N`; otherwise the temporary file is
   removed and the run is skipped. Then `fsync` the file.
2. Memory holds one page of parsed records, one record serialized at a time (the next line is serialized only
   after gzip accepted the last one) and one stream buffer, whatever the journal's size; the bytes are the same
   as writing every record as `JSON.stringify(record) + "\n"` at once. A page is bounded by records, not bytes,
   so it costs at most 4 times the journal's largest record: a model reply record comes from one provider body
   of at most 64 MiB (`MAX_REPLY_BYTES`), a tool result is cut to `tools.resultBytes`, a message or command to
   the request body limit; a workflow node's value and a run's output have no limit of their own.
3. Publish it with `link()`, which never replaces an existing file. If a file already exists at the path, keep it
   when it is a complete archive of this run; replace it (atomic `rename`) only when it fails verification.
4. Read the published file back and verify it record by record against the journal (streamed: the file through
   gunzip chunk by chunk, the journal again a page at a time, one line held while it is compared), and `fsync`
   the published file (also when another pass wrote it).
5. Sync the month directory, so the file's directory entry is on disk, and then the entry of every directory from
   the month directory up to the file-system root (the `archive` directory, the data directory and every directory
   above it), whoever created them and whether or not an earlier pass already did; within one pass a directory
   entry is synced once. A directory above the month directory that the process cannot write to, and that cannot
   be opened or is on a read-only file system, is skipped. A platform that cannot sync a directory at all (Windows, some network and FUSE
   file systems) is tolerated; any other sync error skips the run with the reason and keeps its journal rows.
6. Only then call the conditional `archiveJournal`, which deletes the journal rows and marks the run archived only
   if the run is not archived yet and its journal still holds exactly the archived records.

`archiveFinishedRuns` itself refuses an `olderThanMs` that is not a finite number >= 0 and a `limit` that is not an
integer >= 0 (`bad_request`, nothing archived), so a malformed number never archives everything or nothing by
accident, whoever calls it.

The result lists `archived` (`{runId, path, records}`) and `skipped` (`{runId, reason}`). A run that another
archiver finished meanwhile (`already_archived`) is in neither list. Anything else that prevents archiving (an
incomplete journal, an archive that does not verify, a failed file or directory sync, an error) is reported in `skipped`
and leaves the journal
rows and any existing archive untouched. So journal rows are deleted only after a complete, verified archive
exists, a complete archive is never replaced, and overlapping `retention archive` processes are safe.

The run row, its usage rows and its learning records stay; `GET /v1/runs/:id/timeline` answers `archived: true`
with no records.

## Triggers

A fire is one store transaction, `fireTrigger`, for all three kinds of key (`cron:…`, `webhook:…`, `manual:…`).
In order: the key is looked up first, and a fire that already started a run gets that run (`duplicate`; a
redelivered webhook is answered `202 {runId, duplicate: true}`), also when the trigger has been turned off or
edited since. Then the trigger row is read, and the run is created only if the row exists, is enabled, and its
definition (name, kind, agent, enabled, cron, webhook, message, limits) equals the one the caller read and built
the run from. Otherwise nothing is written and the outcome is `missing` (404), `disabled` (409
`trigger_disabled`) or `changed`. The routes read the trigger themselves before they fire, so a trigger that no
longer exists gets 404 there. So a run never starts from a trigger that was disabled, deleted or edited after the
caller read it: it always carries the agent, message and cap that are stored at the moment it is created. The
run itself is created by the same code as `createRun` (limits merged with the agent revision's, the `runs` row,
`run.created`, `run.queued`). It pins the agent revision that was current when the fire was prepared: the store
wrapper reads that revision, redacts the run's input against its secrets and passes it as `run.revision`, so a
revision published between that read and the transaction does not change what the run pins (the revision
a run pins is always the one its input was redacted against); a trigger whose agent no longer exists starts nothing (`agent_missing`), and a
scheduled fire of it still consumes its slot. `fireTrigger` never inserts a trigger row and never changes a
definition column.

On `changed`, `POST /v1/triggers/:id/fire` and `POST /v1/hooks/:id` read the trigger again and repeat (a
delivery's signature is verified again, against the secret the trigger names now), up to three times, then 409
`conflict`; the cron scheduler skips the trigger until its next tick, which reads it again.

A scheduled fire names the slot it consumes, the `nextFireAt` the scheduler read. The same transaction creates the
run, sets `lastFiredAt` and moves `nextFireAt` from that slot to the next fire time, and only while the stored
`nextFireAt` still equals the slot. A scheduler that is late finds the slot consumed (`stale`, or `duplicate` for
the same slot) and writes nothing, so the cursor only moves forward and schedulers on several processes cannot
start a second run for fire times another one has already coalesced. `lastFiredAt` never moves backwards: a fire
stores the later of the stored value and its own time. The one write a `duplicate` can make is to settle a cursor
that still names the slot of a run that exists (the run was created and the cursor never moved).

Saving the definition of an existing trigger keeps its `lastFiredAt`. A change through `PATCH /v1/triggers/:id` is
written with `updateTrigger`, a compare-and-set: it writes only if the stored definition still equals the one the
request read and merged its fields into, and it never inserts. When another request changed the trigger in
between, the PATCH reads and merges again (up to three times, then 409 `conflict`), so neither change is lost; a
trigger deleted while the change was being handled stays deleted (the request gets 404). A change that leaves an
enabled cron trigger enabled with its expression and time zone as they are keeps the stored `nextFireAt`, so an
unrelated edit never skips a fire time that is due (nor undoes a cursor a fire moved meanwhile); a changed
schedule, or turning the trigger on, stores the next fire time after now, and turning it off stores none.

## Durability guarantees and limits

- **What survives a process crash** (SIGKILL, out-of-memory, a panic): everything committed. Each durable step is
  one transaction, so a crash loses at most the step in flight. On restart, finished steps are replayed from the
  journal and never executed again; an unfinished model call is charged at worst case and issued again; an
  unfinished tool call is retried only when the tool is read-only or resumable, or is declared idempotent and no
  write call of the run finished after it started ([rule R](#tool-calls-started-finished-interrupted)), and
  otherwise waits for a person.
- **Power loss.** The store runs with `synchronous=NORMAL` in WAL mode: commits survive process crashes, but the
  last transactions before a power failure or OS crash can be lost (the database stays consistent). Set
  `store.synchronous` to `"full"` in `config.json` to sync every commit, at some cost in throughput. The API token
  (`<data dir>/token`) and the seal key (`<data dir>/seal.key`) are synced to disk, file and directory entry: each
  is written to a temporary file that is synced before it is linked into place, and **every start** syncs the data
  directory and then the entry of every directory above it, up to the file-system root, whoever created them and
  whether or not an earlier start already did, so a start that was interrupted between creating a file or a
  directory and syncing its entry is repaired by the next one. The one exception: a directory above the data
  directory that the process cannot write to, and that cannot be opened or is on a read-only file system, is
  skipped, because nothing this user started can have created an entry in it; every other sync failure fails the
  start. A power loss after a start therefore cannot take the data directory away, nor leave sealed secrets in
  the database without the key that opens them.
- **Effects outside the journal.** A tool's side effect and its `tool.finished` record cannot be one atomic
  operation. A crash between them, and a pause or a forced shutdown that aborts the call before it finished, are
  exactly the interrupted cases above; Runwright never assumes either way. The built-in file tools' effects are
  fenced by the epoch like the journal: a runner that lost its lease cannot change a workspace file after its
  successor started ([rule F](#leases-epochs-and-fencing)); `shell` and host tools are not.
- **Learning writes are atomic with the journal.** Item versions, given and opened records, promotion outcomes
  and promoted workflows are written in the same fenced commit as the record of their step, so a runner that lost
  its lease cannot write them, and a crash never applies one twice or without its record.
- **One database file.** Runners in other processes must use the same data directory on a local file system;
  SQLite over a network file system is not supported.
- **One writer at a time.** SQLite lets one transaction write at a time, and every transaction is synchronous and
  short. A process that is frozen (for example by `SIGSTOP`) in the middle of one keeps the write lock until it
  runs again or dies. Until then every other writer waits up to `busy_timeout` (5 s) and then fails with a store
  error (a runner's claim is tried again at its next poll), so no lease can be taken over meanwhile. A process that dies releases the lock at once; a frozen one that is
  between transactions holds no lock, and its runs are taken over when their leases expire.
