export interface Handoff<T> {
  /** Deliver to a mounted screen listening on `key`, or keep it for the next screen to take it. */
  give(key: string, value: T): void;
  take(key: string): T | null;
  /** Receive values given to `key` while this screen is mounted; returns an unsubscribe function. */
  listen(key: string, listener: (value: T) => void): () => void;
}

/**
 * Pass a payload (for example a query the AI analyst wrote) to the screen that
 * will show it, whether that screen is already open or about to mount.
 */
export function createHandoff<T>(): Handoff<T> {
  let pending: { key: string; value: T } | null = null;
  const listeners = new Map<(value: T) => void, string>();
  return {
    give(key, value) {
      for (const [listener, k] of listeners) {
        if (k === key) {
          pending = null;
          listener(value);
          return;
        }
      }
      pending = { key, value };
    },
    take(key) {
      if (!pending || pending.key !== key) return null;
      const { value } = pending;
      pending = null;
      return value;
    },
    listen(key, listener) {
      listeners.set(listener, key);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
