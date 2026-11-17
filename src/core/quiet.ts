const SUPPRESSED = "SQLite is an experimental feature";

const original = process.emitWarning.bind(process);

function messageOf(warning: unknown): string {
  if (typeof warning === "string") return warning;
  if (warning instanceof Error) return warning.message;
  return "";
}

process.emitWarning = function emitWarning(warning: string | Error, ...rest: unknown[]): void {
  if (messageOf(warning).includes(SUPPRESSED)) return;
  (original as (warning: string | Error, ...args: unknown[]) => void)(warning, ...rest);
} as typeof process.emitWarning;
