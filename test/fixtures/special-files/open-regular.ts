/**
 * `node open-regular.ts <path> <maxBytes>`: calls `openRegularFile` and then `readRegularFile` on `path` and prints
 * `{opened, read}` as one JSON line: `opened` is null or the size, `read` the kind of the RegularRead.
 */
import { openRegularFile, readRegularFile } from "../../../src/core/regular-file.ts";

const [path, maxBytes] = process.argv.slice(2);
if (path === undefined || maxBytes === undefined) throw new Error("usage: open-regular.ts <path> <maxBytes>");
const opened = await openRegularFile(path);
if (opened !== null) await opened.handle.close();
const read = await readRegularFile(path, { maxBytes: Number(maxBytes) });
process.stdout.write(`${JSON.stringify({ opened: opened === null ? null : opened.size, read: read.kind })}\n`);
