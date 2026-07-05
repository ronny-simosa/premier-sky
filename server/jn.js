// ===========================================================================
// Cliente JobNimbus · SOLO LECTURA (read-only)
// ===========================================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZIP_CACHE_PATH = path.join(__dirname, "data", "zip-geo-cache.json");
const GEO_CONCURRENCY = parseInt(process.env.JN_GEO_CONCURRENCY, 10) || 24;

const JN_BASE = (process.env.JOBNIMBUS_API_URL || "https://app.jobnimbus.com/api1").replace(/\/$/, "");

/** Endpoints permitidos (whitelist). Solo listados GET de jobs y contacts. */
const JN_ALLOWED_GET_ENDPOINTS = new Set(["jobs", "contacts"]);

/** Campos que se exponen al frontend (whitelist — nada sensible extra). */
const JN_PUBLIC_JOB_FIELDS = new Set([
  "jnid", "name", "customer", "status", "recordType",
  "address", "city", "state", "zip", "lat", "lon",
  "contactId", "contactName", "dateCreated", "dateUpdated", "jnUrl"
]);

/** Estados que pertenecen a cada zona Premier Sky */
const ZONE_STATES = {
  IL: ["IL"],
  DC: ["DC"],
  VA: ["VA"],
  WI: ["WI"],
  MD: ["MD"],
  FL: ["FL"]
};

const zipGeoCache = new Map();
let zipCacheDirty = false;
let zipCacheSaveTimer = null;

(function loadZipGeoCache() {
  try {
    if (!fs.existsSync(ZIP_CACHE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(ZIP_CACHE_PATH, "utf8"));
    for (const [z, geo] of Object.entries(raw)) {
      if (geo?.lat != null && geo?.lon != null) zipGeoCache.set(z, geo);
    }
    console.log(`✓ Caché zip geocoding: ${zipGeoCache.size} códigos`);
  } catch (e) {
    console.warn("⚠ Caché zip geocoding no cargada:", e.message);
  }
})();

function scheduleZipCacheSave() {
  if (zipCacheSaveTimer) return;
  zipCacheSaveTimer = setTimeout(() => {
    zipCacheSaveTimer = null;
    if (!zipCacheDirty) return;
    zipCacheDirty = false;
    try {
      fs.mkdirSync(path.dirname(ZIP_CACHE_PATH), { recursive: true });
      fs.writeFileSync(ZIP_CACHE_PATH, JSON.stringify(Object.fromEntries(zipGeoCache)));
    } catch (e) {
      console.warn("⚠ No se pudo guardar caché zip:", e.message);
    }
  }, 2000);
}

function normalizeZip(zip) {
  return String(zip || "").replace(/\D/g, "").slice(0, 5);
}

async function runPool(items, concurrency, fn) {
  if (!items.length) return;
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, worker));
}

async function jnFetch(endpoint, query = {}) {
  const key = process.env.JOBNIMBUS_API_KEY;
  if (!key) throw new Error("JOBNIMBUS_API_KEY no configurada en server/.env");

  const path = String(endpoint || "").replace(/^\//, "").split("?")[0];
  const root = path.split("/")[0];
  if (!JN_ALLOWED_GET_ENDPOINTS.has(root)) {
    throw new Error(`JobNimbus: endpoint no permitido (solo lectura): ${path}`);
  }

  const url = new URL(`${JN_BASE}/${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }

  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    if (r.status === 401) {
      throw new Error(
        "JobNimbus rechazó la API key (401). Verifica en JobNimbus: Settings → API → New API Key, " +
        "copia la key completa en JOBNIMBUS_API_KEY y reinicia el servidor."
      );
    }
    throw new Error(`JobNimbus HTTP ${r.status}${body ? ": " + body.slice(0, 180) : ""}`);
  }
  return r.json();
}

async function geocodeZip(zip) {
  const z = normalizeZip(zip);
  if (z.length < 5) return null;
  if (zipGeoCache.has(z)) return zipGeoCache.get(z);

  try {
    const r = await fetch(`https://api.zippopotam.us/us/${z}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    const place = data.places?.[0];
    if (!place) return null;
    const geo = { lat: parseFloat(place.latitude), lon: parseFloat(place.longitude) };
    if (!isFinite(geo.lat) || !isFinite(geo.lon)) return null;
    zipGeoCache.set(z, geo);
    zipCacheDirty = true;
    scheduleZipCacheSave();
    return geo;
  } catch {
    return null;
  }
}

function pickCoord(job) {
  const lat = job.geo?.lat ?? job.latitude;
  const lon = job.geo?.lon ?? job.longitude;
  const nlat = typeof lat === "number" ? lat : parseFloat(lat);
  const nlon = typeof lon === "number" ? lon : parseFloat(lon);
  if (isFinite(nlat) && isFinite(nlon) && (nlat !== 0 || nlon !== 0)) {
    return { lat: nlat, lon: nlon };
  }
  return null;
}

function normalizeJob(raw, { forExport = false } = {}) {
  const coord = pickCoord(raw);
  const job = {
    jnid: raw.jnid,
    name: raw.name || raw.customer || "Sin nombre",
    customer: raw.customer || "",
    status: raw.status_name || raw.status || "Sin estado",
    recordType: raw.record_type_name || "",
    address: [raw.address_line1, raw.address_line2].filter(Boolean).join(" "),
    city: raw.city || "",
    state: raw.state_text || "",
    zip: raw.zip || "",
    lat: coord?.lat ?? null,
    lon: coord?.lon ?? null,
    contactId: raw.primary?.id || raw.contact_id || null,
    contactName: raw.primary?.name || raw.contact_name || "",
    dateCreated: raw.date_created || null,
    dateUpdated: raw.date_updated || null,
    jnUrl: `https://app.jobnimbus.com/job/${raw.jnid}`
  };
  // Whitelist final: nunca reenviar teléfonos, emails, notas, custom fields, etc.
  const safe = {};
  for (const k of JN_PUBLIC_JOB_FIELDS) {
    if (k in job) safe[k] = job[k];
  }
  if (forExport) {
    safe.fallbackPhone = String(raw.parent_home_phone || "").trim();
  }
  return safe;
}

/** Construye filtro JN: estado + rango de fechas opcional (unix segundos). */
function buildJobsFilter(state, dateRange, dateField = "date_updated") {
  const must = [{ term: { state_text: state } }];
  if (dateRange) {
    const field = dateField === "date_created" ? "date_created" : "date_updated";
    must.push({ range: { [field]: { gte: dateRange.gte, lte: dateRange.lte } } });
  }
  return JSON.stringify({ must });
}

function parseDateRange(fromStr, toStr) {
  const from = String(fromStr || "").trim();
  const to = String(toStr || "").trim();
  if (!from || !to) return null;
  const gte = Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000);
  const lte = Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000);
  if (!isFinite(gte) || !isFinite(lte) || gte > lte) {
    throw new Error("Rango de fechas inválido");
  }
  return { gte, lte, from, to };
}

/** Trae jobs de los estados de una zona (paginado). */
async function fetchRawJobsForStates(states, dateRange, dateField) {
  const all = [];
  const seen = new Set();

  for (const state of states) {
    let from = 0;
    const size = 1000;
    const filter = buildJobsFilter(state, dateRange, dateField);

    while (from < 10000) {
      const data = await jnFetch("jobs", {
        filter,
        from,
        size,
        sort_field: dateField === "date_created" ? "date_created" : "date_updated",
        sort_direction: "desc"
      });

      const batch = data.results || [];
      for (const job of batch) {
        if (!job.jnid || seen.has(job.jnid)) continue;
        seen.add(job.jnid);
        all.push(job);
      }

      if (batch.length < size) break;
      from += size;
    }
  }

  return all;
}

/** Geocodifica zips únicos en paralelo (antes: 1 HTTP por job, secuencial). */
async function enrichCoords(jobs) {
  const zipToGeo = new Map();
  const pendingZips = new Set();

  for (const job of jobs) {
    if (job.lat != null && job.lon != null) continue;
    const z = normalizeZip(job.zip);
    if (z.length < 5) continue;
    if (zipGeoCache.has(z)) zipToGeo.set(z, zipGeoCache.get(z));
    else pendingZips.add(z);
  }

  const zips = [...pendingZips];
  if (zips.length) {
    const t0 = Date.now();
    await runPool(zips, GEO_CONCURRENCY, async (z) => {
      const geo = await geocodeZip(z);
      if (geo) zipToGeo.set(z, geo);
    });
    console.info(`[jn] geocoding ${zips.length} zips únicos en ${Date.now() - t0}ms`);
  }

  return jobs.map((job) => {
    if (job.lat != null && job.lon != null) return job;
    const geo = zipToGeo.get(normalizeZip(job.zip));
    if (geo) return { ...job, lat: geo.lat, lon: geo.lon, _geocodedFromZip: true };
    return job;
  });
}

export async function fetchJobsForStormExport(zoneCode, options = {}) {
  const zone = String(zoneCode || "").toUpperCase();
  const states = ZONE_STATES[zone];
  if (!states) throw new Error(`Zona no válida: ${zone}`);

  const dateField = options.dateField === "date_created" ? "date_created" : "date_updated";
  const dateRange = options.fromDate && options.toDate
    ? parseDateRange(options.fromDate, options.toDate)
    : null;

  const raw = await fetchRawJobsForStates(states, dateRange, dateField);
  let jobs = raw.map((r) => normalizeJob(r, { forExport: true }));
  jobs = await enrichCoords(jobs);
  return jobs;
}

export async function fetchJobsForZone(zoneCode, options = {}) {
  const zone = String(zoneCode || "").toUpperCase();
  const states = ZONE_STATES[zone];
  if (!states) throw new Error(`Zona no válida: ${zone}`);

  const dateField = options.dateField === "date_created" ? "date_created" : "date_updated";
  let dateRange = options.fromDate && options.toDate
    ? parseDateRange(options.fromDate, options.toDate)
    : null;

  const allMonths = parseInt(process.env.JN_ALL_MONTHS, 10);
  if (!dateRange && allMonths > 0) {
    const to = new Date();
    const from = new Date(to);
    from.setMonth(from.getMonth() - allMonths);
    dateRange = parseDateRange(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
  }

  const t0 = Date.now();
  const raw = await fetchRawJobsForStates(states, dateRange, dateField);
  console.info(`[jn] ${zone} API ${raw.length} jobs en ${Date.now() - t0}ms`);
  let jobs = raw.map(normalizeJob);
  jobs = await enrichCoords(jobs);

  const byStatus = {};
  let withCoords = 0;
  for (const j of jobs) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    if (j.lat != null && j.lon != null) withCoords++;
  }

  return {
    zone,
    states,
    total: jobs.length,
    withCoords,
    withoutCoords: jobs.length - withCoords,
    byStatus,
    jobs,
    dateFilter: dateRange
      ? {
          from: dateRange.from,
          to: dateRange.to,
          field: dateField,
          capped: !options.fromDate && allMonths > 0 ? allMonths : null
        }
      : null
  };
}

export function jnConfigured() {
  return !!process.env.JOBNIMBUS_API_KEY;
}

/** Siempre true — esta integración no implementa escrituras a JobNimbus. */
export function jnIsReadOnly() {
  return true;
}

const contactCache = new Map();

/** Extrae teléfono y email del objeto contacto JobNimbus. */
function pickContactFields(data) {
  if (!data || typeof data !== "object") return { email: "", phone: "" };
  const email = String(data.email || "").trim();
  const phones = [
    data.mobile_phone, data.mobilePhone,
    data.work_phone, data.workPhone,
    data.home_phone, data.homePhone,
    data.phone, data.fax_number, data.faxNumber
  ].map((p) => String(p || "").trim()).filter(Boolean);
  return { email, phone: phones[0] || "" };
}

/** Contacto primario de un job (solo campos de contacto, read-only). */
export async function fetchContactPhonesEmail(contactId) {
  const id = String(contactId || "").trim();
  if (!id) return { email: "", phone: "" };
  if (contactCache.has(id)) return contactCache.get(id);

  try {
    const data = await jnFetch(`contacts/${id}`);
    const out = pickContactFields(data);
    contactCache.set(id, out);
    return out;
  } catch (e) {
    console.warn("JobNimbus contact", id, e.message);
    return { email: "", phone: "" };
  }
}

export { ZONE_STATES, parseDateRange, geocodeZip as jnGeocodeZip };
