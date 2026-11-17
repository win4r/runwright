/**
 * `npm run bench [-- --quick]`: runs the benchmark and prints the report as one JSON document on stdout.
 * Progress lines and any error go to stderr; the exit code is 1 when a measurement fails.
 */
import { runBench } from "./bench.ts";

try {
  const report = await runBench({
    quick: process.argv.includes("--quick"),
    progress: (line) => process.stderr.write(`bench: ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`bench failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
}
