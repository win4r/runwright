/**
 * The published package runs where npm installs it: the build compiles `src` and `bin` to JavaScript, and the
 * binary and the three entry points load from a `node_modules/runwright` folder (Node does not strip types
 * there). The build goes into a temporary folder, never into the repository's own `dist`.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILD_SCRIPT = join(ROOT, "scripts", "build.ts");
const BUILD_TIMEOUT_MS = 120_000;
const SERVE_READY_MS = 20_000;

interface Manifest {
  name: string;
  version: string;
  bin: Record<string, string>;
  exports: Record<string, { types: string; default: string }>;
  files: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface Exited { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Manifest;
const children = new Set<ChildProcess>();
let work = "";
let installed = "";
let buildResult: Exited | null = null;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("RUNWRIGHT_") || key.startsWith("NODE_TEST")) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function track(child: ChildProcess): Promise<Exited> {
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => void (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runNode(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<Exited> {
  return track(spawn(process.execPath, args, { cwd: options.cwd, env: cleanEnv(options.env ?? {}), stdio: ["ignore", "pipe", "pipe"] }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out.sort();
}

before(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), "runwright-pkg-")));
  installed = join(work, "node_modules", "runwright");
  await mkdir(installed, { recursive: true });
  buildResult = await runNode(["--disable-warning=ExperimentalWarning", BUILD_SCRIPT, "--out", join(installed, "dist")], { cwd: work });
  await copyFile(join(ROOT, "package.json"), join(installed, "package.json"));
}, { timeout: BUILD_TIMEOUT_MS });

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  if (work !== "") await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("the build into an explicit empty folder exits 0 and says where it wrote", () => {
  assert.ok(buildResult !== null);
  assert.equal(buildResult.code, 0, buildResult.stderr);
  assert.equal(buildResult.stdout.trim().split("\n").at(-1), `built ${join(installed, "dist")}`);
});

test("every bin and exports target named in package.json exists in the installed package", async () => {
  const targets = [...Object.values(manifest.bin), ...Object.values(manifest.exports).flatMap((entry) => [entry.types, entry.default])];
  assert.equal(targets.length, 7);
  for (const target of targets) assert.ok(await exists(join(installed, target)), `${target} exists`);
  assert.ok(await exists(join(installed, "dist", "src", "console", "index.html")), "the console page is next to the compiled modules");
});

test("no emitted JavaScript file imports a .ts specifier", async () => {
  const files = (await listFiles(join(installed, "dist"))).filter((file) => file.endsWith(".js"));
  assert.ok(files.length > 50, `many modules were emitted (${files.length})`);
  const tsSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'][^"'\n]+\.ts["']/;
  const offenders: string[] = [];
  for (const file of files) {
    const match = tsSpecifier.exec(await readFile(file, "utf8"));
    if (match !== null) offenders.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("the three entry points load by their bare names from node_modules", async () => {
  const script = [
    'const root = await import("runwright");',
    'const client = await import("runwright/client");',
    'const builder = await import("runwright/workflow");',
    "console.log(JSON.stringify({",
    "  root: Object.keys(root).sort(),",
    "  builder: Object.keys(builder).sort(),",
    "  createClient: typeof client.createClient,",
    "  rootCreateClient: typeof root.createClient,",
    "  version: root.VERSION,",
    '  built: builder.workflow("probe").input("In", { type: "object" }).output("Out", { type: "object" })',
    '    .root(builder.node.fail("stop", "no")).result(builder.literal({})).build().name,',
    "}));",
  ].join("\n");
  await writeFile(join(work, "check.mjs"), script);
  const result = await runNode(["check.mjs"], { cwd: work });
  assert.equal(result.code, 0, result.stderr);
  const found = JSON.parse(result.stdout) as { root: string[]; builder: string[]; createClient: string; rootCreateClient: string; version: string; built: string };
  const sourceRoot = Object.keys(await import("../../src/index.ts")).sort();
  const sourceBuilder = Object.keys(await import("../../src/workflow/builder.ts")).sort();
  assert.deepEqual(found.root, sourceRoot);
  assert.deepEqual(found.builder, sourceBuilder);
  for (const name of ["workflow", "node", "ref", "literal", "tpl"]) assert.ok(found.builder.includes(name), `the workflow entry exports ${name}`);
  assert.equal(found.createClient, "function");
  assert.equal(found.rootCreateClient, "function");
  assert.equal(found.version, manifest.version);
  assert.equal(found.built, "probe");
});

test("the installed binary prints the package version", async () => {
  const result = await runNode([join(installed, manifest.bin.runwright), "version", "--json"], { cwd: work, env: { HOME: work } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { name: "runwright", version: manifest.version });
});

async function waitForServerJson(path: string, exited: () => boolean): Promise<{ url: string }> {
  const deadline = Date.now() + SERVE_READY_MS;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("serve exited before it wrote server.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { url?: unknown };
      if (typeof parsed.url === "string") return { url: parsed.url };
    } catch {
      // not written yet, or written only in part
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server.json did not appear within ${SERVE_READY_MS} ms`);
}

test("serve from the installed package answers the console and health, and stops on SIGTERM", async () => {
  const home = join(work, "serve-home");
  const dataDir = join(work, "serve-data");
  await mkdir(home, { recursive: true });
  const child = spawn(process.execPath, [join(installed, manifest.bin.runwright), "serve", "--port", "0"], {
    cwd: work,
    env: cleanEnv({ HOME: home, RUNWRIGHT_DATA_DIR: dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let done = false;
  const exit = track(child).finally(() => void (done = true));
  const { url } = await waitForServerJson(join(dataDir, "server.json"), () => done);

  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await page.text(), /<html/i);

  const health = await fetch(`${url}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", version: manifest.version });

  child.kill("SIGTERM");
  const result = await exit;
  assert.equal(result.code, 0, result.stderr);
});

test("an explicit --out that is not empty exits 1 and is left as it was", async () => {
  const out = join(work, "occupied");
  await mkdir(join(out, "inner"), { recursive: true });
  await writeFile(join(out, "keep.txt"), "keep me");
  await writeFile(join(out, "inner", "also.txt"), "and me");
  const before = await listFiles(out);
  const result = await runNode(["--disable-warning=ExperimentalWarning", BUILD_SCRIPT, "--out", out], { cwd: work });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), `error: ${out} is not empty`);
  assert.deepEqual(await listFiles(out), before);
  assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "keep me");
});

test("package.json publishes the compiled build and has no runtime dependencies", () => {
  assert.deepEqual(manifest.bin, { runwright: "dist/bin/runwright.js" });
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
    "./client": { types: "./dist/src/client/index.d.ts", default: "./dist/src/client/index.js" },
    "./workflow": { types: "./dist/src/workflow/builder.d.ts", default: "./dist/src/workflow/builder.js" },
  });
  assert.deepEqual(manifest.files, ["dist", "docs", "README.md", "LICENSE"]);
  assert.equal(manifest.scripts.build, "node --disable-warning=ExperimentalWarning scripts/build.ts");
  assert.equal(manifest.scripts.prepack, "npm run build");
  assert.equal(manifest.scripts.start, "node bin/runwright.ts", "a checkout still runs the sources directly");
  assert.ok(manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), ["@types/node", "typescript"]);
});
