# Configuration

Configuration is built in this order, each layer overriding the one before (`src/config/load.ts`):

1. the defaults in `src/config/defaults.ts`;
2. `<data dir>/config.json`, if it exists;
3. `RUNWRIGHT_*` environment variables;
4. command-line flags (`--port`, `--host`, `--no-runner`, `--concurrency`, `--lease-ms`).

`config.json` holds any subset of the keys below. Every object is closed: an unknown key at any depth, or a value
of the wrong type or range, stops startup with `config_invalid` and the JSON path of the problem. `dataDir`
cannot be set in the file (use `RUNWRIGHT_DATA_DIR` or `--data-dir`). Objects merge key by key; arrays, scalars,
`learning.graderModel` and each entry of `models.prices` are replaced as a whole.

The same holds for an agent definition (`PUT`/`POST` of an agent) and for `learning.graderModel`: the model ref
is closed (`maxOutputToken` is reported at `$.model.maxOutputToken`, or `$.learning.graderModel.maxOutputToken`,
not ignored) and a scripted model's `script` is validated in full, see [below](#scripted-scripts). The only
intentionally open payloads are a scripted tool call's `args` (any JSON object), a scripted turn's `output` (any
JSON value) and an agent's `workflow` (checked in full by the workflow validator, see
[workflows.md](workflows.md)).

## Keys and defaults

| Key | Default | Environment / flag | Meaning |
|---|---|---|---|
| `dataDir` | `~/.runwright` | `RUNWRIGHT_DATA_DIR`, `--data-dir` | the data directory |
| `server.host` | `"127.0.0.1"` | `RUNWRIGHT_HOST`, `--host` | interface to bind |
| `server.port` | `7411` | `RUNWRIGHT_PORT`, `--port` | port; `0` picks any free port |
| `server.portSearch` | `20` | – | when the port is taken, try up to this many following ports; set to `0` whenever the port is given explicitly by environment or flag |
| `server.bodyBytes` | `1048576` | – | request body limit (413 above it) |
| `server.ssePingMs` | `15000` | – | interval of `: ping` comments on SSE streams (1–2147483647) |
| `runner.enabled` | `true` | `RUNWRIGHT_NO_RUNNER` (`1`: off, `0`: on), `--no-runner` | host an in-process runner in `serve` |
| `runner.concurrency` | `8` | `RUNWRIGHT_CONCURRENCY`, `--concurrency` | runs executed at once by one runner (1–1024) |
| `runner.leaseMs` | `30000` | `RUNWRIGHT_LEASE_MS`, `--lease-ms` | lease length; another runner takes over a run this long after its holder stops renewing (1–2147483647) |
| `runner.heartbeatMs` | `10000` | – | lease renewal interval; must be below `leaseMs`; when `leaseMs` is changed by environment or flag and the file does not set it, it becomes `leaseMs / 3` (1–2147483647) |
| `runner.pollMs` | `500` | `RUNWRIGHT_POLL_MS` | polling interval for work and commands from other processes, and for SSE (1–2147483647) |
| `runner.shutdownGraceMs` | `10000` | – | how long graceful shutdown waits for in-flight steps before aborting them (0–2147483647) |
| `store.synchronous` | `"normal"` | – | SQLite `synchronous`: `"normal"` (survives process crashes; the last commits can be lost on power failure) or `"full"` |
| `tools.deny` | `[]` | `RUNWRIGHT_DENY_TOOLS` (comma list, added to the file's) | tools denied to every agent; checked immediately before every tool execution, so it also applies to calls run again or retried after a crash, a pause or a shutdown |
| `tools.resultBytes` | `16384` | – | tool results above this are truncated in the journal; the full text is saved in the workspace |
| `tools.shell.enabled` | `false` | `RUNWRIGHT_SHELL` (`1`: on, `0`: off) | register the `shell` tool |
| `tools.shell.timeoutMs` | `60000` | – | `shell` timeout (1–2147483647) |
| `tools.shell.outputBytes` | `65536` | – | `shell` output limit |
| `tools.webFetch.timeoutMs` | `15000` | – | `web_fetch` time limit (1–2147483647) |
| `tools.webFetch.maxBytes` | `1048576` | – | `web_fetch` response size limit |
| `tools.webFetch.maxRedirects` | `5` | – | `web_fetch` redirect limit |
| `tools.files.maxReadBytes` | `1048576` | – | largest file `read_file` returns |
| `tools.files.maxWriteBytes` | `1048576` | – | largest content `write_file` / `edit_file` writes |
| `models.prices` | `{}` | – | price overrides, see [below](#prices) |
| `models.allowUnpricedModels` | `false` | `RUNWRIGHT_ALLOW_UNPRICED` (`1`: on, `0`: off) | let models with no price run under a cap, their cost counted as zero (priced calls are still held to the cap) |
| `models.defaultMaxOutputTokens` | `4096` | – | output limit of a model call when the model ref sets none |
| `models.defaultContextTokens` | `128000` | – | context budget when the model ref sets no `contextTokens` |
| `models.retry.maxAttempts` | `5` | – | provider attempts per model call; the engine retries transient errors attempt by attempt, see [below](#models-and-keys) |
| `models.retry.baseMs` | `500` | – | first backoff (1–2147483647) |
| `models.retry.maxMs` | `30000` | – | backoff cap (1–2147483647) |
| `models.retry.maxRetryAfterMs` | `300000` | – | the longest wait a provider may ask for (`Retry-After`, `retry-after-ms`) that the engine waits out; a longer one fails the call without another attempt (1–2147483647) |
| `agent.compactAtFraction` | `0.8` | – | compact older turns when a request's estimate passes this fraction of the context budget (0.05–1) |
| `agent.keepRecentTurns` | `4` | – | turns kept verbatim after a compaction |
| `learning.budgetTokens` | `2000` | – | token budget of the learned-items section given to a run |
| `learning.promoteAfterRuns` | `3` | – | completed runs a skill serves before it is drafted as a workflow |
| `learning.maxNotes` | `5` | – | notes kept per run |
| `learning.maxSkills` | `2` | – | skills kept per run |
| `learning.graderModel` | `null` | – | model ref for the grader call (`null`: the agent's model); its key is redacted from the run's records like the agent's own |
| `learning.onLimit` | `"pause"` | – | what a learning, grader or promotion call does when it does not fit the spend cap: `"pause"` (the run waits on a `spend_cap` pending at that step, its output already recorded, and finishes learning when the cap is raised) or `"skip"` (the proposal is skipped, the graded items are held, the promotion is skipped); see [learning.md](learning.md#when-learning-happens) |
| `triggers.tickMs` | `1000` | – | cron scheduler tick (1–2147483647) |
| `triggers.webhookWindowSec` | `300` | – | webhook replay window |
| `log.level` | `"info"` | `RUNWRIGHT_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |

**Numbers.** Every whole-number key is at most 9007199254740991 (`Number.MAX_SAFE_INTEGER`) unless the table
gives a smaller range, and every price (`models.prices`) is a number from 0 to 1000000000 USD per million tokens.
A whole number in an environment variable has at most 15 digits. A value outside these bounds is
`config_invalid` with its path.

**Durations.** Every key that ends in `Ms` is a whole number of milliseconds of at most 2147483647 (2^31 − 1,
about 24.8 days: the longest wait one timer holds). A larger value is refused when the configuration is loaded
(`config_invalid` with the key's path), whether it comes from `config.json`, an environment variable or a flag.

Example `config.json`:

```json
{
  "runner": { "concurrency": 16 },
  "store": { "synchronous": "full" },
  "tools": { "deny": ["web_fetch"] },
  "models": { "prices": { "openai-compatible/llama-3.1-8b": { "inputPerMTok": 0, "outputPerMTok": 0 } } },
  "learning": { "budgetTokens": 4000 }
}
```

## Environment variables

| Variable | Effect |
|---|---|
| `RUNWRIGHT_DATA_DIR` | data directory |
| `RUNWRIGHT_HOST`, `RUNWRIGHT_PORT` | `server.host`, `server.port` (an explicit port disables the port search) |
| `RUNWRIGHT_CONCURRENCY`, `RUNWRIGHT_LEASE_MS`, `RUNWRIGHT_POLL_MS` | runner settings (whole numbers) |
| `RUNWRIGHT_NO_RUNNER` | `1`/`true`/`yes`: no in-process runner; `0`/`false`/`no`: a runner, even when `config.json` sets `runner.enabled: false` (`--no-runner` still wins) |
| `RUNWRIGHT_SHELL` | `1`/`true`/`yes`: enable `shell`; `0`/`false`/`no`: disable it, even when `config.json` enables it |
| `RUNWRIGHT_ALLOW_UNPRICED` | `1`/`true`/`yes` or `0`/`false`/`no`: `models.allowUnpricedModels`, overriding `config.json` either way |
| `RUNWRIGHT_DENY_TOOLS` | comma list **added** to the file's `tools.deny` (it never removes a name; applies to recovered and retried calls too) |
| `RUNWRIGHT_LOG_LEVEL` | `log.level` |
| `RUNWRIGHT_TOKEN` | the API token (instead of `<data dir>/token`); also used by client commands |
| `RUNWRIGHT_SEAL_KEY` | the seal key, base64 of 32 bytes (instead of `<data dir>/seal.key`) |
| `RUNWRIGHT_URL` | server URL for client commands (instead of `<data dir>/server.json`) |

Flag variables accept `1`, `true`, `yes`, `0`, `false` or `no` (any letter case); anything else is
`config_invalid`. A flag variable that is set overrides `config.json` in both directions; an unset or blank one
leaves the file's value. Every other variable that sets a key replaces the file's value, except
`RUNWRIGHT_DENY_TOOLS`, which adds to it; command-line flags override the environment.

## Data directory

Created with mode 0700 on first start:

| Path | Contents |
|---|---|
| `runwright.db` (+ `-wal`, `-shm`) | the SQLite store |
| `token` | the API token (mode 0600); absent when `RUNWRIGHT_TOKEN` is set |
| `seal.key` | the seal key, base64 (mode 0600); absent when `RUNWRIGHT_SEAL_KEY` is set |
| `config.json` | optional configuration (you create it) |
| `server.json` | `{url, pid, startedAt}` while a server runs (mode 0600); the CLI reads it to find the server |
| `workspaces/<runId>/` | each run's workspace; `.runwright/tool-results/` inside holds the full text of truncated tool results (`<label>-<key16>-<sha256>.txt`) and the structured data of results whose data was over the size limit (`<label>-<key16>-<sha256>.data.json`), under `untrusted/` for untrusted results; `.runwright/stage/<epoch>/` is the staging folder of the run's current lease epoch (the temp files of writes in progress; rule F, see "File tools") and `.runwright/unstage/` holds earlier epochs' folders while a claim deletes them, and neither is listed as run files. `write_file`, `edit_file` and `delete_file` refuse paths in `.runwright/` (decided by which directory it is, not by spelling); this is not a sandbox: `shell` and host tools can still write there, and learning checks each saved file of an untrusted result (full text or structured data) against the digest journalled with it |
| `archive/<yyyy-mm>/<runId>.jsonl.gz` | archived journals |

Back up the whole directory while no process writes to it, or copy `runwright.db` with SQLite's backup tools.
Keep `seal.key` (or the `RUNWRIGHT_SEAL_KEY` value): without it the sealed secrets cannot be opened.

## File tools

`read_file`, `write_file`, `edit_file`, `list_files` and `delete_file` act inside the run's workspace
(`tools.files.maxReadBytes` and `maxWriteBytes` bound them).

- **Mutations of one workspace never interleave.** Inside one runner process, `write_file`, `edit_file` and
  `delete_file` share one queue per workspace: each call (for `edit_file` the read, the replacement and the rename
  together) starts after the previous one has settled, so two parallel workflow branches or `map` items that edit
  one file both take effect, whatever spelling of the path they use. A call that fails releases the queue, and a
  call that was aborted (a pause, a cancel, its deadline, a lost lease) while it waited in the queue does not
  start. `read_file` and `list_files` are not queued; a file is always replaced by a rename, so a reader never
  sees half of it.
- **Across runners rule F applies.** The queue is per process, and a runner that lost its lease may still be
  running a call when another runner takes the run over. So every change the file tools and the engine make in a
  workspace is one `rename` or `link` with one end in `.runwright/stage/<epoch>`, the staging folder of the
  writer's own lease epoch: a write goes to a temp file there that one rename moves to its target, a deletion
  renames the file into it, and a saved tool result is linked from it. Only a claim creates that folder, and the
  next runner that claims the run renames it away before its first step. A runner that lost its lease therefore cannot change
  a workspace file after its successor started, however late it wakes up: the system call itself fails, and the
  call ends with `lease_lost`. `shell` and host tools are outside both guarantees: a stale runner's shell command
  that is still running can still write.
- **Text is exact.** `read_file` returns the file's text with a leading byte order mark kept (U+FEFF), so the
  content re-encodes to the `bytes` and `sha256` it reports, and `edit_file` keeps the mark. A file that is not
  UTF-8 is an error result.
- **Limits are checked before anything is built.** `edit_file` computes the size of the edited file from the
  file's size, the number of matches and the two texts' byte lengths, and refuses an edit over `maxWriteBytes`
  (`the edited file would be <n> bytes, larger than the write limit of <limit> bytes`) before it builds the new
  text, so a small file with a large `replace_all` expansion costs no memory to refuse.
- **Listings say when they are cut.** `list_files` lists at most 2000 entries of one directory, in name order;
  its `data` has `entries`, `truncated` (more exist) and `total` (how many the directory holds).

## Models and keys

A model ref in an agent definition is `{provider, name, baseUrl?, apiKeySecret?, maxOutputTokens?,
contextTokens?, script?}`, and nothing else:

| Provider | Key | Notes |
|---|---|---|
| `scripted` | none | offline and deterministic, driven by `script`; used by tests, examples and the benchmark. A structured step that has a step name (a workflow node's id, for example) and no script entry is answered with a placeholder of its schema, made by the generator described in [workflows.md](workflows.md#how-a-placeholder-is-chosen); when no placeholder that validates can be generated, the answer is invalid and the step fails after its repair, so give such a step a script entry. A turn with no `output` whose text is not JSON carries no structured output (an invalid reply, never `null`) |
| `anthropic` | sealed secret `ANTHROPIC_API_KEY`, or the one named by `apiKeySecret` | Messages API; `baseUrl` defaults to `https://api.anthropic.com` |
| `openai-compatible` | sealed secret `OPENAI_API_KEY` for the default base URL; with a custom `baseUrl`, only `apiKeySecret` if given | Chat Completions; `baseUrl` defaults to `https://api.openai.com/v1` (set it for OpenRouter or a local server) |

Keys are set with `runwright secrets set ANTHROPIC_API_KEY` (value from stdin) or `PUT /v1/secrets/:name`. A
missing key makes the run fail with `secret_missing`.

### Scripted scripts

A `script` is `{turns?, steps?, variants?}`, closed at every depth:

- `turns`: a list of turns; turn *n* of the conversation gets entry *n* (past the end: `(script finished)`).
- `steps`: step name → one turn, or a list of turns indexed by turn number.
- `variants`: a list of `{when, turns?, steps?}`; `when` is required, `{contains, in?}`, where `contains` is a
  string looked for in the system prompt, the messages or either (`in`: `"system"`, `"messages"`, `"any"`,
  default `"any"`). The first matching variant with `turns` wins; a variant's steps are looked up before the
  script's.
- A turn: `{text?, toolCalls?, output?, usage?, delayMs?, chunks?, fail?}`. `toolCalls` is a list of
  `{name, args, id?}` (`name` non-empty, `args` any JSON object); `output` is any JSON value; `usage` has the
  four counters `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` (integers ≥ 0); `delayMs`
  is 0 to 2147483647; `chunks` ≥ 1; `fail` is `{attempts, status?, network?, retryAfterMs?, message?, billing?}`
  (`attempts` required, `status` 100 to 599, `billing` `"none"` or `"unknown"`).

Revisions stored by an older version are not validated again; a variant there without `when` never matches.

**Retries.** A provider sends exactly one request per call to it and never retries by itself. `models.retry` is
applied by the engine, per attempt: a model call makes at most `maxAttempts` provider attempts, each one admitted
against the run's spend cap, journalled (`model.started`) and charged on its own. A `model_transient` failure
with attempts left waits, then tries again: the provider's retry-after hint (`retry-after-ms` or `Retry-After`)
in full when it gave one, otherwise `min(maxMs, baseMs × 2^(attempt − 1))` scaled by a random factor between 0.5
and 1. A hint longer than `maxRetryAfterMs` is never shortened: the call fails with `model_failed` and no further
attempt is sent. A run that is paused, stopped or restarted during a provider's wait serves the rest of that wait
before its next attempt. Which failures are transient, and whether a failed attempt counts as possibly
billed (`details.billing`; `"unknown"` is charged the attempt's worst case as an assumed cost, `"none"` is charged
nothing):

| Where the attempt failed | Code | Billing |
|---|---|---|
| `fetch` rejected and the error's `cause` chain has a `code` of `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH` or `UND_ERR_CONNECT_TIMEOUT` (no connection was made) | `model_transient` | `"none"` |
| `fetch` rejected for any other reason | `model_transient` | `"unknown"` |
| HTTP 408, 409, 425, 429 or 5xx | `model_transient` | `"none"` |
| any other non-2xx HTTP status | `model_failed` | `"none"` |
| after a 2xx status: an error envelope in the stream or as the whole JSON body (`{"error": {...}}`, for either provider) | `model_transient` when its status is retryable (the first integer from 100 to 599 among `error.code`, `error.status`, `code`, `status`; a numeric string counts) or its kind (`error.type`, or a non-numeric `error.code`, lower-cased) is `server_error`, `rate_limit_exceeded`, `rate_limit_error`, `overloaded`, `overloaded_error`, `service_unavailable` or `timeout`, and for Anthropic also `api_error` and `timeout_error`; otherwise `model_failed`. `details.status` is the envelope's status (for an Anthropic transient type without one, the type's: 529, 500, 429, 504) | `"unknown"` |
| after a 2xx status: the body or stream failed, ended early, was not JSON, or held tool arguments that are not a JSON object (ordinary tool calls on every path; the output tool's arguments under an object schema; arguments that are not JSON) | `model_transient` (a body or stream that broke off or ended early) or `model_failed` (the rest) | `"unknown"` |
| a failure raised before any request is sent (a bad base URL, a request that cannot be built) | `model_failed` | `"none"` |
| scripted `fail` | `model_transient` (with `network` or a transient `status`) or `model_failed` | `fail.billing`, default `"none"` |

The rules for the attempt loop, resume and the spend bound are in
[architecture.md](architecture.md#model-calls-reservations-interruption-and-repair).

## Prices

The price table (`src/models/prices.ts`) is in USD per million tokens, keyed `"<provider>/<name>"`, with
`inputPerMTok`, `outputPerMTok` and optional `cacheReadPerMTok` and `cacheWritePerMTok` (each defaults to the
input price when absent). It holds `scripted/scripted-1` at nominal prices (input 1.00, output 5.00, cache read
0.10, cache write 1.25) so cost features work offline, and a dated snapshot of list prices for Anthropic and
OpenAI models (`PRICES_AS_OF`). Any other scripted name, for example `scripted/unpriced-1`, has no price.

Override or extend it in `config.json` under `models.prices`. Your entries are looked up first. A key ending in
`*` matches by prefix (the longest prefix wins), for example `"openai-compatible/my-local-*"`.

Usage totals saturate at 2^53 − 1: every stored or reported total of tokens, cost micro-dollars, tool calls and
turns (a run's counters, the usage summaries, the learning metrics) is an integer from 0 to 9007199254740991, and
an addition that would pass it yields exactly that value. One usage row's counts are clamped to that range when
it is stored.

A model with no price makes the run's cost **unknown** (shown as `unknown`, never `$0`), and an unknown cost
counts as over any cap that is set: such a run pauses with a `spend_cap` pending (`reason: "unknown_price"`)
before its first call. Allow it per run with `runwright runs raise <run> --allow-unpriced` (or `allowUnpriced` in
the run's limits), or for every run with `models.allowUnpricedModels: true`.

Allowing unpriced models does not switch off the cap. It lets calls to unpriced models run and counts their
cost as zero; every priced call of the same run (a priced grader model, a workflow step on another model) is
still admitted only when `known spend + reservations + its worst case <= cap`. When that does not fit, the call
is not sent: the run pauses with a `spend_cap` pending, `reason: "cap"` and the amount it needs (a learning
call does the same unless `learning.onLimit` is `"skip"`; then the grader's call is skipped and its items are
held for a person) (`nextCallWorstCaseMicros` is `null`
when the next call is unpriced and the known spend alone is over the cap). The unknown cost is sticky: a run
that already made an unpriced call stays `unknown`, and over a cap unless allowed, even if a price is configured
later.

## Running a separate runner process

`runwright runner` starts a runner with no HTTP server against the same data directory (`--data-dir` or
`RUNWRIGHT_DATA_DIR`), so several processes share the work:

```sh
runwright serve --no-runner          # API and console only
runwright runner --concurrency 8     # in another terminal; start as many as you like
```

All processes must use the same data directory on a local disk. Each runner claims runs under its own leases;
if one dies, the others take over its runs once their leases expire (`runner.leaseMs`). Across processes, new
work and commands are picked up by polling every `runner.pollMs`, and model text deltas are only streamed for
runs executed by the server's own in-process runner.

## Triggers

Create triggers with `runwright triggers create <file.json>` or `POST /v1/triggers` ([api.md](api.md#triggers-and-webhooks)).
Every trigger carries `limits.maxCostMicros` (required, positive) and can be turned off with `enabled: false`
(`runwright triggers disable <id>`).

### Cron

Five fields: `minute hour day-of-month month day-of-week`.

| Supported | Example |
|---|---|
| a number | `30` |
| `*` | every value |
| a range `a-b` | `9-17` |
| a step `*/n` or `a-b/n` | `*/15`, `0-30/10` |
| a comma list of the above | `0,30`, `1-5,0` |

Ranges: minute 0–59, hour 0–23, day of month 1–31, month 1–12, day of week 0–7 (0 and 7 are both Sunday).
The next fire time is searched over a whole 400-year cycle of the calendar (after which it repeats), so a
schedule that fires at all always has one, however far away (`0 0 */30 2 1`, February 1st when it is a Monday,
fires in 2027 and next in 2038); a trigger whose `nextFireAt` is `null` never fires (`0 0 31 2 *`, `0 0 30 2 *`).
**Not supported** (rejected with `cron_invalid`): names (`MON`, `JAN`), `?`, `L`, `W`, `#`, macros such as
`@daily`, a sixth (seconds) field, `a/n` without a range, and out-of-range, reversed or zero-step values.

**Day rule.** A day field is *restricted* when its text does not start with `*`. When **both** day fields are
restricted, a day matches if either field holds it; in every other case it matches only if both fields hold it.
A plain `*` holds every value, so it never excludes a day, but a stepped star (`*/2`) does:

| Expression | Fires at midnight on |
|---|---|
| `0 0 */2 * *` | days 1, 3, 5, … 31 of every month (the step restarts at 1 each month, so the 31st is followed by the 1st) |
| `0 0 * * */2` | Sunday, Tuesday, Thursday and Saturday |
| `0 0 */2 * 1` | Mondays that fall on an odd day of the month (a field starting with `*` never switches to "either") |
| `0 0 13 * 5` | the 13th of every month and every Friday (both fields restricted: either) |

**Time zones.** `cron.timeZone` is an IANA name (default `UTC`). The expression is evaluated in that zone's local
time: a local time skipped by a daylight-saving jump does not fire, and a local time that occurs twice fires
once.

**Missed fires.** The scheduler checks every `triggers.tickMs`. When a trigger's next fire time has passed, it
starts **one** run however many fire times were missed (for example after downtime), with `data:
{scheduledFor, missedFires, missedFiresCapped}` (`missedFires` counts the fires beyond the one that ran), and
stores the next fire time after now. Counting stops at 1 000 fire times, so `missedFires` is at most 999; when the
count stopped there `missedFiresCapped` is `true` and `missedFires` means "at least 999" (for example an
every-minute trigger after a day of downtime). The "trigger fired" log line carries both fields. The run's idempotency key is `cron:<triggerId>:<scheduled time>` (stored as its `sha256:`
digest, like every key). The run and the new `nextFireAt` are written in one transaction, and only while the
stored `nextFireAt` is still the fire time the scheduler read, so several schedulers on the same data directory
start one run per coalesced fire and a late one cannot move the next fire time back.

**Edits while a trigger fires.** A fire starts a run only from the trigger as it is stored when the fire's
transaction runs. A trigger that is disabled, deleted or edited before that transaction starts no run from the
old definition: the scheduler skips it and fires it again, under the new definition, at its next due time (a
disabled trigger once it is turned on again, a deleted one never). An edit that leaves the schedule of an
enabled cron trigger unchanged (same expression and time zone) keeps its next fire time, so a fire that is due
is not skipped; a changed schedule, or turning the trigger on, stores the next fire time after now. A fire
writes only the trigger's `lastFiredAt`, `nextFireAt` and `updatedAt`, so a change made after it is kept, and
a deleted trigger is not recreated.

### Webhooks

1. Store the signing secret: `runwright secrets set HOOK_SECRET`.
2. Create the trigger:

   ```json
   { "name": "build failures", "kind": "webhook", "agentId": "triage", "webhook": { "secretName": "HOOK_SECRET" },
     "message": "A build failed; find out why", "limits": { "maxCostMicros": 100000 } }
   ```

3. Point the sender at `POST <server>/v1/hooks/<triggerId>` with the signature headers `X-Runwright-Timestamp`
   and `X-Runwright-Signature`, and a body that is a JSON object carrying the delivery id as its `delivery`
   string. The delivery id is the `delivery` member of the signed JSON body, so it is covered by the signature: a
   captured request replayed with another `X-Runwright-Delivery` header is rejected, and replayed unchanged it is
   the same delivery and starts no second run. The headers, the replay window, the delivery dedupe and an
   `openssl` signing recipe are in [api.md](api.md#webhooks).
