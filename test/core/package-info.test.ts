import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageRoot, packageVersion } from "../../src/core/package-info.ts";
import { RunwrightError } from "../../src/core/errors.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const REPO_ROOT = new URL("../../", import.meta.url);

function isInternal(error: unknown): boolean {
  return error instanceof RunwrightError && error.code === "internal" && /runwright package root was not found above/.test(error.message);
}

test("packageRoot finds the repository root from a module URL three levels down", () => {
  const expected = fileURLToPath(REPO_ROOT).replace(/\/$/, "");
  assert.equal(packageRoot(new URL("./src/cli/commands/host.ts", REPO_ROOT)), expected);
  assert.equal(packageRoot(new URL("./src/cli/commands/host.ts", REPO_ROOT).href), expected);
  assert.equal(packageRoot(), expected, "the default starts from the package-info module itself");
});

test("packageRoot accepts a URL, a file: string and a plain path, and finds the root at most 6 levels up", async (t) => {
  const top = await makeTempDir(t);
  await writeFile(join(top, "package.json"), JSON.stringify({ name: "runwright", version: "9.9.9" }));
  const six = join(top, "a", "b", "c", "d", "e", "f");
  const seven = join(six, "g");
  await mkdir(seven, { recursive: true });
  assert.equal(packageRoot(join(six, "mod.js")), top);
  assert.equal(packageRoot(pathToFileURL(join(six, "mod.js"))), top);
  assert.equal(packageRoot(pathToFileURL(join(six, "mod.js")).href), top);
  assert.equal(packageRoot(join(top, "mod.js")), top, "the directory of the module itself counts");
  assert.throws(() => packageRoot(join(seven, "mod.js")), isInternal);
});

test("packageRoot skips a package.json with another name or that does not parse", async (t) => {
  const top = await makeTempDir(t);
  await writeFile(join(top, "package.json"), JSON.stringify({ name: "runwright", version: "1.2.3" }));
  await mkdir(join(top, "other", "broken", "src"), { recursive: true });
  await writeFile(join(top, "other", "package.json"), JSON.stringify({ name: "not-runwright", version: "4.5.6" }));
  await writeFile(join(top, "other", "broken", "package.json"), "{ not json");
  assert.equal(packageRoot(join(top, "other", "broken", "src", "mod.js")), top);
});

test("packageRoot throws internal when no runwright package.json is above", async (t) => {
  const top = await makeTempDir(t);
  await mkdir(join(top, "x", "y"), { recursive: true });
  await writeFile(join(top, "x", "package.json"), JSON.stringify({ name: "something-else" }));
  assert.throws(() => packageRoot(join(top, "x", "y", "mod.js")), isInternal);
});

test("packageVersion is the version in package.json", async () => {
  const manifest = JSON.parse(await readFile(new URL("./package.json", REPO_ROOT), "utf8")) as { version: string };
  assert.equal(packageVersion(), manifest.version);
});
