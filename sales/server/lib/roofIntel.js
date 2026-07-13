// ============================================================================
// ROOF INTEL — satellite roof-surface classification (the "Roofr-lite" layer).
// Samples Esri World Imagery pixels INSIDE the building footprint polygon
// (Microsoft footprint ring when available, else a circle around the
// centroid) and classifies the roof surface by color/brightness:
//   - bright/white   → reflective membrane (TPO/PVC) or fresh coating
//   - dark           → EPDM / built-up roof, likely aging
//   - mid/gray mixed → metal, gravel/ballast, or weathered membrane
//
// HONESTY: this is a sales-prioritization signal, not an inspection. It can
// be fooled by shadows, snow, or stale imagery. Confidence is reported and
// every result is labeled "estimado por satélite". For measurement-grade
// data before a proposal: EagleView/Roofr/drone — by design not replaced.
// ============================================================================

import jpeg from "jpeg-js";
import { HttpError } from "./http.js";
import { cacheGet, cacheSet } from "./cache.js";

const TILE_URL = (z, y, x) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const ZOOM = 19;
const TILE_SIZE = 256;

// --- Web Mercator tile math --------------------------------------------------
function toTilePixel(lat, lng, z) {
  const n = 2 ** z;
  const xf = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    tileX: Math.floor(xf),
    tileY: Math.floor(yf),
    px: Math.floor((xf % 1) * TILE_SIZE),
    py: Math.floor((yf % 1) * TILE_SIZE),
  };
}

async function fetchTile(z, y, x) {
  const key = `tile:${z}:${y}:${x}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const res = await fetch(TILE_URL(z, y, x), { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new HttpError(`tile ${res.status}`, { status: res.status });
  const buf = Buffer.from(await res.arrayBuffer());
  const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 });
  return cacheSet(key, decoded, 24 * 60 * 60 * 1000);
}

// --- Sampling ---------------------------------------------------------------
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Up to `max` sample points inside the ring (grid over its bbox). */
function samplePoints(ring, max = 60) {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  const grid = Math.ceil(Math.sqrt(max * 2));
  const pts = [];
  for (let i = 1; i < grid && pts.length < max; i++) {
    for (let j = 1; j < grid && pts.length < max; j++) {
      const lng = minLng + ((maxLng - minLng) * i) / grid;
      const lat = minLat + ((maxLat - minLat) * j) / grid;
      if (pointInRing(lng, lat, ring)) pts.push([lng, lat]);
    }
  }
  return pts;
}

/** Circle fallback when no footprint ring exists (Chicago/Cook records). */
function circleRing(lat, lng, radiusFt) {
  const rDegLat = (radiusFt * 0.3048) / 111320;
  const rDegLng = rDegLat / Math.cos((lat * Math.PI) / 180);
  const ring = [];
  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180;
    ring.push([lng + rDegLng * Math.cos(rad), lat + rDegLat * Math.sin(rad)]);
  }
  ring.push(ring[0]);
  return ring;
}

// --- Classification -----------------------------------------------------------
// Vegetation guard: MS footprints can be offset — if the samples look like
// grass/trees (green-dominant), we are NOT on a roof. Returning null beats
// confidently misclassifying a lawn as "dark membrane".
function isVegetation(p) {
  return p.g > p.b + 22 && p.g >= p.r - 8;
}

function classify(allPixels) {
  const veg = allPixels.filter(isVegetation).length / allPixels.length;
  if (veg > 0.45) return null; // sampling mostly landscape — footprint offset likely
  const pixels = allPixels.filter((p) => !isVegetation(p));
  if (pixels.length < 10) return null;
  const n = pixels.length;
  const mean = pixels.reduce((s, p) => s + (p.r + p.g + p.b) / 3, 0) / n;
  const variance = pixels.reduce((s, p) => s + ((p.r + p.g + p.b) / 3 - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const brightShare = pixels.filter((p) => (p.r + p.g + p.b) / 3 >= 170).length / n;
  const darkShare = pixels.filter((p) => (p.r + p.g + p.b) / 3 <= 95).length / n;

  let label;
  if (brightShare >= 0.6)
    label = "Reflective white membrane — TPO/PVC or relatively recent coating";
  else if (darkShare >= 0.55) label = "Dark membrane — likely EPDM/BUR, aging candidate";
  else if (std > 55) label = "Mixed surface — gravel/ballast, RTU equipment, or distinct sections";
  else label = "Gray surface — metal, aged membrane, or worn coating";

  const confidence = n >= 30 && std < 70 && veg < 0.15 ? "medium" : "low";
  return {
    label,
    confidence,
    brightness: Math.round(mean),
    brightSharePct: Math.round(brightShare * 100),
    samples: n,
    vegetationSharePct: Math.round(veg * 100),
  };
}

/**
 * analyzeRoofSurface({ ring?, lat, lng, roofSqFt? }) → classification or null.
 * Best-effort: any failure returns null and the lead simply has no surface row.
 */
export async function analyzeRoofSurface({ ring, lat, lng, roofSqFt }) {
  try {
    const poly =
      ring && ring.length >= 4
        ? ring
        : lat != null
          ? circleRing(lat, lng, Math.min(Math.sqrt(roofSqFt || 10000) / 2, 150))
          : null;
    if (!poly) return null;

    const cacheKey = `roofintel:${poly[0][0].toFixed(5)}:${poly[0][1].toFixed(5)}:${poly.length}`;
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) return hit;

    const pts = samplePoints(poly);
    if (pts.length < 8) return null;

    const byTile = new Map();
    for (const [plng, plat] of pts) {
      const t = toTilePixel(plat, plng, ZOOM);
      const k = `${t.tileX}:${t.tileY}`;
      if (!byTile.has(k)) byTile.set(k, []);
      byTile.get(k).push(t);
    }

    const pixels = [];
    for (const [k, tilePts] of byTile) {
      const [x, y] = k.split(":").map(Number);
      let tile;
      try {
        tile = await fetchTile(ZOOM, y, x);
      } catch {
        continue; // missing tile — classify with what we have
      }
      for (const t of tilePts) {
        const idx = (t.py * tile.width + t.px) * 4;
        pixels.push({ r: tile.data[idx], g: tile.data[idx + 1], b: tile.data[idx + 2] });
      }
    }
    if (pixels.length < 8) return null;

    return cacheSet(cacheKey, classify(pixels), 24 * 60 * 60 * 1000);
  } catch {
    return null;
  }
}
