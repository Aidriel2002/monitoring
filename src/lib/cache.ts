interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  /** How long after expiry the value may still be served on loader failure. */
  staleMs: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
/** key → earliest next attempt after a loader failure (rate-limit backoff). */
const failUntil = new Map<string, number>();
const FAIL_BACKOFF_MS = 30_000;

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    // Keep expired entries briefly so cacheFetch can serve them on error.
    if (Date.now() >= entry.expiresAt + entry.staleMs) {
      store.delete(key);
    }
    return undefined;
  }
  return entry.value as T;
}

function cacheGetStale<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt + entry.staleMs) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    staleMs: Math.max(ttlMs, 5 * 60_000),
  });
}

export interface CacheFetchResult<T> {
  value: T;
  /** True when the loader did not actually run (stale-on-error serve). */
  stale: boolean;
}

/**
 * Same as cacheFetch but reports stale-on-error serves so callers that
 * track their own freshness timestamps do not mark them as refreshed.
 *
 * Fresh cache hits return stale: false — the value is within TTL.
 */
export async function cacheFetchDetailed<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<CacheFetchResult<T>> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return { value: hit, stale: false };

  const blockedUntil = failUntil.get(key);
  if (blockedUntil && Date.now() < blockedUntil) {
    const stale = cacheGetStale<T>(key);
    if (stale !== undefined) return { value: stale, stale: true };
    throw new Error("Ruijie rate limited — backing off, try again shortly");
  }

  const pending = inflight.get(key);
  if (pending) {
    const value = (await pending) as T;
    return { value, stale: false };
  }

  let loaded = false;
  const promise = loader()
    .then((value) => {
      loaded = true;
      cacheSet(key, value, ttlMs);
      failUntil.delete(key);
      return value;
    })
    .catch((err: unknown) => {
      failUntil.set(key, Date.now() + FAIL_BACKOFF_MS);
      const stale = cacheGetStale<T>(key);
      if (stale !== undefined) return stale;
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  try {
    const value = await promise;
    return { value, stale: !loaded };
  } catch (err) {
    throw err;
  }
}

/**
 * Deduplicates concurrent fetches; caches success.
 * On failure: short backoff, then serve recent stale data if present.
 */
export async function cacheFetch<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const { value } = await cacheFetchDetailed(key, ttlMs, loader);
  return value;
}

export function cacheClear(prefix?: string): void {
  if (!prefix) {
    store.clear();
    failUntil.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  for (const key of failUntil.keys()) {
    if (key.startsWith(prefix)) failUntil.delete(key);
  }
}
