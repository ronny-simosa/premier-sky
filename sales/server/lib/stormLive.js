// ============================================================================
// LIVE storm intelligence for Premier Sales leads.
// Sources (all cached, never N+1 per lead):
//   1) Iowa State IEM Local Storm Reports — hail/wind/tornado proximity (Phase B)
//   2) NOAA SPC Day-1 categorical outlook — polygon risk at the pin
//   3) SPC today reports → Sky-style storm-score hotspots (lite, no JobNimbus)
//
// LSR risk thresholds (nearest report within radiusMiles, lookbackDays):
//   Severe   — tornado, hail ≥ 1.75", or wind ≥ 75 mph
//   High     — hail ≥ 1.25", wind ≥ 65 mph, or ≥ 3 qualifying reports
//   Moderate — hail ≥ 0.75" or wind ≥ 58 mph (NWS severe-wind floor)
//   Low      — weaker hail (≥ 0.5") / wind (≥ 50 mph) only
//   Low+[]   — no qualifying reports (empty history; UI chip stays "Low")
//
// Priority floors (applied in mergeLead after Lead Value Score):
//   Hot  — Severe LSR | SPC MDT/HIGH | storm-score ≥ 70 |
//          (High LSR + SPC ≥ ENH) | (High LSR + storm-score ≥ 40)
//   Warm — High LSR | SPC SLGT/ENH | storm-score ≥ 40 |
//          (Moderate LSR + SPC ≥ SLGT)
//   Note: High + regional SLGT alone stays Warm so outlook polygons don't
//   paint every High-LSR lead identical Hot.
// ============================================================================

import { cached, cacheGet, cacheSet } from "./cache.js";
import { distanceMiles } from "./geo.js";
import { loadSpcCategorical, spcAtPoint, slimSpcGeoJson } from "./spcOutlook.js";
import { loadStormScoreHotspots, stormScoreAtPoint } from "./stormScoreLite.js";

const NWS_UA = "PremierSales/1.0 (storm-proximity; +https://premiergroup.com)";
const LOOKBACK_DAYS_DEFAULT = 730; // ~24 months — matches Lead Value Score "recent"
const CHUNK_DAYS = 90;
const REPORTS_TTL_MS = 6 * 60 * 60 * 1000; // 6h state LSR cache
const PROBE_TTL_MS = 15 * 60 * 1000;
const POINT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RADIUS_MI = 5;
const MAX_EVENTS = 8;

/** Default proximity radius (mi) for "property affected by storm". */
export const STORM_PROXIMITY_MI = DEFAULT_RADIUS_MI;

let probeState = { ok: null, at: 0, error: null, reportCount: null, spcOk: null, scoreOk: null };

function fmtIem(d) {
  return d.toISOString().slice(0, 16) + "Z";
}

function chunkWindows(lookbackDays) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const windows = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 86400000, end.getTime()));
    windows.push({ sts: fmtIem(cursor), ets: fmtIem(next) });
    cursor = next;
  }
  return windows;
}

function parseMagnitude(raw, kind) {
  let n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // IEM sometimes encodes hail as hundredths of an inch (e.g. 175 → 1.75).
  if (kind === "Hail" && n > 10) n /= 100;
  return n;
}

function classifyLsr(props) {
  const raw = `${props.typetext || props.type || ""} ${props.remark || ""}`.toUpperCase();
  if (/\bTORN/.test(raw)) return "Tornado";
  if (/\bHAIL\b/.test(raw)) return "Hail";
  if (/\bWND\b|\bWIND\b/.test(raw)) return "Wind";
  return null;
}

function normalizeFeature(f) {
  const props = f.properties || {};
  const coords = f.geometry?.coordinates || [];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const type = classifyLsr(props);
  if (!type) return null;
  let mag = parseMagnitude(props.magnitude, type);
  if (!mag && type === "Wind") {
    const m = String(props.remark || "").match(/(\d+)\s*mph/i);
    if (m) mag = parseInt(m[1], 10);
  }
  if (!mag && type === "Hail") {
    const m = String(props.remark || "").match(/(\d+(?:\.\d+)?)\s*(?:in|inch)/i);
    if (m) mag = parseFloat(m[1]);
  }
  // Drop noise: tiny hail / non-severe wind unless tornado.
  if (type === "Hail" && mag > 0 && mag < 0.5) return null;
  if (type === "Wind" && mag > 0 && mag < 50) return null;
  const valid = props.valid || props.utc_valid || "";
  const date = String(valid).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    lat,
    lng: lon,
    type,
    mag,
    date,
    valid,
    city: props.city || props.county || "",
    remark: (props.remark || "").trim(),
  };
}

async function fetchLsrWindow(state, sts, ets) {
  const qs = `sts=${encodeURIComponent(sts)}&ets=${encodeURIComponent(ets)}&states=${encodeURIComponent(state)}`;
  const url = `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?${qs}`;
  const res = await fetch(url, {
    headers: { "User-Agent": NWS_UA, Accept: "application/geojson, application/json" },
  });
  if (!res.ok) throw new Error(`IEM LSR HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const f of data.features || []) {
    const row = normalizeFeature(f);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Load hail/wind/tornado LSRs for a state over lookbackDays.
 * Chunked + cached — safe to call once per ZIP search for ~60 leads.
 */
export async function loadStormReports({ state = "IL", lookbackDays = LOOKBACK_DAYS_DEFAULT } = {}) {
  const st =
    String(state || "IL")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "IL";
  const days = Math.min(Math.max(Number(lookbackDays) || LOOKBACK_DAYS_DEFAULT, 30), 900);
  const key = `storm:lsr:${st}:${days}`;

  return cached(key, REPORTS_TTL_MS, async () => {
    const windows = chunkWindows(days);
    let failures = 0;
    const batches = await Promise.all(
      windows.map(async (w) => {
        try {
          return await fetchLsrWindow(st, w.sts, w.ets);
        } catch (e) {
          failures += 1;
          console.warn(`[stormLive] LSR chunk ${st} ${w.sts}→${w.ets}: ${e.message}`);
          return [];
        }
      })
    );
    if (failures === windows.length) {
      throw new Error(`IEM LSR unavailable (${failures}/${windows.length} chunks failed)`);
    }
    const merged = batches.flat();
    const seen = new Set();
    const unique = [];
    for (const r of merged) {
      const k = `${r.date}|${r.type}|${r.lat.toFixed(3)}|${r.lng.toFixed(3)}|${r.mag}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }
    probeState = { ok: true, at: Date.now(), error: null, reportCount: unique.length };
    return unique;
  });
}

function eventDetail(r, distMi) {
  const dist = distMi.toFixed(1);
  if (r.type === "Hail") {
    const size = r.mag ? `${r.mag}" hail` : "hail";
    return `${size} reported ${dist} mi away${r.city ? ` (${r.city})` : ""}`;
  }
  if (r.type === "Wind") {
    const spd = r.mag ? `${Math.round(r.mag)} mph wind` : "thunderstorm wind";
    return `${spd} reported ${dist} mi away${r.city ? ` (${r.city})` : ""}`;
  }
  return `Tornado report ${dist} mi away${r.city ? ` (${r.city})` : ""}${
    r.remark ? ` — ${r.remark.slice(0, 80)}` : ""
  }`;
}

function riskFromNearby(nearby) {
  if (!nearby.length) return "Low";

  let maxHail = 0;
  let maxWind = 0;
  let tornado = false;
  for (const r of nearby) {
    if (r.type === "Tornado") tornado = true;
    if (r.type === "Hail") maxHail = Math.max(maxHail, r.mag || 0);
    if (r.type === "Wind") maxWind = Math.max(maxWind, r.mag || 0);
  }

  if (tornado || maxHail >= 1.75 || maxWind >= 75) return "Severe";
  if (maxHail >= 1.25 || maxWind >= 65 || nearby.length >= 3) return "High";
  if (maxHail >= 0.75 || maxWind >= 58) return "Moderate";
  return "Low";
}

function syncPointCache(key, produce) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  return cacheSet(key, produce(), POINT_TTL_MS);
}

/**
 * Filter cached reports to a point and return SAMPLE_LEADS-shaped storm payload.
 */
export function stormAtPoint(lat, lng, reports, radiusMiles = DEFAULT_RADIUS_MI) {
  if (lat == null || lng == null || !Array.isArray(reports)) {
    return {
      stub: false,
      live: true,
      events: [],
      hailWindRisk: "Low",
      nearbyCount: 0,
      spcCategory: null,
      spcRisk: null,
      stormScoreNearby: null,
    };
  }
  const radius = Math.min(Math.max(Number(radiusMiles) || DEFAULT_RADIUS_MI, 1), 25);
  const nearby = [];
  for (const r of reports) {
    const d = distanceMiles(lat, lng, r.lat, r.lng);
    if (d <= radius) nearby.push({ ...r, distanceMiles: d });
  }
  nearby.sort((a, b) => {
    const tb = new Date(b.date).getTime() - new Date(a.date).getTime();
    if (tb !== 0) return tb;
    return a.distanceMiles - b.distanceMiles;
  });

  const events = nearby.slice(0, MAX_EVENTS).map((r) => ({
    date: r.date,
    type: r.type === "Tornado" ? "Tornado" : r.type,
    detail: eventDetail(r, r.distanceMiles),
    distanceMiles: Math.round(r.distanceMiles * 10) / 10,
    magnitude: r.mag || null,
  }));

  return {
    stub: false,
    live: true,
    events,
    hailWindRisk: riskFromNearby(nearby),
    nearbyCount: nearby.length,
    spcCategory: null,
    spcRisk: null,
    stormScoreNearby: null,
  };
}

/** Rounded lat/lng point cache — avoids repeat haversine work across rebuilds. */
export function stormAtPointCached(lat, lng, reports, radiusMiles = DEFAULT_RADIUS_MI) {
  if (lat == null || lng == null) return stormAtPoint(lat, lng, reports, radiusMiles);
  const key = `storm:pt:${Number(lat).toFixed(3)}:${Number(lng).toFixed(3)}:${radiusMiles}`;
  return syncPointCache(key, () => stormAtPoint(lat, lng, reports, radiusMiles));
}

/**
 * Drop-in replacement for stubs/storm.getStormHistory.
 * Falls back to the stub module only when the live fetch fails entirely.
 */
export async function getStormHistory(lat, lng, radiusMiles = DEFAULT_RADIUS_MI, opts = {}) {
  const state = opts.state || "IL";
  const lookbackDays = opts.lookbackDays || LOOKBACK_DAYS_DEFAULT;
  try {
    const reports = await loadStormReports({ state, lookbackDays });
    return stormAtPointCached(lat, lng, reports, radiusMiles ?? DEFAULT_RADIUS_MI);
  } catch (e) {
    probeState = { ok: false, at: Date.now(), error: e.message, reportCount: null };
    const { getStormHistory: stub } = await import("../stubs/storm.js");
    const fallback = await stub(lat, lng, radiusMiles);
    return { ...fallback, stub: true, live: false, error: e.message };
  }
}

/**
 * One LSR + SPC + storm-score load + per-lead resolver for the merge pipeline.
 * All feeds are fetched once per batch; stormFor() is pure/cached point work.
 */
export async function createStormResolver({
  state = "IL",
  radiusMiles = DEFAULT_RADIUS_MI,
  lookbackDays = LOOKBACK_DAYS_DEFAULT,
} = {}) {
  const radius = radiusMiles ?? DEFAULT_RADIUS_MI;
  let reports = null;
  let lsrError = null;
  let spcOutlook = null;
  let spcError = null;
  let scorePack = null;
  let scoreError = null;

  const [lsrResult, spcResult] = await Promise.all([
    loadStormReports({ state, lookbackDays })
      .then((r) => ({ ok: true, reports: r }))
      .catch((e) => ({ ok: false, error: e })),
    loadSpcCategorical({ day: 1 })
      .then((o) => ({ ok: true, outlook: o }))
      .catch((e) => ({ ok: false, error: e })),
  ]);

  if (lsrResult.ok) {
    reports = lsrResult.reports;
  } else {
    lsrError = lsrResult.error;
    probeState = {
      ...probeState,
      ok: false,
      at: Date.now(),
      error: lsrResult.error.message,
      reportCount: null,
    };
  }

  if (spcResult.ok) {
    spcOutlook = spcResult.outlook;
    probeState = { ...probeState, spcOk: true, at: Date.now() };
  } else {
    spcError = spcResult.error;
    probeState = { ...probeState, spcOk: false, at: Date.now() };
    console.warn(`[stormLive] SPC outlook unavailable: ${spcResult.error.message}`);
  }

  try {
    scorePack = await loadStormScoreHotspots({ state, spcOutlook });
    probeState = { ...probeState, scoreOk: true, at: Date.now() };
  } catch (e) {
    scoreError = e;
    probeState = { ...probeState, scoreOk: false, at: Date.now() };
    console.warn(`[stormLive] storm-score lite unavailable: ${e.message}`);
  }

  const enrichPoint = (lat, lng, base) => {
    const spc = spcOutlook ? spcAtPoint(lat, lng, spcOutlook) : { spcCategory: null, spcRisk: null };
    const nearby = scorePack ? stormScoreAtPoint(lat, lng, scorePack) : null;
    return {
      ...base,
      spcCategory: spc.spcCategory,
      spcRisk: spc.spcRisk,
      stormScoreNearby: nearby,
      sources: {
        lsr: Boolean(reports) && !base.stub,
        spc: Boolean(spcOutlook),
        stormScore: Boolean(scorePack),
      },
    };
  };

  if (!reports) {
    const { getStormHistory: stub } = await import("../stubs/storm.js");
    const storm = await stub(null, null, radiusMiles);
    const stubEnriched = enrichPoint(null, null, { ...storm, stub: true, live: false, error: lsrError?.message });
    return {
      stub: true,
      live: false,
      storm: stubEnriched,
      error: lsrError?.message,
      spcLive: Boolean(spcOutlook),
      stormScoreLive: Boolean(scorePack),
      spcOutlook: slimSpcGeoJson(spcOutlook),
      stormScoreMeta: scorePack
        ? { zone: scorePack.zone, hotspotCount: scorePack.hotspotCount, at: scorePack.at }
        : null,
      // Still expose SPC/score when LSR stubbed — pins with coords get intel.
      stormFor: (lat, lng) => {
        const base = { ...storm, stub: true, live: false, events: storm.events || [], hailWindRisk: storm.hailWindRisk || "Low" };
        return enrichPoint(lat, lng, base);
      },
    };
  }

  return {
    stub: false,
    live: true,
    reportCount: reports.length,
    spcLive: Boolean(spcOutlook),
    stormScoreLive: Boolean(scorePack),
    spcError: spcError?.message || null,
    stormScoreError: scoreError?.message || null,
    spcOutlook: slimSpcGeoJson(spcOutlook),
    stormScoreMeta: scorePack
      ? {
          zone: scorePack.zone,
          hotspotCount: scorePack.hotspotCount,
          reportCounts: scorePack.reportCounts,
          at: scorePack.at,
        }
      : null,
    stormFor: (lat, lng) => {
      const key = `storm:intel:${Number(lat).toFixed(3)}:${Number(lng).toFixed(3)}:${radius}`;
      return syncPointCache(key, () => {
        const lsr = stormAtPoint(lat, lng, reports, radius);
        return enrichPoint(lat, lng, lsr);
      });
    },
  };
}

/** Lightweight availability probe for /api/status (cached ~15 min). */
export async function isStormProviderLive() {
  if (probeState.ok === true && Date.now() - probeState.at < PROBE_TTL_MS) return true;
  if (probeState.ok === false && Date.now() - probeState.at < PROBE_TTL_MS) return false;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 86400000);
    const rows = await fetchLsrWindow("IL", fmtIem(start), fmtIem(end));
    probeState = { ...probeState, ok: true, at: Date.now(), error: null, reportCount: rows.length };
    return true;
  } catch (e) {
    probeState = { ...probeState, ok: false, at: Date.now(), error: e.message, reportCount: null };
    return false;
  }
}

/** True when LSR is live OR SPC/storm-score path is serving (don't re-stub). */
export async function isStormIntelLive() {
  const lsr = await isStormProviderLive();
  if (lsr) return true;
  if (probeState.spcOk === true || probeState.scoreOk === true) return true;
  try {
    await loadSpcCategorical({ day: 1 });
    probeState = { ...probeState, spcOk: true, at: Date.now() };
    return true;
  } catch {
    return false;
  }
}

export function getStormProviderStatus() {
  return {
    live: probeState.ok === true,
    probed: probeState.ok != null,
    at: probeState.at || null,
    error: probeState.error,
    reportCount: probeState.reportCount,
    spcLive: probeState.spcOk === true,
    stormScoreLive: probeState.scoreOk === true,
  };
}
