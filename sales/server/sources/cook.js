// Cook County — "Suburban Building Footprints, 2008" (ArcGIS MapServer).
// Real endpoint resolved from the ArcGIS Hub item API (the Hub page in the
// original brief only showed the dataset landing page). Layer supports
// Query + geoJSON per Hub metadata.
//
// CAVEAT (verified July 2026): gis.cookcountyil.gov was fully unreachable
// (connection timeouts, even on the root page) when tested. Strategy:
//  1. Try the live server with retry.
//  2. Fall back to a local extract (data/cook-footprints.geojson) downloaded
//     once via `npm run fetch-cook-extract`. The data is static 2008 LiDAR,
//     so a local copy is functionally equivalent to live queries.

import { readFileSync, existsSync } from "node:fs";
import { queryEnvelope } from "../lib/arcgis.js";
import { cached } from "../lib/cache.js";
import { radiusToEnvelope, filterToRadius } from "../lib/geo.js";
import { SOURCES, COOK_EXTRACT_PATH } from "../config.js";

const OUT_FIELDS = ["OBJECTID", "Type", "Shape_Area"];

function normalize(attrs, lat, lng) {
  // Live server exposes Shape_Area; Hub GeoJSON extracts expose ShapeSTArea.
  const area = Number(attrs.Shape_Area ?? attrs.ShapeSTArea);
  return {
    source: SOURCES.COOK.key,
    sourceId: attrs.OBJECTID != null ? String(attrs.OBJECTID) : null,
    buildingType: attrs.Type || null,
    // Layer spatial ref is IL State Plane East (ft) → area is sq ft.
    buildingSqFt: Number.isFinite(area) && area > 0 ? Math.round(area) : null,
    address: null, // footprint layer carries no address attributes
    lat,
    lng,
  };
}

async function queryLive(lat, lng, radiusMiles) {
  const envelope = radiusToEnvelope(lat, lng, radiusMiles);
  const { features, exceededCap } = await queryEnvelope(
    SOURCES.COOK.endpoint,
    envelope,
    OUT_FIELDS,
    { maxRecords: 8000, timeoutMs: 25000, retries: 1 }
  );
  const records = features.map((a) =>
    normalize(a, a._centroidLat ?? null, a._centroidLng ?? null)
  );
  return { records: filterToRadius(records, lat, lng, radiusMiles), servedBy: "live" };
}

// Lazy-loaded compacted extract (produced by scripts/fetch-cook-extract.js:
// array of {id, type, sqft, lat, lng}). Loaded once per process — the compact
// form keeps suburban Cook's ~1M footprints at a manageable memory footprint.
let extractCache = null;
function loadExtract() {
  if (extractCache) return extractCache;
  const rows = JSON.parse(readFileSync(COOK_EXTRACT_PATH, "utf8"));
  extractCache = rows.map((r) => ({
    source: SOURCES.COOK.key,
    sourceId: r.id != null ? String(r.id) : null,
    buildingType: r.type || null,
    buildingSqFt: Number.isFinite(r.sqft) && r.sqft > 0 ? r.sqft : null,
    address: null,
    lat: r.lat,
    lng: r.lng,
  }));
  return extractCache;
}

function queryExtract(lat, lng, radiusMiles) {
  const all = loadExtract();
  const env = radiusToEnvelope(lat, lng, radiusMiles);
  const inBox = all.filter(
    (r) =>
      r.lat != null &&
      r.lat >= env.ymin &&
      r.lat <= env.ymax &&
      r.lng >= env.xmin &&
      r.lng <= env.xmax
  );
  return { records: filterToRadius(inBox, lat, lng, radiusMiles), servedBy: "local-extract" };
}

export async function searchCook(lat, lng, radiusMiles) {
  const key = `cook:${lat.toFixed(4)}:${lng.toFixed(4)}:${radiusMiles}`;

  return cached(key, 6 * 60 * 60 * 1000, async () => {
    try {
      const { records, servedBy } = await queryLive(lat, lng, radiusMiles);
      return { sourceMeta: SOURCES.COOK, records, live: true, servedBy, note: null };
    } catch (liveErr) {
      if (existsSync(COOK_EXTRACT_PATH)) {
        const { records, servedBy } = queryExtract(lat, lng, radiusMiles);
        return {
          sourceMeta: SOURCES.COOK,
          records,
          live: true,
          servedBy,
          note: `Live server unreachable (${liveErr.message}) — served from local 2008 extract.`,
        };
      }
      return {
        sourceMeta: SOURCES.COOK,
        records: [],
        live: false,
        servedBy: "none",
        note:
          `Cook County GIS server unreachable (${liveErr.message}) and no local extract found. ` +
          `Run \`npm run fetch-cook-extract\` to enable the offline fallback.`,
      };
    }
  });
}
