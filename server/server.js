// ===========================================================================
// StormTracker · servidor
//   1) Sirve la web estática.
//   2) Proxy del NOAA SPC (añade CORS) -> /api/spc?day=1
//   3) Monitor de tormentas (solo score por normativa): granizo, viento, lluvia,
//      densidad de viviendas. NO envía alertas NWS genéricas (Flood, Heat, etc.).
// Requiere Node >= 18 (usa fetch nativo).
// ===========================================================================
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchJobsForZone, jnConfigured, jnIsReadOnly } from "./jn.js";
import {
  requestLoginCode, verifyLoginCode, getSession, requireAuth,
  applySessionCookie, destroySession, pageRequiresAuth, redirectToLogin,
  sessionDurationHours
} from "./auth.js";
import { buildStormExport } from "./storm-export.js";
import { fetchOpenMeteoForecast, fetchPrecipGrid } from "./meteo.js";
import { evaluateAllZones, formatScoreEmail, getZoneStormScores, ZONE_BBOX } from "./storm-score.js";
import {
  recordStormEvent, listStormHistory, getStormEvent, generateStormPdf
} from "./storm-history.js";
import { initMail, mailConfigured, mailProvider, sendMail } from "./mail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");

// --- Carga sencilla de .env (sin dependencias) -----------------------------
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = (m[2] || "").trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 3000;
const POLL_MS = (parseInt(process.env.POLL_MINUTES) || 10) * 60 * 1000;
const ALERT_TO = process.env.ALERT_TO || "premierandmarketing@gmail.com";
const STATES = ["IL", "DC", "VA", "WI", "MD", "FL"];
const NWS_UA = "StormTracker (" + ALERT_TO + ")";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Email (alertas + códigos de acceso) -----------------------------------
initMail();

// --- Autenticación (público) -----------------------------------------------
app.post("/api/auth/request-code", async (req, res) => {
  res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  const email = req.body?.email;
  const ip = req.ip || req.socket.remoteAddress;
  if (!mailConfigured()) {
    return res.status(503).json({ error: "Correo no configurado. Contacta al administrador." });
  }
  try {
    const result = await requestLoginCode(email, ip, sendMail);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/verify", (req, res) => {
  res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  const { email, code } = req.body || {};
  const result = verifyLoginCode(email, code);
  if (!result.ok) return res.status(401).json({ error: result.error });
  applySessionCookie(res, result.sid);
  res.json({ ok: true, email: result.email });
});

app.get("/api/auth/me", (req, res) => {
  res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  const session = getSession(req, res);
  if (!session) return res.status(401).json({ authenticated: false, sessionExpired: true });
  res.json({ authenticated: true, email: session.email, sessionHours: sessionDurationHours() });
});

app.post("/api/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// Páginas HTML protegidas (antes de static)
app.use((req, res, next) => {
  if (process.env.AUTH_DISABLED === "true") return next();
  if (req.method !== "GET") return next();
  const p = req.path.split("?")[0];
  if (!pageRequiresAuth(p)) return next();
  if (!getSession(req, res)) {
    const nextUrl = req.originalUrl || p;
    return redirectToLogin(res, nextUrl);
  }
  next();
});

// --- JobNimbus: jobs por zona (caché 3 min) · requiere sesión --------------
const jnCache = {};
const JN_CACHE_MS = 10 * 60 * 1000;

function jnReadOnlyGuard(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({
      error: "JobNimbus en Premier Sky es solo lectura. No se permiten crear, actualizar ni eliminar registros."
    });
    return false;
  }
  return true;
}

app.get("/api/jn/status", requireAuth, (req, res) => {
  if (!jnReadOnlyGuard(req, res)) return;
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ configured: jnConfigured(), readOnly: jnIsReadOnly() });
});

app.get("/api/jn/jobs", requireAuth, async (req, res) => {
  if (!jnReadOnlyGuard(req, res)) return;
  const zone = String(req.query.zone || "").toUpperCase();
  const fromDate = String(req.query.from || "").trim();
  const toDate = String(req.query.to || "").trim();
  const dateField = req.query.field === "date_created" ? "date_created" : "date_updated";
  res.set("Access-Control-Allow-Origin", "*");

  if (!jnConfigured()) {
    return res.status(503).json({
      error: "JOBNIMBUS_API_KEY no configurada. Edita server/.env y reinicia el servidor."
    });
  }

  const key = [zone, fromDate || "all", toDate || "all", dateField].join("|");
  try {
    if (jnCache[key] && Date.now() - jnCache[key].t < JN_CACHE_MS) {
      return res.json(jnCache[key].data);
    }
    const data = await fetchJobsForZone(zone, {
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      dateField
    });
    jnCache[key] = { t: Date.now(), data };
    res.json(data);
  } catch (e) {
    console.error("JobNimbus", zone, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Bloquear cualquier otra ruta /api/jn/* que no sea GET (por si se añade en el futuro)
app.all("/api/jn/*", (req, res, next) => {
  if (req.method === "GET") return next();
  res.status(405).json({
    error: "JobNimbus en Premier Sky es solo lectura. Operación no permitida."
  });
});

// --- Open-Meteo con caché (ahorra cuota gratuita) ---------------------------
app.get("/api/meteo/forecast", requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Parámetros lat y lon requeridos." });
  }
  try {
    const data = await fetchOpenMeteoForecast(lat, lon);
    res.json(data);
  } catch (e) {
    const is429 = String(e.message).includes("límite") || String(e.message).includes("429");
    res.status(is429 ? 429 : 502).json({ error: e.message });
  }
});

app.get("/api/meteo/precip-grid", requireAuth, async (req, res) => {
  const zone = String(req.query.zone || "").toUpperCase();
  const bbox = ZONE_BBOX[zone];
  if (!bbox) return res.status(400).json({ error: "Zona no válida" });
  const cols = Math.min(12, Math.max(4, parseInt(req.query.cols, 10) || 10));
  const rows = Math.min(10, Math.max(4, parseInt(req.query.rows, 10) || 8));
  try {
    const data = await fetchPrecipGrid(bbox, cols, rows);
    res.json(data);
  } catch (e) {
    const is429 = String(e.message).includes("límite") || String(e.message).includes("429");
    res.status(is429 ? 429 : 502).json({ error: e.message });
  }
});

// --- Puntuación de tormentas por zona (mapa · caché 5 min) ------------------
const stormScoreCache = {};
const STORM_SCORE_CACHE_MS = 5 * 60 * 1000;

app.get("/api/storm-score", requireAuth, async (req, res) => {
  const zone = String(req.query.zone || "").toUpperCase();
  if (!ZONE_BBOX[zone]) return res.status(400).json({ error: "Zona no válida" });
  const key = zone;
  if (stormScoreCache[key] && Date.now() - stormScoreCache[key].t < STORM_SCORE_CACHE_MS) {
    return res.json(stormScoreCache[key].data);
  }
  try {
    const data = await getZoneStormScores(zone);
    stormScoreCache[key] = { t: Date.now(), data };
    res.json(data);
  } catch (e) {
    console.error("Storm score API", zone, e.message);
    res.status(502).json({ error: e.message });
  }
});

// --- Historial de tormentas + PDF (JSON en server/data/) -------------------
app.get("/api/storm-history", requireAuth, (req, res) => {
  const zone = String(req.query.zone || "").toUpperCase() || undefined;
  const limit = req.query.limit;
  const from = req.query.from;
  const to = req.query.to;
  try {
    res.json(listStormHistory({ zone, limit, from, to }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/storm-history/:id", requireAuth, (req, res) => {
  const event = getStormEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  res.json(event);
});

app.get("/api/storm-history/:id/pdf", requireAuth, async (req, res) => {
  const event = getStormEvent(req.params.id);
  if (!event) return res.status(404).json({ error: "Evento no encontrado" });
  try {
    const pdf = await generateStormPdf(event);
    const safe = event.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="premier-sky-${safe}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error("PDF storm history", event.id, e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Exportación CSV (servidor · teléfono/email de clientes) ----------------
app.post("/api/export/storm", requireAuth, async (req, res) => {
  const type = String(req.body?.type || "");
  const zone = String(req.body?.zone || "").toUpperCase();
  const dateOpts = {};
  if (req.body?.from && req.body?.to) {
    dateOpts.fromDate = req.body.from;
    dateOpts.toDate = req.body.to;
    dateOpts.dateField = req.body.field === "date_created" ? "date_created" : "date_updated";
  }
  try {
    const result = await buildStormExport(type, zone, dateOpts, {
      csvFormat: req.body?.csvFormat
    });
    if (!result.ok) return res.status(400).json({ ok: false, message: result.message });
    const file = result.file;
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(Buffer.isBuffer(file.content) ? file.content : file.content);
  } catch (e) {
    console.error("Export", type, zone, e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// --- Proxy SPC con caché de 5 min ------------------------------------------
const spcCache = {};
app.get("/api/spc", async (req, res) => {
  const day = ["1", "2", "3", "4", "5", "6", "7", "8"].includes(req.query.day) ? req.query.day : "1";
  const type = ["cat", "hail", "torn", "wind", "prob"].includes(req.query.type) ? req.query.type : "cat";
  const key = `${day}_${type}`;
  // Day 4-8: solo existe el outlook probabilístico experimental.
  const url = (type === "prob" || parseInt(day) >= 4)
    ? `https://www.spc.noaa.gov/products/exper/day4-8/day${day}prob.nolyr.geojson`
    : `https://www.spc.noaa.gov/products/outlook/day${day}otlk_${type}.nolyr.geojson`;
  res.set("Access-Control-Allow-Origin", "*");
  try {
    if (spcCache[key] && Date.now() - spcCache[key].t < 5 * 60 * 1000) {
      return res.json(spcCache[key].data);
    }
    const r = await fetch(url, { headers: { "User-Agent": NWS_UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    spcCache[key] = { t: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "SPC no disponible: " + e.message });
  }
});

// --- Proxy del histórico de granizo (IEM Local Storm Reports) --------------
app.get("/api/lsr", async (req, res) => {
  const sts = String(req.query.sts || "");
  const ets = String(req.query.ets || "");
  const states = String(req.query.states || "").replace(/[^A-Za-z,]/g, "");
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const url = `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=${encodeURIComponent(sts)}&ets=${encodeURIComponent(ets)}&states=${states}`;
    const r = await fetch(url, { headers: { "User-Agent": NWS_UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: "LSR no disponible: " + e.message });
  }
});

// --- Proxy de reportes de granizo (Storm Reports CSV) con caché 5 min ------
const reportsCache = {};
app.get("/api/spc-reports", async (req, res) => {
  const period = ["today", "yesterday"].includes(req.query.period) ? req.query.period : "today";
  const url = `https://www.spc.noaa.gov/climo/reports/${period}_hail.csv`;
  res.set("Access-Control-Allow-Origin", "*");
  res.type("text/csv");
  try {
    if (reportsCache[period] && Date.now() - reportsCache[period].t < 5 * 60 * 1000) {
      return res.send(reportsCache[period].data);
    }
    const r = await fetch(url, { headers: { "User-Agent": NWS_UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.text();
    reportsCache[period] = { t: Date.now(), data };
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: "SPC reports no disponible: " + e.message });
  }
});

// --- Resumen de alertas NWS (home · caché 5 min · 1 llamada en lugar de 6) --
const alertsSummaryCache = { t: 0, data: null };
const ALERTS_SUMMARY_MS = 5 * 60 * 1000;

app.get("/api/alerts-summary", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (alertsSummaryCache.data && Date.now() - alertsSummaryCache.t < ALERTS_SUMMARY_MS) {
    return res.json(alertsSummaryCache.data);
  }
  const counts = {};
  await Promise.all(STATES.map(async (st) => {
    try {
      const r = await fetch(`https://api.weather.gov/alerts/active?area=${st}`, {
        headers: { Accept: "application/geo+json", "User-Agent": NWS_UA }
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      counts[st] = (data.features || []).length;
    } catch {
      counts[st] = null;
    }
  }));
  alertsSummaryCache.data = { counts, at: new Date().toISOString() };
  alertsSummaryCache.t = Date.now();
  res.json(alertsSummaryCache.data);
});

// Estado del monitor para el frontend
let lastPoll = null;
let lastNewCount = 0;
app.get("/api/monitor-status", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.json({
    active: true,
    mode: "storm-score",
    mail: mailProvider(),
    alertTo: ALERT_TO,
    pollMinutes: POLL_MS / 60000,
    lastPoll,
    lastNewCount,
    scoreTiers: {
      none: "0-39 pts · sin acción",
      review: "40-69 pts · revisar manualmente",
      campaign: "70+ pts · Meta (solo email por ahora)"
    }
  });
});

async function notifyScore(event) {
  const { subject, text, html } = formatScoreEmail(event);
  // Bloqueo: nunca enviar formato antiguo NWS ("Nueva alerta", Flood Watch, etc.)
  if (!subject.includes("Score") || text.includes("Nueva alerta ·")) {
    console.error("  ✗ Email bloqueado (formato antiguo NWS no permitido):", subject);
    return false;
  }
  if (!mailConfigured()) {
    console.log("  → SCORE (sin correo):", subject);
    return false;
  }
  try {
    await sendMail({ to: ALERT_TO, subject, text, html });
    console.log("  ✉ Email alerta tormenta:", subject);
    return true;
  } catch (e) {
    console.error("  ✗ Error enviando email:", e.message);
    return false;
  }
}

let scoreBaseline = !fs.existsSync(path.join(DATA_DIR, "scored-events.json"));

async function pollOnce() {
  lastPoll = new Date().toISOString();

  if (scoreBaseline) {
    scoreBaseline = false;
    await evaluateAllZones(STATES);
    console.log("Baseline: eventos activos registrados (no se notifica el backlog inicial).");
    return;
  }

  const events = await evaluateAllZones(STATES);
  lastNewCount = events.length;
  for (const ev of events) {
    const emailSent = await notifyScore(ev);
    try {
      await recordStormEvent(ev, { emailSent });
    } catch (e) {
      console.error("  ✗ Historial tormenta:", e.message);
    }
  }
  if (events.length) console.log(`${events.length} alerta(s) de tormenta registrada(s).`);
}

// Archivos estáticos (después de auth en páginas)
app.use(express.static(ROOT));

// --- Arranque --------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`StormTracker en  http://localhost:${PORT}`);
  console.log(`JobNimbus: ${jnConfigured() ? "API key cargada ✓" : "sin API key — edita server/.env"}`);
  console.log(`Monitor de tormentas cada ${POLL_MS / 60000} min · zonas: ${STATES.join(", ")}`);
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
