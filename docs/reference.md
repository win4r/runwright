# Runwright behaviour reference

This page holds the precise rules behind the overview in the [README](../README.md): how a run is stored and
resumed, what every limit guarantees, and what the security layers do and do not cover. Each section is a summary
of a longer chapter; the chapters are linked from each section.

## How it fits together

```
  runwright CLI      web console (GET /)      TypeScript client (src/client)
        \                   |                        /
         +------------------+-----------------------+
                            |
                  HTTP API  /v1/...  (bearer token, JSON, SSE)
                            |
                            v
          +-------------------------------------+
          |  Store: one SQLite file (WAL)       |
          |  agents, revisions, runs, journal,  |
          |  commands, pendings, usage,         |
          |  learning, triggers, sealed secrets |
          +-------------------------------------+
                  ^                    ^
      claim/lease |                    | commit (epoch-checked)
                  |                    |
        runners (in the server process and/or `runwright runner` processes)
                            |
                 drivers: agent loop | workflow executor
                            |
            durable steps: model, tool, ask, memo, inbox, emit
                            |
              model providers            tools (in the run's workspace)
     scripted / anthropic / openai-compat    files, ask_person, web_fetch, shell,
                                             run_workflow, recall, host tools
```

**The journal and replay.** Every run has an append-only journal. A driver (the agent loop or the workflow
executor) never calls a model or a tool directly: it calls durable step primitives, each with a stable key. A
primitive first looks its key up in the journal; if the step already finished, it returns the recorded result
and does nothing else. So resuming a run is replaying it: a runner reads the journal, calls the driver from the
top, every finished step returns at once from the journal, and real work starts again at the first unfinished
step.

**Leases and fencing.** A runner claims a queued run (or a run whose lease expired) under a time-limited lease and
renews it with heartbeats. Every claim increases the run's epoch. The store accepts journal appends and state
changes only from the current lease holder at the current epoch, so a runner that lost its lease (a "zombie") cannot
write to the store. The workspace is fenced by the epoch too (rule F): every change the built-in file tools make
there, and every saved tool result, is one `rename` or `link` through `.runwright/stage/<epoch>`, the staging
folder of the writer's own epoch, and the next claim renames that folder away before its first step, so a zombie's
late file write fails with `lease_lost` however late it wakes up. The one effect that is not staged is the
creation of a write's missing parent directories, so a fenced writer can leave empty directories behind, never
content. `shell` and host tools are outside rule F: a
stale runner's shell command that is still running can still write. When a runner dies, another one takes its
runs over after the lease expires (30 s by default).

**Commands and idempotency.** Commands sent to a run (messages, answers, approvals, limit changes, cancel, pause,
resume, the resolution of an interrupted call) are applied in arrival order, the order in which their inserts committed (`commands.seq`). A run started
with the same idempotency key returns the same run; a key must be well-formed Unicode (one with an unpaired
surrogate is 400 `bad_request`). A run started by a trigger pins the agent revision that was current when the
fire was prepared, the one its input was redacted against.

**Pendings.** Questions, approvals, spend-cap pauses, tool-call-budget pauses, turn-limit pauses and interrupted
tool calls all share one record shape, are listed together (`GET /v1/pendings`, `runwright pendings list`, the
console's "needs you" list) and are stored in the journal and a table, so they survive restarts. A run's detail
(`GET /v1/runs/:id`, `runwright runs get`) lists every open pending of that run, however many there are, so
`runs approve <run>` without `--pending` refuses and lists the choices when there is more than one. A run's file
listing (`GET /v1/runs/:id/files`) is paged by path (`limit` 1 to 1 000, default 200, and a `cursor`); the
client and `runwright runs files <run>` follow the pages and return every file.

**Learning.** With `learning: true`, a completed run gets one extra step that proposes notes and skills. Code
checks come first (a secret, a redaction marker such as `[redacted]` or `[redacted:NAME]`, or a hidden character
anywhere drops the whole proposal, because the text the check sees is already redacted), then a provenance check of
every retained text (name, title, description, body, and all of them together) against untrusted text: the
content and the structured data of results of tools declared untrusted (`web_fetch`, `shell`, host tools that
say so) and a webhook delivery's payload, together with every `read_file` result whose bytes the journal does
not show the run itself left in the file (a page a host tool downloaded into the workspace reads as untrusted),
then one grader call. An item that copies untrusted text is dropped or held, and in a run that read untrusted
content (or was started by a webhook) every other item is **held for a person** whenever the journal cannot
prove that the item's text is the run's own earlier text (journalled before the first untrusted record) or a
person's (a message or answer sent to the run); the grader's keep cannot lift a hold. Provenance always uses the journalled content
and data of untrusted results; a saved full result (or saved over-long structured data) counts only when its file still
matches the SHA-256 journalled with it, and when one cannot be verified every item that would be kept is held
for a person. Kept items are versioned with full history and ETags, and
the next run of the agent is given them within a token budget (rule S2): when they do not all fit whole but one
line for every item fits, every item is given, at least as its line, and in order of BM25 relevance to the
run's first message each item is given whole instead when the difference still fits; only when even the lines do
not all fit are items taken in relevance order, each whole if it fits, otherwise as one line if that fits,
otherwise left out. Every learning write of a run is part of the same
lease-fenced commit as the journal record of its step, and is conditional on the item version the run saw when
it checked its proposal: an item a person or another run changed in between keeps the newer version, and a
retired item is never reactivated by a run. Text without words (only symbols and punctuation, such as `---`) is
judged on its characters: it is copied when it occurs in untrusted text and proven when it occurs in trusted text.
A skill is drafted as a workflow after it served `learning.promoteAfterRuns` completed runs (3 by default); an
attempt counts only against the skill version it was drafted from, so a draft made stale by an edit of the
skill uses up no attempt. A learning, grading or promotion call that does not fit the run's
spend cap pauses the run with a `spend_cap` pending at that step (`learning.onLimit: "pause"`, the default),
after the job's output is already recorded; raising the cap lets learning finish. With `learning.onLimit:
"skip"` the step is skipped instead.

**Workflows.** A workflow is a JSON document (`runwright.workflow/v1`) of typed nodes with an explicit reference
syntax. It is validated with JSON paths for every problem, can be dry-run without calling anything, exports as a
graph and as Mermaid text, and runs durably under the owning agent's tool policy, caps and budgets. A
`deadlineMs` on a composite node or an `agent` hand-off bounds that node's whole execution, everything inside it
included, and on a `wait` node the time a person has to answer; both are measured from the node's journalled
start, so they hold across waits, pauses and restarts. On `tool`, `model` and `decide` nodes it bounds each call,
and on a `fail` node it has no effect. An `agent` hand-off's `tools` is enforced on every call made inside the
hand-off (by its loop, by a workflow it starts with `run_workflow`, by a nested hand-off), not only on the tools
its model is shown. The dry run marks a path *assumed* only when a real run with valid values might not take
it: a `map` over a list the schema guarantees to have an item runs its body for certain. A numeric path segment
into a value whose schema allows both an array and an object is not statically typed (its value is unknown to the
validator and the dry run). `validate`, `dry-run` and `graph` take `embedded: true` (`--embedded` in the CLI) to
check a document exactly as an agent's embedded workflow is checked when the agent is saved. A node retried
after a failure waits its backoff from the journalled retry record, so after a restart or a resume it waits only
what is left of it. A message sent to a run is handed to at most one agent loop, the first that takes its messages after it
arrived: in a workflow with parallel agent hand-offs, never to two of them.

See also [Architecture and the durability model](architecture.md) and the [workflow language reference](workflows.md).

## Control and cost

- **Tool policies.** Each tool an agent lists has a policy: `allow`, `ask` or `deny`. For each call the first
  matching rule wins: (1) a tool on the server's deny list (`tools.deny`) is denied; (2) inside an `agent`
  hand-off with `tools`, a tool outside that subset is denied; (3) a tool the agent lists gets the agent's policy
  for it, else the tool's own default (`shell` defaults to `ask`), else `allow`, and `ask` becomes `allow` once a
  person approved it "always" for the run, for a call that has no approval of its own; (4) a tool the agent does not list but the learning context grants
  (`recall`) is allowed; (5) any other tool is denied. So a learning grant is only a default: an agent that lists
  `recall` with `ask` asks before each recall, and one that lists it with `deny` is refused it and its prompt does
  not mention it. The server deny list is
  checked again immediately before every tool execution, including a call that is run again or retried after a
  crash, a pause or a shutdown, and a person's retry of an interrupted call. A tool put on the deny list before a
  run continues (for example in the configuration of the process that takes the run over after a crash) never
  runs again for it; the call finishes as `denied`.
- **Approvals.** An `ask` call pauses the run with an `approval` pending until a person approves or denies it. A
  denial (with an optional reason) is returned to the model as the tool result. A call whose own approval was
  resolved is decided by that resolution: a call already denied stays denied, whatever is approved later.
  "Approve always" approves that call, also approves, in the same commit, every other call of that tool that is
  waiting for approval in the run (one whose approval had not expired when the command was sent), and makes the
  tool `allow` for the run's later calls.
- **Spend cap.** A run can have a cap (`maxCostMicros`, integer micro-dollars; the CLI takes dollars). Every
  request Runwright sends to a model provider (a provider *attempt*) is admitted against the cap on its own:
  before each attempt Runwright computes the call's worst case and sends the attempt only if `spent + reserved +
  worstCase <= cap`, where `reserved` is the sum of the worst cases of the run's other calls still in flight.
  Every call holds a reservation of its worst case from its first admission until its last record is written,
  also while it waits between attempts: calls in parallel workflow branches, and the repair call of a
  structured-output step. The check and the reservation happen with no `await` in between, so two parallel
  calls cannot both pass a cap that fits only one. When the check fails the run pauses with a `spend_cap`
  pending whose `neededMicros` is the least extra budget that lets the next attempt go (`spent + reserved +
  worstCase - cap`). Raising the cap resumes the run. The admission is made again inside the commit that
  journals the attempt as started, against the limits in force at that moment, so a cap lowered during a
  backoff or a provider wait is seen before the attempt is sent.
- **What a reply is charged.** The usage the provider reported, priced. A count the provider did not report (a
  reply with no input or no output token count) is charged the bound the attempt was reserved with: the worst
  case's input tokens for a missing input count, `maxOutputTokens` for a missing output count. It is recorded as
  assumed (`usageAssumed` on the journal record, `assumed: true` on the usage row), and replay charges exactly the
  same. Neither the engine nor the Anthropic and OpenAI-compatible adapters derive a count from the size of the
  request or of the reply (the offline scripted model reports the counts its script names, and a typical count of
  the request and reply for those it does not).
- **Retries are attempts, each admitted and charged.** Providers never retry by themselves; the engine retries
  transient provider errors (HTTP 408, 409, 425, 429 and 5xx, network errors, and an error envelope with a
  transient status or kind that a provider sends after a 2xx status, in a stream or as the whole body) up to
  `models.retry.maxAttempts` attempts per call, with capped exponential backoff and jitter, honouring
  `Retry-After`. When the provider names a wait (`Retry-After` or `retry-after-ms`), the engine waits that long,
  never less, before the next attempt, also when the run is paused or the server restarts in between: the rest of
  the wait is served first. Each attempt is admitted against the limits in force when it is sent, also after a
  backoff. A wait longer than `models.retry.maxRetryAfterMs` (5 minutes by default) is neither
  waited out nor cut short: the call fails with `model_failed` (`model call not retried after N attempts ...`) and
  nothing more is sent. Every attempt is journalled as its own `model.started` before it is sent. A failed attempt is
  charged **nothing** when the provider answered with an HTTP error status or no connection was ever made, and
  its **worst case as an assumed cost** otherwise (a connection that broke after the request was sent, a
  truncated or malformed reply, an error envelope after a 2xx status), because the provider may have billed it. When the next attempt does not fit the
  cap, the run pauses between attempts with a `spend_cap` pending; once the cap is raised it continues with the
  next attempt, never repeating one. A call that runs out of attempts fails with `model_failed` (`model call
  failed after N attempts (last error: ...)`).
- **Worst case of one call.** One input token per UTF-8 byte of the serialized request (system prompt, messages,
  tools and output schema) plus 1 024 framing tokens for what a provider adds around the request, priced at the
  highest of the input, cache-read and cache-write prices, plus `maxOutputTokens` of output at the output price. The request
  asks the provider for at most `maxOutputTokens`.
- **Overshoot bound.** As long as a provider bills no more than the worst case for one request (at most one input
  token per byte of the request plus 1 024, and at most `maxOutputTokens` output tokens) and bills nothing for a
  request it refused with an HTTP error status, **a run's spend never exceeds its cap**, with sequential and with
  parallel calls, retries included, and whether or not the provider reports its usage. This is stronger than "never more than one model call's worst case over the
  cap", which it therefore also satisfies. A model attempt that was interrupted (crash, pause, cancel, shutdown,
  deadline) or that failed with uncertain billing is charged its worst case, recorded as an *assumed* cost; so
  crashes and failed attempts do not break the bound. If a provider reports more than the worst case, the real
  cost is recorded: the run can then end above its cap by that excess, and it pauses before its next request.
- **Structured-output repair.** When a model step's structured output does not match its schema, or the reply
  carries no structured output at all (never read as `null`), the invalid reply is recorded (`model.invalid`,
  billed) and one repair call follows. The repair call is admitted against
  the cap on its own, with its own worst case. When it does not fit, the run pauses with a `spend_cap` pending
  and, once the cap is raised, continues with the repair call; the first call is never sent again.
- **Unknown prices.** A model with no entry in the price table makes the cost **unknown**: the usage row has no
  cost, the run's cost is shown as `unknown` (never `$0`). If the run has a cap and its model is unpriced, the run
  pauses with a `spend_cap` pending (`reason: "unknown_price"`) before the first call, unless the run's limits set
  `allowUnpriced` (for example `runwright runs raise <run> --allow-unpriced`) or the server config sets
  `models.allowUnpricedModels: true`. Allowing unpriced models does not switch off the cap: it counts the
  unpriced calls' cost as zero, and every priced call of the run is still admitted only when
  `known spend + reservations + its worst case <= cap`; when that does not fit, the run pauses with
  `reason: "cap"` and the amount it needs. The overshoot bound then holds for the known cost. A run that already has
  an unknown cost stays `unknown` (and over a cap unless allowed) even if a price is configured later.
- **Tool-call budget and turn limit.** `maxToolCalls` is checked before each new tool call starts and `maxTurns`
  before each model call that counts as a turn, and both again inside the commit that journals the call as
  started. Reaching either pauses the run (`tool_budget` or `turn_limit` pending, `detail: {limit, used,
  needed}`) until the limit is raised; `needed = max(1, used + 1 − limit)` is exactly what must be added to the
  limit for the next call to go (after five tool calls with the budget lowered to 2, `needed` is 4). The turn admitted for a
  structured-output step stays reserved until its repair call finishes, also across a pause, a spend-cap wait
  and a restart, so a parallel step cannot take it and the run never passes `maxTurns`.
- **Totals saturate.** Every stored or reported total of tokens, cost micros, tool calls and turns (a run's
  counters, the usage summaries, the learning metrics, the state a runner rebuilds from the journal) is an
  integer from 0 to 2^53 − 1 (`Number.MAX_SAFE_INTEGER`); an addition that would pass it yields exactly that
  value, so they always agree.
- Limits come from the agent revision, are overridden by the limits given when the run is started, and then by
  every `limits` command sent to the run. A limit can be changed over the API but not removed.

See also [Configuration](configuration.md) for every limit and default, and the [HTTP API reference](api.md) for the `limits` command.

## Security notes

- **Loopback by default.** The server binds `127.0.0.1`. Binding elsewhere (`--host`, `RUNWRIGHT_HOST`) exposes
  plain HTTP; put a TLS proxy in front if you do that.
- **Bearer token.** Every API route except `GET /`, `GET /v1/health`, `GET /v1/ready` and the signed webhook
  route needs `Authorization: Bearer <token>`. The token is `rw_` plus 32 random bytes (base64url), generated on
  first start into `<data dir>/token` with mode 0600 (or taken from `RUNWRIGHT_TOKEN`). It is compared in constant
  time (both sides hashed with SHA-256, then `timingSafeEqual`).
- **Sealed secrets.** Model keys, tool keys and webhook signing secrets are sealed with AES-256-GCM under one seal
  key (`RUNWRIGHT_SEAL_KEY`, or `<data dir>/seal.key` generated with mode 0600). The API is write-only: it reports
  whether a secret is set, never its value.
- **Redaction and its limits.** A secret is any stored value of 8 to 16 384 UTF-8 bytes, and every one is
  redacted, however few characters it has. Every journal record, tool result and error of a run passes through
  the run's redactor, which replaces with `[redacted:NAME]` the secrets the run was handed and the credential of
  every model the run actually calls (the grader's model when `learning.graderModel` is set, any other model a
  step names), registered before that provider is called; a key rotated during a run is registered when the
  next model step resolves it, and the old value stays registered for the rest of that session. The store
  wrapper then passes every commit (journal records, pendings, run output and error, learning items, promoted
  workflows) through a second, process-wide layer over every secret the process has set or revealed
  (`[redacted]`), and every API response, SSE event and log line passes through that process-wide redactor too.
  Redaction works on values, never on serialized text: at an output boundary and in caller, model, tool and
  driver values, each string and each object key is redacted on its own, so the output is always valid JSON. A
  journal record is redacted field by field: its free text as text, and Runwright's own field names,
  enumerated values, ids and numbers as they are, because a resume reads them back; a field the field
  specification does not name, and a record of a type the engine does not write, is redacted whole
  ([docs/security.md](security.md#redaction)). A value whose structure Runwright itself built (a
  learning step's value, a decision, a loop's or a tool node's result) keeps Runwright's field names, and only
  the text inside it is redacted; a value an author's expression builds (a sub-workflow's result, a workflow's
  result) is a payload. At an output boundary (API responses, SSE events, log lines)
  and in every stored caller, model, tool or driver value, a number whose digits hold a secret becomes the
  redacted text, as a string; only the numbers the engine owns (limits, costs, counters, timestamps) are stored
  unchanged, because the engine reads them back from the journal. Both layers replace each of these forms: the value itself, base64 (padded and unpadded),
  base64url, percent-encoded and JSON-string-escaped.
  Streamed model text is redacted across delta boundaries for every secret the run's redactor knows: text that
  could be the start of such a secret is held back until the next delta shows whether it is one, so it is never
  sent split over several deltas. A value only the process-wide layer knows is redacted one delta at a time. **At
  intake**, text a caller supplies (a run's message and data, the free text of commands, trigger messages and
  webhook payloads) is redacted for every known secret (`[redacted]`) before it is stored, so the journal, the
  timeline and the model see the placeholder, not the value: hand a run a secret by naming it in the agent
  definition, never by pasting it into a message. A person's edit of a learning item, and the note of a retire,
  restore or approve, is refused when it contains a stored secret, a credential-shaped string or a hidden
  character. Learning drops a whole proposal that contains a secret or a redaction marker (`[redacted]`,
  `[redacted:NAME]`). A replaced or deleted secret value is kept sealed as a retired value for as long as a run
  that started before the change is unfinished, and is loaded again at start-up, so text containing the old
  value stays redacted (`[redacted]`) across a rotation and a restart; once every such run has finished the
  retired value is deleted. After a restart a retired value is known to the process-wide layer, not to the run's
  own redactor, so in streamed model text it is redacted one delta at a time (a retired value split over two
  deltas is not caught there; the stored records are redacted whole), and the full text of an over-long tool
  result, saved in the workspace, can hold it ([docs/security.md](security.md#redaction)). Not covered: **files a run writes into its
  workspace are not redacted** (a tool that writes a secret to a file leaves it there); agent definitions and
  workflow documents are stored as given; a secret stored only after a text was written, and rows written by an
  earlier version, are not rewritten; a retired value is no longer recognised by a process that starts after it
  was deleted (once every run older than the change has finished); a secret transformed in a way the redactor does not know (reversed,
  hex, base64 at another alignment inside a larger blob) is not recognised; a secret whose value is, or is
  contained in, a tool's name, a tool-call id or a tool argument's name is journalled as the placeholder there,
  so that call is answered as an unknown tool (or as invalid arguments); and at an output boundary Runwright's
  own words are redacted too, so with a secret whose value is a word such as `completed` a response shows the
  placeholder in its place (what is stored is redacted field by field; do not store such values as secrets).
- **Fencing.** The store rejects every journal append and state change of a runner that lost its lease, and
  the built-in file tools and saved tool results cannot be changed by such a runner after its successor claimed
  the run (rule F, see "Leases and fencing" above and [docs/security.md](security.md)). `shell` and host
  tools are outside rule F.
- **Workspace confinement.** File tools act only inside the run's workspace: `..`, absolute paths, backslashes
  and symlinks that lead outside are refused. They read regular files only: a FIFO, a socket or a device in the
  workspace is refused without a blocking open. `write_file`, `edit_file` and `delete_file` also refuse the
  workspace's `.runwright/` folder (Runwright's saved tool results and the staging folders of rule F), whatever
  the spelling of the path; this is not a sandbox, since `shell` and host tools can still write there. Files are served back through the API with safe content types
  (text as `text/plain`, unknown types as attachments) and a sandboxing CSP.
- **SSRF guard.** `web_fetch` resolves the host, refuses loopback, private, link-local, CGNAT, metadata,
  multicast and reserved addresses (IPv4 and IPv6, including IPv4-mapped forms), connects to the address it
  checked, and checks every redirect hop again. Its time limit covers the whole call, address resolution on
  every hop included. Its output, text and structured data, is marked untrusted.
- **`shell`** is off unless the operator enables it (`tools.shell.enabled` or `RUNWRIGHT_SHELL=1`), and its
  default policy is `ask`. Its output is marked untrusted too (a command can print a fetched page).
- **What learning's provenance check does not track:** text an API caller sends (messages, `data`, answers),
  untrusted text the model itself writes back into a file with `write_file` (it is still matched where the run
  first read it), file names, and paraphrase (the check is lexical); a paraphrase is still not kept
  automatically, because in a run that read untrusted content an item whose text the journal cannot prove is the
  run's own or a person's is held for a person. A file that
  `shell` or a host tool wrote and that the run reads with `read_file` is tracked: its result is untrusted unless
  the journal shows the run itself left those bytes there. See [docs/learning.md](learning.md#provenance).
- **Webhooks** are verified with HMAC-SHA256 over `timestamp + "." + body`, compared in constant time, must be
  within a 300 s window, and are deduplicated by delivery id. The body is a JSON object carrying a `delivery`
  string. The delivery id is the `delivery` member of the signed JSON body, so it is covered by the signature: a
  captured request replayed with another `X-Runwright-Delivery` header is rejected, and replayed unchanged it is
  the same delivery and starts no second run. A sender's redelivery carries the same `delivery`: a redelivery is
  answered with the run the first delivery started (`duplicate: true`), also after the trigger was turned off,
  and a new delivery to a disabled trigger is refused (409).
- **Request limits.** Bodies over 1 MiB are refused (413); JSON is parsed strictly (duplicate keys, trailing
  text, `__proto__` keys and nesting deeper than 64 are refused).
- **Console.** One static page with a strict Content-Security-Policy and no external requests. It renders
  everything as text (no `innerHTML`), keeps the token in `sessionStorage` and sends it only as a header, never in
  a URL.
- **Not protected:** a local user who can read the data directory can read the token, the seal key and therefore
  every secret; and a tool the operator allowed can do whatever that tool does (for example, `shell` with an
  `allow` policy runs any command with the server's user rights, inside the workspace folder but not sandboxed).

More detail: [Security](security.md).
