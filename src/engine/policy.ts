import type { AgentDefinition, ToolPolicy } from "../agents/definition.ts";

export interface PolicyInput {
  tool: string;
  definition: AgentDefinition;
  /** The registered tool's defaultPolicy (undefined when it has none or is not registered). */
  registryDefault: ToolPolicy | undefined;
  /** Server-level deny list; wins over everything. */
  denyTools: readonly string[];
  /**
   * The tool scope of the context the call is made through (a hand-off's `tools`, see RunContext.withTools), or
   * null when the context has none. A tool outside it is denied whatever the agent or the learning context says.
   */
  scope: ReadonlySet<string> | null;
  /** Tools the learning context grants; a default for tools the agent does not list. */
  granted: readonly string[];
  /** Tools a person approved "always" for this run. */
  approvedAlways: readonly string[];
}

/** The reason a call is refused by the server's deny list. */
export const SERVER_DENY_REASON = "denied by the server's deny list";

/** The reason a call is refused because the tool is outside the tool scope of its context. */
export const SCOPE_DENY_REASON = "not among the tools of this hand-off";

/** The reason a call of a tool the agent does not list (and the learning context does not grant) is refused. */
export const UNGRANTED_REASON = "not granted to this agent";

/** The reason an unlisted tool is allowed because the learning context grants it. */
export const LEARNING_GRANT_REASON = "granted by the learning context";

/** The server deny list's verdict for one tool: the refusal reason, or null when the tool is not on the list. */
export function serverDenial(denyTools: readonly string[], tool: string): string | null {
  return denyTools.includes(tool) ? SERVER_DENY_REASON : null;
}

/**
 * Tool policy for one call (plan 3.6), first match wins:
 * 1. the tool is on the server deny list → deny;
 * 2. the context has a tool scope and the tool is not in it → deny;
 * 3. the agent lists the tool → the entry's policy, else the registered tool's default, else allow; "ask"
 *    becomes "allow" once the tool was approved "always" for this run;
 * 4. the agent does not list the tool and the learning context grants it → allow;
 * 5. otherwise → deny.
 * So a learning grant is only a default for a tool the agent says nothing about: an explicit entry always wins.
 */
export function resolvePolicy(input: PolicyInput): { policy: ToolPolicy; reason: string } {
  const denied = serverDenial(input.denyTools, input.tool);
  if (denied !== null) return { policy: "deny", reason: denied };
  if (input.scope !== null && !input.scope.has(input.tool)) return { policy: "deny", reason: SCOPE_DENY_REASON };
  const entry = input.definition.tools.find((t) => t.name === input.tool);
  if (entry === undefined) {
    if (input.granted.includes(input.tool)) return { policy: "allow", reason: LEARNING_GRANT_REASON };
    return { policy: "deny", reason: UNGRANTED_REASON };
  }
  let policy: ToolPolicy;
  let reason: string;
  if (entry.policy !== undefined) {
    policy = entry.policy;
    reason = `agent policy "${entry.policy}"`;
  } else if (input.registryDefault !== undefined) {
    policy = input.registryDefault;
    reason = `tool default policy "${input.registryDefault}"`;
  } else {
    policy = "allow";
    reason = "allowed by default";
  }
  if (policy === "ask" && input.approvedAlways.includes(input.tool)) {
    return { policy: "allow", reason: "approved always for this run" };
  }
  if (policy === "deny") return { policy, reason: `denied by ${reason}` };
  return { policy, reason };
}
