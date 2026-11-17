# Security

## Threat model in short

Runwright is a single-operator service on one machine. It assumes:

- **Trusted:** the operator, the local user account that runs Runwright, and the data directory. Anyone who can
  read the data directory can read the API token and the seal key, and therefore every secret.
- **Authenticated:** API clients. Anyone with the bearer token can do everything the API offers; there are no
  user accounts or roles.
- **Untrusted:** model output, tool results from outside the run (web pages, fetched files, `shell` output, the
  results of host tools declared `untrustedOutput`, in their text and in their structured data), webhook
  senders (also after their signature checks: a signature proves who sent a payload, not that its text is safe
  to learn from), and anything a run writes into its workspace.

The controls below keep untrusted content from reaching secrets, the host network or files outside a run's
workspace, and keep secrets out of everything Runwright stores or sends. They do not sandbox the host: a tool the
operator allows runs with the rights of the Runwright process.

## Network exposure

- The server binds `127.0.0.1` by default (`server.host`, `RUNWRIGHT_HOST`, `--host`). It speaks plain HTTP;
  binding to another interface exposes the token in transit unless a TLS proxy sits in front.
- `GET /`, `GET /v1/health` and `GET /v1/ready` are open; the webhook route is authenticated by its signature;
  every other route needs the bearer token.

## API token

- `rw_` followed by 32 random bytes as base64url (the prefix keeps a token from starting with `-`, so
  `--token <token>` always parses), generated on first start into `<data dir>/token` with mode 0600 (the data
  directory itself is 0700). `RUNWRIGHT_TOKEN` replaces it (no file is written then).
- File creation is exclusive and atomic, so two processes starting at once agree on one token; an existing file
  with looser permissions is tightened to 0600.
- Compared in constant time: both sides are hashed with SHA-256 to 32 bytes first and the two digests are
  compared once with `timingSafeEqual` (`tokensEqual` in `src/security/token.ts`), so neither the length nor the
  content leaks through timing. An empty token never matches.
- The token is accepted only in the `Authorization: Bearer` header, never in a query string. The CLI never prints
  it; the server's logger redacts it.

## Sealed secrets

- Model API keys, tool keys and webhook signing secrets are stored sealed with **AES-256-GCM** under one 32-byte
  seal key: `RUNWRIGHT_SEAL_KEY` (base64), or `<data dir>/seal.key` generated with mode 0600 on first start.
- A sealed blob is `0x01 | 12-byte random nonce | ciphertext | 16-byte tag`, with the secret's name as additional
  authenticated data, so a blob cannot be moved to another name. Tampering fails with `seal_failed`.
- Names match `^[A-Z][A-Z0-9_]{0,63}$`; values are 8 to 16 384 bytes.
- **Write-only API:** `PUT` sets, `DELETE` removes, `GET` reports `{name, set, updatedAt}`. No route returns a
  value.
- A run is **handed** only the secrets its agent definition lists in `secrets`, plus its model's API key
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the model's `apiKeySecret`). `shell` gets handed secrets as
  environment variables; `web_fetch` header values may use `{{secret:NAME}}`.

## Redaction

- **What counts as a secret.** A secret is a stored value of 8 to 16 384 bytes in UTF-8
  (`MIN_SECRET_BYTES = 8` in `src/core/redact.ts`). The threshold is in bytes, never in characters, both for
  accepting a value and for redacting it, so every value that can be stored is redacted, including one of fewer
  than 8 characters (for example 4 characters of 2 bytes each).
- **Forms.** For each secret the redactors replace these forms (`secretForms`): the value itself, its base64
  (padded and unpadded), base64url, percent-encoded (`encodeURIComponent`) and JSON-string-escaped
  (`JSON.stringify(value)` without the quotes) forms. At each position the longest matching form wins. The forms
  apply to every text the redactors see: a string value, an object key, a tool result, a streamed delta. (In a
  stored journal record, Runwright's own field names are not redacted text: see **Field by field at rest**.)
- **Values, not serialized text.** Redaction works on JSON values and the JSON text is produced only
  afterwards, so the output is always valid JSON whatever a secret looks like (a secret such as `"level":`
  cannot break a log line, and one such as `12345678` cannot turn `"maxCostMicros":12345678` into something
  that does not parse). At an output boundary and for every caller, model, tool or driver value, one function,
  `redactJsonWith` in `src/core/redact.ts`, applies the text redactor to every string and every object key at
  any depth. A journal record is walked field by field instead (`redactBySpec` in
  `src/store/record-fields.ts`), and that walk hands its payload values to the same function.
- **The run's redactor.** Each run session has one redactor (`createGrowingRedactor` in `src/core/redact.ts`)
  that only ever learns values. It starts with the secrets the run was handed (the definition's `secrets` and its
  model's API-key secret) and, in addition, learns the credential of **every model the run actually calls**:
  before each model step resolves its provider, the key that step's model ref names is read through the secrets
  service and registered under its secret name, and so is every credential the resolved provider object says it
  sends (`ModelProvider.credentials`). This covers the learning grader's model when `learning.graderModel` is set
  and any other model a workflow step names. All of this happens before the step's first provider request. A
  key rotated while a run is in progress is registered when the next model step resolves it, and the old value
  stays registered for the rest of that session (values are never removed). A session that starts after the
  rotation (the run resumed after a restart, or taken over by another runner) knows only the current value; the
  old one is then caught by the process-wide set, which keeps every retired value of the run's secrets (see
  **Retired values** below). Every journal record (field by
  field, see **Field by field at rest**), every pending, the run's output and error, every learning write,
  every tool result, every log line of the run and every published delta passes through it, replacing each form
  with `[redacted:NAME]`.
- **A second layer on every commit.** The store wrapper `redactingStore` (`src/security/write-redaction.ts`)
  passes every commit of a run through the process-wide set as well (every secret value this process has set or
  revealed, every retired value it has loaded, plus the API token), with the placeholder `[redacted]`, after the run's own redactor has run. The
  helper is `redactCommitBatch` (`src/store/batch-redaction.ts`), which covers: `records[].data`;
  `openPendings[].title` and `.detail`; `resolvePendings[].resolution`; `transition.output` and
  `transition.error.message`; `learning.puts[].title`, `.description`, `.body` and `.note`;
  `learning.promotions[].note` and `.workflow.document`. Each part is redacted by what it is: a record's
  `data`, a pending's `detail` and a resolution field by field, as described under **Field by field at rest**
  below; titles, messages, notes and learning text as text; the run's output whole. Record types and keys,
  usage, counters, limits, consumed commands, pending ids and kinds, item ids and names and workflow names are
  not touched. The run session applies its own redactor through the same
  helper (`redactCommitBatch(batch, <the run's redactor>)`), so the field list exists once (it is
  `RECORD_FIELDS` in `src/store/record-fields.ts`). This layer
  catches a secret the process knows that the run was never handed (another agent's key, a value a tool wrote to
  a workspace file that a later run reads back). It uses what the process knows at that moment and reveals
  nothing itself.
- **Streamed model text.** Model text deltas are redacted by a streaming redactor over every value the run's
  redactor knows when the attempt starts, a fresh one for each provider attempt. It holds back the end of the text
  received so far when it could still be the beginning of a secret form, and releases it as soon as the next
  delta shows whether it is one (or when the answer ends). Text that cannot start a secret form passes through with no delay. The released text is exactly
  what redacting the whole answer at once gives, however the provider cut it into deltas, so, for every value the run's
  redactor knows, a secret split across deltas is never sent.
- **The process-wide redactor.** The logger, HTTP responses and SSE events are redacted by a second redactor
  over every secret value the process has set or revealed, every retired value it has loaded, plus the API
  token, replacing each form with
  `[redacted]`. Each redacts the **value** before it is serialized, one log record, response body or SSE event
  at a time: strings, object keys, and numbers whose digits hold a secret, which become the placeholder text (a
  field `12345678` becomes `"[redacted]"`; a number `91234567899` becomes `"9[redacted]99"`). The same holds in
  what is stored for every caller, model, tool and driver value (see **Field by field at rest** below). The output is
  always valid JSON. It does not join consecutive delta events, so it is the run's streaming redactor that covers a
  secret split across deltas.
- **At intake.** Text that a person or a caller supplies is redacted for every known secret before it is stored
  in anything a journal, an archive, a timeline or a later run reads: the run input (`message`, and every string,
  object key and secret-holding number of `data`, in `runs.input` and the `run.created` record), the free text of commands
  (`message.text`, `answer.answer`, the `reason` of a deny or a cancel, the `result` of a skip), trigger messages
  and names, and webhook payloads (which become the run input). One place enforces this: the store wrapper
  `redactingStore` (`src/security/write-redaction.ts`), which `createApp` puts around the SQLite store and is
  the only store it hands to the runner, the trigger scheduler and the server. The SQLite store itself stores
  what it is given: it holds only sealed secret bytes and never sees a plaintext value, so it cannot redact. The
  only other code that opens a store is the benchmark (generated text) and `runwright retention archive` (which
  writes no caller text). Idempotency keys are not redacted, and they need not be: the store keeps every key
  only as `sha256:<hex digest of the key>`, and the key's text is never stored ([api.md](api.md#idempotency)).
  - *Known secret* means every secret value this process has set or revealed or loaded as a retired value, plus
    the secrets the run's agent
    revision names (its `secrets` and its model's API-key secret), which are re-read from the store for every
    write, so a value another process stored is covered. Every form of `secretForms` is replaced, with the
    placeholder `[redacted]`.
  - The model therefore sees the placeholder, not the value. Hand a run a secret by naming it in the agent
    definition, never by pasting it into a message.
  - `POST /v1/runs` looks the idempotency key up first: a request whose key already started a run is answered
    with that run (or 409 `idempotency_mismatch`) before any secret, revision or schema is read, so a repeat is
    never refused because a value in it has since become a secret. For a new request it redacts first, then
    validates `data` against the workflow's input schema, then creates the run, so the stored input is exactly
    what was validated. The request's idempotency fingerprint is taken from the request as sent, before
    redaction, so whether two requests are the same never depends on which secrets exist. The store wrapper
    does the same: its `createRun` asks `findIdempotentRun` first and, for a key that already has a run,
    returns it without reading a revision or revealing a secret. Its `fireTrigger` (every trigger fire) asks
    first as well, and a fire whose key already has a run reaches the store without any of its text.
  - A person's text for learning is **refused** rather than redacted: `PATCH /v1/learning/:id` (title,
    description, body) and the `note` of retire, restore and approve get 400 `validation_failed` when the text
    contains a stored secret, a credential-shaped string or a redaction marker (`[redacted]`,
    `[redacted:NAME]`; the checks of `src/learning/secret-scan.ts`) or a hidden or bidirectional-control
    character. The problem names the field (`$.title`, `$.note`, ...) and the
    kind of problem, never the text.
- Learning drops a whole proposal that contains a handed secret, a credential-shaped string or any redaction
  marker (`[redacted]`, `[redacted:NAME]`): the proposal it checks is the model step's stored output, which is
  already redacted, so a marker is the trace of a secret ([learning.md](learning.md#code-checks)). A promotion
  draft holding any of these is rejected.
- **Limits:** files a run writes into its workspace are **not** redacted (a tool that writes a secret to a file
  leaves it there, and `GET /v1/runs/:id/files/...` serves that file); the full text and data the engine saves
  for a tool result over the size limit are redacted by the run's redactor (the secrets the run was handed and
  its model credentials), numbers included, before they are saved. Agent definitions
  and workflow documents are stored as given: they are operator configuration, numbers included (a scripted
  model's script is part of its definition), so do not put secret values in them, name the secret instead. Intake redaction knows
  only the secrets that exist when the text is written: a secret first stored *after* a text was written does not
  change that text, and rows written by an earlier version of Runwright are not rewritten. A replaced or deleted
  secret is covered by **retired values** (below) for as long as a run that started before the change is
  unfinished; after that, text containing the old value is no longer recognised. The
  process-wide set is per process: a secret another process stored is known here only once this process reads
  it (at start-up, or when a run or an intake write reveals it by name, which also loads that name's retired
  values). A secret transformed in a way the
  redactor does not know (reversed, hex-encoded, base64 at another alignment inside a larger blob) is not
  recognised. A secret that is not in the run's redactor when an attempt starts is not held back in streamed
  text; the process-wide redactor still covers it in responses, events and logs when the process knows it, one
  event at a time.
- **Retired values.** A replaced or deleted secret value is kept sealed as a *retired value* (table
  `secret_history`, sealed under the same seal key and name, written in the same transaction as the `set` or
  `delete` that replaces or removes it; setting the same value again retires nothing) for as long as a run
  that started before the change is unfinished, that is, while some run created at or before the change is
  `queued`, `running`, `waiting` or `paused`. It is loaded into the process-wide set at start-up and whenever a
  secret of that name is revealed (a run session reveals its definition's secrets when it starts, so a runner
  process that started before the rotation and takes the run over afterwards learns it too), and it appears as
  `[redacted]`. A rotation or a deletion followed by a restart therefore does not unredact the old value: a
  tool result, model text, output, error, pending, learning write, intake text, log line, response or event of
  that run that contains it is redacted. It is deleted once every such run has finished: the next `set`,
  `delete` or start-up prunes it (one row per replaced or deleted value, so the table stays as small as the
  unfinished runs need). A process that loaded it keeps it in its set until it ends; once it is deleted, a
  process that starts later no longer recognises text containing the old value. That is the remaining limit.
  No API returns a retired value: `GET /v1/secrets` lists current names only, and no route reads
  `secret_history`. The run's own redactor knows only the values it revealed, so after a restart a retired
  value is not held back in streamed text; each published delta is still redacted by the process-wide set one
  event at a time, and the stored records are redacted whole. The full text of a tool result over the size
  limit, which the engine saves as a file in the workspace, is redacted by the run's redactor only, so after a
  restart that file can hold a retired value (workspace files are not redacted otherwise, see **Limits**).
- **Field by field at rest.** A journal record is redacted by what each field is (`RECORD_FIELDS` in
  `src/store/record-fields.ts`, one entry per record type the engine writes), in one walk over the record as the
  engine built it. A pending's `detail` and a resolution are walked the same way.
  - *Free text* (a model's text, a tool's content, a question, a title, an error message, a reason, and names
    that a model, a caller or a workflow author chose: tool names, tool-call ids, the `name`, `nodeId` and
    `scope` of a step or node record) is redacted as text.
  - *Caller, model, tool and driver values* (a run's input data, a model's output (unless its writer declared
    a specification, next bullet) and tool-call arguments, a tool's arguments and data (unless its writer
    declared a specification, next bullet), a step's or node's value (unless its writer declared a
    specification, next bullet), a run's output, the arguments in an approval or interrupted pending) are
    redacted whole: every string, every object key, and every number whose digits hold a secret, which is
    stored as the placeholder text, a string; the run goes on with that stored value, so it sees the same
    thing before and after a resume.
  - *A value whose structure Runwright built.* The value of a step or node, a model's structured output and a
    tool's data are payloads unless the code that writes them declares their field specification
    (`MemoMeta.valueFields`, `ModelStepRequest.outputFields`, `ToolOutput.dataFields`). The engine attaches
    the specification to the record it commits (`NewJournalRecord.fields`); the run's redactor and the store
    wrapper both use it; it is never stored. Runwright's own steps declare one wherever the engine reads the
    stored value back by field name: the six learning steps and the structured outputs of the proposal, the
    grader and the promotion draft (`src/learning/value-fields.ts`); a decision's structured output, the
    pinned version of a saved workflow, the provider wait in `run_workflow`'s error data, and every workflow
    node's value by the node's kind (`src/workflow/exec/value-fields.ts`). In a node's value `ok`, `route`,
    `iterations` and `completed` are kept; `content`, `reason`, `answer` and `text` are text; `data`,
    `value`, `confidence` and a model node's output are payloads. A composite's value follows the nodes it
    encloses: a sequence its last step, a map a list of its body, a parallel group one field per branch id, a
    loop's `last` and a decision's `fallback` the enclosed node, a branch its cases when they all agree. In a
    declared specification only the listed field names and the values the engine computed are written as
    they are; every string that a model, a person, a caller or a tool supplied is still redacted, and a key
    the specification does not list is redacted together with its value. So a secret whose value is, or is
    contained in, `promptSection`, `jobFinished`, `confidence` or `low_confidence` changes neither what the
    next run is given, nor which skills are kept, nor which way a decision routes.
  - *Runwright's own words* are written as they are: the field names of a record, enumerated values (a
    pending's `kind`, a command's `type`, a stop reason, an outcome, an error code), ids Runwright generated,
    the model and agent ids of the definition, saved-result paths and digests, and the engine's numbers
    (limits, costs, token counts, attempts, durations, byte counts, versions, timestamps). The engine reads
    them back on resume, they are the same whatever secrets exist, and no caller, model or tool can put text
    into them. So a secret whose value happens to be `toolCalls`, `question` or the digits of a limit does not
    change a record, and a limit you set to a number equal to a secret stays that number. Record types, record
    keys and columns such as a run's status are stored as they are for the same reason.
  - A field the table does not name, and every record of a type the engine does not write (a host tool's or
    driver's own record), is redacted whole. A field's mode is decided by its place in the record as the
    engine built it, never by a name a redaction produced, so the second layer treats every field as the
    first did.
- **Promoted workflows.** A promoted workflow document (`learning.promotions[].workflow.document`) is redacted
  in engine mode: every string and object key, numbers kept (they are structure). It is built from the
  stored, already redacted output of the draft's model step, so the document that was validated and dry-run
  is the redacted one and this pass changes nothing. If a secret became known between the draft's commit and
  this one, secrecy wins and the stored document carries the placeholder.
- **Limits of field-by-field redaction.**
  - A name a model must repeat is text: with a secret whose value is, or is contained in, a tool's name, a
    tool-call id or the name of a tool argument, the journalled call carries the placeholder in place of the
    name and the run continues with what is stored, so that call is answered as an unknown tool (or as
    invalid arguments).
  - Values that an author's expression builds are payloads: the value of a sub-workflow call node, a
    workflow's result, a model node's output, and the value of a branch whose cases end in nodes of different
    kinds. With a secret whose value is, or is contained in, a field name inside such a value (for example
    `confidence`, when a workflow returns a whole decision as its result), that name is stored as the
    placeholder there and a reference through it does not resolve. A reference to the node's own output
    (`steps.<id>.confidence`) is not affected.
  - A workflow's node ids are stored as they are: they are part of record keys, and they are the field names
    of a parallel group's value. Do not put a secret value in a node id.
  - The table describes the records as Runwright's own code writes them. A driver or host tool that writes a
    record under one of Runwright's own types (through `emit`, for a type the engine does not reserve, or
    through `memo` with its own `info`) is trusted with that record's shape: a string it puts where the table
    expects Runwright's own word is stored as it is. The same holds for a field specification that a driver
    or host tool declares for its own step value, structured output or tool data: what it marks as kept is
    stored as it is. Without a declaration its value is redacted whole.
  - At an output boundary (API responses, SSE events, log lines) everything is redacted, Runwright's own
    words included: with a secret whose value is a word such as `completed`, a response shows the placeholder
    in its place; what is stored follows the rules above. Do not store such values as secrets.

## Workspace confinement

- Each run has a workspace folder, `<data dir>/workspaces/<runId>/`. The file tools (`read_file`,
  `write_file`, `edit_file`, `list_files`, `delete_file`) accept only relative paths inside it: empty paths, NUL
  bytes, backslashes, absolute paths (POSIX or drive letters) and `..` segments are refused, and every existing
  path component is checked with `lstat`: a symbolic link is followed with `realpath` and must stay inside the
  real workspace root, and a dangling link is refused (`workspace_escape`).
- **`.runwright/` is reserved.** `<workspace>/.runwright/` holds Runwright's own files (the saved full text of
  truncated tool results and the saved structured data of results whose data was over the size limit). `write_file`, `edit_file` and `delete_file` refuse a path in it with an error result
  `<path>: .runwright/ is reserved for Runwright's own files`; `read_file` and `list_files` still work there.
  Whether a path is in it is decided by which directory it is, not by how the path is spelled: a path whose
  first segment is `.runwright` after Unicode NFC normalisation and lower-casing is refused (also when the folder
  does not exist yet), and so is a path that resolves to the existing `<workspace>/.runwright` directory or
  anything under it, compared by device and inode (other letter case on a case-insensitive file system, another
  Unicode normalisation, a symbolic link into it). **This is not a sandbox:** it guards against accidents and
  against a model that only has the file tools, but `shell` and host tools can still write there, like anywhere
  the process can write. What protects learning is the digest check of saved results
  ([learning.md](learning.md#provenance)).
- **Only regular files are read.** `read_file`, `edit_file`, the engine's check of a saved result, learning's
  verification of one and the file download open a path once, without following a final symbolic link and
  without blocking (`O_NOFOLLOW | O_NONBLOCK`, `src/core/regular-file.ts`), and decide on the opened handle
  whether it is a regular file. A FIFO, a socket, a device or a directory is `<path>: not a regular file` (a
  404 for the download), so a FIFO that `shell` left in the workspace cannot hang a call or a graceful stop. A
  read never takes more than its size limit plus one byte into memory, also when the file grows while it is
  read.
- **A file's content is the run's own work only when the journal says so.** `read_file` marks its result
  untrusted unless the run's journal shows that the run itself left exactly those bytes: a `write_file` or
  `edit_file` result of this run with the same SHA-256, or a file the engine saved for a trusted result. A file
  that `shell` or a host tool downloaded, or that was changed behind the tools, therefore reads as untrusted, and
  an `edit_file` of untrusted content stays untrusted. Learning does not keep text copied from such a read
  ([learning.md](learning.md#provenance) states the rule and its limits).
- **Mutations of one workspace are serialised.** Inside one runner process, `write_file`, `edit_file` and
  `delete_file` share one queue per workspace: each mutation (for `edit_file` the read, the replacement and the
  rename together) starts after the previous one settled, so parallel workflow branches that edit the same file
  never lose an edit, whatever spelling of the path they use. A mutation whose call was aborted while it waited
  does not start. `read_file` and `list_files` are not queued (an atomic rename protects readers). `shell` and
  host tools are outside this queue: what they write to the same files can still race with the file tools.
- **A runner that lost its lease cannot change a workspace file (rule F).** The queue covers one process only;
  across runners, every change the file tools and the engine make inside a workspace has, as its one effective
  system call, a `rename` or `link` with one end in `.runwright/stage/<epoch>`, the staging folder of the
  writer's own lease epoch (writes: a temp file there that one rename moves to its target; deletions: a rename
  into it; saved tool results: a link from it). Only a claim creates that folder, never a writer, and the next
  claimant renames it away before its first step. A frozen runner that wakes up after another runner took its run over may have
  checked its lease, its signal or anything else before it froze; its rename fails anyway, because its folder is
  gone, and the call ends with `lease_lost`. The one effect that is not staged is the creation of a write's
  missing parent directories, so a fenced writer can leave empty directories behind, never content. This is the
  workspace half of fencing; the store rejects the same
  runner's journal writes ([architecture.md](architecture.md#leases-epochs-and-fencing)). `shell` and host tools
  are outside it: they get `context.signal`, but a stale runner's shell command that is still running can still
  write.
- Files are served back by `GET /v1/runs/:id/files/<path>` with the same confinement (an escape is a 404), safe
  content types (text-like files as `text/plain; charset=utf-8`, images as images, PDF and everything else as an
  attachment), `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`, so a
  file a run wrote cannot run script in the console's origin. The bytes come from the handle whose type and
  size were checked, and exactly the announced number of bytes is sent.

## SSRF guard (`web_fetch`)

- Only `http` and `https` URLs, GET only, with a time limit (`tools.webFetch.timeoutMs`, 15 s), a size limit
  (`tools.webFetch.maxBytes`, 1 MiB) and a redirect limit (`tools.webFetch.maxRedirects`, 5). Only text, JSON and
  XML responses are returned.
- The time limit bounds the whole call: resolving the address, connecting, waiting for the response headers,
  reading the body, and every redirect hop. A call over it ends with `fetch_failed: timed out after <n> ms`. A
  pause, a cancel or a forced shutdown ends the call in any of these phases too (a stalled DNS resolver
  included), and a run that is already stopping does not resolve the address at all.
- The host is resolved, and **every** resolved address must be public. Refused classes: loopback (127/8, ::1),
  private (10/8, 172.16/12, 192.168/16, fc00::/7, fec0::/10), link-local (169.254/16, fe80::/10), CGNAT
  (100.64/10), metadata (169.254.169.254, 100.100.100.200, fd00:ec2::254), unspecified, multicast and reserved
  ranges (documentation, benchmarking, 6to4, NAT64, Teredo, 240/4, and every IPv6 address outside global
  unicast). IPv4-mapped (`::ffff:a.b.c.d`, also in hex), IPv4-translated and IPv4-compatible IPv6 addresses are
  judged by their embedded IPv4 address.
- The connection goes to the address that was checked (the DNS answer is pinned), so a second DNS answer cannot
  redirect it. Every redirect hop is checked again the same way.
- Every response the tool does not read to its end (a redirect hop, a refused content type, a body cut at the
  size limit, a timeout, an abort, a response that arrives after the call gave up) is destroyed, socket
  included, before the call returns or when it arrives, so a server that never ends a body holds nothing.
- `web_fetch` output is marked **untrusted**: learning does not keep content that came from it, in the text
  or in the structured data of the result ([provenance](learning.md#provenance)), and the model is told the
  content is not instructions.

## `shell`

- Not registered unless the operator enables it (`tools.shell.enabled`, or `RUNWRIGHT_SHELL=1`). Its default
  policy is `ask`, so every call needs a person's approval unless the agent sets another policy.
- It runs `/bin/sh -c <command>` in the workspace, in its own process group, with a minimal environment (`PATH`,
  `HOME` set to the workspace, `LANG`, and the run's handed secrets), a timeout (`tools.shell.timeoutMs`, 60 s)
  and an output limit (`tools.shell.outputBytes`, 64 KiB). A timeout or an abort kills the whole process group
  (SIGTERM, then SIGKILL one second later); a process that left the group and still holds the output open is
  not waited for longer than one more second, so the call ends at most about two seconds after its timeout or
  abort.
- It is **not a sandbox**: an allowed command can read or change anything the Runwright user can.
- Its output is marked **untrusted** (the tool is declared `untrustedOutput`), because a command can print
  anything from anywhere (`curl`, `cat` of a downloaded file): learning does not keep content copied from it
  ([provenance](learning.md#provenance)). A file a command writes into the workspace is not the run's own work
  either: reading it back with `read_file` gives an untrusted result, because no `write_file` or `edit_file`
  record of the run accounts for its bytes.

## Tool policy

One resolver (`resolvePolicy`, `src/engine/policy.ts`) decides every call, and the first match wins:

1. the server-level deny list (`tools.deny`, `RUNWRIGHT_DENY_TOOLS`) → `deny`, whatever anything else says;
2. inside an `agent` hand-off with `tools`, a tool outside that subset → `deny`, for every call made inside the
   hand-off: by its loop, by a workflow it starts with `run_workflow`, and by a nested hand-off (scopes nest by
   intersection);
3. the agent's own entry for the tool → its policy, else the tool's default policy (`shell`: `ask`), else
   `allow`; `ask` pauses for a person, and becomes `allow` once the person approved the tool "always" for the run,
   for a call that has no approval of its own (a call whose own approval was denied stays denied, and "approve
   always" also approves the tool's other open approvals in the run that had not expired, in the same commit);
4. a tool the agent does not list that the learning context grants (`recall`) → `allow`; the grant is only a
   default, so an agent's `recall: "deny"` or `recall: "ask"` wins over it, and a run whose policy denies
   `recall` is not told about it;
5. any other tool → `deny`.

The deny list is checked again immediately before every handler invocation: a first attempt, an automatic retry
of an unfinished read-only or idempotent call after a crash, a pause or a shutdown, a resumed resumable call, and
a person's retry of an interrupted call. An unfinished call of a tool declared `idempotent` is run again by itself
only when no write call of the run finished after it started; otherwise repeating it could undo that finished
work, so it waits for a person as an interrupted call. A denied call finishes as `denied` without running and the refusal is
returned to the model as the tool result. Arguments are validated against the tool's JSON Schema before the
handler runs. Rules in full: [architecture.md](architecture.md#policy-caps-and-budgets).

## Learning

Learning keeps only what the journal can vouch for ([learning.md](learning.md#provenance)). An item that copies
untrusted text (results of `web_fetch`, `shell` and host tools declared `untrustedOutput`, `read_file` results
the journal does not show to be the run's own bytes, a webhook delivery's payload) is dropped or held. Beyond
copying, rule T holds for a person every other item of a run that read untrusted content (or was started by a
webhook) unless each of its texts occurs in a *trusted text*: one journalled before the run's first untrusted
record, or one a person sent (a message, an answer, an approval). A paraphrase of a page is therefore held, not
kept, and so is the run's own conclusion after reading one; a person approves it (`runwright learning
approve`). A grader `keep` never lifts a provenance hold. A secret or a hidden character anywhere drops the whole
proposal.

## Webhooks

- `X-Runwright-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`, compared in constant
  time; `X-Runwright-Timestamp` (unix seconds) must be within `triggers.webhookWindowSec` (300 s) of the server's
  clock, so a captured delivery cannot be replayed later. The body must be a JSON object with a string member
  `delivery` (1 to 128 visible ASCII characters); that signed value deduplicates redeliveries (idempotency key
  `webhook:<trigger>:<delivery>`), so a redelivered webhook never starts a second run. The delivery id is the
  `delivery` member of the signed JSON body, so it is covered by the signature: a captured request replayed with
  another `X-Runwright-Delivery` header is rejected, and replayed unchanged it is the same delivery and starts no
  second run. The header `X-Runwright-Delivery` is optional; when it is sent it must equal the body's `delivery`
  (400 `bad_request` otherwise). Nothing of the body is parsed before the signature is verified.
- The signing secret is a sealed secret named by the trigger. A disabled trigger starts nothing: a new delivery
  to it gets 409 `trigger_disabled`. A delivery that already started a run is answered
  `202 {runId, duplicate: true}` with that run also after the trigger was turned off, because the delivery's key
  is looked up before the trigger's `enabled` flag is read. The check is made on the stored trigger inside the
  transaction that creates the run, so a delivery that arrives while the trigger is being turned off, deleted or
  changed cannot start a run from the old definition.
- A delivery's payload becomes the run's input `data` (`{delivery, body}`) and is in the untrusted corpus of
  learning's provenance check: an item copied from it is not kept without a person.
- Recipe with `openssl`: [api.md](api.md#webhooks).

## Request handling

- Body limit `server.bodyBytes` (1 MiB): a larger `Content-Length` is refused before reading, and a stream that
  grows past the limit is refused with 413 and `Connection: close`. Nothing past the limit is kept: the rest of
  that body is read and thrown away, at most 4 MiB more and for at most 2 seconds, so that the client reads the
  413 instead of a reset connection; then the connection is closed.
- Strict JSON: syntax errors, trailing text, duplicate keys, `__proto__` keys and nesting deeper than 64 are
  refused; JSON bodies need `Content-Type: application/json`; route bodies are validated against their schemas,
  unknown fields included.
- Workflow references cannot reach prototypes (`__proto__`, `constructor`, `prototype` are rejected and only own
  properties are walked) and cannot execute code: there are no functions or operators.
- Error responses never carry the message of an unexpected exception (500 `internal`); it is logged, redacted.

## Console

- One static page served at `/` with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`, plus `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. It loads nothing from
  other origins.
- It renders all data as text through one DOM builder (no `innerHTML`, no `eval`).
- The token is entered once (or taken from a `#token=` URL fragment, which is removed from the address bar and
  never sent to the server), kept in `sessionStorage`, and sent only in the `Authorization` header. The live
  timeline is read with `fetch` (not `EventSource`, which cannot send headers). Run files are fetched with the
  header and shown as text or downloaded through a blob URL.

## Logs

Structured JSON lines on stderr with a level and correlation fields (`runnerId`; `runId` and `agentId` for
everything a run logs; `requestId` for HTTP). Request bodies and the `Authorization` header are never logged.
Every record's fields (and its message) pass through the process-wide redactor as values before the line is
serialized, so a line is always one valid JSON object; a run's log records also pass through the run's own
redactor. `ts`, `level` and `msg` are always present; a field whose name is one of them is written as
`field_<name>`. If a record cannot be redacted (a redactor that throws), the line is written without its fields,
and its message is replaced by a fixed text when the message itself cannot be redacted.

## Client

The TypeScript client (`src/client`) puts a time limit on every request, covering the body as well
(`requestTimeoutMs`, 30 s by default); a request that exceeds it fails with `unavailable`. The live event stream
(`followTimeline`) has no time limit and ends only at `end`, on its signal or when the connection drops. `waitForRun`
gives each request the caller's signal and at most the time left of its `timeoutMs`, so neither a stalled server
nor an answer that arrives late outlives the caller's deadline or signal. Server discovery probes health with a
limit of 1 s or the time left, whichever is shorter.

## What is not protected

- A local user (or process) who can read the data directory: it holds the token, the seal key (unless
  `RUNWRIGHT_SEAL_KEY` is used) and the database. Protect it with file permissions and disk encryption.
- Whatever a tool the operator allowed can do. `shell` with an `allow` policy, a host tool, or `write_file` used
  to write a secret into the workspace are the operator's decisions.
- Prompt injection inside a run: untrusted content can still steer a model's next step within the tools and
  policies the run has. Policies, approvals, caps and the SSRF guard bound what that can reach.
- Denial of service by an authenticated client (there is no rate limiting).
