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
