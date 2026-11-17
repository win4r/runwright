import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const quietPath = fileURLToPath(new URL("../../src/core/quiet.ts", import.meta.url));

test("quiet drops only the SQLite experimental warning", () => {
  const script = `
    await import(${JSON.stringify(quietPath)});
    const { DatabaseSync } = await import("node:sqlite");
    new DatabaseSync(":memory:").close();
    process.emitWarning("SQLite is an experimental feature and might change at any time", "Warning");
    process.emitWarning("something else entirely", "CustomWarning");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  assert.match(result.stderr, /something else entirely/);
});
