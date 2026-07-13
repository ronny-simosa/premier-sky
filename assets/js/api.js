// ===========================================================================
// Wrappers de las APIs públicas. Todas permiten peticiones desde el navegador
// (CORS abierto) y no requieren API key.
//   - NWS / NOAA:  https://api.weather.gov
//   - Open-Meteo:  https://api.open-meteo.com
//   - NOAA SPC:    https://www.spc.noaa.gov  (GeoJSON de outlooks)
//   - Nominatim:   geocodificación inversa para direcciones / zip codes
// ===========================================================================

const NWS_HEADERS = { Accept: "application/geo+json" };

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

// --- NWS: alertas activas por estado --------------------------------------
// Devuelve un FeatureCollection GeoJSON con las alertas activas.
async function getActiveAlerts(stateCode) {
  const url = `https://api.weather.gov/alerts/active?area=${stateCode}`;
  return fetchJSON(url, { headers: NWS_HEADERS });
}

// Resumen de alertas por estado (vía servidor · caché 5 min)
async function getAlertsSummary() {
  return fetchJSON("/api/alerts-summary");
}

// --- NWS: geometría de una zona (para alertas sin polígono propio) ---------
async function getZoneGeometry(zoneUrl) {
  try {
    const data = await fetchJSON(zoneUrl, { headers: NWS_HEADERS });
    return data.geometry || null;
  } catch (e) {
    return null;
  }
}

// --- NWS: pronóstico oficial a partir de lat/lon ---------------------------
async function getNWSForecast(lat, lon) {
  const point = await fetchJSON(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers: NWS_HEADERS }
  );
  const forecastUrl = point.properties.forecast;
  const rel = point.properties.relativeLocation?.properties;
  const forecast = await fetchJSON(forecastUrl, { headers: NWS_HEADERS });
  return {
    location: rel ? `${rel.city}, ${rel.state}` : null,
    periods: forecast.properties.periods
  };
}

// --- NWS como RESPALDO del clima (cuando Open-Meteo no responde) ------------
// Devuelve un objeto con la MISMA forma que Open-Meteo (current/daily/hourly)
// para que el renderizado no cambie. Usa api.weather.gov (sí tiene CORS).
function nwsTextToWmo(txt) {
  const t = (txt || "").toLowerCase();
  if (t.includes("thunder")) return 95;
  if (t.includes("snow") || t.includes("flurr") || t.includes("blizzard")) return 73;
  if (t.includes("sleet") || t.includes("freezing")) return 66;
  if (t.includes("shower") || t.includes("rain")) return 63;
  if (t.includes("drizzle")) return 53;
  if (t.includes("fog") || t.includes("haze") || t.includes("mist")) return 45;
  if (t.includes("cloud") || t.includes("overcast")) return 3;
  if (t.includes("partly") || t.includes("mostly sunny") || t.includes("mostly clear")) return 2;
  if (t.includes("sunny") || t.includes("clear")) return 0;
  return 1;
}
async function getNWSWeather(lat, lon) {
  const point = await fetchJSON(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers: NWS_HEADERS }
  );
  const props = point.properties;
  const [fc, hourly] = await Promise.all([
    fetchJSON(props.forecast, { headers: NWS_HEADERS }),
    fetchJSON(props.forecastHourly, { headers: NWS_HEADERS })
  ]);
  const periods = fc.properties.periods || [];
  const hp = hourly.properties.periods || [];

  // Actual = primer periodo horario
  const h0 = hp[0] || {};
  const current = {
    temperature_2m: h0.temperature ?? 0,
    relative_humidity_2m: h0.relativeHumidity?.value ?? "—",
    weather_code: nwsTextToWmo(h0.shortForecast),
    wind_speed_10m: parseInt(h0.windSpeed) || 0,
    precipitation: 0
  };

  // Horario (próximas 48 h)
  const hh = hp.slice(0, 48);
  const hourlyOut = {
    time: hh.map((p) => p.startTime),
    temperature_2m: hh.map((p) => p.temperature),
    wind_speed_10m: hh.map((p) => parseInt(p.windSpeed) || 0),
    precipitation_probability: hh.map((p) => p.probabilityOfPrecipitation?.value ?? 0),
    precipitation: hh.map(() => 0) // NWS horario no da cantidad; se deja en 0
  };

  // Diario: agrupa los periodos día/noche por fecha
  const byDate = {};
  const order = [];
  for (const p of periods) {
    const date = (p.startTime || "").slice(0, 10);
    if (!byDate[date]) { byDate[date] = { date, max: null, min: null, code: null, pop: 0, wind: 0 }; order.push(date); }
    const o = byDate[date];
    const pop = p.probabilityOfPrecipitation?.value ?? 0;
    o.pop = Math.max(o.pop, pop);
    o.wind = Math.max(o.wind, parseInt(p.windSpeed) || 0);
    if (p.isDaytime) { o.max = p.temperature; o.code = nwsTextToWmo(p.shortForecast); }
    else { o.min = p.temperature; if (o.code == null) o.code = nwsTextToWmo(p.shortForecast); }
  }
  const days = order.map((d) => byDate[d]).slice(0, 7);
  const daily = {
    time: days.map((d) => d.date),
    weather_code: days.map((d) => d.code ?? 0),
    temperature_2m_max: days.map((d) => d.max ?? d.min ?? 0),
    temperature_2m_min: days.map((d) => d.min ?? d.max ?? 0),
    precipitation_sum: days.map(() => 0),
    precipitation_probability_max: days.map((d) => d.pop),
    wind_speed_10m_max: days.map((d) => d.wind),
    wind_gusts_10m_max: days.map((d) => d.wind)
  };

  return { current, daily, hourly: hourlyOut, _source: "NWS" };
}

// --- Open-Meteo: proyección diaria a 7 días (vía proxy + caché local) -----
const METEO_CLIENT_TTL_MS = 45 * 60 * 1000;
const meteoClientCache = new Map();

function meteoCacheKey(lat, lon) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
}

async function getOpenMeteoForecast(lat, lon) {
  const ck = meteoCacheKey(lat, lon);
  const hit = meteoClientCache.get(ck);
  if (hit && Date.now() - hit.t < METEO_CLIENT_TTL_MS) return hit.data;

  const qs = new URLSearchParams({
    lat: String(lat),
    lon: String(lon)
  });
  const res = await fetch(`/api/meteo/forecast?${qs}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    redirectToLogin(true);
    throw new Error("Sesión expirada");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  meteoClientCache.set(ck, { t: Date.now(), data });
  return data;
}

// --- NOAA SPC: outlook convectivo categórico (Day 1) -----------------------
// El SPC publica GeoJSON. Si el CORS falla se devuelve null y se omite la capa.
async function getSPCOutlook(day = 1) {
  // 1º intenta el proxy local (sirve con CORS); 2º intenta el SPC directo.
  const candidates = [
    `/api/spc?day=${day}`,
    `https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.nolyr.geojson`
  ];
  for (const url of candidates) {
    try {
      const data = await fetchJSON(url);
      if (data && data.features) return data;
    } catch (e) {
      console.warn("SPC intento fallido:", url, e.message);
    }
  }
  return null;
}

// --- NOAA SPC: outlook PROYECTADO por día (1 a 8) --------------------------
// Day 1-3: outlook categórico (TSTM/MRGL/SLGT/ENH/MDT/HIGH).
// Day 4-8: outlook probabilístico experimental (% de tiempo severo combinado).
// Devuelve { kind: "cat" | "prob", data: GeoJSON } o null.
async function getProjectionOutlook(day = 1) {
  const d = Math.max(1, Math.min(8, parseInt(day) || 1));
  let kind, candidates;
  if (d <= 3) {
    kind = "cat";
    candidates = [
      `/api/spc?day=${d}&type=cat`,
      `https://www.spc.noaa.gov/products/outlook/day${d}otlk_cat.nolyr.geojson`
    ];
  } else {
    kind = "prob";
    candidates = [
      `/api/spc?day=${d}&type=prob`,
      `https://www.spc.noaa.gov/products/exper/day4-8/day${d}prob.nolyr.geojson`
    ];
  }
  for (const url of candidates) {
    try {
      const data = await fetchJSON(url);
      if (data && data.features) return { kind, data };
    } catch (e) {
      console.warn("SPC proyección fallida:", url, e.message);
    }
  }
  return { kind, data: null };
}

// --- Rejilla de precipitación PRONOSTICADA (radar simulado / mapa de calor) -
// Construye una malla de cols×rows puntos sobre el bbox del estado y pide a
// Open-Meteo la precipitación horaria de todos en UNA sola petición (bulk).
// Devuelve { cols, rows, bbox, times:[ISO...], cells:[{lat,lon,precip:[mm...]}] }.
// bbox = [west, south, east, north]. precip está en mm/h.
async function getPrecipGrid(zoneOrBbox, cols = 10, rows = 8, hours = 24) {
  const zone = typeof zoneOrBbox === "string" ? zoneOrBbox.toUpperCase() : null;
  if (zone) {
    const qs = new URLSearchParams({
      zone,
      cols: String(cols),
      rows: String(rows)
    });
    const res = await fetch(`/api/meteo/precip-grid?${qs}`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      redirectToLogin(true);
      throw new Error("Sesión expirada");
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (hours < 24 && data.cells) {
      return {
        ...data,
        cells: data.cells.map((c) => ({
          ...c,
          precip: (c.precip || []).slice(0, hours)
        }))
      };
    }
    return data;
  }

  const bbox = zoneOrBbox;
  const [west, south, east, north] = bbox;
  const cellW = (east - west) / cols;
  const cellH = (north - south) / rows;
  const lats = [], lons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lats.push(+(south + (r + 0.5) * cellH).toFixed(4));
      lons.push(+(west + (c + 0.5) * cellW).toFixed(4));
    }
  }
  const params = new URLSearchParams({
    latitude: lats.join(","),
    longitude: lons.join(","),
    hourly: "precipitation",
    forecast_days: "2",
    timezone: "auto",
    precipitation_unit: "mm"
  });
  // Nota: preferir export vía servidor (caché). Esta ruta directa queda como respaldo.
  const res = await fetchJSON(`https://api.open-meteo.com/v1/forecast?${params}`);
  const arr = Array.isArray(res) ? res : [res];
  // Recorta a las próximas `hours` horas desde la hora actual del primer punto.
  const t0 = arr[0] && arr[0].hourly ? arr[0].hourly.time : [];
  const nowMs = Date.now();
  let start = t0.findIndex((t) => new Date(t).getTime() >= nowMs - 3600000);
  if (start < 0) start = 0;
  const end = Math.min(t0.length, start + hours);
  const times = t0.slice(start, end);
  const cells = arr.map((o, i) => ({
    lat: lats[i],
    lon: lons[i],
    precip: (o.hourly && o.hourly.precipitation ? o.hourly.precipitation : []).slice(start, end)
  }));
  return { cols, rows, bbox, times, cells };
}

// --- NOAA SPC: probabilidad de granizo PRONOSTICADO (outlook) --------------
// GeoJSON con zonas de % de probabilidad de granizo (5/15/30/45/60 + SIGN).
async function getHailOutlook(day = 1) {
  const candidates = [
    `/api/spc?day=${day}&type=hail`,
    `https://www.spc.noaa.gov/products/outlook/day${day}otlk_hail.nolyr.geojson`
  ];
  for (const url of candidates) {
    try {
      const data = await fetchJSON(url);
      if (data && data.features) return data;
    } catch (e) {
      console.warn("SPC hail outlook fallido:", url, e.message);
    }
  }
  return null;
}

// --- NOAA SPC: reportes de granizo YA OCURRIDO (Storm Reports CSV) ----------
// Devuelve [{time, sizeIn, location, county, state, lat, lon, comments}].
async function getHailReports(period = "today") {
  const p = ["today", "yesterday"].includes(period) ? period : "today";
  const candidates = [
    `/api/spc-reports?period=${p}`,
    `https://www.spc.noaa.gov/climo/reports/${p}_hail.csv`
  ];
  let text = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      if (text) break;
    } catch (e) {
      console.warn("SPC reports fallido:", url, e.message);
    }
  }
  return text ? parseHailCSV(text) : [];
}

// Parsea el CSV de reportes (Size viene en centésimas de pulgada: 175 = 1.75").
function parseHailCSV(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^time\s*,/i.test(line)) continue; // saltar cabeceras
    const parts = line.split(",");
    if (parts.length < 7) continue;
    const lat = parseFloat(parts[5]);
    const lon = parseFloat(parts[6]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push({
      time: parts[0],
      sizeIn: (parseInt(parts[1], 10) || 0) / 100,
      location: parts[2],
      county: parts[3],
      state: parts[4],
      lat,
      lon,
      comments: parts.slice(7).join(",")
    });
  }
  return out;
}

// --- Histórico de granizo (IEM Local Storm Reports) ------------------------
// opts: { days } (últimos N días) ó { from, to } (YYYY-MM-DD). Devuelve
// [{time, sizeIn, location, county, state, lat, lon, remark, source}].
async function getHailHistory(stateCode, opts = {}) {
  let start, end;
  if (opts.from && opts.to) {
    start = new Date(opts.from + "T00:00Z");
    end = new Date(opts.to + "T23:59Z");
  } else {
    const days = opts.days || 30;
    end = new Date();
    start = new Date(end.getTime() - days * 86400000);
  }
  const fmt = (d) => d.toISOString().slice(0, 16) + "Z"; // YYYY-MM-DDTHH:MMZ
  const qs = `sts=${fmt(start)}&ets=${fmt(end)}&states=${encodeURIComponent(stateCode)}`;
  const candidates = [
    `/api/lsr?${qs}`,
    `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?${qs}`
  ];
  let data = null;
  for (const url of candidates) {
    try {
      data = await fetchJSON(url);
      if (data && data.features) break;
    } catch (e) {
      console.warn("LSR histórico fallido:", url, e.message);
    }
  }
  if (!data || !data.features) return [];
  const out = [];
  for (const f of data.features) {
    const p = f.properties || {};
    if (p.type !== "H") continue; // solo reportes de granizo
    const coords = (f.geometry && f.geometry.coordinates) || [p.lon, p.lat];
    const lon = parseFloat(coords[0]);
    const lat = parseFloat(coords[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push({
      time: p.valid,
      sizeIn: typeof p.magf === "number" ? p.magf : parseFloat(p.magf) || 0,
      location: p.city || "",
      county: p.county || "",
      state: p.state || stateCode,
      lat,
      lon,
      remark: p.remark || "",
      source: p.source || ""
    });
  }
  out.sort((a, b) => (b.time || "").localeCompare(a.time || "")); // más reciente primero
  return out;
}

// --- Nominatim: geocodificación inversa (dirección + zip) ------------------
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
  try {
    const data = await fetchJSON(url, { headers: { Accept: "application/json" } });
    return data;
  } catch (e) {
    return null;
  }
}

// --- Zippopotam: buscar coordenadas a partir de un zip code de EE.UU. -------
async function geocodeZip(zip) {
  const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
  const data = await fetchJSON(url);
  const place = data.places[0];
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    name: `${place["place name"]}, ${data["country abbreviation"]} ${data["post code"]}`
  };
}

// Texto descriptivo del weather_code de Open-Meteo (WMO) — localized via i18n
const WMO_FALLBACK_EN = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail"
};
function wmoText(code) {
  const key = `weather.wmo.${code}`;
  if (window.I18n) {
    const v = window.I18n.t(key);
    if (v && v !== key) return v;
  }
  return WMO_FALLBACK_EN[code] || "—";
}
function wmoEmoji(code) {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([66, 67].includes(code)) return "🌧️❄️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

// --- JobNimbus (vía proxy local /api/jn) · SOLO LECTURA --------------------
// Premier Sky no expone ni implementa crear/actualizar/eliminar en JobNimbus.
function redirectToLogin(sessionExpired) {
  // Never sticky ?next=/contract.html — role home is decided by the server after OTP.
  let path = location.pathname + location.search;
  if (location.pathname === "/contract.html" || location.pathname === "/login.html") {
    path = "/index.html";
  }
  const next = encodeURIComponent(path);
  const extra = sessionExpired ? "&expired=1" : "";
  location.href = `/login.html?next=${next}${extra}`;
}

async function getJNJobs(zone, opts = {}) {
  const qs = new URLSearchParams({ zone });
  if (opts.from && opts.to) {
    qs.set("from", opts.from);
    qs.set("to", opts.to);
    if (opts.field) qs.set("field", opts.field);
  }
  const res = await fetch(`/api/jn/jobs?${qs}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    redirectToLogin(data.sessionExpired);
    throw new Error("Sesión expirada");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getJNStatus() {
  try {
    const res = await fetch("/api/jn/status", { credentials: "include" });
    if (res.status === 401) {
      redirectToLogin(true);
      return { configured: false };
    }
    if (!res.ok) return { configured: false };
    return res.json();
  } catch {
    return { configured: false };
  }
}

async function getAuthMe() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  const data = await res.json().catch(() => ({ authenticated: false }));
  if (res.status === 401) return { authenticated: false, sessionExpired: true };
  return data;
}

async function logoutAuth() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  location.href = "/login.html";
}

/** Exportación CSV en servidor (teléfono + email de clientes). */
async function exportStormList(type, zone, dateOpts = {}, csvFormat = "excel") {
  const body = { type, zone, csvFormat };
  if (dateOpts.from && dateOpts.to) {
    body.from = dateOpts.from;
    body.to = dateOpts.to;
    body.field = dateOpts.field;
  }
  const res = await fetch("/api/export/storm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  if (res.status === 401) {
    redirectToLogin(true);
    throw new Error("Sesión expirada");
  }
  const ct = res.headers.get("Content-Type") || "";
  if (ct.includes("text/csv") || ct.includes("spreadsheetml")) {
    const blob = await res.blob();
    const disp = res.headers.get("Content-Disposition") || "";
    const m = disp.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : `premier-sky-${zone}-export.${ct.includes("spreadsheetml") ? "xlsx" : "csv"}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { ok: true, message: "Descarga iniciada." };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: false, message: data.message || data.error || `Error ${res.status}` };
}

async function getStormScores(zone) {
  const z = String(zone || "").toUpperCase();
  const res = await fetch(`/api/storm-score?zone=${encodeURIComponent(z)}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    redirectToLogin(true);
    throw new Error("Sesión expirada");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getStormHistory(zone, limit = 30) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (zone) params.set("zone", zone);
  const res = await fetch(`/api/storm-history?${params}`, { credentials: "include" });
  if (res.status === 401) {
    redirectToLogin(true);
    throw new Error("Sesión expirada");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error al cargar historial");
  return data;
}

async function downloadStormHistoryPdf(id) {
  const res = await fetch(`/api/storm-history/${encodeURIComponent(id)}/pdf`, { credentials: "include" });
  if (res.status === 401) {
    redirectToLogin(true);
    throw new Error("Sesión expirada");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Error al generar PDF");
  }
  const blob = await res.blob();
  const disp = res.headers.get("Content-Disposition") || "";
  const m = disp.match(/filename="([^"]+)"/);
  const filename = m ? m[1] : `premier-sky-${id}.pdf`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { ok: true, message: "PDF descargado" };
}

window.WeatherAPI = {
  getActiveAlerts,
  getAlertsSummary,
  getZoneGeometry,
  getNWSForecast,
  getOpenMeteoForecast,
  getNWSWeather,
  getSPCOutlook,
  getProjectionOutlook,
  getPrecipGrid,
  getHailOutlook,
  getHailReports,
  getHailHistory,
  reverseGeocode,
  geocodeZip,
  wmoText,
  wmoEmoji,
  getJNJobs,
  getJNStatus,
  getAuthMe,
  logoutAuth,
  redirectToLogin,
  exportStormList,
  getStormScores,
  getStormHistory,
  downloadStormHistoryPdf
};
