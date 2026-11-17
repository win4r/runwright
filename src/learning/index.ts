import type { Config } from "../config/types.ts";
import type { IdSource } from "../core/ids.ts";
import type { LearningHooks } from "../engine/types.ts";
import type { Logger } from "../log/logger.ts";
import type { Store } from "../store/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { createLearningHooks } from "./hooks.ts";
import { createRecallTool } from "./recall-tool.ts";

export interface LearningServiceDeps {
  store: Store; tools: ToolRegistry; config: Config["learning"]; logger: Logger;
  /** Ids of the learning items a run creates. */
  ids: IdSource;
}

/**
 * Learning (plan 3.12): `hooks` for the engine (what a run is given; the learning turn after it) and the
 * `recall` tool, which the host registers in its tool registry. Hooks log through the run's own (redacting)
 * logger; `deps.logger` receives one debug line describing the configuration.
 */
export function createLearning(deps: LearningServiceDeps): { hooks: LearningHooks; recallTool: ToolDefinition } {
  deps.logger.debug("learning.configured", {
    budgetTokens: deps.config.budgetTokens, promoteAfterRuns: deps.config.promoteAfterRuns,
    maxNotes: deps.config.maxNotes, maxSkills: deps.config.maxSkills, onLimit: deps.config.onLimit,
    graderModel: deps.config.graderModel === null ? null : `${deps.config.graderModel.provider}/${deps.config.graderModel.name}`,
  });
  return {
    hooks: createLearningHooks({ store: deps.store, tools: deps.tools, config: deps.config, ids: deps.ids }),
    recallTool: createRecallTool(deps.store),
  };
}
