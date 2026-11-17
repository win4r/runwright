/**
 * A test server holding one of everything the CLI can address (not a test file): agents with two revisions, a
 * completed run with a text and a binary file, a waiting run with an open question, approval and interrupted
 * call, a saved workflow, learning items, a trigger, a secret, and the JSON files the commands read. The command
 * sweep (`output.test.ts`) and the API coverage test (`api-coverage.test.ts`) both run against it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { LearningItem, PendingRecord, RunRecord } from "../../src/store/types.ts";
import { seedLearningItems } from "../helpers/learning.ts";
import type { TestServer } from "../server/support.ts";
import { cliServer, finish, openPendings, seed } from "./support.ts";

export interface World {
  s: TestServer;
  agentId: string;
  done: RunRecord;
  waiting: RunRecord;
  question: PendingRecord;
  approval: PendingRecord;
  interrupted: PendingRecord;
  active: LearningItem;
  held: LearningItem;
  triggerId: string;
  workflowName: string;
  files: { agent: string; workflow: string; trigger: string; triggerPatch: string };
  /** Bytes that are not valid UTF-8, in the completed run's workspace as `blob.bin`. */
  binary: Buffer;
}

export const GREETING = "Hello, Ada!\n";

export function readerWorkflow(): object {
  return {
    format: "runwright.workflow/v1",
    name: "reader",
    schemas: { in: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, out: { type: "string" } },
    input: "in",
    output: "out",
    root: { id: "read", kind: "tool", tool: "read_file", args: { path: { $ref: "input.path" } } },
    result: { $ref: "steps.read.content" },
  };
}

export async function buildWorld(t: TestContext): Promise<World> {
  const s = await cliServer(t);
  const agentId = "cli-agent";
  const done = await seed(s.store, agentId);
  await s.store.saveAgent({
    id: agentId,
    definition: {
      name: "CLI agent", instructions: "Do the job better.", model: { provider: "scripted", name: "scripted-1" }, tools: [], limits: {}, learning: false,
    },
  });
  await finish(s.store, done.id, "completed");
  const workspace = join(s.dir, "workspaces", done.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "greeting.txt"), GREETING);
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x41]);
  await writeFile(join(workspace, "blob.bin"), binary);

  const waiting = await seed(s.store, agentId, "ask me");
  const [question, approval, interrupted] = (await openPendings(s.store, waiting.id, ["question", "approval", "interrupted"])) as [PendingRecord, PendingRecord, PendingRecord];

  const [active, held] = (await seedLearningItems(s.store, agentId, [
    { kind: "note", name: "printer", title: "The printer", description: "It is on floor 2.", body: "Floor 2.", status: "active" },
    { kind: "skill", name: "reboot", title: "Reboot", description: "How to reboot it.", body: "Hold the button.", status: "held" },
  ])) as [LearningItem, LearningItem];

  const workflowName = "reader";
  const files = {
    agent: join(s.dir, "agent.json"),
    workflow: join(s.dir, "reader.json"),
    trigger: join(s.dir, "trigger.json"),
    triggerPatch: join(s.dir, "trigger-patch.json"),
  };
  await writeFile(files.agent, JSON.stringify({
    name: "Saved agent", instructions: "Do it.", model: { provider: "scripted", name: "scripted-1" }, tools: [], limits: {}, learning: false,
  }));
  await writeFile(files.workflow, JSON.stringify(readerWorkflow()));
  await writeFile(files.trigger, JSON.stringify({
    name: "Nightly", kind: "cron", agentId, cron: { expression: "0 3 * * *", timeZone: "UTC" }, message: "tidy up", limits: { maxCostMicros: 50_000 },
  }));
  await writeFile(files.triggerPatch, JSON.stringify({ name: "Nightly, renamed" }));
  await s.client.saveWorkflow(workflowName, readerWorkflow() as never);
  const trigger = await s.client.createTrigger({
    name: "Hourly", kind: "cron", agentId, cron: { expression: "0 * * * *", timeZone: "UTC" }, message: "check", limits: { maxCostMicros: 10_000 },
  });
  await s.client.setSecret("MODEL_KEY", "sk-world-secret-value");
  return {
    s, agentId, done, waiting, question, approval, interrupted, active, held, triggerId: trigger.id, workflowName, files, binary,
  };
}
