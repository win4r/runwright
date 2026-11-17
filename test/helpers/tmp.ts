import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** A fresh directory under the OS temp dir (realpath-resolved), removed recursively when the test ends. */
export async function makeTempDir(t: TestContext, prefix?: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix ?? "runwright-test-"));
  const dir = await realpath(created);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return dir;
}
