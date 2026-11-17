export interface EphemeralEvent { runId: string; type: "model.delta"; key: string; text: string }

export interface EphemeralEvents {
  publish(event: EphemeralEvent): void;
  subscribe(runId: string, listener: (event: EphemeralEvent) => void): () => void;
}

export function createEphemeralEvents(): EphemeralEvents {
  const listeners = new Map<string, Set<(event: EphemeralEvent) => void>>();
  return {
    publish(event: EphemeralEvent): void {
      const set = listeners.get(event.runId);
      if (set === undefined) return;
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must not affect the publisher or other subscribers.
        }
      }
    },
    subscribe(runId: string, listener: (event: EphemeralEvent) => void): () => void {
      let set = listeners.get(runId);
      if (set === undefined) {
        set = new Set();
        listeners.set(runId, set);
      }
      const wrapped = (event: EphemeralEvent): void => listener(event);
      set.add(wrapped);
      return () => {
        const current = listeners.get(runId);
        if (current === undefined) return;
        current.delete(wrapped);
        if (current.size === 0) listeners.delete(runId);
      };
    },
  };
}
