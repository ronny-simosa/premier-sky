// ===========================================================================
// Sistema de puntuación de tormentas · variables climáticas → acción por email
//   0-39 pts  → sin acción
//   40-69 pts → revisar manualmente (alerta email)
//   70+ pts   → campañas Meta (por ahora solo alerta email)
// ===========================================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchJobsForStormExport } from "./jn.js";
import { enrichJob } from "./phases.js";
import { fetchPrecipGrid, fetchOpenMeteoForecast, fetchNwsHeavyRainNear } from "./meteo.js";
import { haversineMi, geometryCentroid, spcLabelAtPoint } from "./geo-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCORED_SEEN_FILE = path.join(__dirname, "data", "scored-events.json");

const EXCLUDED = new Set(["lost", "closed"]);
const HAIL_RADIUS_MI = 22;
const HIST_HAIL_RADIUS_MI = 15;
const RAIN_CELL_MAX_MI = 35;
const RAIN_MIN_MM = 2;
const HOTSPOT_MERGE_MI = 18;
const NWS_UA = "PremierSky/1.0";
const PREMIER_RADIUS_MI = 40;

const HOME_DENSITY_MIN = parseInt(process.env.HOME_DENSITY_MIN, 10) || 5;
const ALERT_MIN_SCORE = parseInt(process.env.ALERT_MIN_SCORE, 10) || 40;
const NOTIFY_COOLDOWN_MS = (parseInt(process.env.ALERT_COOLDOWN_HOURS, 10) || 72) * 3600000;
const MONITOR_GRID_COLS = 6;
const MONITOR_GRID_ROWS = 5;
const JN_SCORE_CACHE_MS = (parseInt(process.env.JN_SCORE_CACHE_MIN, 10) || 20) * 60 * 1000;
const SPC_CACHE_MS = 5 * 60 * 1000;
const HAIL_HIST_CACHE_MS = 24 * 60 * 60 * 1000;

const PREMIER_OFFICES = {
  IL: { lat: 41.9578017, lon: -88.0836828 },
  FL: { lat: 26.1461074, lon: -80.1991495 },
  MD: { lat: 39.1477652, lon: -76.7965342 },
  WI: { lat: 43.0001646, lon: -87.9497563 }
};

const ZONE_TZ_OFFSET = { IL: -6, WI: -6, DC: -5, VA: -5, MD: -5, FL: -5 };

export const ZONE_BBOX = {
  IL: [-91.6, 36.9, -87.0, 42.6],
  DC: [-77.12, 38.79, -76.91, 39.0],
  VA: [-83.7, 36.5, -75.2, 39.5],
  WI: [-92.9, 42.5, -86.8, 47.1],
  MD: [-79.5, 37.9, -75.0, 39.7],
  FL: [-87.6, 24.4, -80.0, 31.0]
};

const jobsCache = new Map();
const spcCache = new Map();
const hailHistCache = new Map();

export function hailPoints(sizeIn) {
  if (!sizeIn || sizeIn < 1.5) return 0;
  if (sizeIn >= 2.0) return 70;
  return 50;
}

export function windPoints(mph) {
  if (!mph || mph < 60) return 0;
  if (mph >= 70) return 50;
  return 30;
}

export function spcCatPoints(label) {
  const u = String(label || "").toUpperCase();
  if (u.includes("HIGH")) return 25;
  if (u.includes("MDT") || u.includes("MOD")) return 25;
  if (u.includes("ENH")) return 15;
  if (u.includes("SLGT") || u.includes("SLIGHT")) return 10;
  if (u.includes("MRGL") || u.includes("MARGINAL")) return 5;
  return 0;
}

export function hailOutlookPoints(label) {
  const n = parseFloat(String(label || "").replace(/[^\d.]/g, ""));
  if (n >= 0.30) return 35;
  if (n >= 0.15) return 20;
  if (n >= 0.05) return 10;
  return 0;
}

export function actionFromScore(score) {
  if (score >= 70) return "campaign";
  if (score >= 40) return "review";
  return "none";
}

export function actionLabel(tier) {
  if (tier === "campaign") return "Activar campañas Meta (pendiente — por ahora solo alerta email)";
  if (tier === "review") return "Revisar manualmente";
  return "Sin acción";
}

function firstNum(val) {
  if (val == null) return 0;
  const n = parseFloat(Array.isArray(val) ? val[0] : val);
  return isFinite(n) ? n : 0;
}

function parseHailFromAlert(props) {
  const params = props?.parameters || {};
  const fromParam = firstNum(params.MAXHAILSIZE || params.maxHailSize);
  if (fromParam) return fromParam;
  const text = `${props?.headline || ""} ${props?.description || ""}`;
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:inch|inches|")\s*(?:hail|granizo)?/i)
    || text.match(/hail[^\d]*(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
}

function parseWindFromAlert(props) {
  const params = props?.parameters || {};
  const fromParam = firstNum(params.MAXWINDGUST || params.maxWindGust || params.WINDGUST || params.windGust);
  if (fromParam) return fromParam;
  const text = `${props?.headline || ""} ${props?.description || ""} ${props?.windSpeed || ""}`;
  const m = text.match(/(\d+)\s*mph/i);
  return m ? parseInt(m[1], 10) : 0;
}

function parseSpcCsvLine(bbox, line, mapRow) {
  const p = line.split(",");
  if (p.length < 7) return null;
  const [w, s, e, n] = bbox;
  const lat = parseFloat(p[5]);
  const lon = parseFloat(p[6]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lon < w || lon > e || lat < s || lat > n) return null;
  return mapRow(p, lat, lon);
}

async function fetchSpcCsvToday(bbox, filename, mapRow) {
  const r = await fetch(`https://www.spc.noaa.gov/climo/reports/${filename}`, {
    headers: { "User-Agent": NWS_UA }
  });
  if (!r.ok) return [];
  const out = [];
  for (const line of (await r.text()).trim().split("\n").slice(1)) {
    const row = parseSpcCsvLine(bbox, line, mapRow);
    if (row) out.push(row);
  }
  return out;
}

async function fetchHailToday(bbox) {
  return fetchSpcCsvToday(bbox, "today_hail.csv", (p, lat, lon) => ({
    sizeIn: (parseInt(p[1], 10) || 0) / 100,
    location: p[2],
    time: p[0],
    lat, lon
  }));
}

async function fetchWindToday(bbox) {
  return fetchSpcCsvToday(bbox, "today_wind.csv", (p, lat, lon) => ({
    mph: parseInt(p[1], 10) || 0,
    location: p[2],
    time: p[0],
    lat, lon
  }));
}

async function fetchTornadoToday(bbox) {
  return fetchSpcCsvToday(bbox, "today_torn.csv", (p, lat, lon) => ({
    location: p[2],
    time: p[0],
    lat, lon
  }));
}

async function fetchNwsAlertFeatures(zone) {
  const r = await fetch(`https://api.weather.gov/alerts/active?area=${zone}`, {
    headers: { Accept: "application/geo+json", "User-Agent": NWS_UA }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.features || []).filter((f) => f.geometry);
}

async function fetchSpcOutlook(type, day = 1) {
  const key = `${day}_${type}`;
  const hit = spcCache.get(key);
  if (hit && Date.now() - hit.t < SPC_CACHE_MS) return hit.data;
  const url = `https://www.spc.noaa.gov/products/outlook/day${day}otlk_${type}.nolyr.geojson`;
  const r = await fetch(url, { headers: { "User-Agent": NWS_UA } });
  if (!r.ok) return [];
  const data = await r.json();
  const features = (data.features || []).filter((f) => f.geometry);
  spcCache.set(key, { t: Date.now(), data: features });
  return features;
}

async function fetchHailHistory30d(zone) {
  const hit = hailHistCache.get(zone);
  if (hit && Date.now() - hit.t < HAIL_HIST_CACHE_MS) return hit.data;
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 16) + "Z";
  const qs = `sts=${fmt(start)}&ets=${fmt(end)}&states=${zone}`;
  const r = await fetch(
    `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?${qs}`,
    { headers: { "User-Agent": NWS_UA } }
  );
  if (!r.ok) return [];
  const data = await r.json();
  const out = (data.features || []).map((f) => {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [];
    let sizeIn = parseFloat(p.magnitude) || 0;
    if (sizeIn > 10) sizeIn /= 100;
    return {
      lat: coords[1],
      lon: coords[0],
      sizeIn,
      time: p.valid || ""
    };
  }).filter((r) => isFinite(r.lat) && isFinite(r.lon) && r.sizeIn >= 1.0);
  hailHistCache.set(zone, { t: Date.now(), data: out });
  return out;
}

async function loadCallableJobsCached(zone) {
  const hit = jobsCache.get(zone);
  if (hit && Date.now() - hit.t < JN_SCORE_CACHE_MS) return hit.jobs;
  const jobs = await loadCallableJobs(zone);
  jobsCache.set(zone, { t: Date.now(), jobs });
  return jobs;
}

async function loadCallableJobs(zone) {
  try {
    const raw = await fetchJobsForStormExport(zone, {});
    return raw.map(enrichJob).filter((j) => !EXCLUDED.has(j.phaseId));
  } catch {
    return [];
  }
}

function maxNearbyHail(lat, lon, reports) {
  let max = 0;
  for (const r of reports) {
    if (haversineMi(lat, lon, r.lat, r.lon) <= HAIL_RADIUS_MI) {
      max = Math.max(max, r.sizeIn || 0);
    }
  }
  return max;
}

function maxNearbyWind(lat, lon, reports) {
  let max = 0;
  for (const r of reports) {
    if (haversineMi(lat, lon, r.lat, r.lon) <= HAIL_RADIUS_MI) {
      max = Math.max(max, r.mph || 0);
    }
  }
  return max;
}

function hasNearbyTornado(lat, lon, reports) {
  return reports.some((r) => haversineMi(lat, lon, r.lat, r.lon) <= HAIL_RADIUS_MI);
}

function hasHistoricalHail(lat, lon, history) {
  return history.some((r) =>
    haversineMi(lat, lon, r.lat, r.lon) <= HIST_HAIL_RADIUS_MI && r.sizeIn >= 1.0
  );
}

function hasHeavyRainFromGrid(lat, lon, grid) {
  if (!grid?.cells?.length) return false;
  for (const cell of grid.cells) {
    const dist = haversineMi(lat, lon, cell.lat, cell.lon);
    if (dist > RAIN_CELL_MAX_MI) continue;
    const slice = (cell.precip || []).slice(0, 12);
    const maxMm = slice.length ? Math.max(...slice) : 0;
    if (maxMm >= RAIN_MIN_MM) return true;
  }
  return false;
}

function countNearbyHomes(lat, lon, jobs) {
  let n = 0;
  for (const job of jobs) {
    if (job.lat == null || job.lon == null) continue;
    if (haversineMi(lat, lon, job.lat, job.lon) <= HAIL_RADIUS_MI) n++;
  }
  return n;
}

function countNearbyPhases(lat, lon, jobs) {
  let leads = 0;
  let estimates = 0;
  for (const job of jobs) {
    if (job.lat == null || job.lon == null) continue;
    if (haversineMi(lat, lon, job.lat, job.lon) > HAIL_RADIUS_MI) continue;
    if (job.phaseId === "lead") leads++;
    if (job.phaseId === "estimate") estimates++;
  }
  return { leads, estimates };
}

function nearPremierOffice(lat, lon, zone) {
  const off = PREMIER_OFFICES[zone];
  if (!off) return false;
  return haversineMi(lat, lon, off.lat, off.lon) <= PREMIER_RADIUS_MI;
}

function isBusinessHours(timeStr, zone) {
  if (!timeStr) return false;
  const d = new Date(timeStr);
  if (isNaN(d.getTime())) return false;
  const offset = ZONE_TZ_OFFSET[zone] ?? -6;
  const localHour = (d.getUTCHours() + offset + 24) % 24;
  return localHour >= 8 && localHour < 20;
}

function mergeHotspots(list) {
  const merged = [];
  for (const h of list) {
    let found = null;
    for (const m of merged) {
      if (haversineMi(h.lat, h.lon, m.lat, m.lon) <= HOTSPOT_MERGE_MI) {
        found = m;
        break;
      }
    }
    if (found) {
      found.hailIn = Math.max(found.hailIn || 0, h.hailIn || 0);
      found.windMph = Math.max(found.windMph || 0, h.windMph || 0);
      found.tornado = found.tornado || h.tornado;
      if (!found.time && h.time) found.time = h.time;
      if (!found.label && h.label) found.label = h.label;
      if (!found.alertId && h.alertId) found.alertId = h.alertId;
    } else {
      merged.push({ ...h });
    }
  }
  return merged;
}

function buildHotspots(hailReports, windReports, tornadoReports, alerts) {
  const hotspots = [];

  for (const r of hailReports) {
    if (r.sizeIn < 1.5) continue;
    hotspots.push({
      lat: r.lat, lon: r.lon, hailIn: r.sizeIn, windMph: 0,
      time: r.time, label: r.location || "Reporte granizo SPC"
    });
  }

  for (const r of windReports) {
    if (r.mph < 60) continue;
    hotspots.push({
      lat: r.lat, lon: r.lon, hailIn: 0, windMph: r.mph,
      time: r.time, label: r.location || "Reporte viento SPC"
    });
  }

  for (const r of tornadoReports) {
    hotspots.push({
      lat: r.lat, lon: r.lon, hailIn: 0, windMph: 0, tornado: true,
      time: r.time, label: r.location || "Tornado reportado SPC"
    });
  }

  for (const f of alerts) {
    const c = geometryCentroid(f.geometry);
    if (!c) continue;
    const p = f.properties || {};
    const hailIn = parseHailFromAlert(p);
    const windMph = parseWindFromAlert(p);
    if (hailIn < 1.5 && windMph < 60) continue;
    hotspots.push({
      lat: c.lat, lon: c.lon, hailIn, windMph,
      time: p.sent || p.onset,
      label: p.event || "Alerta NWS",
      alertId: p.id
    });
  }

  return mergeHotspots(hotspots);
}

async function forecastGustMph(lat, lon) {
  try {
    const fc = await fetchOpenMeteoForecast(lat, lon);
    const hourly = fc.hourly?.wind_speed_10m || [];
    const fromHourly = hourly.length ? Math.max(...hourly.slice(0, 12)) : 0;
    const fromDaily = fc.daily?.wind_gusts_10m_max?.[0] || 0;
    return Math.max(fromHourly, fromDaily);
  } catch {
    return 0;
  }
}

export async function scoreHotspot(hotspot, ctx, { forEmail = false } = {}) {
  const {
    zone, hailReports, windReports, tornadoReports, precipGrid,
    jobs, spcCat, spcHail, hailHistory, useNwsRainFallback
  } = ctx;

  const hailIn = Math.max(hotspot.hailIn || 0, maxNearbyHail(hotspot.lat, hotspot.lon, hailReports));
  const reportedWind = Math.max(hotspot.windMph || 0, maxNearbyWind(hotspot.lat, hotspot.lon, windReports));
  let windMph = reportedWind;

  const breakdown = [];
  let total = 0;

  const hp = hailPoints(hailIn);
  if (hp) {
    total += hp;
    breakdown.push({
      variable: hailIn >= 2.0 ? 'Granizo ≥ 2.0"' : 'Granizo ≥ 1.5"',
      points: hp
    });
  }

  // Correo: solo viento reportado (normativa). Mapa: incluye ráfagas pronosticadas.
  if (!forEmail && windMph < 60) {
    const gust = await forecastGustMph(hotspot.lat, hotspot.lon);
    if (gust >= 60) windMph = gust;
  }

  const wp = windPoints(windMph);
  if (wp) {
    total += wp;
    breakdown.push({
      variable: windMph >= 70 ? "Viento ≥ 70 mph" : "Viento ≥ 60 mph",
      points: wp
    });
  }

  const stormPresent = hp > 0 || wp > 0;
  let heavyRain = hasHeavyRainFromGrid(hotspot.lat, hotspot.lon, precipGrid);
  if (!heavyRain && stormPresent && useNwsRainFallback) {
    heavyRain = await fetchNwsHeavyRainNear(hotspot.lat, hotspot.lon);
  }
  if (stormPresent && heavyRain) {
    total += 10;
    breakdown.push({ variable: "Lluvia intensa posterior", points: 10 });
  }

  const homeCount = countNearbyHomes(hotspot.lat, hotspot.lon, jobs);
  if (homeCount >= HOME_DENSITY_MIN) {
    total += 20;
    breakdown.push({
      variable: `Alta densidad de viviendas afectadas (${homeCount} jobs ≤ ${HAIL_RADIUS_MI} mi)`,
      points: 20
    });
  }

  // Variables extra solo en mapa (no disparan correo según normativa)
  if (!forEmail) {
    if (hasNearbyTornado(hotspot.lat, hotspot.lon, tornadoReports) || hotspot.tornado) {
      total += 40;
      breakdown.push({ variable: "Tornado reportado", points: 40 });
    }

    const catLabel = spcLabelAtPoint(hotspot.lat, hotspot.lon, spcCat);
    const cp = spcCatPoints(catLabel);
    if (cp) {
      total += cp;
      breakdown.push({ variable: `Riesgo SPC ${catLabel}`, points: cp });
    }

    const hailFcLabel = spcLabelAtPoint(hotspot.lat, hotspot.lon, spcHail);
    const hfp = hailOutlookPoints(hailFcLabel);
    if (hfp && !hp) {
      total += hfp;
      breakdown.push({ variable: `Granizo pronosticado ${hailFcLabel}`, points: hfp });
    }

    const { leads, estimates } = countNearbyPhases(hotspot.lat, hotspot.lon, jobs);
    if (leads >= 2 || estimates >= 1) {
      total += 10;
      breakdown.push({
        variable: `Leads/estimaciones cerca (${leads} leads, ${estimates} est.)`,
        points: 10
      });
    }

    if (nearPremierOffice(hotspot.lat, hotspot.lon, zone)) {
      total += 10;
      breakdown.push({ variable: "Dentro del radio de oficina Premier", points: 10 });
    }

    if (hasHistoricalHail(hotspot.lat, hotspot.lon, hailHistory)) {
      total += 10;
      breakdown.push({ variable: "Granizo histórico en zona (30 días)", points: 10 });
    }

    if (isBusinessHours(hotspot.time, zone)) {
      total += 5;
      breakdown.push({ variable: "Horario comercial (8am–8pm)", points: 5 });
    }
  }

  const phases = forEmail ? { leads: 0, estimates: 0 } : countNearbyPhases(hotspot.lat, hotspot.lon, jobs);

  return {
    total,
    tier: actionFromScore(total),
    breakdown,
    hailIn,
    windMph,
    homeCount,
    leads: phases.leads,
    estimates: phases.estimates,
    label: hotspot.label || "—"
  };
}

async function gatherZoneData(zone) {
  const bbox = ZONE_BBOX[zone];
  if (!bbox) return null;

  const [hailReports, windReports, tornadoReports, alerts, spcCat, spcHail, hailHistory] =
    await Promise.all([
      fetchHailToday(bbox),
      fetchWindToday(bbox),
      fetchTornadoToday(bbox),
      fetchNwsAlertFeatures(zone),
      fetchSpcOutlook("cat"),
      fetchSpcOutlook("hail"),
      fetchHailHistory30d(zone)
    ]);

  const hotspots = buildHotspots(hailReports, windReports, tornadoReports, alerts);
  let precipGrid = null;
  let useNwsRainFallback = false;

  if (hotspots.length) {
    try {
      precipGrid = await fetchPrecipGrid(bbox, MONITOR_GRID_COLS, MONITOR_GRID_ROWS);
    } catch (e) {
      useNwsRainFallback = true;
      const msg = String(e.message || "");
      if (!msg.includes("429") && !msg.includes("límite")) {
        console.warn("Precip grid", zone, msg);
      }
    }
  }

  const jobs = hotspots.length ? await loadCallableJobsCached(zone) : [];

  return {
    zone,
    hotspots,
    ctx: {
      zone,
      hailReports,
      windReports,
      tornadoReports,
      precipGrid,
      jobs,
      spcCat,
      spcHail,
      hailHistory,
      useNwsRainFallback
    }
  };
}

function eventKey(zone, lat, lon) {
  // ~35 mi por celda — un solo aviso por zona de tormenta (no por cada reporte SPC)
  const rLat = (Math.round(lat * 2) / 2).toFixed(1);
  const rLon = (Math.round(lon * 2) / 2).toFixed(1);
  return `${zone}:${rLat}:${rLon}`;
}

function wasRecentlyNotified(seen, zone, lat, lon, tier) {
  const now = Date.now();
  for (const [key, val] of Object.entries(seen)) {
    if (!key.startsWith(`${zone}:`)) continue;
    const at = val.at ? new Date(val.at).getTime() : 0;
    if (!at || now - at > NOTIFY_COOLDOWN_MS) continue;
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const kLat = parseFloat(parts[1]);
    const kLon = parseFloat(parts[2]);
    if (!isFinite(kLat) || !isFinite(kLon)) continue;
    if (haversineMi(lat, lon, kLat, kLon) > HOTSPOT_MERGE_MI) continue;
    if ((TIER_RANK[tier] || 0) <= (TIER_RANK[val.tier] || 0)) return true;
  }
  return false;
}

function loadScoredSeen() {
  try {
    return JSON.parse(fs.readFileSync(SCORED_SEEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveScoredSeen(obj) {
  const dir = path.dirname(SCORED_SEEN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCORED_SEEN_FILE, JSON.stringify(obj, null, 2));
}

const TIER_RANK = { none: 0, review: 1, campaign: 2 };

function shouldNotify(seen, key, tier, lat, lon) {
  const prev = seen[key];
  if (prev) {
    return (TIER_RANK[tier] || 0) > (TIER_RANK[prev.tier] || 0);
  }
  const zone = key.split(":")[0];
  return !wasRecentlyNotified(seen, zone, lat, lon, tier);
}

export async function getZoneStormScores(zone) {
  const data = await gatherZoneData(zone);
  if (!data) return { zone, hotspots: [], at: new Date().toISOString() };

  const results = [];
  for (const h of data.hotspots) {
    const score = await scoreHotspot(h, data.ctx);
    results.push({
      lat: h.lat,
      lon: h.lon,
      label: h.label,
      alertId: h.alertId,
      score
    });
  }
  results.sort((a, b) => b.score.total - a.score.total);
  return { zone, hotspots: results, at: new Date().toISOString() };
}

export async function evaluateZone(zone) {
  const data = await gatherZoneData(zone);
  if (!data?.hotspots.length) return [];

  const seen = loadScoredSeen();
  const toNotify = [];

  let best = null;
  for (const h of data.hotspots) {
    const score = await scoreHotspot(h, data.ctx, { forEmail: true });
    if (score.total < ALERT_MIN_SCORE) continue;
    if (!best || score.total > best.score.total) best = { h, score };
  }

  if (best) {
    const key = eventKey(zone, best.h.lat, best.h.lon);
    if (shouldNotify(seen, key, best.score.tier, best.h.lat, best.h.lon)) {
      seen[key] = {
        tier: best.score.tier,
        score: best.score.total,
        at: new Date().toISOString(),
        label: best.h.label
      };
      toNotify.push({
        zone,
        lat: best.h.lat,
        lon: best.h.lon,
        alertId: best.h.alertId,
        score: best.score
      });
    }
  }

  saveScoredSeen(seen);
  return toNotify;
}

export function formatScoreEmail(event) {
  const { zone, score, lat, lon } = event;
  const tier = score.tier;
  const priority = tier === "campaign" ? "ALTA PRIORIDAD · " : "";
  const subject = `[Premier Sky] ${priority}${zone} · Score ${score.total} · ${actionLabel(tier)}`;

  const lines = score.breakdown.map((b) => `  • ${b.variable}: +${b.points}`);
  const text =
    `Alerta Premier Sky — Puntuación de tormenta\n\n` +
    `Zona: ${zone}\n` +
    `Ubicación: ${lat.toFixed(3)}, ${lon.toFixed(3)}\n` +
    `Evento: ${score.label}\n` +
    `Puntuación total: ${score.total}\n` +
    `Acción: ${actionLabel(tier)}\n\n` +
    `Desglose:\n${lines.join("\n")}\n\n` +
    (score.homeCount ? `Jobs afectados (≤ ${HAIL_RADIUS_MI} mi): ${score.homeCount}\n` : "") +
    (score.leads != null ? `Leads: ${score.leads} · Estimaciones: ${score.estimates}\n` : "") +
    (tier === "campaign"
      ? "\nNota: En producción esto activaría campañas de Meta automáticamente. Por ahora solo alerta por correo.\n"
      : "");

  const breakdownHtml = score.breakdown
    .map((b) => `<li><b>${b.variable}</b>: +${b.points}</li>`)
    .join("");

  const tierColor = tier === "campaign" ? "#c1121f" : "#e85d04";
  const html =
    `<h2 style="margin:0 0 8px">⛈️ Alerta de tormenta · ${zone}</h2>` +
    `<p style="font-size:22px;margin:0 0 8px"><b>Score: ${score.total}</b></p>` +
    `<p style="background:${tierColor};color:#fff;display:inline-block;padding:4px 12px;border-radius:8px;font-size:14px">` +
    `${actionLabel(tier)}</p>` +
    `<p style="margin-top:12px"><b>Evento:</b> ${score.label}<br/>` +
    `<b>Ubicación:</b> ${lat.toFixed(3)}, ${lon.toFixed(3)}</p>` +
    `<h3 style="margin:16px 0 6px">Desglose de puntos</h3><ul>${breakdownHtml}</ul>` +
    (score.homeCount ? `<p><b>Jobs afectados:</b> ${score.homeCount} (radio ${HAIL_RADIUS_MI} mi)</p>` : "") +
    (tier === "campaign"
      ? `<p style="color:#666;font-size:13px;margin-top:16px">En producción esto activaría campañas de Meta. Por ahora solo alerta por correo.</p>`
      : "");

  return { subject, text, html };
}

export async function evaluateAllZones(zones) {
  const all = [];
  for (const z of zones) {
    try {
      const events = await evaluateZone(z);
      all.push(...events);
    } catch (e) {
      console.error("Storm score", z, e.message);
    }
  }
  return all;
}
