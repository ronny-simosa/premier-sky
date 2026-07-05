// ===========================================================================
// Open-Meteo · proxy con caché (ahorra cuota del plan gratuito)
// Opcional: OPEN_METEO_API_KEY → customer-api.open-meteo.com
// ===========================================================================

const METEO_FREE = "https://api.open-meteo.com/v1/forecast";
const METEO_PAID = "https://customer-api.open-meteo.com/v1/forecast";
const FORECAST_CACHE_MS = 45 * 60 * 1000;
const GRID_CACHE_MS = 60 * 60 * 1000;

const forecastCache = new Map();
const gridCache = new Map();

function meteoUrl() {
  return process.env.OPEN_METEO_API_KEY ? METEO_PAID : METEO_FREE;
}

function roundCoord(n) {
  return Number(n).toFixed(2);
}

async function meteoFetch(params) {
  if (process.env.OPEN_METEO_API_KEY) {
    params.set("apikey", process.env.OPEN_METEO_API_KEY);
  }
  const r = await fetch(`${meteoUrl()}?${params}`);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    let reason = "";
    try {
      const j = JSON.parse(body);
      reason = j.reason || j.error || "";
    } catch { /* ignore */ }
    if (r.status === 429) {
      throw new Error(reason || "Open-Meteo: límite diario alcanzado. Intenta mañana o usa el respaldo NWS.");
    }
    throw new Error(`Open-Meteo HTTP ${r.status}${reason ? ": " + reason : ""}`);
  }
  return r.json();
}

/** Pronóstico 7 días · una ubicación (caché ~45 min por punto redondeado). */
export async function fetchOpenMeteoForecast(lat, lon) {
  const key = `${roundCoord(lat)},${roundCoord(lon)}`;
  const hit = forecastCache.get(key);
  if (hit && Date.now() - hit.t < FORECAST_CACHE_MS) return hit.data;

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: "auto",
    forecast_days: "7",
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_gusts_10m_max"
    ].join(","),
    hourly: "temperature_2m,precipitation_probability,precipitation,wind_speed_10m",
    current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch"
  });

  const data = await meteoFetch(params);
  forecastCache.set(key, { t: Date.now(), data });
  return data;
}

/** Rejilla de precipitación · export lluvia (caché ~60 min por zona). */
export async function fetchPrecipGrid(bbox, cols = 10, rows = 8) {
  const [west, south, east, north] = bbox;
  const gridKey = [west, south, east, north].map(roundCoord).join("|") + `_${cols}x${rows}`;
  const hit = gridCache.get(gridKey);
  if (hit && Date.now() - hit.t < GRID_CACHE_MS) return hit.data;

  const cellW = (east - west) / cols;
  const cellH = (north - south) / rows;
  const lats = [];
  const lons = [];
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

  const raw = await meteoFetch(params);
  const arr = Array.isArray(raw) ? raw : [raw];
  const t0 = arr[0]?.hourly?.time || [];
  const nowMs = Date.now();
  let start = t0.findIndex((t) => new Date(t).getTime() >= nowMs - 3600000);
  if (start < 0) start = 0;
  const end = Math.min(t0.length, start + 24);
  const cells = arr.map((o, i) => ({
    lat: lats[i],
    lon: lons[i],
    precip: (o.hourly?.precipitation || []).slice(start, end)
  }));

  const data = { cells };
  gridCache.set(gridKey, { t: Date.now(), data });
  return data;
}

const NWS_UA = "PremierSky/1.0";

/** Respaldo NWS: lluvia fuerte o tormenta en las próximas ~12 h (sin Open-Meteo). */
export async function fetchNwsHeavyRainNear(lat, lon) {
  try {
    const r = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: { Accept: "application/geo+json", "User-Agent": NWS_UA } }
    );
    if (!r.ok) return false;
    const point = await r.json();
    const hr = await fetch(point.properties.forecastHourly, {
      headers: { Accept: "application/geo+json", "User-Agent": NWS_UA }
    });
    if (!hr.ok) return false;
    const data = await hr.json();
    const periods = (data.properties?.periods || []).slice(0, 12);
    return periods.some((p) => {
      const pop = p.probabilityOfPrecipitation?.value ?? 0;
      const txt = String(p.shortForecast || "").toLowerCase();
      return pop >= 70 || /heavy rain|thunderstorm|torrential/.test(txt);
    });
  } catch {
    return false;
  }
}
