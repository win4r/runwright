/**
 * The two redaction layers wired as `createApp` wires them, for engine tests of declared field specifications:
 * the run's redactor in the session (over the secrets the run is handed, revealed through a real secrets
 * service), then a store wrapper that commits through the write-redaction layer over that same service (every
 * secret the process has set or revealed).
 *
 *   const wiring = twoLayerWiring();
 *   const h = await createHarness(t, { models, tools, ...wiring.options });
 *   await wiring.attach(h, { WORD: "promptSection" });
 *
 * A run is handed a secret (first layer) only when its agent lists the secret's name (`h.saveAgent({ secrets })`);
 * a secret that is only stored reaches the second layer alone. `wiring.batches` holds every batch a session
 * committed, as the store wrapper received it (after the run's redactor, before the process-wide layer), with the
 * records' `fields` still on them. The harness hands the same wrapped store and reader to every runner it
 * creates, `h.crashAndReplace()` included.
 */
import type { CommitBatch } from "../../src/store/types.ts";
import { isEngineRecordType, listedNames, RECORD_FIELDS, unlistedPaths, type FieldSpec } from "../../src/store/record-fields.ts";
import { generateSealKey } from "../../src/security/seal.ts";
import { createSecretsService } from "../../src/security/secrets.ts";
import type { SecretsService } from "../../src/security/types.ts";
import { createWriteRedaction, type WriteRedaction } from "../../src/security/write-redaction.ts";
import { MIN_SECRET_BYTES } from "../../src/core/redact.ts";
import { storeWith, type Harness, type HarnessOptions } from "./engine.ts";

export interface TwoLayerWiring {
  /** Spread into `createHarness` options: the secrets reader and the store wrapper of `createApp`, runner not started. */
  readonly options: Required<Pick<HarnessOptions, "secretsReader" | "wrapStore" | "autoStart">>;
  /** Call once with the created harness: builds a real secrets service over `h.store`, sets every value of
   *  `values` (name -> value) as a stored secret, and starts the runner. */
  attach(h: Harness, values: Readonly<Record<string, string>>): Promise<SecretsService>;
  /** Every batch a session committed, as it reached the store wrapper: after the run's redactor, before the
   *  process-wide one. Records still carry `fields`. */
  readonly batches: CommitBatch[];
}

const NOT_ATTACHED = "twoLayerWiring: attach(h, values) must be called before the runner uses the store or the secrets reader";

export function twoLayerWiring(): TwoLayerWiring {
  let service: SecretsService | null = null;
  let layer: WriteRedaction | null = null;
  const batches: CommitBatch[] = [];
  return {
    batches,
    options: {
      autoStart: false,
      secretsReader: {
        reveal: (names) => {
          if (service === null) return Promise.reject(new Error(NOT_ATTACHED));
          return service.reveal(names);
        },
      },
      wrapStore: (store) => storeWith(store, {
        commit: (lease, batch) => {
          if (layer === null) return Promise.reject(new Error(NOT_ATTACHED));
          batches.push(batch);
          return store.commit(lease, layer.batch(batch));
        },
      }),
    },
    async attach(h, values) {
      if (service !== null) throw new Error("twoLayerWiring: attach was already called");
      const created = await createSecretsService({ store: h.store, sealKey: generateSealKey() });
      for (const [name, value] of Object.entries(values)) await created.set(name, value);
      service = created;
      layer = createWriteRedaction(created);
      h.runner.start();
      return created;
    },
  };
}

/** `<record type>@<JSON path>` of everything in the captured batches that no specification names:
 *  `unlistedPaths(record.data, record.fields ?? RECORD_FIELDS[record.type])` for every record of an engine type. */
export function undeclaredPaths(batches: readonly CommitBatch[]): string[] {
  return batches.flatMap((batch) => batch.records)
    .filter((record) => isEngineRecordType(record.type))
    .flatMap((record) => {
      const spec = record.fields ?? RECORD_FIELDS[record.type];
      return spec === undefined ? [] : unlistedPaths(record.data, spec).map((path) => `${record.type}@${path}`);
    });
}

/** The secrets a specification is tested with: every name of `listedNames(spec)` that has 8 or more UTF-8
 *  bytes, and for each its first 8 and its last 8 characters; without duplicates. */
export function wordSecrets(...specs: FieldSpec[]): string[] {
  const out = new Set<string>();
  for (const spec of specs) {
    for (const name of listedNames(spec)) {
      if (Buffer.byteLength(name, "utf8") < MIN_SECRET_BYTES) continue;
      out.add(name);
      out.add(name.slice(0, 8));
      out.add(name.slice(-8));
    }
  }
  return [...out];
}
