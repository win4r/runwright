/**
 * The identity of an idempotent create-run request. Two requests are the same request when their keys have the
 * same digest and their fingerprints are equal; both are functions of the request alone, so nothing a process
 * knows (which secrets exist, before or after a restart) can change the answer.
 */
import { RunwrightError } from "../core/errors.ts";
import { canonicalJson, sha256Hex, type Json } from "../core/json.ts";
import type { RunInput, RunLimits } from "./types.ts";

/** An unpaired surrogate: with the `u` flag a paired surrogate is one astral code point and does not match. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/** True when `text` is well-formed Unicode (no unpaired surrogate), the case in which its UTF-8 encoding is injective. */
export function isWellFormedText(text: string): boolean {
  return !UNPAIRED_SURROGATE.test(text);
}

/**
 * "sha256:" + lower-case hex SHA-256 of the key's UTF-8 bytes. The only form in which a key is stored or reported.
 * A key that is not well-formed Unicode (it holds an unpaired surrogate) is refused with bad_request: UTF-8 would
 * encode every unpaired surrogate as U+FFFD, so "\ud800" and "\ud801" would share a digest. For well-formed
 * strings UTF-8 is injective, so two different accepted keys never have the same digest. Every lookup and every
 * write of a key goes through this function first, so an ill-formed key is refused before anything is read or
 * written.
 */
export function idempotencyDigest(key: string): string {
  if (!isWellFormedText(key)) {
    throw new RunwrightError("bad_request", "an idempotency key must be well-formed Unicode (no unpaired surrogate)", {
      details: { field: "idempotencyKey" },
    });
  }
  return `sha256:${sha256Hex(key)}`;
}

/**
 * The fingerprint of a create-run request, taken from the request as the caller sent it, before any redaction:
 * sha256Hex(canonicalJson({ agentId, revision: revision ?? null, input, limits: limits ?? null })).
 * Byte for byte the formula of `request_hash` in schema versions 1 to 3. Injective for any input, well-formed or
 * not: canonicalJson writes strings with JSON.stringify, which escapes an unpaired surrogate as `\udXXX`, so the
 * hashed text is well-formed and two requests that differ only in unpaired surrogates hash different text.
 */
export function requestFingerprint(request: { agentId: string; revision?: number; input: RunInput; limits?: Partial<RunLimits> }): string {
  return sha256Hex(canonicalJson({
    agentId: request.agentId,
    revision: request.revision ?? null,
    input: request.input as unknown as Json,
    limits: (request.limits ?? null) as unknown as Json,
  }));
}

/** True for a string that can be a fingerprint: 64 lower-case hex characters. */
export function isRequestFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
