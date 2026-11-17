import { RunwrightError } from "../core/errors.ts";
import type { Json } from "../core/json.ts";
import { createFormMatcher, MIN_SECRET_BYTES, redactJsonWith, secretForms, type FormMatcher } from "../core/redact.ts";
import type { Store } from "../store/types.ts";
import { seal, unseal } from "./seal.ts";
import type { SecretStatus, SecretsService } from "./types.ts";

export const SECRET_NAME_PATTERN: RegExp = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_MAX_BYTES = 16_384;
/** What the process-wide set writes in place of every form of a secret it knows. */
export const REDACTED_MARKER = "[redacted]";

/**
 * A growing set of values to hide, in every form `secretForms` lists and under the same byte rule as the
 * per-run redactor; the matcher is rebuilt only after the set changes.
 */
class RedactionSet {
  private readonly values = new Set<string>();
  private matcher: FormMatcher | null = null;

  add(value: string): void {
    if (this.values.has(value) || secretForms(value).length === 0) return;
    this.values.add(value);
    this.matcher = null;
  }

  get empty(): boolean {
    return this.values.size === 0;
  }

  apply(text: string): string {
    if (this.matcher === null) {
      const placeholders = new Map<string, string>();
      for (const value of this.values) for (const form of secretForms(value)) placeholders.set(form, REDACTED_MARKER);
      this.matcher = createFormMatcher(placeholders);
    }
    return this.matcher.text(text);
  }
}

function validateSecret(name: string, value: string): void {
  const problems: { path: string; message: string }[] = [];
  if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
    problems.push({ path: "$.name", message: "a secret name is 1-64 characters: an upper-case letter, then A-Z, 0-9 or _" });
  }
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : -1;
  if (bytes < MIN_SECRET_BYTES || bytes > SECRET_MAX_BYTES) {
    problems.push({ path: "$.value", message: `a secret value is a string of ${MIN_SECRET_BYTES} to ${SECRET_MAX_BYTES} bytes` });
  }
  if (problems.length > 0) {
    throw new RunwrightError("validation_failed", problems.map((p) => `${p.path}: ${p.message}`).join("; "), {
      details: { problems },
    });
  }
}

/**
 * Write-only secrets over the store's sealed blobs. Every value this service sets or reveals (and every value it
 * could unseal at start-up, and the `alsoRedact` extras) stays in its redaction set for the life of the process.
 *
 * Retired values: a value replaced by `set` or removed by `delete` is kept sealed by the store as a retired value
 * while a run that started before the change is unfinished (`Store.pruneRetiredSecrets`). Start-up loads every
 * retired value, and `reveal` loads the retired values of each name it is asked for, so a value a run may have
 * been handed is redacted by every process that writes for that run, across rotation, deletion, restart and a
 * take-over by another runner. A blob that does not unseal under this seal key is skipped. Retired values are
 * never returned by any method.
 */
export async function createSecretsService(deps: {
  store: Store;
  sealKey: Uint8Array;
  alsoRedact?: readonly string[];
}): Promise<SecretsService> {
  const { store, sealKey } = deps;
  const redaction = new RedactionSet();
  for (const extra of deps.alsoRedact ?? []) redaction.add(extra);

  /** The value a blob holds, or null when it does not unseal here (another seal key, damaged bytes). */
  const readable = (name: string, sealed: Uint8Array): string | null => {
    try {
      return unseal(sealKey, name, sealed);
    } catch {
      return null;
    }
  };
  const learn = (name: string, sealed: Uint8Array): void => {
    const value = readable(name, sealed);
    if (value !== null) redaction.add(value);
  };
  const learnRetired = async (name?: string): Promise<void> => {
    for (const retired of await store.listRetiredSecrets(name)) learn(retired.name, retired.sealed);
  };

  for (const { name } of await store.listSecrets()) {
    const row = await store.getSecret(name);
    // An unreadable blob must not stop start-up; it is still listed as set, and reveal reports it.
    if (row !== null) learn(name, row.sealed);
  }
  await learnRetired();
  await store.pruneRetiredSecrets();

  return {
    async reveal(names: readonly string[]): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const name of new Set(names)) {
        // First, so a deleted name or an unreadable current blob still teaches this process the retired values.
        await learnRetired(name);
        const row = await store.getSecret(name);
        if (row === null) continue;
        const value = unseal(sealKey, name, row.sealed);
        redaction.add(value);
        Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
      }
      return out;
    },

    async set(name: string, value: string): Promise<SecretStatus> {
      validateSecret(name, value);
      redaction.add(value);
      const current = await store.getSecret(name);
      const previous = current === null ? null : readable(name, current.sealed);
      if (previous !== null) redaction.add(previous);
      // The same value again keeps its sealed bytes, so the store retires nothing; a new value retires the old one.
      const sealed = current !== null && previous === value ? current.sealed : seal(sealKey, name, value);
      const { updatedAt } = await store.putSecret(name, sealed);
      await store.pruneRetiredSecrets();
      return { name, set: true, updatedAt };
    },

    async delete(name: string): Promise<boolean> {
      const current = await store.getSecret(name);
      if (current !== null) learn(name, current.sealed);
      const deleted = await store.deleteSecret(name);
      await store.pruneRetiredSecrets();
      return deleted;
    },

    async status(name: string): Promise<SecretStatus> {
      const row = await store.getSecret(name);
      return { name, set: row !== null, updatedAt: row?.updatedAt ?? null };
    },

    async list(): Promise<SecretStatus[]> {
      return (await store.listSecrets()).map(({ name, updatedAt }) => ({ name, set: true, updatedAt }));
    },

    redactText(text: string): string {
      return redaction.apply(text);
    },

    redactJson<T extends Json>(value: T): T {
      if (redaction.empty) return value;
      return redactJsonWith(value, (text) => redaction.apply(text)) as T;
    },

    redactPayload(value: Json): Json {
      if (redaction.empty) return value;
      return redactJsonWith(value, (text) => redaction.apply(text), { numbers: true });
    },
  };
}
