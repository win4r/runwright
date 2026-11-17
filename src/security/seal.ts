import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { RunwrightError } from "../core/errors.ts";

/**
 * Sealed secret format: `0x01 | nonce (12 bytes) | ciphertext | tag (16 bytes)`, AES-256-GCM, with the UTF-8
 * secret name as additional authenticated data, so a blob cannot be moved to another name.
 */
const VERSION = 0x01;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function generateSealKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Accepts base64 or base64url text of exactly 32 bytes; anything else is `config_invalid`. */
export function parseSealKey(text: string): Buffer {
  const trimmed = text.trim();
  if (!BASE64_TEXT.test(trimmed)) {
    throw new RunwrightError("config_invalid", "the seal key must be base64 or base64url text");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new RunwrightError("config_invalid", `the seal key must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new RunwrightError("seal_failed", `the seal key must be ${KEY_BYTES} bytes`);
  }
}

export function seal(key: Uint8Array, name: string, plaintext: string): Uint8Array {
  checkKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), nonce, body, tag]));
}

/** Throws `seal_failed` for a wrong key or name, a truncated or modified blob, or an unknown version byte. */
export function unseal(key: Uint8Array, name: string, sealed: Uint8Array): string {
  checkKey(key);
  const fail = (reason: string): never => {
    throw new RunwrightError("seal_failed", `secret ${JSON.stringify(name)} could not be unsealed: ${reason}`, {
      details: { name },
    });
  };
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) return fail("the sealed value is truncated");
  if (sealed[0] !== VERSION) return fail("unknown seal format version");
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const body = bytes.subarray(1 + NONCE_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return fail("authentication failed (wrong key, wrong name or modified data)");
  }
}
