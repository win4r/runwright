#!/usr/bin/env node
import "../src/core/quiet.ts";
const { main, processIo } = await import("../src/cli/main.ts");
process.exitCode = await main(process.argv.slice(2), processIo());
