// Minimal in-memory TTL cache. GIS/parcel data changes slowly, so caching
// identical ZIP+radius queries avoids hammering the free public endpoints
// (and rides out DuPage's occasional "Service not started" windows).
// Identical in-flight keys share one promise (no stampede on cold start).

const store = new Map();
const inflight = new Map();

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs = 6 * 60 * 60 * 1000) {
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/** Wrap an async producer with cache-on-success + in-flight coalescing. */
export async function cached(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(producer)
    .then((value) => cacheSet(key, value, ttlMs))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
