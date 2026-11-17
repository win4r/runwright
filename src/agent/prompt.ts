/** The fixed paragraph every agent's system prompt ends with. */
export const WORKSPACE_NOTE =
  "File tools act inside this run's workspace folder. Paths are relative to that folder; absolute paths, `..` " +
  "segments and links that lead outside it are refused.";

/**
 * Builds the system prompt of an agent loop: the agent's instructions, then the learning section when there is
 * one, then the workspace note. It contains no time and no random content, so a replayed run sends exactly the
 * same prompt.
 */
export function buildSystemPrompt(instructions: string, learningSection?: string): string {
  const parts = [instructions.trim(), (learningSection ?? "").trim(), WORKSPACE_NOTE].filter((part) => part !== "");
  return parts.join("\n\n");
}
