/** Polls `probe` until it returns a truthy value (default every 10 ms, 5 s timeout); rejects with `message` on timeout. */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  options?: { timeoutMs?: number; intervalMs?: number; message?: string },
): Promise<NonNullable<T>> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const intervalMs = options?.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<T>;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const base = options?.message ?? `condition not met within ${timeoutMs} ms`;
      const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
      throw new Error(base + suffix);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
