// ===========================================================================
// Exportación CSV en servidor · leads + teléfono/email (solo autenticados)
// ===========================================================================
import { fetchJobsForStormExport, fetchContactPhonesEmail, jnGeocodeZip } from "./jn.js";
import { enrichJob } from "./phases.js";
import { fetchPrecipGrid } from "./meteo.js";

const EXCLUDED = new Set(["lost", "closed"]);
const PHASE_SCORE = { lead: 100, estimate: 85, hold: 60, other: 35, production: 20, sold: 10 };
const SEV_SCORE = { Extreme: 40, Severe: 30, Moderate: 20, Minor: 10, Unknown: 5 };
const HAIL_RADIUS_MI = 22;
const RAIN_CELL_MAX_MI = 35;
const RAIN_MIN_MM = 2;
const NWS_UA = "PremierSky/1.0";

const ZONE_BBOX = {
  IL: [-91.6, 36.9, -87.0, 42.6],
  DC: [-77.12, 38.79, -76.91, 39.0],
  VA: [-83.7, 36.5, -75.2, 39.5],
  WI: [-92.9, 42.5, -86.8, 47.1],
  MD: [-79.5, 37.9, -75.0, 39.7],
  FL: [-87.6, 24.4, -80.0, 31.0]
};

function haversineMi(lat1, lon1, lat2, lon2) {
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

function pointInGeometry(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInPolygon(lng, lat, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
  }
  return false;
}

async function resolveCoords(job) {
  if (job.lat != null && job.lon != null) {
    return { lat: job.lat, lon: job.lon, approx: false };
  }
  const geo = await jnGeocodeZip(job.zip);
  if (geo) return { lat: geo.lat, lon: geo.lon, approx: true };
  return null;
}

/** Separador CSV por defecto (Excel Windows español). */
const CSV_SEP_DEFAULT = process.env.CSV_DELIMITER || ";";
/** Columnas que Excel no debe convertir a número (teléfono, zip). */
const CSV_TEXT_COLS = new Set([5, 9]);

function resolveCsvSep(format) {
  const f = String(format || "").toLowerCase();
  if (f === "comma" || f === "google" || f === ",") return ",";
  if (f === "semicolon" || f === "excel" || f === ";") return ";";
  return CSV_SEP_DEFAULT;
}

function csvCell(v, colIndex = -1) {
  let s = String(v ?? "").replace(/"/g, '""');
  if (CSV_TEXT_COLS.has(colIndex) && s) s = "\t" + s;
  return /[",\n\r;]/.test(s) ? `"${s}"` : s;
}

function toCsv(filename, header, rows, sep = CSV_SEP_DEFAULT) {
  const bom = "\uFEFF";
  const fmtRow = (arr) => arr.map((c, i) => csvCell(c, i)).join(sep);
  const body = [fmtRow(header), ...rows.map(fmtRow)].join("\r\n");
  return { filename, content: bom + body };
}

const CSV_HEADER = [
  "Prioridad", "Score", "Nombre", "Cliente", "Contacto", "Teléfono_cliente", "Email_cliente",
  "Dirección", "Ciudad", "Zip", "Fase", "Estado JN", "Motivo", "Detalle",
  "Distancia_mi", "JobNimbus_URL"
];

async function enrichContacts(matches) {
  const out = [];
  for (const m of matches) {
    let contactEmail = "";
    let contactPhone = "";
    if (m.job.contactId) {
      const c = await fetchContactPhonesEmail(m.job.contactId);
      contactEmail = c.email;
      contactPhone = c.phone;
    }
    if (!contactPhone && m.job.fallbackPhone) contactPhone = m.job.fallbackPhone;
    out.push({ ...m, contactEmail, contactPhone });
  }
  return out;
}

function finalizeRows(matches) {
  matches.sort((a, b) => b.score - a.score || (a.distMi ?? 0) - (b.distMi ?? 0));
  return matches.map((m, i) => [
    i + 1,
    Math.round(m.score),
    m.job.name || "",
    m.job.customer || "",
    m.job.contactName || "",
    m.contactPhone || "",
    m.contactEmail || "",
    [m.job.address, m.job.city, m.job.state, m.job.zip].filter(Boolean).join(", "),
    m.job.city || "",
    m.job.zip || "",
    m.job.phaseLabel || "",
    m.job.status || "",
    m.motivo,
    m.detalle,
    m.distMi != null ? m.distMi.toFixed(1) : "",
    m.job.jnUrl || ""
  ]);
}

async function loadJobs(zone, dateOpts) {
  const jobs = await fetchJobsForStormExport(zone, dateOpts || {});
  return jobs.map(enrichJob).filter((j) => !EXCLUDED.has(j.phaseId));
}

function phaseScore(job) {
  return PHASE_SCORE[job.phaseId] ?? PHASE_SCORE.other;
}

async function fetchNwsAlertFeatures(zone) {
  const r = await fetch(`https://api.weather.gov/alerts/active?area=${zone}`, {
    headers: { Accept: "application/geo+json", "User-Agent": NWS_UA }
  });
  if (!r.ok) throw new Error("Alertas NWS no disponibles");
  const data = await r.json();
  return (data.features || []).filter((f) => f.geometry);
}

async function fetchHailToday(bbox) {
  const [w, s, e, n] = bbox;
  const r = await fetch("https://www.spc.noaa.gov/climo/reports/today_hail.csv", {
    headers: { "User-Agent": NWS_UA }
  });
  if (!r.ok) return [];
  const text = await r.text();
  const lines = text.trim().split("\n").slice(1);
  const out = [];
  for (const line of lines) {
    const p = line.split(",");
    if (p.length < 7) continue;
    const lat = parseFloat(p[5]);
    const lon = parseFloat(p[6]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    const sizeIn = (parseInt(p[1], 10) || 0) / 100;
    out.push({
      sizeIn,
      location: p[2],
      county: p[3],
      state: p[4],
      lat, lon
    });
  }
  return out;
}

/** Leads dentro del radio de tormenta (snapshot para historial / PDF). */
export async function collectLeadsNearStorm(zone, lat, lon, dateOpts = {}) {
  const z = String(zone || "").toUpperCase();
  if (!ZONE_BBOX[z]) throw new Error("Zona no válida");
  const jobs = await loadJobs(z, dateOpts);
  const matches = [];
  for (const job of jobs) {
    const coords = await resolveCoords(job);
    if (!coords) continue;
    const distMi = haversineMi(lat, lon, coords.lat, coords.lon);
    if (distMi > HAIL_RADIUS_MI) continue;
    matches.push({
      job,
      distMi,
      score: phaseScore(job) + (coords.approx ? -5 : 0),
      motivo: "Tormenta",
      detalle: `Radio ${HAIL_RADIUS_MI} mi · ${distMi.toFixed(1)} mi`
    });
  }
  const enriched = await enrichContacts(matches);
  enriched.sort((a, b) => b.score - a.score || (a.distMi ?? 0) - (b.distMi ?? 0));
  return enriched.map((m, i) => ({
    priority: i + 1,
    score: Math.round(m.score),
    name: m.job.name || "",
    customer: m.job.customer || "",
    contactName: m.job.contactName || "",
    phone: m.contactPhone || "",
    email: m.contactEmail || "",
    address: [m.job.address, m.job.city, m.job.state, m.job.zip].filter(Boolean).join(", "),
    city: m.job.city || "",
    zip: m.job.zip || "",
    phase: m.job.phaseLabel || "",
    status: m.job.status || "",
    distMi: m.distMi != null ? Number(m.distMi.toFixed(1)) : null,
    jnUrl: m.job.jnUrl || ""
  }));
}

export async function buildStormExport(type, zone, dateOpts = {}, exportOpts = {}) {
  const csvSep = resolveCsvSep(exportOpts.csvFormat);
  const z = String(zone || "").toUpperCase();
  const bbox = ZONE_BBOX[z];
  if (!bbox) throw new Error("Zona no válida");

  const jobs = await loadJobs(z, dateOpts);
  if (!jobs.length) return { ok: false, message: "No hay jobs para exportar en esta zona." };

  const stamp = new Date().toISOString().slice(0, 10);
  let matches = [];

  if (type === "alerts") {
    const features = await fetchNwsAlertFeatures(z);
    if (!features.length) return { ok: false, message: "No hay alertas activas con área en el mapa." };
    for (const job of jobs) {
      const c = await resolveCoords(job);
      if (!c) continue;
      const hits = [];
      for (const f of features) {
        if (pointInGeometry(c.lon, c.lat, f.geometry)) hits.push(f.properties);
      }
      if (!hits.length) continue;
      hits.sort((a, b) => (SEV_SCORE[b.severity] || 0) - (SEV_SCORE[a.severity] || 0));
      const top = hits[0];
      matches.push({
        job,
        score: phaseScore(job) + (SEV_SCORE[top.severity] || 5) + (c.approx ? -5 : 0),
        motivo: "Alerta NWS",
        detalle: `${top.event || "Alerta"} · ${top.severity || "—"}${c.approx ? " · zip approx." : ""}`,
        distMi: 0
      });
    }
    if (!matches.length) return { ok: false, message: "Ningún job dentro de alertas activas." };
    const enriched = await enrichContacts(matches);
    const rows = finalizeRows(enriched);
    return { ok: true, message: `${rows.length} lead(s) exportados.`, csv: toCsv(`premier-sky-${z}-alertas-${stamp}.csv`, CSV_HEADER, rows, csvSep) };
  }

  if (type === "hail") {
    const reports = await fetchHailToday(bbox);
    if (!reports.length) return { ok: false, message: "Sin granizo reportado hoy en esta zona." };
    for (const job of jobs) {
      const c = await resolveCoords(job);
      if (!c) continue;
      let best = null;
      for (const r of reports) {
        const dist = haversineMi(c.lat, c.lon, r.lat, r.lon);
        if (dist > HAIL_RADIUS_MI) continue;
        const score = phaseScore(job) + (r.sizeIn || 0) * 18 - dist * 0.8 + (c.approx ? -5 : 0);
        if (!best || score > best.score) {
          best = {
            job, score,
            motivo: "Granizo reportado hoy",
            detalle: `${(r.sizeIn || 0).toFixed(2)}" · ${r.location || ""} · ${dist.toFixed(1)} mi`,
            distMi: dist
          };
        }
      }
      if (best) matches.push(best);
    }
    if (!matches.length) return { ok: false, message: `Ningún job a ${HAIL_RADIUS_MI} mi del granizo.` };
    const enriched = await enrichContacts(matches);
    const rows = finalizeRows(enriched);
    return { ok: true, message: `${rows.length} lead(s) exportados.`, csv: toCsv(`premier-sky-${z}-granizo-${stamp}.csv`, CSV_HEADER, rows, csvSep) };
  }

  if (type === "rain") {
    const grid = await fetchPrecipGrid(bbox);
    const heavy = grid.cells.map((cell) => ({
      ...cell,
      maxMm: cell.precip.length ? Math.max(...cell.precip.slice(0, 12)) : 0
    })).filter((c) => c.maxMm >= RAIN_MIN_MM);
    if (!heavy.length) return { ok: false, message: "Sin lluvia fuerte pronosticada." };
    for (const job of jobs) {
      const c = await resolveCoords(job);
      if (!c) continue;
      let best = null;
      for (const cell of heavy) {
        const dist = haversineMi(c.lat, c.lon, cell.lat, cell.lon);
        if (dist > RAIN_CELL_MAX_MI) continue;
        const score = phaseScore(job) + cell.maxMm * 8 - dist * 0.5 + (c.approx ? -5 : 0);
        if (!best || score > best.score) {
          best = {
            job, score,
            motivo: "Lluvia fuerte pronosticada",
            detalle: `hasta ${cell.maxMm.toFixed(1)} mm/h · ~${dist.toFixed(1)} mi`,
            distMi: dist
          };
        }
      }
      if (best) matches.push(best);
    }
    if (!matches.length) return { ok: false, message: "Ningún job cerca de lluvia fuerte pronosticada." };
    const enriched = await enrichContacts(matches);
    const rows = finalizeRows(enriched);
    return { ok: true, message: `${rows.length} lead(s) exportados.`, csv: toCsv(`premier-sky-${z}-lluvia-${stamp}.csv`, CSV_HEADER, rows, csvSep) };
  }

  throw new Error("Tipo de exportación no válido");
}
