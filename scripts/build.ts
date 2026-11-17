/**
 * `npm run build`: compiles `src` and `bin` to JavaScript with type declarations, for the published package.
 *
 *   node --disable-warning=ExperimentalWarning scripts/build.ts [--out <dir>]
 *
 * The default output is `<repository>/dist`, removed first. An explicit `--out` must not exist or must be an
 * empty directory; otherwise the script exits 1 and touches nothing. The compiler is the TypeScript in
 * `node_modules`, run with `tsconfig.build.json`; the console page is copied next to the compiled modules.
 * A checkout never needs this: Node runs the TypeScript sources directly.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function runCompiler(out: string): Promise<number> {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const child = spawn(process.execPath, [tsc, "-p", join(ROOT, "tsconfig.build.json"), "--outDir", out], { stdio: "inherit" });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === null ? 1 : 128)));
  });
}

async function build(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" } }, strict: true, allowPositionals: false });
  let out: string;
  if (values.out === undefined) {
    out = join(ROOT, "dist");
    await rm(out, { recursive: true, force: true });
  } else {
    out = resolve(values.out);
    if (!(await isEmptyOrMissing(out))) {
      process.stderr.write(`error: ${out} is not empty\n`);
      return 1;
    }
  }
  const compiled = await runCompiler(out);
  if (compiled !== 0) return compiled;
  const page = join(out, "src", "console", "index.html");
  await mkdir(dirname(page), { recursive: true });
  await copyFile(join(ROOT, "src", "console", "index.html"), page);
  process.stdout.write(`built ${out}\n`);
  return 0;
}

try {
  process.exitCode = await build(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
