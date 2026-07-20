// ===========================================================================
// Historial de tormentas · persistencia en JSON (sin base de datos)
//   server/data/storm-history.json — portable local / servidor
// ===========================================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { collectLeadsNearStorm } from "./storm-export.js";
import { actionLabel, localizeBreakdownVariable } from "./storm-score.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "storm-history.json");
const MAX_EVENTS = parseInt(process.env.STORM_HISTORY_MAX, 10) || 500;
const RETENTION_DAYS = parseInt(process.env.STORM_HISTORY_RETENTION_DAYS, 10) || 365;
const HAIL_RADIUS_MI = 22;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Elimina por fecha (más antiguos primero) y luego por capacidad máxima. */
function pruneEvents(events) {
  let list = Array.isArray(events) ? events : [];
  if (RETENTION_DAYS > 0) {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600000;
    const before = list.length;
    list = list.filter((e) => {
      const t = new Date(e.recordedAt).getTime();
      return isFinite(t) && t >= cutoff;
    });
    const byDate = before - list.length;
    if (byDate > 0) {
      console.log(`Storm history: ${byDate} evento(s) eliminado(s) · antigüedad > ${RETENTION_DAYS} días`);
    }
  }
  if (list.length > MAX_EVENTS) {
    const dropped = list.length - MAX_EVENTS;
    list = list.slice(0, MAX_EVENTS);
    console.log(`Storm history: ${dropped} evento(s) eliminado(s) · capacidad máxima ${MAX_EVENTS}`);
  }
  return list;
}

export function stormHistoryPolicy() {
  return {
    maxEvents: MAX_EVENTS,
    retentionDays: RETENTION_DAYS > 0 ? RETENTION_DAYS : null
  };
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(HISTORY_FILE)) return { version: 1, events: [] };
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (!Array.isArray(data.events)) return { version: 1, events: [] };
    const before = data.events.length;
    data.events = pruneEvents(data.events);
    if (data.events.length < before) saveStore(data);
    return data;
  } catch {
    return { version: 1, events: [] };
  }
}

function saveStore(store) {
  ensureDataDir();
  store.events = pruneEvents(store.events);
  const tmp = HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, HISTORY_FILE);
}

function newId(zone) {
  const slug = crypto.randomBytes(3).toString("hex");
  return `${new Date().toISOString().slice(0, 10)}-${zone}-${slug}`;
}

/** Registra un evento de tormenta con snapshot de leads afectados. */
export async function recordStormEvent(event, { emailSent = false } = {}) {
  const { zone, lat, lon, score } = event;
  let leads = [];
  try {
    leads = await collectLeadsNearStorm(zone, lat, lon);
  } catch (e) {
    console.error("Storm history · leads:", e.message);
  }

  const record = {
    id: newId(zone),
    recordedAt: new Date().toISOString(),
    zone,
    lat,
    lon,
    label: score.label || "",
    alertId: event.alertId || null,
    score: {
      total: score.total,
      tier: score.tier,
      breakdown: score.breakdown || [],
      hailIn: score.hailIn ?? null,
      windMph: score.windMph ?? null,
      homeCount: score.homeCount ?? leads.length,
      leads: score.leads ?? null,
      estimates: score.estimates ?? null
    },
    radiusMi: HAIL_RADIUS_MI,
    leadCount: leads.length,
    leads,
    emailSent: !!emailSent
  };

  const store = loadStore();
  store.events.unshift(record);
  saveStore(store);
  console.log(`  📁 Historial: ${record.id} · ${zone} · score ${score.total} · ${leads.length} lead(s)`);
  return record;
}

export function listStormHistory({ zone, limit = 50, from, to } = {}) {
  const store = loadStore();
  let events = store.events;
  const z = zone ? String(zone).toUpperCase() : "";
  if (z) events = events.filter((e) => e.zone === z);
  if (from) {
    const t0 = new Date(from).getTime();
    if (isFinite(t0)) events = events.filter((e) => new Date(e.recordedAt).getTime() >= t0);
  }
  if (to) {
    const t1 = new Date(to).getTime();
    if (isFinite(t1)) events = events.filter((e) => new Date(e.recordedAt).getTime() <= t1);
  }
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return {
    total: events.length,
    policy: stormHistoryPolicy(),
    events: events.slice(0, cap).map(summarizeEvent)
  };
}

export function getStormEvent(id) {
  const store = loadStore();
  return store.events.find((e) => e.id === id) || null;
}

function summarizeEvent(e) {
  return {
    id: e.id,
    recordedAt: e.recordedAt,
    zone: e.zone,
    lat: e.lat,
    lon: e.lon,
    label: e.label,
    scoreTotal: e.score?.total,
    tier: e.score?.tier,
    leadCount: e.leadCount ?? e.leads?.length ?? 0,
    emailSent: !!e.emailSent
  };
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return iso;
  }
}

/** Generate storm report PDF + affected leads (English). */
export function generateStormPdf(event) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "LETTER" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const tier = event.score?.tier || "none";
    const tierLabel = actionLabel(tier);

    doc.fontSize(18).fillColor("#1a1a2e").text("Premier Sky · Storm Report", { align: "left" });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#666").text(`Generated: ${fmtDate(new Date().toISOString())}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor("#000");
    doc.text(`ID: ${event.id}`);
    doc.text(`Event date: ${fmtDate(event.recordedAt)}`);
    doc.text(`Zone: ${event.zone}`);
    doc.text(`Location: ${event.lat?.toFixed(4)}, ${event.lon?.toFixed(4)}`);
    if (event.label) doc.text(`Event: ${event.label}`);
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor("#c1121f").text(`Score: ${event.score?.total ?? "—"} · ${tierLabel}`);
    doc.fillColor("#000").fontSize(11);
    doc.moveDown(0.5);

    if (event.score?.hailIn) doc.text(`Reported hail: ${event.score.hailIn}"`);
    if (event.score?.windMph) doc.text(`Wind: ${event.score.windMph} mph`);
    doc.text(`Impact radius: ${event.radiusMi || HAIL_RADIUS_MI} miles`);
    doc.text(`Affected leads: ${event.leadCount ?? event.leads?.length ?? 0}`);
    doc.moveDown(0.8);

    doc.fontSize(13).text("Score breakdown", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);
    for (const b of event.score?.breakdown || []) {
      doc.text(`  • ${localizeBreakdownVariable(b.variable)}: +${b.points}`);
    }
    doc.moveDown(1);

    const leads = event.leads || [];
    doc.fontSize(13).text(`Affected leads (${leads.length})`, { underline: true });
    doc.moveDown(0.4);

    if (!leads.length) {
      doc.fontSize(10).fillColor("#666").text("No leads with coordinates were inside the radius at the time of recording.");
    } else {
      const maxRows = 80;
      const shown = leads.slice(0, maxRows);
      doc.fontSize(8).fillColor("#000");

      for (const L of shown) {
        if (doc.y > doc.page.height - 72) doc.addPage();
        doc.font("Helvetica-Bold").text(`#${L.priority} · ${L.name || L.customer || "Unnamed"}`, { continued: false });
        doc.font("Helvetica");
        const line1 = [
          L.phase && `Phase: ${L.phase}`,
          L.distMi != null && `${L.distMi} mi`,
          L.score && `Score ${L.score}`
        ].filter(Boolean).join(" · ");
        if (line1) doc.text(line1);
        if (L.address) doc.text(L.address);
        const contact = [L.phone && `Phone: ${L.phone}`, L.email && `Email: ${L.email}`].filter(Boolean).join(" · ");
        if (contact) doc.text(contact);
        doc.moveDown(0.35);
      }
      if (leads.length > maxRows) {
        doc.moveDown(0.3).fillColor("#666").text(`… and ${leads.length - maxRows} more lead(s) (see CSV or app).`);
      }
    }

    doc.moveDown(1);
    doc.fontSize(8).fillColor("#999").text(
      "Document generated by Premier Sky. Lead data is a snapshot at the time of the event.",
      { align: "center" }
    );

    doc.end();
  });
}
