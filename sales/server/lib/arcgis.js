// Shared ArcGIS REST query helper: envelope-geometry queries with pagination.
// Both DuPage and Cook are ArcGIS servers; only field mapping differs.

import { fetchJson } from "./http.js";

/** Centroid from ArcGIS geometry (point / polygon / multipoint) in outSR 4326. */
function centroidFromGeometry(geom) {
  if (!geom) return null;
  if (typeof geom.x === "number" && typeof geom.y === "number") {
    return { lng: geom.x, lat: geom.y };
  }
  const rings =
    geom.rings ||
    (Array.isArray(geom.points) ? [geom.points] : null) ||
    null;
  if (!rings || !rings.length) return null;
  let n = 0;
  let sLng = 0;
  let sLat = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const lng = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      sLng += lng;
      sLat += lat;
      n += 1;
    }
  }
  if (!n) return null;
  return { lng: sLng / n, lat: sLat / n };
}

/**
 * Query an ArcGIS layer with an envelope, paging through results.
 *  - endpoint: full .../query URL
 *  - envelope: from radiusToEnvelope()
 *  - outFields: array of field names (or ["*"])
 *  - maxRecords: safety cap across all pages
 * Returns { features: [...attribute objects + optional centroid], exceededCap }
 */
export async function queryEnvelope(endpoint, envelope, outFields, opts = {}) {
  const { pageSize = 1000, maxRecords = 5000, timeoutMs = 20000, retries = 2 } = opts;
  const features = [];
  let offset = 0;
  let exceededCap = false;

  while (true) {
    const params = new URLSearchParams({
      f: "json",
      geometry: JSON.stringify(envelope),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: outFields.join(","),
      // FeatureServers return centroid; MapServers often ignore it — keep
      // geometry as a fallback so we can still place markers on the map.
      returnGeometry: "true",
      returnCentroid: "true",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    const data = await fetchJson(`${endpoint}?${params}`, { timeoutMs, retries });
    if (data.error) {
      throw new Error(
        `ArcGIS query error ${data.error.code || ""}: ${data.error.message || "unknown"}`
      );
    }
    const page = data.features || [];
    for (const f of page) {
      const rec = { ...f.attributes };
      if (f.centroid) {
        rec._centroidLng = f.centroid.x;
        rec._centroidLat = f.centroid.y;
      } else {
        const c = centroidFromGeometry(f.geometry);
        if (c) {
          rec._centroidLng = c.lng;
          rec._centroidLat = c.lat;
        }
      }
      features.push(rec);
    }
    offset += page.length;
    if (features.length >= maxRecords) {
      exceededCap = true;
      break;
    }
    const more = data.exceededTransferLimit || page.length === pageSize;
    if (!more || page.length === 0) break;
  }

  return { features: features.slice(0, maxRecords), exceededCap };
}
