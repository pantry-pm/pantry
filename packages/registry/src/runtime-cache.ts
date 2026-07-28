export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, { value: V, expiresAt: number }>()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer')
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive number')
  }

  get size(): number {
    return this.entries.size
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }

    // Map iteration order is the LRU order. Refresh it on every hit.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

export class BoundedAsyncCache<K, V> {
  private readonly cache: BoundedTtlCache<K, V>
  private readonly inFlight = new Map<K, Promise<V>>()

  constructor(maxEntries: number, ttlMs: number, now: () => number = Date.now) {
    this.cache = new BoundedTtlCache(maxEntries, ttlMs, now)
  }

  get size(): number {
    return this.cache.size
  }

  async getOrCreate(key: K, load: () => Promise<V>): Promise<V> {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    const pending = this.inFlight.get(key)
    if (pending) return pending

    const created = load()
      .then((value) => {
        this.cache.set(key, value)
        return value
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, created)
    return created
  }

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
  }
}
