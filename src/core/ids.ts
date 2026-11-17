import { randomBytes as nodeRandomBytes } from "node:crypto";
import { systemClock, type Clock } from "./clock.ts";

export interface IdSource { next(prefix: string): string }

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(ms: number): string {
  let value = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** 16 base32 digits, most significant first, each 0..31. */
function randomDigits(randomBytes: (size: number) => Uint8Array): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  const digits: number[] = [];
  for (let i = 0; i < RANDOM_CHARS; i++) digits.push((bytes[i] ?? 0) & 31);
  return digits;
}

/** Adds one to the digit array; returns false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export function createIdSource(options?: { clock?: Clock; randomBytes?: (size: number) => Uint8Array }): IdSource {
  const clock = options?.clock ?? systemClock;
  const randomBytes = options?.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)));
  let lastTime = -1;
  let lastDigits: number[] = [];
  return {
    next(prefix: string): string {
      let time = clock.now();
      if (time <= lastTime) {
        time = lastTime;
        if (!increment(lastDigits)) {
          time = lastTime + 1;
          lastDigits = randomDigits(randomBytes);
        }
      } else {
        lastDigits = randomDigits(randomBytes);
      }
      lastTime = time;
      return `${prefix}_${encodeTime(time)}${lastDigits.map((d) => ALPHABET[d]).join("")}`;
    },
  };
}
