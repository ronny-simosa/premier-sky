// Google Solar API (buildingInsights) — per-building roof intelligence:
// total roof area, segment count, and pitch per segment. The closest thing
// to a Roofr-style measurement available via API.
//
// KEY-GATED: activates automatically when GOOGLE_MAPS_API_KEY is set in .env
// (the Solar API must be enabled on that Google Cloud project). Without the
// key this module is a silent no-op — leads simply don't get a solarRoof.
// Pricing note: buildingInsights calls are billed (~$0.01–0.02/req range) —
// we only call it for the TOP ranked leads and cache for 7 days.

import { fetchJson } from "../lib/http.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { getGoogleMapsApiKey } from "../config.js";

const SQFT_PER_M2 = 10.7639;

export function solarAvailable() {
  return Boolean(getGoogleMapsApiKey());
}

/** Roof stats for the building nearest to lat/lng, or null. */
export async function solarRoofFor(lat, lng) {
  if (!solarAvailable() || lat == null || lng == null) return null;
  const key = `solar:${lat.toFixed(5)}:${lng.toFixed(5)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  try {
    const url =
      `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
      `?location.latitude=${lat}&location.longitude=${lng}` +
      `&requiredQuality=LOW&key=${getGoogleMapsApiKey()}`;
    const d = await fetchJson(url, { timeoutMs: 12000, retries: 1 });
    const sp = d.solarPotential;
    if (!sp?.wholeRoofStats?.areaMeters2) return cacheSet(key, null, 24 * 3600 * 1000);

    const segs = sp.roofSegmentStats || [];
    const pitches = segs.map((s) => s.pitchDegrees || 0);
    const result = {
      areaSqFt: Math.round(sp.wholeRoofStats.areaMeters2 * SQFT_PER_M2),
      segments: segs.length,
      avgPitchDeg: pitches.length
        ? Math.round(pitches.reduce((a, b) => a + b, 0) / pitches.length)
        : null,
      // ≤5° reads as flat/low-slope — the commercial-membrane signal
      flatSharePct: pitches.length
        ? Math.round((pitches.filter((p) => p <= 5).length / pitches.length) * 100)
        : null,
      imageryDate: d.imageryDate
        ? `${d.imageryDate.year}-${String(d.imageryDate.month).padStart(2, "0")}`
        : null,
    };
    return cacheSet(key, result, 7 * 24 * 3600 * 1000);
  } catch {
    // 404 = no coverage for this building; other errors = quota/key issues.
    // Either way: no solar row, pipeline continues.
    return cacheSet(key, null, 3600 * 1000);
  }
}

/** Enrich top records with solarRoof (bounded concurrency, no-op without key). */
export async function enrichWithSolar(records, { concurrency = 4, signal } = {}) {
  if (!solarAvailable()) return;
  const queue = records.filter((r) => r.lat != null);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      if (signal?.aborted) return;
      const rec = queue[idx++];
      rec.solarRoof = await solarRoofFor(rec.lat, rec.lng);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
}
