import { createHash } from "node:crypto";
import { isJsonObject } from "../core/json.ts";
import { dataOf } from "../engine/journal-types.ts";
import type { JournalRecord } from "../store/types.ts";

/** The built-in tools whose journalled `data.sha256` vouches for the bytes they left in a file. */
const WRITING_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

/** Lower-case hex SHA-256 of `bytes`. */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * True when the run's journal shows that the run itself left bytes with the digest `sha256`: a `tool.finished`
 * record that is neither an error nor untrusted and that either is a `write_file` or `edit_file` result whose
 * `data.sha256` is the digest, or carries it as `fullResultSha256` / `fullDataSha256` (a file the engine saved
 * for a trusted result). Any other content (downloaded by `shell` or a host tool, changed behind the tools, or
 * an edit of untrusted content) is not the run's own. The journal is scanned once, up to the first match; nothing
 * is cached, because the journal grows between calls.
 */
export function isTrustedContent(journal: readonly JournalRecord[], sha256: string): boolean {
  for (const record of journal) {
    const finished = dataOf(record, "tool.finished");
    if (finished === null || finished.isError === true || finished.untrusted === true) continue;
    if (finished.fullResultSha256 === sha256 || finished.fullDataSha256 === sha256) return true;
    if (WRITING_TOOLS.has(finished.tool) && isJsonObject(finished.data) && finished.data["sha256"] === sha256) return true;
  }
  return false;
}
