import type { Json, JsonObject } from "../core/json.ts";
import type { JsonSchema } from "../schema/validate.ts";
import type { Logger } from "../log/logger.ts";
import type { RunContext } from "../engine/types.ts";
import type { ToolPolicy } from "../agents/definition.ts";
import type { FieldSpec } from "../store/record-fields.ts";

export interface ToolOutput {
  content: string; data?: Json; isError?: boolean; untrusted?: boolean;
  /** Ids of learning items this call opened. Committed with the call's tool.finished record in one fenced transaction. */
  learningOpened?: string[];
  /**
   * The field specification of `data`: which field names are Runwright's own (written as they are) and which
   * values are text or payload. For data this code built and reads back by field name. Default: the whole data
   * is a payload (every string, object key and secret-holding number redacted).
   */
  dataFields?: FieldSpec;
}
export interface ToolContext {
  runId: string; agentId: string;
  /** Absolute path of the run's workspace folder (exists). */
  workspace: string;
  /**
   * Aborted when this call is: its deadline, a pause, a cancel, a forced shutdown or a lost lease (and, for a call
   * made from inside another tool call's `steps`, whenever that enclosing call is aborted).
   */
  signal: AbortSignal;
  logger: Logger;
  /** The secrets handed to this run. */
  secrets: Readonly<Record<string, string>>;
  /**
   * Durable steps scoped under this call's key. Any tool may read `steps.journal()` (the run's records so far;
   * the file tools decide from it whether content is the run's own work); only `resumable` tools may run steps
   * through it. Those steps belong to this call:
   * `steps.signal` is `signal`; once the call is aborted no further step starts (it throws `deadline_exceeded`
   * for a deadline, the control signal otherwise, and journals nothing), and the steps in flight are aborted
   * with the same cause and journalled as if it had hit them directly. This composes to any nesting depth.
   */
  steps: RunContext;
}
/**
 * A handler reports an ordinary failure by returning isError: true or throwing a RunwrightError; both become
 * an error result for the model. It must rethrow control signals and honour context.signal.
 */
export interface ToolDefinition {
  /** /^[a-z][a-z0-9_]{0,63}$/ */
  name: string;
  description: string;
  /** Object schema for the arguments. */
  parameters: JsonSchema;
  effect: "read" | "write";
  /**
   * A write that is safe to repeat. The engine runs such a call again by itself when a crash, a pause or a forced
   * shutdown left it started but unfinished, so the first invocation may already have taken full effect. The
   * promise: invoked again with the same arguments after it already succeeded, the handler returns a result that
   * is not an error and leaves the same end state. A tool that cannot promise this leaves the flag off; its
   * unfinished calls then wait for a person.
   */
  idempotent?: boolean;
  /** Handler is built from durable steps and may be invoked again after a suspend or crash. */
  resumable?: boolean;
  /** Results come from outside the run (web pages, fetched files). */
  untrustedOutput?: boolean;
  /** Used when the agent lists the tool without a policy (default "allow"). */
  defaultPolicy?: ToolPolicy;
  handler(args: JsonObject, context: ToolContext): Promise<ToolOutput>;
}
