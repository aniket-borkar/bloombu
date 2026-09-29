interface Entry<T> {
  value: T;
  expires: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<Promise<T>>>();

  constructor(private ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = load().catch((err) => {
      this.store.delete(key);
      throw err;
    });
    this.store.set(key, { value, expires: now + this.ttlMs });
    return value;
  }
}
