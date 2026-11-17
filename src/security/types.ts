import type { Json } from "../core/json.ts";
import type { SecretsReader } from "../engine/types.ts";

export interface SecretStatus { name: string; set: boolean; updatedAt: number | null }
export interface SecretsService extends SecretsReader {
  /** name /^[A-Z][A-Z0-9_]{0,63}$/, value 8..16384 bytes, else validation_failed. */
  set(name: string, value: string): Promise<SecretStatus>;
  delete(name: string): Promise<boolean>;
  status(name: string): Promise<SecretStatus>;
  list(): Promise<SecretStatus[]>;
  /**
   * Every secret value this process has set or revealed, every retired value it has loaded (at start-up and for
   * each name it revealed), plus extras given at creation, each form replaced by "[redacted]".
   */
  redactText(text: string): string;
  /**
   * Engine mode: redactText over every string and every object key of a JSON value; numbers are kept. Used for a
   * promoted workflow document; journal records are redacted field by field (`redactCommitBatch`).
   */
  redactJson<T extends Json>(value: T): T;
  /**
   * Payload mode: redactJson, and a number whose digits hold a secret becomes the placeholder text (a string).
   * For caller, model, tool and driver values, and for whatever a record's field specification does not name.
   */
  redactPayload(value: Json): Json;
}
