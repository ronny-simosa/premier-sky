// Geometry helpers for radius searches against GIS endpoints.

export const MILES_TO_METERS = 1609.34;

/**
 * Bounding envelope (WGS84 degrees) for a center + radius.
 * Used for ArcGIS envelope queries — DuPage's server silently returns 0
 * features for point+distance queries, so we buffer client-side instead.
 */
export function radiusToEnvelope(lat, lng, radiusMiles) {
  const meters = radiusMiles * MILES_TO_METERS;
  const latDelta = meters / 111320;
  const lngDelta = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    xmin: lng - lngDelta,
    ymin: lat - latDelta,
    xmax: lng + lngDelta,
    ymax: lat + latDelta,
    spatialReference: { wkid: 4326 },
  };
}

/** Great-circle distance in miles (haversine). */
export function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// --- Point-in-polygon (SPC outlook / NWS polygons; same rules as Sky geo-utils) ---

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    const hit = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng, lat, rings) {
  if (!rings.length || !pointInRing(lng, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(lng, lat, rings[k])) return false;
  }
  return true;
}

/** True if WGS84 (lng, lat) falls inside a GeoJSON Polygon / MultiPolygon. */
export function pointInGeometry(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInPolygon(lng, lat, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
  }
  return false;
}

/** First matching SPC/NWS feature label at a point (LABEL2 → LABEL → DN). */
export function spcLabelAtPoint(lat, lng, features) {
  for (const f of features || []) {
    if (f.geometry && pointInGeometry(lng, lat, f.geometry)) {
      return f.properties?.LABEL2 || f.properties?.LABEL || f.properties?.DN || null;
    }
  }
  return null;
}

/**
 * Filter records (each with .lat/.lng, possibly null) from an envelope query
 * down to the true circle. Records without coordinates are kept — better to
 * over-include a corner parcel than silently drop data.
 */
export function filterToRadius(records, lat, lng, radiusMiles) {
  return records.filter((r) => {
    if (r.lat == null || r.lng == null) return true;
    r.distanceMiles = Math.round(distanceMiles(lat, lng, r.lat, r.lng) * 10) / 10;
    return r.distanceMiles <= radiusMiles;
  });
}
