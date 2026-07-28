export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, { value: V, expiresAt: number, weight: number }>()
  private currentWeight = 0

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxWeight: number = Number.POSITIVE_INFINITY,
    private readonly weightOf: (value: V) => number = () => 1,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer')
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive number')
    if (maxWeight <= 0) throw new RangeError('maxWeight must be a positive number')
  }

  get size(): number {
    return this.entries.size
  }

  get weight(): number {
    return this.currentWeight
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry)
      return undefined
    }

    // Map iteration order is the LRU order. Refresh it on every hit.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    const existing = this.entries.get(key)
    if (existing) this.remove(key, existing)

    const weight = Math.max(0, this.weightOf(value))
    if (!Number.isFinite(weight) || weight > this.maxWeight) return

    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, weight })
    this.currentWeight += weight
    while (this.entries.size > this.maxEntries || this.currentWeight > this.maxWeight) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      const entry = this.entries.get(oldest)
      if (entry) this.remove(oldest, entry)
    }
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.remove(key, entry)
    return true
  }

  clear(): void {
    this.entries.clear()
    this.currentWeight = 0
  }

  private remove(key: K, entry: { weight: number }): void {
    this.entries.delete(key)
    this.currentWeight -= entry.weight
  }
}

export class BoundedAsyncCache<K, V> {
  private readonly cache: BoundedTtlCache<K, V>
  private readonly inFlight = new Map<K, Promise<V>>()

  constructor(
    maxEntries: number,
    ttlMs: number,
    now: () => number = Date.now,
    maxWeight: number = Number.POSITIVE_INFINITY,
    weightOf: (value: V) => number = () => 1,
  ) {
    this.cache = new BoundedTtlCache(maxEntries, ttlMs, now, maxWeight, weightOf)
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
