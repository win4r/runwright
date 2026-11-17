# Learning rules

An agent with `learning: true` keeps what its runs worked out and gives it to its next runs. This document is
the complete rule set; the code is in `src/learning/`.

## Notes and skills

Each agent has a learning area with two folders:

- `notes/<name>.md`: **one fact each** (a convention, a location, a pitfall) that saves a later run time.
- `skills/<name>.md`: **how to do a job again**, step by step. Only a run that finished its job may write one.

`<name>` matches `^[a-z0-9][a-z0-9-]{0,63}$`. A file is short markdown with a front-matter block that holds
exactly a `title` and a one-line `description`:

```
---
title: Where the build output goes
description: The build writes to dist/, not build/.
---
Run `npm run build`; the bundle lands in dist/app.js. The build/ folder is stale and ignored.
```

The learning area is virtual: items live in the store (`learning_items`), not in the run's workspace.

## When learning happens

After the driver returns and `run.output` is journalled, while the run is still `running`, one learning phase
runs; the run becomes `completed` afterwards. Its steps are durable (keys under `learning/`), so a crash during
learning resumes it without repeating finished steps.

- The learning model calls use their own purposes, `learning`, `grader` and `promotion`, so their cost is kept
  apart from the job's cost in usage and metrics. They do not count as turns.
- What happens when one of them does not fit the spend cap is set by `learning.onLimit`
  ([configuration.md](configuration.md#keys-and-defaults)):
  - `"pause"` (the default): the run **pauses** with the normal `spend_cap` pending at that call's step key
    (`learning/propose`, `learning/grade` or `learning/promote/draft`), like any call over the cap. The job's
    output is already recorded (`run.output`). Raising the cap resumes the run at that call; learning finishes
    and the run becomes `completed` with the same output. Cancelling instead ends the run `cancelled`, with the
    output still in the journal. The pause survives a restart like any pending. A model with no known price
    under a cap opens the same pending ("Spend cap is set but <model> has no known price").
  - `"skip"`: the run never pauses for learning. When the proposal call does not fit, learning is **skipped**
    (`learning.skipped` with `reason: "limit"`); when the grader call does not fit, the surviving items are held
    for a person; when the promotion call does not fit, promotion is skipped for this run.
- A learning failure never fails the run: it is journalled as `learning.skipped` with the reason and logged.

The values of the six learning steps (`learning/given`, `learning/check`, `learning/provenance`,
`learning/apply`, `learning/promote/pick`, `learning/promote/apply`) and the structured outputs of the
proposal, the grader and the promotion draft are stored with Runwright's own field names as they are, whatever
secrets exist: each declares its field specification (`src/learning/value-fields.ts`), so a secret whose value is,
or is contained in, `promptSection`, `jobFinished`, `job_finished` or `decisions` changes neither what the next
run is given nor which items are kept. The text inside them (item names, titles, descriptions, bodies, paths,
reasons, problems, the prompt section) is redacted as text, and a field the specification does not name is
redacted together with its value; what learning's code computed (kinds, modes, verdicts, versions, ids,
booleans) is kept. The `document` of a promotion draft is the model's own workflow document and is a payload,
redacted whole ([security.md](security.md#redaction)).

One limit follows from the proposal being model text: every proposed file has the front-matter line
`description: …`. A secret handed to the run whose value is, or is contained in, the word `description` is
found in every proposal, so every proposal is dropped whole. Stored only (not handed to the run), the same
value is replaced in the stored proposal, the line is no longer a description, and each item is dropped by its
own check (malformed front matter); nothing is kept either way. Do not store a value contained in
`description` as a secret. In the same way a secret contained in a word of the workflow format that a draft
uses (`workflow`, in the format tag; `decision`, the key of a decide node) makes the draft fail validation, and
the attempt is recorded as rejected.

## The proposal

One model call (step `learning/propose`, scripted step name `learning.propose`) gets a compact account of the run
built from its journal (messages, model replies and tool calls, tool results with untrusted ones marked
`[untrusted]`, pendings and their resolutions, workflow node results, the final output; at most 24 000
characters, keeping the start and the end) and answers with structured output. The node line of a workflow
`tool` node whose tool result is untrusted is marked too (`[node <name>] [untrusted] …`), so the same text is
never shown unmarked in the node's value:

```json
{ "job_finished": true,
  "files": [ { "path": "notes/build-output.md", "content": "---\ntitle: ...\ndescription: ...\n---\n..." } ] }
```

The reply's schema checks the envelope only: an object with a boolean `job_finished`, an array `files` and no
other key (a reply that breaks it is asked to be repaired once, then the phase is skipped). Each entry of `files`
is checked on its own by the code checks below, so one malformed entry never costs the others.

## Code checks

The checks (`src/learning/checks.ts`, `secret-scan.ts`, `proposal.ts`) run before any grading, in this order.

### Whole-proposal checks: any hit drops everything

The whole proposal is dropped (`learning.checked` with `dropAll` set to the reason, never the offending text) if
any string anywhere in any entry of `files` contains one of the following, whatever the entry's shape: its
`path` and `content`, strings nested at any depth in a `content` that is not a string, the names and values of
extra keys, an entry that is itself a string, and entries past the first 50 are all scanned. The reason names the
entry (`files[<i>].path`, `files[<i>].content`, or `files[<i>]` for anything else), never a key or the text.

- **a secret the run was handed** (its value, or any encoded form the redactor knows: base64 padded or
  unpadded, base64url, percent-encoded, JSON-escaped);
- **any redaction marker**: `[redacted]` (what the process-wide set writes in place of every secret the process
  knows, a retired value included) and `[redacted:NAME]` (what the run's own redactor writes in place of a
  secret it was handed). The text the check sees is already redacted: the proposal is the learning step's
  stored model output, which both redaction layers have passed over, so a stored secret this agent was never
  handed reaches the check only as `[redacted]`, with no credential pattern left to find. A marker is therefore
  itself the evidence of a secret, and it drops the whole proposal (reason `a redacted secret was found in …`
  or `the handed secret NAME was found in …`). The word "redacted" without the brackets is ordinary text;
- **a credential-shaped string**: `sk-ant-…` keys, other `sk-…` keys (20+ characters), AWS key ids
  (`AKIA…`/`ASIA…` + 16), GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack tokens
  (`xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-`), `-----BEGIN … PRIVATE KEY-----` blocks, `Bearer <20+ token
  characters>`, and JWT-shaped `eyJ….….…` triples;
- **a hidden or bidirectional-control character** (`findHiddenCharacters`). A code point is reported when it is:
  - a C0 or C1 control character or DEL other than tab, line feed and carriage return (U+0000–U+0008,
    U+000B–U+000C, U+000E–U+001F, U+007F–U+009F);
  - the line or paragraph separator, U+2028 or U+2029;
  - a bidirectional control (Unicode property `Bidi_Control`): U+061C, U+200E–U+200F, U+202A–U+202E,
    U+2066–U+2069;
  - a default-ignorable code point (Unicode property `Default_Ignorable_Code_Point`), for example the soft
    hyphen U+00AD, U+180E, the zero-width characters U+200B–U+200F, U+2060–U+206F, the byte order mark U+FEFF,
    the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the variation selectors U+FE00–U+FE0F and
    U+E0100–U+E01EF, and the tag characters U+E0000–U+E007F;
  - an interlinear annotation character, U+FFF9–U+FFFB;
  - an unpaired surrogate (U+D800–U+DFFF not part of a pair): text that is not well-formed Unicode, which the
    store could not keep as it was sent.

  One exception: U+FE0E or U+FE0F directly after a pictographic character (Unicode property
  `Extended_Pictographic`) is not reported, because it only picks text or emoji presentation, as in "⚠️". A
  variation selector anywhere else is reported, a second one after an allowed one included.

A proposal that does not have the shape `{job_finished, files}` is also dropped as a whole.

### Per-item checks: a failing item is dropped alone

The other items continue. An item is dropped (with its reason in `learning.checked.dropped`, under its path, or
`files[<i>]` when it has no string path) when:

- it is past the first **50** entries of `files` (`over the limit of 50 files per proposal`);
- the entry is not an object (`the entry is not an object {path, content}`), has a key other than `path` and
  `content` (`the entry has a key other than path and content`), or its `path` or `content` is missing or not a
  string (`a file needs a string path and a string content`);
- its path is not exactly `notes/<name>.md` or `skills/<name>.md`: empty, absolute, containing a backslash, a
  `..` or `.` segment, another folder, nested folders, no `.md` extension, or a name that breaks the pattern;
- it repeats the path of an earlier item in the same proposal;
- its front matter is missing or malformed (no opening or closing `---`, a line that is not `key: value`, a
  duplicate key, a key other than `title` and `description`, a missing `title` or `description`);
- its `title` is empty, more than one line, or over 80 characters;
- its `description` is empty, more than one line, or over 160 characters;
- its body is empty, or over the size limit: **2 000 bytes for a note, 8 000 bytes for a skill**;
- it is a skill and `job_finished` is false;
- a person retired the item with that path earlier (a retired item is not proposed again);
- it is over the count limit: **5 notes and 2 skills per run** (`learning.maxNotes`, `learning.maxSkills`); the
  extra ones, in proposal order, are dropped.

## Provenance

Whether an item's content came from untrusted tool output is decided from the journal, not by the model
(`src/learning/provenance.ts`). Two questions are asked: does the item **copy** untrusted text (the lexical
checks below), and, in a run that read untrusted content, can the journal **prove** where the item's text came
from (rule T). No word comparison can recognise a paraphrase; what the journal can prove is that a text existed
before the run saw anything external, or was written by a person.

### Rule T: the taint rule

> A run is *tainted* once its journal holds an untrusted record: a `tool.finished` marked untrusted (whatever
> its content, even empty or an error), or the `run.created` of a run started by a webhook. The taint point is
> the `seq` of the first such record.
>
> 1. A run that is not tainted keeps every item (the grader still judges it).
> 2. In a tainted run the lexical checks run first, as before: an item that copies untrusted text is dropped or
>    held.
> 3. Every other item of a tainted run is **held for a person** unless the journal proves where its text came
>    from: its title, its description, its body and its name (hyphens are word breaks) must each occur, as a
>    run of whole words, in one *trusted text*. Trusted texts are: every text journalled before the taint point
>    (the run's input, model replies, tool arguments and results, what earlier learning gave the run), and, at
>    any point, what a person sent — the data of `command.applied` records and the resolution of
>    `pending.resolved` records that carry a `commandId`.
> 4. When a saved file of an untrusted result cannot be verified, every item that is not already dropped or held
>    for copying is held with `field: "evidence"` (unchanged).
>
> So in a run that read a web page, fetched a file or ran a shell command, nothing is kept automatically except
> text that provably predates that content or came from a person; the rest waits in the held list
> (`runwright learning approve`). Held, not dropped: the item may well be the run's own work, but the journal
> cannot show it.

The texts of a record are taken like structured data (`structuredTexts` of the record's `data`), normalised to
words like everything else here, and a field is proven when its words are a contiguous run of one trusted text's
words. A field without words is proven when its character form (below) occurs in the character form of one
trusted text; only a field that is empty after trimming is trivially proven. Each field may be proven by a
different trusted text. A
`pending.resolved` whose `commandId` is `null` (a pending that expired or was closed by Runwright) proves nothing.
For a run started by a webhook the taint point is its `run.created`, so its input, the delivery, and everything
after it are untrusted, and only what a person sent can prove an item.

Rule T is conservative by design: a run that reads untrusted content keeps almost nothing automatically. An item
the run worked out itself after reading a page is held, and a person approves it.

Per item the decisions are made in this order: the lexical drop or hold (reasons below) → unverifiable evidence
(`field: "evidence"`) → not proven (`field: "origin"`) → keep.

**Text without words.** A *wordless* text is one in which the tokeniser finds no word (only symbols,
punctuation and white space, such as `:(){ :|:& };:` or `---`) and that is not empty after trimming. It is judged
on its characters, in *character form*: every run of white space collapsed to one space, then trimmed
(`collapseSpace`). Whatever its field, a wordless text is *copied* when its character form occurs in the
character form of an untrusted text, and *proven* when it occurs in that of a trusted text. Copied and not
proven → `drop`, the verdict of a short body found whole in untrusted output. Neither copied nor proven → the
rule for any text found nowhere: kept in a run that is not tainted, held for its origin (`field: "origin"`) in a
tainted one. A text that has words is judged by its words only, even when it also holds long runs of symbols.

### The lexical checks

1. The untrusted corpus is every text of external origin the run journalled:
   - for every `tool.finished` record marked `untrusted`: its **content** and its **structured `data`**. Untrusted
     results are those of tools declared `untrustedOutput` (`web_fetch`, `shell`, and host tools that say so),
     `read_file` results of files that were saved from an untrusted result (under
     `.runwright/tool-results/untrusted/`), and every other `read_file` result whose bytes the journal does not
     show the run itself left there (see "Which file reads are the run's own work" below). The structured data counts as decoded values, never as JSON text:
     every string value on its own, all string values joined in document order, and the keys with their scalar
     values (numbers and booleans as their JSON text) in document order (`structuredTexts`), so text split over
     two fields, an array of single words or a value under a key is found as well;
   - the saved full text of a truncated untrusted result, and the saved structured data of an untrusted result
     whose data was over the size limit (`fullDataPath`; parsed as JSON and taken like `data`, text that does not
     parse counts as one string), each only when its file is verified (below);
   - the payload of a webhook delivery: for a `run.created` record whose trigger is a webhook, the run's input
     `data` (`{delivery, body}`), taken like structured data. Runs started through the API, by
     `triggers fire` or by cron contribute nothing here.

   The journalled content and data of every untrusted result are always in the corpus, also when they were cut
   or omitted. A saved file is added only when it is **verified** against the record: the journalled path
   (`fullResultPath` or `fullDataPath`) is inside the workspace, the file is opened without following a symbolic
   link, is a regular file, has exactly `fullResultBytes` (or `fullDataBytes`) bytes, and its SHA-256 equals
   `fullResultSha256` (or `fullDataSha256`). Anything else (no digest in the record, as in journals written
   before this version; no path; a missing file; not a regular file; another size or digest) makes the result
   **unverifiable**. When at least one result of the run is unverifiable, every item whose own verdict would be
   `keep` is **held** for a person instead, with `field: "evidence"` (its own verdict here is the lexical one, so
   this holds an item that rule T would hold for its origin as well), `overlap: 0` and the reason `the saved full
   text of <n> truncated untrusted result(s) is missing or was changed (<path>: <why>); a person decides` (the
   same text when the unverifiable file is a saved data file); an item that is already held or dropped keeps its
   own verdict. So a run that rewrites or deletes a saved file cannot get copied untrusted text kept without a
   person.
2. Every text of an item that is retained and shown to later runs is assessed on its own against the corpus:
   the **name** (its hyphens separate words), the **title**, the **description** and the **body**, plus the
   **whole** (title, description and body joined by a line break), which catches text split across fields.
   Texts and corpus are normalised to words by learning's one tokeniser (`src/learning/words.ts`, also used by
   BM25 below): lower-case the text; every character of a script written without spaces between words (Han,
   Hiragana, Katakana, Hangul, Thai, Lao, Khmer, Myanmar) is a word of its own; every other maximal run of letters
   and digits is a word; everything else separates words. So `abc設備def` is the four words `abc`, `設`, `備`,
   `def`, and a Chinese or Japanese sentence is compared character by character. A text of 5 or more words is cut into 5-word shingles, and `overlap` is the share of
   its distinct shingles that occur in the corpus. "Found verbatim" means the text's words occur in the corpus as
   consecutive whole words.
3. Each assessment gives a verdict by its rule, and the **strictest wins** (`drop` > `hold` > `keep`):

| Text | 5 or more words | Fewer than 5 words |
|---|---|---|
| body | `overlap >= 0.5` → **drop** (`untrusted_origin`); `overlap >= 0.2`, or any run of **12 or more consecutive words** found verbatim → **hold** for a person | found verbatim → **drop** |
| title, description, name (each on its own) | `overlap >= 0.5` → **drop**; **any** shared 5-word shingle → **hold** | 2 to 4 words found verbatim → **hold**; 1 word: not assessed |
| whole | the body rule | not assessed |

"One word" means one token: a single Han character is one word, so a title of two or more such characters is
assessed. An item that passes these checks goes on to rule T (the evidence hold, then the proof of origin). The verdict is
journalled per item (`path`, `verdict`, `field`, `overlap`, `verbatimRun`, `reason`) as the value of the
`learning/provenance` step (a `step.finished` record), where `field` names the assessment that decided it
(`whole` for a keep; `evidence` for an item held because a saved result could not be verified):

| `field` | Meaning | Example `reason` |
|---|---|---|
| `body`, `description`, `title`, `name`, `whole` | that text copies untrusted output (drop or hold) | `untrusted_origin: 100% of the description comes from untrusted tool output`; `the body is partly from untrusted tool output (a run of 12+ words is copied); a person decides`; `the title is copied from untrusted tool output; a person decides` |
| `evidence` | a saved file of an untrusted result could not be verified (hold) | `the saved full text of 1 truncated untrusted result is missing or was changed (<path>: missing); a person decides` |
| `origin` | the run is tainted and one of the item's texts is not proven by rule T (hold); the first unproven one is named, in the order body, description, title, name | `the run read untrusted content and the journal does not show that the body is the run's own earlier text or a person's; a person decides` |
| `whole` (keep) | kept | `no overlap with untrusted tool output` (the run is not tainted); `every text of the item is in the run's trusted material` (proven) |

When provenance decides an item, `learning.graded` shows the same `reason` with `by: "provenance"`. Items
dropped by provenance are not sent to the grader. The grader cannot upgrade a provenance verdict: a provenance
`hold` beats a grader `keep`.

**Which file reads are the run's own work.** A `read_file` result is untrusted unless the journal proves that
the run itself left those bytes in the file (`src/tools/file-trust.ts`). `write_file` and `edit_file` journal
`data.sha256`, the SHA-256 of the bytes they left in the file, and `read_file` journals `data.sha256` of the bytes
of the whole file it read (also when `offset` and `limit` return a part). The read is trusted only when an
earlier `tool.finished` record of the run that is neither an error nor untrusted either is a `write_file` or
`edit_file` result with that digest, or carries it as `fullResultSha256` or `fullDataSha256` (a file the engine
saved for a trusted result). A file under `.runwright/tool-results/untrusted/` is untrusted whatever the journal
says. An `edit_file` of a file that was not trusted by this rule journals its own result untrusted, so an edit
of untrusted content stays untrusted and a later read of the edited file is untrusted too. So a file that a
`shell` command or a host tool downloaded, and a file changed behind the tools (by `shell`, by a host tool or
from outside the run, also after a `write_file`), reads as untrusted, and its text is in the corpus. A host tool
cannot vouch for a file it writes: only the built-in `write_file` and `edit_file` can. The rule errs on the
untrusted side: a read that overlaps a `write_file` of the same file still in flight, or a file an `edit_file`
changed just before a crash cut the call off (before its result was journalled), reads as untrusted. A
`write_file` cut off that way (it is declared idempotent) is run again by the engine only when no write call of
the run finished after it started, and then the new result vouches for the file; otherwise it waits for a person
as an interrupted call. An unfinished call of a tool declared `idempotent` is run again by itself only when no
write call of the run finished after it started; otherwise repeating it could undo that finished work, so it
waits for a person as an interrupted call.

**What provenance does not track.** Stated plainly, these are not in the untrusted corpus:

- text a caller with the API token sends: the first message, the run's `data`, later messages and answers to
  questions (an API caller is trusted; cron data is generated by Runwright). These are trusted texts for rule T
  instead: the first message and data when they are journalled before the taint point, messages and answers a
  person sent at any point;
- untrusted text written back by the model: the file rule compares content by SHA-256, so a model that reads
  an untrusted file and writes the same text back with `write_file` produces a file that reads as trusted. The
  text itself is already in the corpus from the untrusted read and is still matched there; only text the model
  received some other untracked way (one of the other entries in this list) passes through such a file
  unnoticed;
- file names: `list_files` reports names, types and sizes only and its result is trusted, so a file name chosen
  by a download is not tracked;
- paraphrase: the comparison is lexical, so reworded untrusted text is not recognised. The grader is the second
  check, and it can only make a verdict stricter, never upgrade a provenance verdict. Rule T is what stops a
  paraphrase: a reworded item of a tainted run is not proven, so it is held for a person.

## The grader

One more model call (step `learning/grade`, scripted step name `learning.grade`, purpose `grader`) judges all
surviving items at once. It uses `learning.graderModel` from the configuration when set, otherwise the agent's
model. The grader model's key is registered with the run's redactor before the grader is called, so it is
redacted from the run's records like the agent's own key ([security.md](security.md#redaction)). It sees the same account of the run and the candidate files, and answers:

```json
{ "job_finished": true, "decisions": [ { "path": "notes/build-output.md", "verdict": "keep", "reason": "..." } ] }
```

How verdicts combine, per item:

1. The grader's verdict for the path (`keep`, `drop` or `hold`); an item with no usable decision is **held**.
   The reply's schema checks the envelope only (`job_finished`, `decisions`); each decision is checked alone and
   is usable when it is an object with exactly a string `path`, a `verdict` of `keep`, `drop` or `hold` and a
   string `reason` (cut to 500 characters). A malformed decision is ignored, so its item is held ("the grader's
   decision was malformed; a person decides") while the other decisions apply. If the grader call could not run
   (a limit stopped it under `learning.onLimit: "skip"`, the provider failed, or its output stayed invalid after
   the repair attempt), every item is held.
2. A **skill** is dropped unless both the proposal and the grader say `job_finished: true`.
3. The final verdict is the **stricter** of that and the provenance verdict: `drop` > `hold` > `keep`.
4. A new version of an item whose current version is held stays held.

The decisions are journalled as `learning.graded` with who decided each one (`grader`, `provenance` or `rule`).

## Versions, history and ETags

Kept items are stored with status `active`, held items with status `held` (listed for a person, who approves or
retires them). A proposal for an existing `(agent, kind, name)` makes a new version of that item, under these
rules:

- **Fenced and atomic.** The item writes of a run are part of the fenced commit that journals its
  `learning/apply` step (a `ctx.effect` step, see [architecture.md](architecture.md#durable-steps-and-replay)).
  A runner that lost its lease cannot write an item, and a crash can never apply a write twice or without its
  journal record: after a crash before that commit, the step plans again from what is stored then.
- **Conditional on the version the run saw.** The `learning/check` step journals the version of each existing
  item at the time the run checked its proposal. A write is made only if the item is still at that version (or,
  for a new item, still does not exist) when the commit happens. An item that was edited, retired, approved,
  restored, or created or updated by another run in between is not written: it is listed in
  `learning.applied.conflicts` (`{path, reason}`) and the newer version stays.
- **A retired item is never reactivated by a run**, whatever content the run proposes.
- **Identical content writes nothing.** When the item is at the version the run saw and already has the proposed
  title, description, body and status, no new version is made; the item is reported in `kept` (or `held`) at its
  current version.

Every change appends a row to `learning_history` with the full snapshot (title, description, body, status),
the actor and a note, and increases `version`:

| Action | Change |
|---|---|
| `created`, `updated` | from a run's learning phase |
| `held` | stored or updated as held |
| `approved` | held → active (a person) |
| `retired` | active or held → retired (a person) |
| `restored` | retired → active (a person) |
| `edited` | title, description or body changed (a person), any status |
| `promoted` | the skill was saved as a workflow |

Each item has an ETag, `"<version>-<8 hex of the content hash>"`. Retire, restore, approve and edit are
conditional: they need `If-Match` with the current ETag (missing → 428 `precondition_required`, stale → 412
`etag_mismatch`, wrong status → 409 `conflict`). The CLI reads the ETag for you unless `--etag` is given.

A person's text gets the same protection as a proposal: an edit (`title`, `description`, `body`) and the `note`
of a retire, restore or approve are **refused** with 400 `validation_failed`, and nothing is stored, when the
text contains a stored secret (the item's agent's named secrets are re-read first), a credential-shaped string
or a redaction marker (`[redacted]`, `[redacted:NAME]`: the whole-proposal secret checks above) or a hidden or
bidirectional-control character. The problem's `path` names the field
(`$.title`, `$.description`, `$.body`, `$.note`) and its message the kind of problem, never the text.

## Giving items to the next run

Before the driver starts, a run of a learning agent is given its agent's **active** items (step
`learning/given`), as a section of the system prompt headed `## Learned from earlier runs`. In an agent loop run
it follows the instructions; in a workflow run every `model` and `decide` node's system prompt ends with it, and
every `agent` node's loop includes it like any agent run (`model` and `decide` nodes have no tools, so only an
`agent` node can open a listed item with `recall`, and only when its `tools` list, if it narrows the tools,
names `recall`):

What is included follows **rule S2** (`selectItems`, `src/learning/select.ts`), with the budget
`learning.budgetTokens` (default 2 000, estimated at 4 bytes per token):

> If everything fits whole, every item is given whole (skills first, then by name). Otherwise the items are
> ranked by BM25 against the run's first message (ties: newest first, then name).
> **(a) When one line for every item fits**, every item is given: each starts as its line, and in rank order an
> item is given whole instead when the difference still fits. No item is left out.
> **(b) When even the lines do not all fit**, something must be left out, and relevance decides: in rank order an
> item is given whole if it still fits, otherwise as its line if that fits, otherwise it is left out.
> The section never exceeds the budget.

- The budget is charged for the heading that mentions lines (the larger one) from the start; if even that
  heading does not fit, nothing is given. The section lists the whole items in rank order, then the lines in rank
  order, a line being `- [kind] name — title: description`.
- **Example of case (a).** Two notes, `alpha` (first in rank) and `beta`, cost 173 and 160 tokens whole and 10
  and 9 as lines; the heading costs 51 and the budget is 226. Both lines fit (51 + 10 + 9 = 70), so both notes
  are given. Upgrading `alpha` would cost 163 more (233 > 226), so it stays a line; upgrading `beta` costs 151
  more (221 ≤ 226), so `beta` is given whole. The trade-off is deliberate: when the lines of all items fit, a
  very relevant long item may be given as a line so that no item is hidden; `recall` opens it.
- **Example of case (b).** With 101 notes whose lines alone take more than the budget of 300, the items are
  taken in rank order: an item is given whole if it still fits in what is left of the budget, otherwise as one
  line if the line fits, otherwise it is left out. The notes are 100 unrelated ones, `n0` to `n99` (about 47
  tokens whole and 14 as a line each; none matches the first message, so they rank in tie order: newest first,
  then by name), and one short note `kiln-firing` (38 tokens whole) that matches the first message `what is the
  kiln firing schedule`; their lines take 1 459 tokens. `kiln-firing` comes first and is given whole (51 + 38 =
  89); the next notes are given whole while they still fit (`n0`, `n1`, `n10` and `n11`: 279); `n12` no longer
  fits whole but its line does (294); no further item fits, so the other 95 notes are left out.
- **BM25**: `k1 = 1.2`, `b = 0.75`, idf `ln(1 + (N − n + 0.5) / (n + 0.5))`, over one weighted term frequency of
  title × 3, description and body (an item's length is that weighted count). Tokens are the words of learning's
  tokeniser (see [Provenance](#the-lexical-checks)), one-character tokens dropped except a character of a script
  written without spaces, which is a word by itself (so a Chinese query term finds a Chinese body). Only the
  first 256 distinct words of the first message are scored; equal scores keep the tie order.
- Choosing costs `O(N log N)` in the number of active items: two sorts (kind and name; recency and name), the
  BM25 ranking (one pass over the items per query word, then a sort of the scores), and at most `2 × N + 2`
  token estimates.
- When some items are listed as lines and the run can call `recall`, the run is granted the **`recall`** tool
  (policy `allow`, effect `read`, even if the agent does not list it), and the section says it can open a listed
  item with it. The grant is only a default for a tool the agent says nothing about: an agent that sets
  `recall: "deny"`, or a server deny list that names it, keeps it denied
  ([architecture.md](architecture.md#policy-caps-and-budgets)). Then the lines are still listed, the section's intro is "These notes and
  skills were kept from earlier runs of this agent. Items listed on one line are summaries only." and no tool is
  granted. (An agent that sets `recall: "ask"` is told about it and asked as usual.)

`recall` takes `{name}` (`name`, `kind/name` or `folder/name[.md]`), returns the item's text at the version this
run was given, and marks the item **opened** for this run (through the call's `tool.finished` commit, see below).
It only opens items this run was given. The workflow pointer it shows is also that of the version the run was
given: a promotion writes its own version (history action `promoted`), so the pointer is shown only when the
given version is that one or later. A run given a version from before the promotion is not told to run a
workflow drafted from text it was not shown. The result's `data` is `{itemId, version, kind, name, promoted}`.
The prompt section a run starts with is built from the items as they are when their versions are pinned, so its
text and pointers always belong to the versions recorded as given.

A skill that was promoted to a workflow is shown with a pointer to that workflow, its version and the
`run_workflow` tool (see [Skill promotion](#skill-promotion)).

## Given and opened records

`prepare` records what each run was given in `run_learning` (`{itemId, version, mode: "full" | "line",
opened}`) and journals `learning.given`. `GET /v1/runs/:id/learning` returns those records.

Both records go through the same fenced commits as the journal: the given rows are written with the record of
the `learning/given` step, and an item `recall` opened is marked with the `tool.finished` record of that call
(`ToolOutput.learningOpened`). A crash therefore never records them twice, and a runner that lost its lease
cannot record them.

## Metrics

`GET /v1/agents/:id/learning/metrics` (and the console's Learning tab) compares the agent's **completed** runs
in two groups: `before` (no item given) and `after` (at least one item given). Each group reports the number of
runs, the average job cost (usage with purposes other than `learning`, `grader` and `promotion`; `null` when no
cost is known), the average input and output tokens, and the average duration.

## Skill promotion

A skill that keeps working is drafted as a workflow:

1. In the learning phase, the first active skill is picked that has no promoted workflow yet, fewer than **2**
   promotion attempts, and has served at least `learning.promoteAfterRuns` (default **3**) completed runs. A skill
   serves a run when it was given to it in full, or opened with `recall`, and the run completed.
2. One model call (step `learning/promote/draft`, scripted step name `learning.promote`, purpose `promotion`)
   gets the skill, the agent's tools with their argument schemas and a summary of the workflow format, and answers
   `{document}`. The tools offered are those the agent lists that a call from this run would not be denied (the
   engine's own policy answer: the server deny list, an explicit `deny`, a tool whose default policy is `deny`).
3. The draft is named `promotedWorkflowName(item)` (`src/learning/promotion.ts`): `skill-`, the first 30
   characters of the skill name with trailing hyphens removed, `-`, and the last 26 characters of the item id
   without its `li_` prefix, lower-cased, letters and digits only. For the skill `deploy-the-static-site` with the
   id `li_01JC3M8Z4QF6Y2N7T5W9XKD0AB` it is `skill-deploy-the-static-site-01jc3m8z4qf6y2n7t5w9xkd0ab`. The name
   is unique per learning item, so same-named skills of different agents never share a workflow, and it is at
   most 63 characters and a valid workflow name. A draft that holds a secret in any string or object key of
   its document (a redaction marker of either form, a value the run was handed, a credential-shaped string: the
   whole-proposal secret checks above) is rejected first, with the problem `<path>: <what> was found; a draft
   holding a secret is not kept`, since a saved workflow would hand that text to every later run. Otherwise the
   draft is kept only if it passes `validateWorkflow` with no
   error **and** `dryRunWorkflow` with `ok: true`, both judging it under that name (`savedAs`,
   [workflows.md](workflows.md)): a `call` of that name is the draft itself. Then it is saved under that name with `source: "promotion"`
   and linked to the skill (history action `promoted`). `ok: true` means the dry run found no error, was not
   truncated and did not end at a `fail` that every run reaches ([what `ok` means](workflows.md#what-ok-means)).
   Warnings about placeholder-dependent values (code `placeholder_dependent`: problems that depend on values the
   dry run made up, such as a model's answer that a pattern or an `enum` constrains) do not reject a draft and do
   not count as a failed attempt. A draft that the validator rejects records the validator's errors only, each as
   `<path>: <message> (<code>)`; a value that can never fit its schema is usually found here already ([what the
   validator can and cannot see](workflows.md#what-the-validator-can-and-cannot-see)), and then the draft is not
   dry-run. When a draft is rejected by its dry run, the recorded problems are the dry run's
   errors only, each as `dry run <path>: <message> (<code>)`, or, when it has none, its last step note (for example
   `dry run $.root: would fail: …`); warnings never appear among them.
4. An attempt, kept or rejected, counts only against the skill version it was drafted from, while that skill is
   active and not promoted. So the skill is read first: when it is gone, not active, promoted or at another
   version than the one picked, the outcome is `rejected` with the problem "the skill changed while its
   workflow was being drafted" and nothing is counted. Otherwise (including a draft call that failed, an
   invalid draft and a taken name) the attempt and the problems are recorded on the item, and
   `learning.promotion` is journalled with `outcome: "rejected"`. After two failed attempts the skill is not
   drafted again.
5. **The name belongs to the skill.** The API cannot save a version under a name that has a promoted version
   (`PUT /v1/workflows/:name` answers 409 `conflict` with `details.reason: "promoted_workflow"`, `name` and
   `skillItemId`), and a promotion cannot write under a name that anything else owns (an API version, or a
   version of another skill): the store throws `learning_conflict` (`details.reason: "workflow_name_taken"`) and
   rolls the whole commit back. If the name is taken when a draft is ready, the attempt is recorded as rejected
   with the problem `the workflow name <name> is already used by a workflow this skill does not own`; nothing of
   the other workflow changes.
6. The outcome, the attempt counter and the promoted workflow are written in one fenced commit with the record
   of the `learning/promote/apply` step, so an attempt is counted exactly once, even across a crash. The store
   checks the same precondition in that transaction for both outcomes: a kept or a rejected promotion of a skill
   that is not an active, unpromoted skill at exactly the version drafted from throws `learning_conflict` and
   writes nothing; the step then plans again and ends with "the skill changed while its workflow was being
   drafted", not counted. So a skill that a person or another run changed while its draft was being written is
   neither promoted nor charged an attempt of its new version.

Promotion does not run when the proposal step was skipped. Under `learning.onLimit: "skip"`, a promotion call
stopped by a limit is not counted as an attempt (`learning.skipped` with `reason: "limit"`); under `"pause"` the
run waits at `learning/promote/draft` and the attempt is made once the cap is raised.

**The pointer has a version.** A kept promotion records on the skill both the name (`promotedWorkflow`) and the
version it saved (`promotedWorkflowVersion`), so a skill always runs the document that was validated for it. What
a run is told names both. In full (`renderItem` in `src/learning/proposal.ts`, also what `recall` returns):

```
Saved as workflow `<name>` version <n>: run it with the `run_workflow` tool, passing this name and version.
```

and as one line (`renderLine`), appended to the item's line:

```
 (workflow `<name>` version <n>, use `run_workflow`)
```

`run_workflow` takes that `version` and runs exactly it ([workflows.md](workflows.md#saved-workflows-and-run_workflow)).
A pointer without a version (`promotedWorkflowVersion: null`) is shown without one and runs the latest version.

**Older databases.** Schema migration 3 (`promotion-pointer`) upgrades a database written by an earlier
version: each promoted skill gets the highest version of the workflow row with its `promotedWorkflow` name that
the skill owns (`skill_item_id` = the item's id), or `null` when there is none. Workflows saved by an earlier
version (named `skill-` plus the skill name alone) keep that name; new promotions use the name above.
