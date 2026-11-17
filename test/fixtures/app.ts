/**
 * An in-process app for the end-to-end tests that need no crash (not a test file): a temp data directory,
 * port 0, short leases, an empty environment (so no RUNWRIGHT_* setting of the developer leaks in), a temp
 * console page, the host tools, and every log line captured. Stopped when the test ends.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createApp, type App, type AppOptions } from "../../src/app/app.ts";
import { createClient, type RunwrightClient } from "../../src/client/index.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { Config } from "../../src/config/types.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { createHostTools } from "./host-tools.ts";

export interface TestApp { app: App; client: RunwrightClient; dir: string; effects: string; logLines: string[] }

export async function startTestApp(
  t: TestContext,
  options?: { configure?: (config: Config) => void; app?: Partial<AppOptions>; dir?: string },
): Promise<TestApp> {
  const dir = options?.dir ?? (await makeTempDir(t, "runwright-app-"));
  const config = await loadConfig({ env: {}, overrides: { dataDir: join(dir, "data"), port: 0, leaseMs: 400, pollMs: 20 } });
  config.log.level = "debug";
  options?.configure?.(config);
  const consolePath = join(dir, "console.html");
  await writeFile(consolePath, "<!doctype html><title>Runwright</title>\n");
  const effects = join(dir, "effects.txt");
  const logLines: string[] = [];
  const app = await createApp({
    config, env: {}, consolePath, tools: createHostTools(effects), logWrite: (line) => logLines.push(line), ...options?.app,
  });
  t.after(() => app.stop({ graceMs: 200 }));
  await app.start();
  const client = createClient({ baseUrl: app.url, token: app.token });
  return { app, client, dir, effects, logLines };
}
