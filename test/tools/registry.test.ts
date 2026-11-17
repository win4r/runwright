import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry } from "../../src/tools/registry.ts";
import type { ToolDefinition } from "../../src/tools/types.ts";
import { isRunwrightError } from "../../src/core/errors.ts";

function tool(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
    effect: "read",
    handler: async (args) => ({ content: String(args["x"]) }),
    ...overrides,
  };
}

const badRequest = (e: unknown): boolean => isRunwrightError(e) && e.code === "bad_request";

test("registers, gets and lists tools sorted by name", async () => {
  const registry = createToolRegistry([tool("zeta"), tool("alpha")]);
  registry.register(tool("mid_1", { effect: "write", idempotent: true }));
  assert.deepEqual(registry.list().map((t) => t.name), ["alpha", "mid_1", "zeta"]);
  const found = registry.get("alpha");
  assert.ok(found);
  assert.equal(registry.get("missing"), null);
  assert.deepEqual(await found.handler({ x: "hi" }, undefined as never), { content: "hi" });
});

test("rejects bad names, duplicates and bad schemas", () => {
  const registry = createToolRegistry([tool("one")]);
  for (const name of ["", "One", "1x", "a-b", "x".repeat(65)]) assert.throws(() => registry.register(tool(name)), badRequest, name);
  assert.throws(() => registry.register(tool("one")), badRequest);
  assert.throws(() => registry.register(tool("bad_schema", { parameters: { type: "object", properties: { x: { type: "text" } } } })),
    (e: unknown) => badRequest(e) && /properties\.x\.type/.test((e as Error).message));
  assert.throws(() => registry.register(tool("not_object", { parameters: { type: "string" } })), badRequest);
  assert.throws(() => registry.register(tool("bad_effect", { effect: "maybe" as "read" })), badRequest);
  assert.throws(() => createToolRegistry([tool("dup"), tool("dup")]), badRequest);
  assert.deepEqual(registry.list().map((t) => t.name), ["one"]);
});
