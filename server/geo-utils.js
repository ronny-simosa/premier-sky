// Utilidades geográficas compartidas (servidor)
export function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
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

export function pointInGeometry(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInPolygon(lng, lat, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
  }
  return false;
}

export function geometryCentroid(geom) {
  if (!geom) return null;
  const pts = [];
  const collect = (ring) => {
    for (const [lng, lat] of ring) pts.push({ lat, lon: lng });
  };
  if (geom.type === "Polygon") geom.coordinates.forEach(collect);
  else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) poly.forEach(collect);
  }
  if (!pts.length) return null;
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length
  };
}

export function spcLabelAtPoint(lat, lon, features) {
  for (const f of features || []) {
    if (f.geometry && pointInGeometry(lon, lat, f.geometry)) {
      return f.properties?.LABEL2 || f.properties?.LABEL || f.properties?.DN || null;
    }
  }
  return null;
}
