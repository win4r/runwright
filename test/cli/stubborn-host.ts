/**
 * A child process for `test/e2e/forced-exit.test.ts` (not a test file): the real `runwright serve` path,
 * `hostApp(ctx, app, "server", process)` with an io whose `exit` is `process.exit`, plus one host tool that
 * ignores cancellation.
 *
 * Environment: RUNWRIGHT_DATA_DIR (required), STUBBORN_LEASE_MS (runner lease, default 30000).
 *
 * `stubborn_write` (write) waits 60 s on a timer that is not tied to its abort signal, so neither a graceful stop
 * nor fencing ends it: only ending the process does. stdout gets the JSON document `serve` prints.
 */
import { createApp } from "../../src/app/app.ts";
import { hostApp } from "../../src/cli/commands/host.ts";
import { createContext, readGlobals } from "../../src/cli/context.ts";
import { COMMANDS, processIo } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/config/load.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";

const stubbornTool: ToolDefinition = {
  name: "stubborn_write",
  description: "Waits a minute and ignores cancellation.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  effect: "write",
  async handler() {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return { content: "finished after a minute" };
  },
};

const lease = process.env["STUBBORN_LEASE_MS"];
const leaseMs = lease === undefined || lease === "" ? undefined : Number(lease);
const config = await loadConfig({ env: process.env, overrides: { port: 0, pollMs: 50, ...(leaseMs === undefined ? {} : { leaseMs }) } });
const app = await createApp({ config, tools: [stubbornTool] });
const spec = COMMANDS.find((command) => command.name === "serve");
if (spec === undefined) throw new Error("no serve command");
const io = { ...processIo(), isTTY: false };
const ctx = createContext({ io, spec, values: {}, positionals: [], globals: readGlobals({}, process.env, "serve") });
process.exitCode = await hostApp(ctx, app, "server", process);
