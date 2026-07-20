// ============================================================================
 // SPC Day-1 categorical outlook for Sales Lead Map.
 // Same NOAA GeoJSON Sky proxies via /api/spc?day=1&type=cat — fetched once,
 // cached ~5 min, then point-in-polygon for every lead (never N+1 HTTP).
 // ============================================================================

import { cached } from "./cache.js";
import { spcLabelAtPoint } from "./geo.js";

const NWS_UA = "PremierSales/1.0 (spc-outlook; +https://premiergroup.com)";
const SPC_TTL_MS = 5 * 60 * 1000;

/** Short codes used in GeoJSON LABEL / DN fields. */
export const SPC_CODE_RANK = {
  TSTM: 1,
  MRGL: 2,
  SLGT: 3,
  ENH: 4,
  MDT: 5,
  HIGH: 6,
};

const CODE_FROM_LABEL = [
  [/HIGH/i, "HIGH"],
  [/\bMDT\b|MODERATE/i, "MDT"],
  [/\bENH\b|ENHANCED/i, "ENH"],
  [/\bSLGT\b|SLIGHT/i, "SLGT"],
  [/\bMRGL\b|MARGINAL/i, "MRGL"],
  [/\bTSTM\b|THUNDERSTORM|GENERAL/i, "TSTM"],
];

export function normalizeSpcCode(label) {
  if (label == null || label === "") return null;
  const raw = String(label).trim();
  const upper = raw.toUpperCase();
  if (SPC_CODE_RANK[upper] != null) return upper;
  for (const [re, code] of CODE_FROM_LABEL) {
    if (re.test(raw)) return code;
  }
  return null;
}

export function spcDisplayLabel(codeOrLabel) {
  const code = normalizeSpcCode(codeOrLabel) || codeOrLabel;
  const map = {
    HIGH: "High Risk",
    MDT: "Moderate Risk",
    ENH: "Enhanced Risk",
    SLGT: "Slight Risk",
    MRGL: "Marginal Risk",
    TSTM: "General Thunderstorm",
  };
  return map[code] || (codeOrLabel ? String(codeOrLabel) : null);
}

/** Sky-aligned categorical points (storm-score.js spcCatPoints). */
export function spcCatPoints(label) {
  const u = String(label || "").toUpperCase();
  if (u.includes("HIGH")) return 25;
  if (u.includes("MDT") || u.includes("MOD")) return 25;
  if (u.includes("ENH")) return 15;
  if (u.includes("SLGT") || u.includes("SLIGHT")) return 10;
  if (u.includes("MRGL") || u.includes("MARGINAL")) return 5;
  return 0;
}

export async function loadSpcCategorical({ day = 1 } = {}) {
  return loadSpcOutlook({ day, type: "cat" });
}

/**
 * Fetch SPC Day 1–3 outlook GeoJSON (cat / hail / torn / wind).
 * Cached 5 min — shared by lead enrichment and Lead Map overlays.
 */
export async function loadSpcOutlook({ day = 1, type = "cat" } = {}) {
  const d = [1, 2, 3].includes(Number(day)) ? Number(day) : 1;
  const t = ["cat", "hail", "torn", "wind"].includes(String(type)) ? String(type) : "cat";
  const key = `storm:spc:${t}:day${d}`;
  return cached(key, SPC_TTL_MS, async () => {
    const url = `https://www.spc.noaa.gov/products/outlook/day${d}otlk_${t}.nolyr.geojson`;
    const res = await fetch(url, {
      headers: { "User-Agent": NWS_UA, Accept: "application/geo+json, application/json" },
    });
    if (!res.ok) throw new Error(`SPC ${t} outlook HTTP ${res.status}`);
    const data = await res.json();
    const features = Array.isArray(data.features) ? data.features : [];
    return {
      day: d,
      outlookType: t,
      type: "FeatureCollection",
      at: new Date().toISOString(),
      featureCount: features.length,
      features,
    };
  });
}

/**
 * SPC risk at a lead pin. Prefer highest-rank polygon when multiple overlap
 * (features are usually ordered general→severe, but we take max rank).
 */
export function spcAtPoint(lat, lng, outlook) {
  if (lat == null || lng == null || !outlook?.features?.length) {
    return { spcCategory: null, spcRisk: null, spcPoints: 0 };
  }
  let best = null;
  let bestRank = 0;
  for (const f of outlook.features) {
    const label = f.properties?.LABEL2 || f.properties?.LABEL || f.properties?.DN;
    const code = normalizeSpcCode(label) || normalizeSpcCode(f.properties?.LABEL);
    if (!code) continue;
    // Fast reject via label-at-point for this single feature
    if (!spcLabelAtPoint(lat, lng, [f])) continue;
    const rank = SPC_CODE_RANK[code] || 0;
    if (rank >= bestRank) {
      bestRank = rank;
      best = { code, label: spcDisplayLabel(code) };
    }
  }
  if (!best) {
    // Fallback: first hit via shared helper (any feature)
    const hit = spcLabelAtPoint(lat, lng, outlook.features);
    if (!hit) return { spcCategory: null, spcRisk: null, spcPoints: 0 };
    const code = normalizeSpcCode(hit);
    return {
      spcCategory: code,
      spcRisk: spcDisplayLabel(code || hit),
      spcPoints: spcCatPoints(hit),
    };
  }
  return {
    spcCategory: best.code,
    spcRisk: best.label,
    spcPoints: spcCatPoints(best.code),
  };
}

/** Compact GeoJSON for the Lead Map overlay (omit huge props). */
export function slimSpcGeoJson(outlook) {
  if (!outlook?.features?.length) return null;
  return {
    type: "FeatureCollection",
    day: outlook.day || 1,
    at: outlook.at || null,
    features: outlook.features.map((f) => ({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        LABEL: f.properties?.LABEL || null,
        LABEL2: f.properties?.LABEL2 || null,
        DN: f.properties?.DN ?? null,
      },
    })),
  };
}
