// Shared ArcGIS REST query helper: envelope-geometry queries with pagination.
// Both DuPage and Cook are ArcGIS servers; only field mapping differs.

import { fetchJson } from "./http.js";

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
      returnGeometry: "false",
      returnCentroid: "true", // FeatureServers honor this; MapServers ignore it
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
