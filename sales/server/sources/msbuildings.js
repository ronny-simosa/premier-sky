// LIVE — Microsoft Building Footprints (AI-detected from aerial imagery,
// nationwide coverage), via the Esri-hosted MSBFP2 FeatureServer. Used to
// enrich DuPage leads with REAL building footprint areas — DuPage county
// publishes no footprint layer, so without this the roof estimate is just
// parcel-area × lot-coverage.
//
// Verified July 2026: layer supports point+distance queries. CAVEAT: its
// Shape__Area attribute is Web Mercator m² (inflated ~1.81× at 41.9°N), so
// we compute true areas from the returned 4326 geometry ourselves.

import { fetchJson } from "../lib/http.js";
import { cacheGet, cacheSet } from "../lib/cache.js";

const ENDPOINT =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query";

const SQFT_PER_M2 = 10.7639;
const M_PER_DEG = 111320;

/** True polygon area (sqft) from a 4326 ring via shoelace + cos(lat) correction. */
function ringAreaSqFt(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const lat0 = ring[0][1];
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const m2 = (Math.abs(a) / 2) * M_PER_DEG * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  return m2 * SQFT_PER_M2;
}

/**
 * Sum of building footprints (sqft) within `radiusMeters` of a point.
 * Returns { totalSqFt, count } or null on failure (caller keeps its estimate).
 */
export async function footprintsNear(lat, lng, radiusMeters) {
  const key = `msbfp:${lat.toFixed(5)}:${lng.toFixed(5)}:${Math.round(radiusMeters)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const params = new URLSearchParams({
    f: "json",
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(Math.round(radiusMeters)),
    units: "esriSRUnit_Meter",
    outFields: "OBJECTID",
    returnGeometry: "true",
    resultRecordCount: "200",
  });

  try {
    const data = await fetchJson(`${ENDPOINT}?${params}`, { timeoutMs: 15000, retries: 1 });
    if (data.error) throw new Error(data.error.message || "MSBFP query error");
    let totalSqFt = 0;
    let count = 0;
    let bestRing = null;
    let bestScore = 0;
    for (const f of data.features || []) {
      const ring = f.geometry?.rings?.[0];
      const sqft = ringAreaSqFt(ring);
      if (sqft > 400) {
        // ignore sheds/noise
        totalSqFt += sqft;
        count++;
        // Primary ring for roof-surface sampling: prefer big AND close to the
        // query point. MS footprints can be positionally sloppy — a far-away
        // "largest" ring may belong to the neighbor's building.
        const cLng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
        const cLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        const distM = Math.hypot(
          (cLat - lat) * 111320,
          (cLng - lng) * 111320 * Math.cos((lat * Math.PI) / 180)
        );
        const score = sqft / (1 + (distM / 50) ** 2);
        if (score > bestScore) {
          bestScore = score;
          bestRing = ring;
        }
      }
    }
    return cacheSet(
      key,
      { totalSqFt: Math.round(totalSqFt), count, largestRing: bestRing },
      24 * 60 * 60 * 1000
    );
  } catch {
    return null; // enrichment is best-effort — caller keeps its estimate
  }
}

/**
 * Enrich parcel records (must have lat/lng + parcelAreaSqFt) with real
 * footprint areas. Mutates records: buildingSqFt, footprintCount,
 * footprintSource = "MS_BUILDINGS". Bounded concurrency.
 */
export async function enrichWithMsFootprints(records, { concurrency = 6 } = {}) {
  const queue = records.filter((r) => r.lat != null && r.lng != null);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const rec = queue[idx++];
      // Search radius ≈ half the parcel's equivalent square side, so we
      // (mostly) capture this parcel's buildings and not the neighbors'.
      const sideFt = Math.sqrt(rec.parcelAreaSqFt || 40000);
      const radiusM = Math.min(Math.max((sideFt / 2) * 0.3048, 30), 220);
      const result = await footprintsNear(rec.lat, rec.lng, radiusM);
      if (result && result.totalSqFt > 0) {
        rec.buildingSqFt = result.totalSqFt;
        rec.footprintCount = result.count;
        rec.footprintSource = "MS_BUILDINGS";
        rec.footprintRing = result.largestRing;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return records;
}
