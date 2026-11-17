# CLI reference (`runwright`)

From a checkout, run the CLI as `node bin/runwright.ts <command>` (the examples below write `runwright` for
short). `npm start` is the same as `runwright` with no arguments. The CLI is built on the TypeScript client in
`src/client`. Every API operation has a command, with two exceptions: `GET /` is the web console page itself (open
it in a browser), and `POST /v1/hooks/:id` is a signed webhook delivery, whose caller is the sender that holds the
signing secret; `runwright triggers fire` is the operator's way to start a run from a trigger by hand.

## Global flags

| Flag | Meaning |
|---|---|
| `--json` | print JSON even on a terminal |
| `--data-dir <dir>` | the data directory (default `RUNWRIGHT_DATA_DIR`, else `~/.runwright`) |
| `--url <url>` | the server URL (default: discovered, see below) |
| `--token <token>` | the API token (default: discovered) |
| `--connect-timeout <sec>` | how long to wait for a server to answer (default 5) |
| `-h`, `--help` | usage of the command, of a command group (`runwright runs --help`), or the command list |

## Output

- **JSON mode.** When stdout is not a terminal, or `--json` is given, every command prints exactly one JSON
  document on stdout: its result (the client's result object), `{"help": "<usage text>"}` for help (`help`,
  `--help`, `-h`, a group's usage), or `{"error": {...}}`. The one stream is `runs timeline --follow`: one JSON
  document per line (a failure after the stream started is one more line, `{"error": {...}}`).
- **Raw bytes and text.** In JSON mode `runs files <run> <path>` prints `{path, contentType, bytes, encoding,
  content}`: `encoding` is `"utf8"` and `content` the text when the file is valid UTF-8, otherwise `"base64"` and
  the bytes in base64. The text is exact: a leading byte order mark is kept (U+FEFF), so `content` re-encodes to
  `bytes` bytes, and a terminal gets the same bytes as `--out` writes. `workflows graph --mermaid` prints `{"mermaid": "<text>"}`. To get the raw bytes or text
  whatever the mode, use `--out <file>` (`runs files ... --out`, `workflows graph ... --out`); the command then
  prints a short result instead (`runs files`: `{path, out, bytes, contentType}`; `workflows graph`: `{out,
  bytes}`; on a terminal `Wrote <n> bytes to <file>`).
- **Human text** on a terminal: aligned tables for lists, a few labelled lines for single objects, a file's text
  as it is (a binary file prints `<path>: <n> bytes of binary data; save it with --out <file>` instead), the
  Mermaid text, the usage text. Costs are printed as dollars, and an unknown cost as `unknown` (never `$0`).
- **Errors** go to stderr as `error: <message> (<code>)`, or in JSON mode to stdout as
  `{"error": {"code", "message"}}` (a usage error has the code `usage`; its usage text still goes to stderr).

## Arguments

- `--help`, `-h` and `--json` are options like any other: a token after `--` is always an argument
  (`runwright runs message @last -- --help` sends the message `--help`), and so is the value of an option. A
  value that starts with `-` is written with `=`: `--reason=--help`; `--reason --help` is a usage error.
- Numbers are checked before anything is sent: whole numbers have a lower and an upper bound (for example
  `runs list --limit` 1 to 200), and seconds (`--timeout`, `--connect-timeout`) are at most 2147483, the longest
  wait one timer holds. A flag that would have no effect is refused rather than ignored: `runs start --timeout`
  needs `--wait`, `runs resolve --result` goes with `--action skip` only, `runs files --out` needs a path, and
  `--url`, `--token` and `--connect-timeout` are refused by the commands that do not talk to a server (`serve`,
  `runner`, `retention archive`, `bench`, `version`, `help`).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success; for `runs wait`, the run completed |
| `1` | failure: an API error, no server found, a run that failed or was cancelled, a `runs wait` timeout, `workflows validate` with errors |
| `2` | usage error: unknown command or flag, missing or out-of-range argument, a pending that cannot be picked automatically, or a `--pending` that is not an open pending of that run and kind |
| `8` | the run is waiting on a person (or paused) |

## Finding the server

Client commands find a local server by themselves:

- URL: `--url`, else `RUNWRIGHT_URL`, else `<data dir>/server.json` (written by a running server).
- Token: `--token`, else `RUNWRIGHT_TOKEN`, else `<data dir>/token`.
- If no server answers `GET /v1/health`, the CLI retries for up to `--connect-timeout` seconds, then exits 1 with
  `no Runwright server found for <data dir>; start one with: runwright serve`.

## `@last`

Wherever a run id is expected, `@last` means the most recently created run.

## Commands

### Server and runners

```
runwright                         same as `serve`
runwright serve [--port N] [--host H] [--no-runner] [--concurrency N] [--lease-ms N]
runwright runner [--concurrency N] [--lease-ms N]
```

`serve` starts the HTTP API, the web console, the trigger scheduler and (unless `--no-runner`) one in-process
runner. It prints the URL, the console URL, the path of the token file (never the token), the data directory and
the runner. The default port is 7411; when it is taken the next free port is used (up to 20 further). An explicit
`--port` (or `RUNWRIGHT_PORT`) is used exactly, with no search. The first SIGINT or SIGTERM stops gracefully and
exits 0 (1 if stopping fails). A second one, while the graceful stop is still waiting, fences the runner's runs
(nothing more is written under its leases; another runner takes them over once the leases expire, and a write
call that was interrupted waits for a person as after a crash) and then ends the process immediately with exit
code 1, without waiting for open requests or for a tool call that ignores cancellation. A signal that arrives
while the server is still starting stops it the same way: nothing more is started, nothing is announced, and the
exit code is the one of the stop. When starting fails half way, whatever had started is stopped before the error
is printed (exit 1), so nothing is left listening.

`runner` starts a runner process (no HTTP server) against the same data directory, for more capacity or for a
runner that survives restarts of the server. It stops on signals the same way.

```sh
runwright serve --port 7500 --concurrency 16 &   # in the background, or in a terminal of its own
runwright runner --concurrency 4 &               # one more runner on the same data directory
```

### Agents

```
runwright agents list
runwright agents get <id> [--revision N]
runwright agents save <file.json> [--id <id>]
runwright agents revisions <id>
runwright agents metrics <id>
```

The file holds either `{id?, definition}` or a bare definition; `--id` overrides. Without an id, it is derived
from the definition's name. Saving an unchanged definition keeps the current revision. `get --revision N` shows
that revision of the agent (`{agent, revision}`, the same shape as without it). `metrics` compares the
agent's completed runs before and after it was given learned items (run count, average job cost, tokens and
duration).

```sh
runwright agents save examples/ask-and-write/agent.json
runwright agents revisions ask-and-write
```

### Runs

```
runwright runs start <agentId> [--message <text>] [--data <json|@file>] [--max-cost <usd>]
               [--max-tool-calls N] [--max-turns N] [--idempotency-key K] [--revision N] [--wait [--timeout <sec>]]
runwright runs get <run>
runwright runs list [--agent <id>] [--status a,b] [--trigger <id>] [--limit N] [--cursor C]
runwright runs wait <run> [--timeout <sec>]
runwright runs message <run> <text>
runwright runs answer <run> <text> [--pending <id>]
runwright runs approve <run> [--pending <id>] [--always]
runwright runs deny <run> [--pending <id>] [--reason <text>]
runwright runs raise <run> [--max-cost <usd>] [--max-tool-calls N] [--max-turns N] [--allow-unpriced]
runwright runs resolve <run> --action retry|skip|cancel [--result <text>] [--pending <id>]
runwright runs cancel <run> [--reason <text>]
runwright runs pause <run>
runwright runs resume <run>
runwright runs timeline <run> [--after <seq>] [--follow]
runwright runs files <run> [<path>] [--out <file>]
runwright runs learning <run>
```

- `start`: `--data` takes JSON text or `@path` to a JSON file (a file the CLI reads, here and for
  `learning edit --body @path`, must be UTF-8; other bytes are an error, never replaced); `--max-cost` is in US dollars (decimals allowed) and
  is converted to integer micro-dollars; `--wait` behaves like `runs wait` afterwards (same exit codes). With
  `--idempotency-key`, a repeat of the same request prints `Run <id> already exists for this idempotency key
  (<status>)` instead of starting a second run; in JSON output `run.idempotencyKey` is the key's digest
  (`sha256:<hex>`), never the key itself. `--revision N` runs that revision of the agent instead of the current
  one.
- `list` prints **one page** of runs, newest first (`--limit`, 1 to 200, default 50). When there are more, the
  JSON has `nextCursor` and the text ends with `More: --cursor <c>`; pass it as `--cursor` for the next page.
  `--trigger` lists only the runs a trigger started.
- `start` returns as soon as the run is queued: the run has not asked anything yet. A command that needs a state
  the run reaches later (`answer`, `approve`, `deny`, `resolve`, `raise` for a pause, `files` for what the run
  writes) waits for it first, with `runs wait` or `start --wait` (exit 8 once the run waits on a person).
- `wait`: exits **0** when the run completed, **1** when it failed or was cancelled (or on timeout), **8** when it
  is waiting on a person or paused. With exit 8 it lists the open pendings (`<kind>  <pendingId>  <title>`). It
  also prints the run's cost.
- `message` sends a message the agent loop reads at its next turn boundary; it is accepted at once, and the
  timeline says what happened to it: a message that arrives after the run's last turn is not delivered (recorded
  as `command.rejected`, or `message.undelivered` for a message the driver never took).
- `answer`, `approve`, `deny`, `resolve`: without `--pending`, the run's only open pending of the matching kind is
  used (`question`; `approval`; `approval`; `interrupted`). None or more than one → exit 2. With `--pending`, the
  pending must belong to the run named first, be open and be of the verb's kind; otherwise nothing is sent and the
  command exits 2 with what it found (`pending <id> belongs to run <other>, not <run>`, `pending <id> is already
  resolved`, `pending <id> is a <kind>, not a <kind>`). An unknown run or pending exits 1 (`not_found`).
- `raise`: changes the run's limits (resolves `spend_cap`, `tool_budget` and `turn_limit` pendings when they now
  pass). A limit can be changed but not removed: there is no flag or value for "no limit". `--allow-unpriced` lets calls to unpriced models run under a cap, their cost counted as zero; priced
  calls are still admitted only when the known spend, the reservations and their worst case fit the cap (else the run pauses
  with `reason: "cap"`).
- `resolve`: `retry` runs the interrupted tool call again (unless the server deny list now denies the tool),
  `skip` uses `--result` as its result, `cancel` cancels the run. A call is interrupted when a crash, a pause or a
  forced shutdown left a call of a tool that is not safe to run again unfinished; the pending's detail gives a
  `reason`: `pause` or `shutdown` when the call was interrupted by one of those, `crash` when the call was found
  unfinished as its step was entered again (after a crash, and for every call rule R holds back). An unfinished call of a tool declared `idempotent` is run again by itself only when no write call of
  the run finished after it started; otherwise repeating it could undo that finished work, so it waits for a
  person as an interrupted call. Such a call is resolved with this command like any other.
- `timeline` prints `<seq>  <type>  <key>  <summary>` per journal record, all of them after `--after`. It reads
  the journal one page (1000 records) at a time and prints each page before it asks for the next, so it holds one
  page whatever the journal's size. In JSON mode the output is still one document, `{"records": [...],
  "archived": false}`, written as the pages arrive; when a page fails after the document started, the document is
  closed with an `error` member (`{records, archived, error: {code, message}}`, the records printed so far) and
  the exit code is 1. `--follow` then streams over SSE from the last printed record until the run ends (one JSON
  document per line).
- `files` lists every file of the workspace (the client follows the API's pages: the list is bounded by the
  workspace); with a path it prints the file (see [Output](#output) for JSON mode), or writes its
  exact bytes to `--out <file>`.
- `learning` lists the learned items the run was given (`full` or as one `line`) and whether it opened them.

```sh
runwright agents save examples/ask-and-write/agent.json
runwright runs start ask-and-write --message "Write a greeting" --max-cost 0.05 --wait --timeout 60   # exit 8: it asks a question
runwright runs answer @last Ada
runwright runs wait @last --timeout 60
runwright runs timeline @last --follow
runwright runs files @last greeting.txt --out greeting.txt
```

The verbs for the other pauses act on a run that waits in that state (`runs wait` exits 8 and lists the
pending): `runwright runs approve @last --always` for an approval, `runwright runs raise @last --max-cost 0.20`
for a spend cap, `runwright runs resolve @last --action skip --result "already sent"` for an interrupted call.

### Pendings

```
runwright pendings list [--agent <id>] [--run <run>] [--kind <kind>] [--status open|resolved] [--limit N] [--cursor C]
runwright pendings get <id>
```

`list` prints **one page** of the open pendings across runs, oldest first: questions, approvals, cap, budget and
turn-limit pauses, and interrupted tool calls (`--limit`, 1 to 200, default 50). When more match, the JSON
(`{pendings, nextCursor}`) has `nextCursor` and the text ends with `More: --cursor <c>`; pass it as `--cursor` for
the next page, which continues without a gap or a duplicate. On the last page `nextCursor` is `null` and there is
no hint. `--status resolved` lists resolved ones instead (they grow without bound, which is why the command pages
like `runs list`), `--run` narrows the list to one run, `--agent` to one agent, and `--kind` is one of `question`,
`approval`, `spend_cap`, `tool_budget`, `turn_limit`, `interrupted`. `get` shows one pending with its detail.

### Workflows

```
runwright workflows validate <file> [--embedded]
runwright workflows dry-run <file> [--input <json|@file>] [--decisions <json|@file>] [--embedded]
runwright workflows graph [<file>] [--name <saved>] [--mermaid] [--out <file>] [--embedded]
runwright workflows save <name> <file>
runwright workflows list
runwright workflows get <name> [--version N]
```

`validate` prints each problem as `<severity> <path> <code>: <message>` and exits 1 when there is an error.
`dry-run` prints the steps taken and the calls a real run would make (nothing is called), the output, every
problem under "Problems", and then `Dry run OK.` (exit 0) or `Dry run failed.` (exit 1). Warnings, such as
`placeholder_dependent` problems about values the dry run made up, are printed under "Problems" too, and a report
with only warnings still prints `Dry run OK.` and exits 0. `--decisions` sets the value and confidence of named
decision nodes, for example `{"urgent": {"value": false, "confidence": 0.4}}`.
`graph` takes exactly one of a document `<file>` and `--name <saved>` (a saved workflow's latest version). It
prints nodes and edges, or the Mermaid text with `--mermaid` (`{"mermaid"}` in JSON mode); `--out <file>` writes
the Mermaid text to the file. See [workflows.md](workflows.md).

`validate`, `dry-run` and `graph <file>` check the document as the saved workflow of the `name` it carries, so a
`call` to that name is a call to the document itself. With `--embedded` they check it as an agent's embedded
workflow is checked when the agent is saved: no `call` resolves to it by its own name, so an embedded workflow
`helper` that calls the saved workflow `helper` is valid. `--embedded` goes with a `<file>`, not with `--name`.

```sh
runwright workflows validate examples/triage-workflow/workflow.json
runwright workflows graph examples/triage-workflow/workflow.json --mermaid
runwright workflows save triage examples/triage-workflow/workflow.json
```

### Learning

```
runwright learning list [--agent <id>] [--status active|held|retired] [--kind note|skill]
runwright learning show <id>
runwright learning history <id>
runwright learning retire <id> [--etag <etag>]
runwright learning restore <id> [--etag <etag>]
runwright learning approve <id> [--etag <etag>]
runwright learning edit <id> [--title <text>] [--description <text>] [--body <text|@file>] [--etag <etag>]
```

`retire`, `restore`, `approve` and `edit` read the item's current ETag first unless `--etag` is given (then a stale
ETag fails with `etag_mismatch`). `edit` changes the title, description or body (`@file` reads the body from a
file) and records a new version. An edit that contains a stored secret, a credential-shaped string
or a hidden character is refused (`validation_failed`) and nothing changes. `show` prints a promoted skill's
workflow as `<name> v<version>`. See [learning.md](learning.md).

### Triggers

```
runwright triggers list
runwright triggers create <file.json>
runwright triggers get <id>
runwright triggers update <id> <file.json>
runwright triggers enable <id>
runwright triggers disable <id>
runwright triggers delete <id>
runwright triggers fire <id> [--data <json|@file>]
```

The `create` file is a `TriggerInput` ([api.md](api.md#triggers-and-webhooks)); the `update` file holds only the
fields to change (a partial `TriggerInput`), and the updated trigger is printed.

### Secrets

```
runwright secrets set <name> [--value <v>]
runwright secrets delete <name>
runwright secrets status [<name>]
```

Without `--value`, `set` reads the value from stdin (one trailing newline removed). The value is never printed.
`status` reports set/missing, for one secret or all. A value replaced by `set` or removed by `delete` is kept
sealed as a retired value while a run that started before the change is unfinished, so it stays redacted
([security.md](security.md#redaction)); `status` never lists retired values.

```sh
printf '%s' "$ANTHROPIC_KEY" | runwright secrets set ANTHROPIC_API_KEY   # with ANTHROPIC_KEY set: an empty value is refused
runwright secrets status
```

### Usage, retention, bench and the rest

```
runwright usage [--by day|agent|model] [--agent <id>] [--from <date|ms>] [--to <date|ms>]
runwright status
runwright retention archive --older-than <days> [--limit N]
runwright bench [--quick]
runwright api
runwright version
runwright help
```

- `usage`: token use and cost grouped by day (UTC), agent or model. `--from` (inclusive) and `--to` (exclusive)
  take a date, `YYYY-MM-DD`, meaning the start of that UTC day, or epoch milliseconds.
- `status`: the server's health and readiness, `{health, ready}`; exits 0 when the server is ready and 1 when it
  answers but is not ready (or cannot be reached).
- `retention archive`: archives the journals of finished runs older than the given number of days into
  `<data dir>/archive/` and deletes their journal rows ([architecture.md](architecture.md#retention-and-archival)).
  It works on the data directory directly and needs no server. It prints the runs it `archived` (run, number of
  records, archive path) and the runs it `skipped` with the reason (an incomplete journal, an archive that did
  not verify, an error); with `--json` (or when stdout is not a TTY) it prints `{archived, skipped}`. Each journal
  is streamed: it is read one page of records at a time into a gzip stream, and verified by streaming the archive
  back against the journal page by page, so memory holds one page of records whatever the journal's size. A skipped
  run keeps its journal rows. It may be run while another copy of it runs: a journal's rows are deleted only
  after a complete, verified archive exists, and a run the other copy archived is in neither list.
- `bench`: the benchmark of `npm run bench`; `--quick` shrinks every size so it takes a few seconds.
- `api`: the machine-readable API description. `version`: the version from `package.json`. `bench` prints its
  report as JSON in both modes.

## Lists and paging

A command never holds more than one page of the API plus what it prints. Over the collections that grow without
bound, the CLI prints one page and leaves paging to you: `runs list` and `pendings list` print one page and the
`More: --cursor <c>` hint (JSON: `nextCursor`). `runs timeline` prints the whole journal, page by page, printing
each page before it asks for the next. `runs files` lists the whole workspace, which the run's own files bound. The
other lists, `agents list`, `agents revisions`, `workflows list`, `learning list`, `learning history`,
`runs learning`, `triggers list`, `secrets status` and `usage`, are not paged by the API: one request returns
everything.

## Environment variables

| Variable | Meaning |
|---|---|
| `RUNWRIGHT_DATA_DIR` | data directory (default `~/.runwright`) |
| `RUNWRIGHT_URL`, `RUNWRIGHT_TOKEN` | server URL and token for client commands (the token also sets the server's token) |
| `RUNWRIGHT_HOST`, `RUNWRIGHT_PORT` | where `serve` listens |
| `RUNWRIGHT_CONCURRENCY`, `RUNWRIGHT_LEASE_MS`, `RUNWRIGHT_POLL_MS`, `RUNWRIGHT_NO_RUNNER` | runner settings |
| `RUNWRIGHT_SEAL_KEY` | the seal key for secrets (base64 of 32 bytes) |
| `RUNWRIGHT_SHELL`, `RUNWRIGHT_DENY_TOOLS`, `RUNWRIGHT_ALLOW_UNPRICED`, `RUNWRIGHT_LOG_LEVEL` | tool and model settings, log level |

The full list with defaults is in [configuration.md](configuration.md#environment-variables).
