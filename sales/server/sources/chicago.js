// LIVE — City of Chicago Data Portal building footprints (Socrata SODA API).
// Dataset syp8-uezg ("Building Footprints"). NOTE: the prototype pointed at
// hz9b-7nh8, which is a derived map view with no data columns — it silently
// returns []. This is the real table, verified July 2026.

import { fetchJson } from "../lib/http.js";
import { cached } from "../lib/cache.js";
import { SOURCES } from "../config.js";
import { MILES_TO_METERS } from "../lib/geo.js";

const FIELDS = [
  "the_geom", // footprint polygon (WGS84) — used for the map centroid
  "bldg_id",
  "bldg_sq_fo",
  "year_built",
  "stories",
  "no_stories",
  "no_of_unit", // NB: queryable column has no trailing "s" (row JSON shows no_of_units, SoQL rejects it)
  "f_add1",
  "pre_dir1",
  "st_name1",
  "st_type1",
  "bldg_name1",
  "bldg_statu",
  "x_coord",
  "y_coord",
].join(",");

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildAddress(row) {
  const parts = [row.f_add1, row.pre_dir1, row.st_name1, row.st_type1].filter(Boolean);
  return parts.length ? `${parts.join(" ")}, Chicago, IL` : null;
}

// the_geom is GeoJSON MultiPolygon (WGS84) — centroid of the outer ring.
function centroidOf(geom) {
  const ring = geom?.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || !ring.length) return [null, null];
  let sLng = 0;
  let sLat = 0;
  for (const p of ring) {
    sLng += p[0];
    sLat += p[1];
  }
  return [sLat / ring.length, sLng / ring.length];
}

/**
 * Returns normalized footprint records:
 * { source, sourceId, address, buildingSqFt, yearBuilt, stories, units,
 *   buildingName, lat, lng }
 */
export async function searchChicago(lat, lng, radiusMiles) {
  const meters = Math.round(radiusMiles * MILES_TO_METERS);
  const key = `chicago:${lat.toFixed(4)}:${lng.toFixed(4)}:${meters}`;

  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const url =
      `${SOURCES.CHICAGO.endpoint}?$select=${encodeURIComponent(FIELDS)}` +
      `&$where=${encodeURIComponent(`within_circle(the_geom,${lat},${lng},${meters})`)}` +
      `&$limit=5000`;
    const rows = await fetchJson(url, { timeoutMs: 25000 });

    const records = rows.map((r) => {
      const [lat, lng] = centroidOf(r.the_geom);
      return {
        source: SOURCES.CHICAGO.key,
        sourceId: r.bldg_id || null,
        address: buildAddress(r),
        buildingSqFt: toNumber(r.bldg_sq_fo),
        yearBuilt: toNumber(r.year_built),
        stories: toNumber(r.stories) || toNumber(r.no_stories),
        units: toNumber(r.no_of_unit ?? r.no_of_units),
        buildingName: r.bldg_name1 || null,
        lat,
        lng,
      };
    });

    return { sourceMeta: SOURCES.CHICAGO, records, live: true };
  });
}
