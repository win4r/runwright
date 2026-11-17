import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Clock } from "../../src/core/clock.ts";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { openSqliteStore } from "../../src/store/sqlite.ts";
import type { Store } from "../../src/store/types.ts";
import { makeTempDir } from "./tmp.ts";

/** A minimal valid agent definition on the scripted model. */
export function testAgentDefinition(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: "Test agent",
    instructions: "Do the job.",
    model: { provider: "scripted", name: "scripted-1", script: { turns: [{ text: "done" }] } },
    tools: [],
    limits: {},
    learning: false,
    ...overrides,
  };
}

/** Opens a SQLite store in a temp directory (or `dir`); the store is closed when the test ends. */
export async function openTestStore(
  t: TestContext,
  options?: { clock?: Clock; dir?: string },
): Promise<{ store: Store; path: string; dir: string }> {
  const dir = options?.dir ?? (await makeTempDir(t, "runwright-store-"));
  const path = join(dir, "runwright.db");
  const store = await openSqliteStore(options?.clock === undefined ? { path } : { path, clock: options.clock });
  t.after(async () => {
    await store.close();
  });
  return { store, path, dir };
}

/**
 * `store` with some members replaced: every other member is the store's own, bound to it. For tests that act
 * between two calls a wrapper makes (a store double that does something "another process" does in between).
 */
export function interceptStore(store: Store, overrides: Partial<Store>): Store {
  return new Proxy(store, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return (overrides as Record<string | symbol, unknown>)[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
