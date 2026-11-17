/**
 * Probes for secret values at rest (not a test file): which forms of a value a text holds, and a scan of every
 * TEXT and BLOB column of every table of a SQLite database file, read with node:sqlite read-only.
 */
import { DatabaseSync } from "node:sqlite";
import { secretForms } from "../../src/core/redact.ts";

/** The forms of `value` that `text` contains (every form `secretForms` lists). */
export function formsIn(text: string, value: string): string[] {
  return secretForms(value).filter((form) => text.includes(form));
}

export interface AtRestHit { table: string; column: string; form: string }

function cellText(cell: unknown): string | null {
  if (typeof cell === "string") return cell;
  if (cell instanceof Uint8Array) return Buffer.from(cell).toString("utf8");
  return null;
}

/** Every cell of `path` (tables in `exclude` skipped) that holds a form of `value`. */
export function scanDatabase(path: string, value: string, exclude: readonly string[] = []): AtRestHit[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hits: AtRestHit[] = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name: table } of tables) {
      if (exclude.includes(table)) continue;
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const columns = (db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string; type: string }[])
        .filter((column) => /TEXT|BLOB/i.test(column.type) || column.type === "");
      for (const { name: column } of columns) {
        const rows = db.prepare(`SELECT "${column.replaceAll('"', '""')}" AS cell FROM ${quoted}`).all() as { cell: unknown }[];
        for (const { cell } of rows) {
          const text = cellText(cell);
          if (text === null) continue;
          for (const form of formsIn(text, value)) hits.push({ table, column, form });
        }
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

/** One column of every row of a table, as text. */
export function columnValues(path: string, sql: string, ...params: (string | number)[]): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => String(Object.values(row)[0]));
  } finally {
    db.close();
  }
}
