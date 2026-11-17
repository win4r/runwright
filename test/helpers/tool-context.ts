/**
 * A ToolContext for calling the built-in file tools directly, the way the engine calls them: the workspace stage
 * is claimed for the context's epoch first (`claimWorkspaceStage`, as a session does at claim), and
 * `steps.run.epoch` names that epoch, so the tools write under rule F.
 *
 *   const context = await fileToolContext(workspace);                      // epoch 1, a signal never aborted
 *   const late = await fileToolContext(workspace, { epoch: 2, journal: () => records });
 *
 * `journal` is what `steps.journal()` returns (default: an empty journal); `signal` defaults to one that never
 * aborts. Claiming a second context of a higher epoch on the same workspace fences the first one's writes.
 *
 * `holdingSeams()` builds `StageSeams` whose `rename` and `link` stop a writer between its temp file and its
 * effect: every call waits until `release()`, then runs the real call; `reached` resolves at the first call.
 */
import { link as fsLink, rename as fsRename } from "node:fs/promises";
import type { RunContext } from "../../src/engine/types.ts";
import { createLogger } from "../../src/log/logger.ts";
import type { JournalRecord } from "../../src/store/types.ts";
import type { ToolContext } from "../../src/tools/types.ts";
import { claimWorkspaceStage, type StageSeams } from "../../src/tools/workspace-stage.ts";

export interface FileToolContextOptions {
  epoch?: number;
  signal?: AbortSignal;
  journal?: () => readonly JournalRecord[];
}

export async function fileToolContext(workspace: string, options: FileToolContextOptions = {}): Promise<ToolContext> {
  const epoch = options.epoch ?? 1;
  await claimWorkspaceStage(workspace, epoch);
  return {
    runId: "run_1",
    agentId: "agent_1",
    workspace,
    signal: options.signal ?? new AbortController().signal,
    logger: createLogger({ write: () => undefined }),
    secrets: {},
    steps: { journal: options.journal ?? (() => []), run: { id: "run_1", agentId: "agent_1", epoch } } as unknown as RunContext,
  };
}

export interface HeldSeams {
  readonly seams: StageSeams;
  /** Resolves when the first `rename` or `link` was called (and is waiting). */
  readonly reached: Promise<void>;
  /** How many calls were made so far. */
  calls(): number;
  /** Lets every waiting and every later call run. */
  release(): void;
}

export function holdingSeams(): HeldSeams {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  let count = 0;
  const hold = async (): Promise<void> => {
    count += 1;
    reach();
    await released;
  };
  return {
    seams: {
      rename: async (from, to) => {
        await hold();
        return fsRename(from, to);
      },
      link: async (from, to) => {
        await hold();
        return fsLink(from, to);
      },
    },
    reached,
    calls: () => count,
    release: () => open(),
  };
}
