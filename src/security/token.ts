import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * "rw_" and 32 random bytes as base64url. The prefix means a token never starts with "-", so it can always be
 * passed as `--token <token>` on a command line.
 */
export function generateToken(): string {
  return `rw_${randomBytes(32).toString("base64url")}`;
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** Compares two equal-length digests; `timingSafeEqual` unless a caller supplies another (tests record calls). */
export type DigestCompare = (a: Buffer, b: Buffer) => boolean;

/**
 * Constant-time comparison: both sides are hashed with SHA-256 so the compared buffers are always 32 bytes, then
 * compared once with `compare` (default `timingSafeEqual`). The decision is that comparison's result; an empty
 * token on either side never matches, and is checked after the comparison so every call compares exactly once.
 */
export function tokensEqual(expected: string, presented: string, compare: DigestCompare = timingSafeEqual): boolean {
  const same = compare(digest(expected), digest(presented));
  return same && expected.length > 0 && presented.length > 0;
}
