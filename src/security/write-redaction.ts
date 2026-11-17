/**
 * Redaction at intake: text a person or a caller supplies is redacted for every known secret before it is stored
 * anywhere a journal, an archive, a timeline or a later run reads.
 */
import type { AgentDefinition } from "../agents/definition.ts";
import type { Json } from "../core/json.ts";
import { apiKeySecretName } from "../models/util.ts";
import { redactCommitBatch } from "../store/batch-redaction.ts";
import { requestFingerprint } from "../store/idempotency.ts";
import { RunwrightError } from "../core/errors.ts";
import type { CommitBatch, RunCommand, RunInput, Store, TriggerRecord } from "../store/types.ts";
import type { SecretsService } from "./types.ts";

export interface WriteRedaction {
  /**
   * Text with every known secret form replaced by "[redacted]". With a definition, the secrets it names (its
   * `secrets` and its model's API-key secret) are revealed first, so a value another process stored is known here.
   */
  text(text: string, definition?: AgentDefinition): Promise<string>;
  /** The same over `message`, and over `data` in payload mode (every string, key, and number holding a secret). */
  runInput(definition: AgentDefinition, input: RunInput): Promise<RunInput>;
  /**
   * The same over a command's free text: message.text, answer.answer, deny.reason, cancel.reason,
   * resolve_interrupted.result. Other fields are untouched (a `limits` command's numbers are engine numbers).
   */
  command(definition: AgentDefinition, command: RunCommand): Promise<RunCommand>;
  /**
   * A commit batch with every known secret form replaced by "[redacted]", each part by what it is
   * (`redactCommitBatch`): journal records field by field over RECORD_FIELDS (free text as text; caller, model,
   * tool and driver values whole, numbers whose digits hold a secret included; Runwright's own field names,
   * enumerated values, generated ids and numbers as they are). Uses what the process knows now; reveals nothing.
   */
  batch(batch: CommitBatch): CommitBatch;
}

/**
 * The revision a fire pins when the wrapper found the agent missing. Revisions start at 1, so the store answers
 * "agent_missing" (consuming a cron slot as it does for a missing agent) even when the agent is saved after the read.
 */
const NO_REVISION = 0;

/** The secret names a definition hands to its runs: its `secrets` and its model's API-key secret. */
function namedSecrets(definition: AgentDefinition): string[] {
  const names = new Set<string>(Array.isArray(definition.secrets) ? definition.secrets : []);
  const keyName = apiKeySecretName(definition.model);
  if (keyName !== null) names.add(keyName);
  return [...names];
}

export function createWriteRedaction(secrets: SecretsService): WriteRedaction {
  /**
   * Re-reads every named secret from the store, which adds its value to the process-wide set. Each name is
   * revealed on its own: a blob this process cannot unseal (another seal key) cannot be known here, so it is
   * skipped and every readable secret is still revealed; the text is then redacted with what is known.
   */
  const learn = async (definition: AgentDefinition | undefined): Promise<void> => {
    if (definition === undefined) return;
    for (const name of namedSecrets(definition)) {
      try {
        await secrets.reveal([name]);
      } catch {
        // Unreadable here, so not redactable here either; the runner reports it when the run starts.
      }
    }
  };

  const nullable = async (value: string | null, definition: AgentDefinition): Promise<string | null> => {
    if (value === null) return null;
    await learn(definition);
    return secrets.redactText(value);
  };

  return {
    async text(text: string, definition?: AgentDefinition): Promise<string> {
      await learn(definition);
      return secrets.redactText(text);
    },

    async runInput(definition: AgentDefinition, input: RunInput): Promise<RunInput> {
      await learn(definition);
      return { message: secrets.redactText(input.message), data: secrets.redactPayload(input.data) };
    },

    async command(definition: AgentDefinition, command: RunCommand): Promise<RunCommand> {
      switch (command.type) {
        case "message":
          await learn(definition);
          return { ...command, text: secrets.redactText(command.text) };
        case "answer":
          await learn(definition);
          return { ...command, answer: secrets.redactText(command.answer) };
        case "deny":
          return { ...command, reason: await nullable(command.reason, definition) };
        case "cancel":
          return { ...command, reason: await nullable(command.reason, definition) };
        case "resolve_interrupted":
          return { ...command, result: await nullable(command.result, definition) };
        case "approve":
        case "limits":
        case "pause":
        case "resume":
          return command;
      }
    },

    batch(batch: CommitBatch): CommitBatch {
      return redactCommitBatch(batch, {
        text: (value) => secrets.redactText(value),
        json: <T extends Json>(value: T): T => secrets.redactJson(value),
        payload: (value) => secrets.redactPayload(value),
      });
    },
  };
}

/**
 * A Store that redacts before it persists: createRun and fireTrigger (the run's input.message, and input.data in
 * payload mode), enqueueCommand (the command's free text), saveTrigger and updateTrigger (trigger.message and
 * trigger.name), and commit (every part of the batch by what it is, journal records field by field, through
 * the process-wide set: every secret value this process has set or revealed, placeholder "[redacted]"; a run's
 * own redactor has already replaced what the run was handed with "[redacted:NAME]", and because neither pass
 * rewrites a field name of a record, this one finds every field the first did).
 * Every other member is the inner store's. An explicit object that implements Store method by method (no
 * Proxy), so a method added to Store later does not compile until it is decided here.
 *
 * Idempotency comes first (invariant I2): the store looks a key up and keeps it only as idempotencyDigest(key),
 * for every caller, and the wrapper keeps the request's identity independent of what it redacts. createRun takes
 * the given requestFingerprint, or computes requestFingerprint() from the input as received, before anything
 * else; with an idempotency key it then asks the inner findIdempotentRun with that fingerprint, and a run the
 * key already started is returned (created: false) before any revision is read or any secret is revealed. Only
 * a key without a run (or no key) goes on to read the revision, redact the input and call the inner createRun,
 * which looks the key up once more inside its transaction. So the same request is the same run whichever
 * secrets or revisions exist now. fireTrigger follows the same rule: it asks findIdempotentRun (never strict)
 * first, and a fire whose key already has a run reaches the inner fireTrigger without its `run` (no caller
 * text, no revision read, no secret revealed); only a fire with an unused key takes the fingerprint of the
 * input as received, reads the revision, redacts the input and calls the inner fireTrigger, which looks the key
 * up again inside its transaction and decides on the stored trigger. findIdempotentRun itself is passed
 * through unchanged (an idempotency key that is not well-formed Unicode is refused there, bad_request, before
 * any revision is read).
 *
 * Read, then write (invariant R: the revision a run pins is the revision whose secrets its stored input was
 * redacted against; it is decided once, by this wrapper's read, and carried into the creating transaction):
 * - createRun reads the revision (the one asked for, else the current one), redacts against it and passes
 *   `revision: revision.revision` to the inner createRun, with the fingerprint of the request as sent (so a
 *   replay of a request without a revision still matches). A revision read as missing creates nothing (not_found).
 * - fireTrigger reads the current revision, redacts against it and passes `run.revision`; a revision published in
 *   between does not change what the run pins. A missing agent pins revision 0, which never exists: agent_missing.
 * - enqueueCommand reads the run and its pinned revision, which is immutable: the command is redacted against
 *   the revision the run was handed, whatever was published since.
 * - saveTrigger and updateTrigger redact the trigger's text against the agent's current revision. A later fire
 *   redacts the run input again against the revision it pins, so a revision published in between is covered then.
 * - commit reads nothing (the process-wide set); every other member writes nothing it read here.
 *
 * Why a wrapper and not the store itself: the store holds only sealed secret bytes and never sees a plaintext
 * value or the seal key, so it cannot know what to redact. The guarantee is therefore "an app never hands out a
 * bare store". The places in `src/` that open a SQLite store (pinned by test/app/wiring.test.ts):
 *
 * - `src/app/app.ts`: wrapped; everything a server, runner or trigger writes goes through this wrapper.
 * - `src/bench/compose.ts`: not wrapped; the benchmark creates its own agents and runs with generated text, no
 *   secrets, no callers.
 * - `src/cli/commands/host.ts` (`retention archive`): not wrapped; it reads journals and calls `archiveJournal`
 *   and writes no caller text.
 */
export function redactingStore(store: Store, redaction: WriteRedaction): Store {
  /**
   * The store's not_found for a run of an agent or revision the wrapper read as missing. No run is created then:
   * there is no revision whose secrets the input could be redacted against (agents and revisions are never
   * deleted, but one may be saved after the read; its secrets were not read here).
   */
  const missingRevision = async (agentId: string, revision: number | undefined): Promise<RunwrightError> =>
    revision === undefined || (await store.getAgent(agentId)) === null
      ? new RunwrightError("not_found", `agent ${agentId} not found`, { details: { agentId } })
      : new RunwrightError("not_found", `agent ${agentId} has no revision ${revision}`, { details: { agentId, revision } });

  const redactTrigger = async (trigger: TriggerRecord): Promise<TriggerRecord> => {
    const revision = await store.getRevision(trigger.agentId);
    const message = await redaction.text(trigger.message, revision?.definition);
    const name = await redaction.text(trigger.name, revision?.definition);
    return message === trigger.message && name === trigger.name ? trigger : { ...trigger, name, message };
  };

  const wrapped: Store = {
    get schemaVersion(): number {
      return store.schemaVersion;
    },
    subscribe: (listener) => store.subscribe(listener),
    close: () => store.close(),
    saveAgent: (input) => store.saveAgent(input),
    getAgent: (id) => store.getAgent(id),
    listAgents: () => store.listAgents(),
    getRevision: (agentId, revision) => store.getRevision(agentId, revision),
    listRevisions: (agentId) => store.listRevisions(agentId),
    saveWorkflow: (input) => store.saveWorkflow(input),
    getWorkflow: (name, version) => store.getWorkflow(name, version),
    listWorkflows: () => store.listWorkflows(),
    async createRun(input) {
      const fingerprinted = { ...input, requestFingerprint: input.requestFingerprint ?? requestFingerprint(input) };
      if (input.idempotencyKey !== undefined) {
        const existing = await store.findIdempotentRun({
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprinted.requestFingerprint,
          ...(input.strictIdempotency === undefined ? {} : { strictIdempotency: input.strictIdempotency }),
        });
        if (existing !== null) return { run: existing, created: false };
      }
      const revision = await store.getRevision(input.agentId, input.revision);
      if (revision === null) throw await missingRevision(input.agentId, input.revision);
      return store.createRun({
        ...fingerprinted, revision: revision.revision, input: await redaction.runInput(revision.definition, input.input),
      });
    },
    findIdempotentRun: (query) => store.findIdempotentRun(query),
    getRun: (id) => store.getRun(id),
    listRuns: (filter, page) => store.listRuns(filter, page),
    claimRuns: (input) => store.claimRuns(input),
    heartbeat: (input) => store.heartbeat(input),
    commit: (lease, batch) => store.commit(lease, redaction.batch(batch)),
    readJournal: (runId, options) => store.readJournal(runId, options),
    archiveJournal: (runId, archive) => store.archiveJournal(runId, archive),
    async enqueueCommand(runId, command) {
      const run = await store.getRun(runId);
      const revision = run === null ? null : await store.getRevision(run.agentId, run.revision);
      if (revision === null) return store.enqueueCommand(runId, command);
      return store.enqueueCommand(runId, await redaction.command(revision.definition, command));
    },
    listCommands: (runId, options) => store.listCommands(runId, options),
    getPending: (id) => store.getPending(id),
    listPendings: (filter, page) => store.listPendings(filter, page),
    usageSummary: (query) => store.usageSummary(query),
    changeLearningItem: (id, change) => store.changeLearningItem(id, change),
    getLearningItem: (id) => store.getLearningItem(id),
    listLearningItems: (filter) => store.listLearningItems(filter),
    learningHistory: (id) => store.learningHistory(id),
    learningUses: (runId) => store.learningUses(runId),
    skillServeCounts: (agentId) => store.skillServeCounts(agentId),
    learningMetrics: (agentId) => store.learningMetrics(agentId),
    async saveTrigger(trigger) {
      return store.saveTrigger(await redactTrigger(trigger));
    },
    async updateTrigger(trigger, expected) {
      return store.updateTrigger(await redactTrigger(trigger), expected);
    },
    async fireTrigger(input) {
      // Invariant I2: the key first. A fire whose key already has a run hands the store no caller text at all.
      const existing = await store.findIdempotentRun({ idempotencyKey: input.idempotencyKey, strictIdempotency: false });
      if (existing !== null || input.run === undefined) {
        return store.fireTrigger({
          trigger: input.trigger, kind: input.kind, idempotencyKey: input.idempotencyKey, firedAt: input.firedAt,
          ...(input.cron === undefined ? {} : { cron: input.cron }),
        });
      }
      const fingerprint = input.run.requestFingerprint
        ?? requestFingerprint({ agentId: input.trigger.agentId, input: input.run.input, limits: input.run.limits });
      const revision = await store.getRevision(input.trigger.agentId);
      if (revision === null) {
        return store.fireTrigger({ ...input, run: { ...input.run, requestFingerprint: fingerprint, revision: NO_REVISION } });
      }
      const runInput = await redaction.runInput(revision.definition, input.run.input);
      return store.fireTrigger({
        ...input, run: { ...input.run, input: runInput, requestFingerprint: fingerprint, revision: revision.revision },
      });
    },
    getTrigger: (id) => store.getTrigger(id),
    listTriggers: () => store.listTriggers(),
    deleteTrigger: (id) => store.deleteTrigger(id),
    putSecret: (name, sealed) => store.putSecret(name, sealed),
    getSecret: (name) => store.getSecret(name),
    deleteSecret: (name) => store.deleteSecret(name),
    listSecrets: () => store.listSecrets(),
    listRetiredSecrets: (name) => store.listRetiredSecrets(name),
    pruneRetiredSecrets: () => store.pruneRetiredSecrets(),
    upsertRunner: (info) => store.upsertRunner(info),
    removeRunner: (id) => store.removeRunner(id),
    listRunners: () => store.listRunners(),
  };
  return wrapped;
}
