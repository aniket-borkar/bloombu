/** Debounce edits while keeping writes in order; flush before leaving an editor. */
export function createAutosave<T>(save: (value: T) => Promise<void>, delayMs = 800) {
  let pending: { value: T; revision: number } | null = null;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writes: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const write = writes.then(async () => {
      const draft = pending;
      if (!draft) return;
      pending = null;
      try {
        await save(draft.value);
      } catch (e) {
        // Keep the latest failed draft available for an explicit retry or flush.
        if (revision === draft.revision && pending === null) pending = draft;
        throw e;
      }
    });
    // A failed request must not block later edits from being saved.
    writes = write.catch(() => {});
    return write;
  };

  return {
    schedule(value: T): void {
      pending = { value, revision: ++revision };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush().catch(() => {}), delayMs);
    },
    flush,
  };
}
