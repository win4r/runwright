import { createHash } from "node:crypto";
import { RunwrightError } from "./errors.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const DEFAULT_MAX_DEPTH = 64;

class StrictParser {
  private readonly text: string;
  private readonly maxDepth: number;
  private pos = 0;

  constructor(text: string, maxDepth: number) {
    this.text = text;
    this.maxDepth = maxDepth;
  }

  parseDocument(): Json {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.pos < this.text.length) this.fail("unexpected trailing text");
    return value;
  }

  private fail(message: string): never {
    throw new RunwrightError("invalid_json", `invalid JSON at position ${this.pos}: ${message}`, {
      details: { position: this.pos },
    });
  }

  private skipWhitespace(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(depth: number): Json {
    if (this.pos >= this.text.length) this.fail("unexpected end of input");
    const c = this.text[this.pos];
    switch (c) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
        return this.fail(`unexpected character ${JSON.stringify(c)}`);
    }
  }

  private checkDepth(depth: number): void {
    if (depth > this.maxDepth) this.fail(`nesting deeper than ${this.maxDepth}`);
  }

  private parseObject(depth: number): JsonObject {
    this.checkDepth(depth);
    this.pos++;
    const result: JsonObject = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') this.fail("expected a string key");
      const keyStart = this.pos;
      const key = this.parseString();
      if (key === "__proto__") {
        this.pos = keyStart;
        this.fail('the key "__proto__" is not allowed');
      }
      if (seen.has(key)) {
        this.pos = keyStart;
        this.fail(`duplicate key ${JSON.stringify(key)}`);
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") this.fail("expected ':'");
      this.pos++;
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "}") {
        this.pos++;
        return result;
      }
      this.fail("expected ',' or '}'");
    }
  }

  private parseArray(depth: number): Json[] {
    this.checkDepth(depth);
    this.pos++;
    const result: Json[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "]") {
        this.pos++;
        return result;
      }
      this.fail("expected ',' or ']'");
    }
  }

  private parseString(): string {
    const t = this.text;
    this.pos++;
    let out = "";
    let chunkStart = this.pos;
    for (;;) {
      if (this.pos >= t.length) this.fail("unterminated string");
      const c = t.charCodeAt(this.pos);
      if (c === 0x22) {
        out += t.slice(chunkStart, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail("control character in string");
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += t.slice(chunkStart, this.pos);
      this.pos++;
      const e = t[this.pos];
      switch (e) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const hex = t.slice(this.pos + 1, this.pos + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("bad unicode escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail("bad escape sequence");
      }
      this.pos++;
      chunkStart = this.pos;
    }
  }

  private parseNumber(): number {
    const pattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.text);
    if (match === null) this.fail("bad number");
    const after = this.text[this.pos + match[0].length];
    if (after !== undefined && /[0-9.eE+-]/.test(after)) this.fail("bad number");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number out of range");
    this.pos += match[0].length;
    return value;
  }

  private parseLiteral<T extends Json>(word: string, value: T): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    return this.fail("unexpected token");
  }
}

export function parseStrictJson(text: string, options?: { maxDepth?: number }): Json {
  return new StrictParser(text, options?.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
}

function canonicalInto(value: unknown, parts: string[]): void {
  if (value === null) {
    parts.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      parts.push(value ? "true" : "false");
      return;
    case "number":
      parts.push(Number.isFinite(value) ? JSON.stringify(value) : "null");
      return;
    case "string":
      parts.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        parts.push("[");
        value.forEach((item: unknown, index) => {
          if (index > 0) parts.push(",");
          canonicalInto(item === undefined ? null : item, parts);
        });
        parts.push("]");
        return;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      parts.push("{");
      keys.forEach((key, index) => {
        if (index > 0) parts.push(",");
        parts.push(JSON.stringify(key), ":");
        canonicalInto(record[key], parts);
      });
      parts.push("}");
      return;
    }
    default:
      parts.push("null");
  }
}

export function canonicalJson(value: Json): string {
  const parts: string[] = [];
  canonicalInto(value, parts);
  return parts.join("");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
