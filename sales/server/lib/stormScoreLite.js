// ============================================================================
// Lightweight storm-score proximity for Sales leads.
// Reuses Sky scoring formulas (hail/wind/SPC points + action tiers) against
// today's SPC storm reports — one cached fetch per zone, then haversine to
// each lead. Does NOT pull JobNimbus / Meta / full monitor pipeline.
//
// stormScoreNearby on a lead when a hotspot is within HOTSPOT_RADIUS_MI and
// the simplified score is ≥ REVIEW_FLOOR (40, same as Sky review tier).
// ============================================================================

import { cached } from "./cache.js";
import { distanceMiles, spcLabelAtPoint } from "./geo.js";
import { spcCatPoints } from "./spcOutlook.js";

const NWS_UA = "PremierSales/1.0 (storm-score-lite; +https://premiergroup.com)";
const REPORTS_TTL_MS = 5 * 60 * 1000;
const HOTSPOT_MERGE_MI = 18;
const HOTSPOT_RADIUS_MI = 22; // matches Sky HAIL_RADIUS_MI for "near hotspot"
const REVIEW_FLOOR = 40;
const CAMPAIGN_FLOOR = 70;

/** Zone bounding boxes — same as server/storm-score.js ZONE_BBOX. */
export const ZONE_BBOX = {
  IL: [-91.6, 36.9, -87.0, 42.6],
  DC: [-77.12, 38.79, -76.91, 39.0],
  VA: [-83.7, 36.5, -75.2, 39.5],
  WI: [-92.9, 42.5, -86.8, 47.1],
  MD: [-79.5, 37.9, -75.0, 39.7],
  FL: [-87.6, 24.4, -80.0, 31.0],
};

function hailPoints(sizeIn) {
  if (!sizeIn || sizeIn < 1.5) return 0;
  if (sizeIn >= 2.0) return 70;
  return 50;
}

function windPoints(mph) {
  if (!mph || mph < 60) return 0;
  if (mph >= 70) return 50;
  return 30;
}

function actionFromScore(score) {
  if (score >= CAMPAIGN_FLOOR) return "campaign";
  if (score >= REVIEW_FLOOR) return "review";
  return "none";
}

function parseSpcCsvLine(bbox, line, mapRow) {
  const p = line.split(",");
  if (p.length < 7) return null;
  const [w, s, e, n] = bbox;
  const lat = parseFloat(p[5]);
  const lon = parseFloat(p[6]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  return mapRow(p, lat, lon);
}

async function fetchSpcCsvToday(bbox, filename, mapRow) {
  const r = await fetch(`https://www.spc.noaa.gov/climo/reports/${filename}`, {
    headers: { "User-Agent": NWS_UA },
  });
  if (!r.ok) return [];
  const out = [];
  for (const line of (await r.text()).trim().split("\n").slice(1)) {
    const row = parseSpcCsvLine(bbox, line, mapRow);
    if (row) out.push(row);
  }
  return out;
}

function mergeHotspots(list) {
  const merged = [];
  for (const h of list) {
    let found = null;
    for (const m of merged) {
      if (distanceMiles(h.lat, h.lon, m.lat, m.lon) <= HOTSPOT_MERGE_MI) {
        found = m;
        break;
      }
    }
    if (found) {
      found.hailIn = Math.max(found.hailIn || 0, h.hailIn || 0);
      found.windMph = Math.max(found.windMph || 0, h.windMph || 0);
      found.tornado = found.tornado || h.tornado;
      if (!found.label && h.label) found.label = h.label;
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

function scoreHotspotLite(hotspot, spcFeatures) {
  let total = 0;
  const breakdown = [];
  const hp = hailPoints(hotspot.hailIn);
  if (hp) {
    total += hp;
    breakdown.push({ variable: hotspot.hailIn >= 2 ? 'Hail ≥ 2.0"' : 'Hail ≥ 1.5"', points: hp });
  }
  const wp = windPoints(hotspot.windMph);
  if (wp) {
    total += wp;
    breakdown.push({
      variable: hotspot.windMph >= 70 ? "Wind ≥ 70 mph" : "Wind ≥ 60 mph",
      points: wp,
    });
  }
  if (hotspot.tornado) {
    total += 40;
    breakdown.push({ variable: "Tornado reported", points: 40 });
  }
  const catLabel = spcLabelAtPoint(hotspot.lat, hotspot.lon, spcFeatures);
  const cp = spcCatPoints(catLabel);
  if (cp) {
    total += cp;
    breakdown.push({ variable: `SPC ${catLabel}`, points: cp });
  }
  return {
    total,
    tier: actionFromScore(total),
    breakdown,
    label: hotspot.label || "SPC storm report",
  };
}

/**
 * Load today's SPC hail/wind/tornado reports for a zone and score merged hotspots.
 * Cached 5 min — shared across all leads in a ZIP search.
 */
export async function loadStormScoreHotspots({ state = "IL", spcOutlook = null } = {}) {
  const zone =
    String(state || "IL")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "IL";
  const bbox = ZONE_BBOX[zone] || ZONE_BBOX.IL;
  const key = `storm:score-lite:${zone}`;

  return cached(key, REPORTS_TTL_MS, async () => {
    const [hail, wind, tornado] = await Promise.all([
      fetchSpcCsvToday(bbox, "today_hail.csv", (p, lat, lon) => ({
        lat,
        lon,
        sizeIn: parseFloat(p[4]) || 0,
        location: p[1] || "",
        time: p[0] || "",
      })),
      fetchSpcCsvToday(bbox, "today_wind.csv", (p, lat, lon) => ({
        lat,
        lon,
        mph: parseFloat(p[4]) || 0,
        location: p[1] || "",
        time: p[0] || "",
      })),
      fetchSpcCsvToday(bbox, "today_torn.csv", (p, lat, lon) => ({
        lat,
        lon,
        location: p[1] || "",
        time: p[0] || "",
      })),
    ]);

    const raw = [];
    for (const r of hail) {
      if (r.sizeIn < 1.5) continue;
      raw.push({
        lat: r.lat,
        lon: r.lon,
        hailIn: r.sizeIn,
        windMph: 0,
        label: r.location || "SPC hail",
      });
    }
    for (const r of wind) {
      if (r.mph < 60) continue;
      raw.push({
        lat: r.lat,
        lon: r.lon,
        hailIn: 0,
        windMph: r.mph,
        label: r.location || "SPC wind",
      });
    }
    for (const r of tornado) {
      raw.push({
        lat: r.lat,
        lon: r.lon,
        hailIn: 0,
        windMph: 0,
        tornado: true,
        label: r.location || "SPC tornado",
      });
    }

    const merged = mergeHotspots(raw);
    const spcFeatures = spcOutlook?.features || [];
    const hotspots = merged.map((h) => {
      const score = scoreHotspotLite(h, spcFeatures);
      return {
        lat: h.lat,
        lon: h.lon,
        label: score.label,
        score: score.total,
        tier: score.tier,
        breakdown: score.breakdown,
      };
    });
    hotspots.sort((a, b) => b.score - a.score);
    return {
      zone,
      at: new Date().toISOString(),
      reportCounts: { hail: hail.length, wind: wind.length, tornado: tornado.length },
      hotspotCount: hotspots.length,
      hotspots,
      live: true,
    };
  });
}

/**
 * Nearest scored hotspot within radius. Returns null when none qualify.
 */
export function stormScoreAtPoint(lat, lng, scorePack, radiusMiles = HOTSPOT_RADIUS_MI) {
  if (lat == null || lng == null || !scorePack?.hotspots?.length) return null;
  const radius = Math.min(Math.max(Number(radiusMiles) || HOTSPOT_RADIUS_MI, 5), 40);
  let best = null;
  let bestDist = Infinity;
  for (const h of scorePack.hotspots) {
    if ((h.score || 0) < REVIEW_FLOOR) continue;
    const d = distanceMiles(lat, lng, h.lat, h.lon);
    if (d > radius) continue;
    // Prefer higher score; break ties by closer distance.
    if (
      !best ||
      h.score > best.score ||
      (h.score === best.score && d < bestDist)
    ) {
      best = h;
      bestDist = d;
    }
  }
  if (!best) return null;
  return {
    score: best.score,
    tier: best.tier,
    label: best.label,
    distanceMiles: Math.round(bestDist * 10) / 10,
    lat: best.lat,
    lon: best.lon,
    source: "spc-reports+outlook",
  };
}

export { REVIEW_FLOOR, CAMPAIGN_FLOOR, HOTSPOT_RADIUS_MI };
