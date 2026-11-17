/**
 * `node publish-result.ts <workspace> <key> <bytes of content>`: claims the workspace stage for epoch 1, then calls
 * `limitToolResult` for a trusted result whose content is `"r"` repeated `<bytes>` times, with a limit of 16 bytes,
 * and prints the returned paths and digests as one JSON line.
 */
import { limitToolResult } from "../../../src/engine/results.ts";
import { claimWorkspaceStage } from "../../../src/tools/workspace-stage.ts";

const [workspace, key, bytes] = process.argv.slice(2);
if (workspace === undefined || key === undefined || bytes === undefined) throw new Error("usage: publish-result.ts <workspace> <key> <bytes>");
await claimWorkspaceStage(workspace, 1);
const shaped = await limitToolResult({
  workspace, epoch: 1, key, limitBytes: 16, outcome: "ok", content: "r".repeat(Number(bytes)), data: null, isError: false, untrusted: false,
});
process.stdout.write(`${JSON.stringify({
  fullResultPath: shaped.fullResultPath, fullResultSha256: shaped.fullResultSha256, fullResultBytes: shaped.fullResultBytes,
})}\n`);
