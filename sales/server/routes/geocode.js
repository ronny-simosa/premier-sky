// GET /api/geocode?zip=60108
// Replaces the prototype's hardcoded DEMO_ZIP_COUNTY_MAP / DEMO_ZIP_COORDS.
//
// Provider chain:
//  1. Google Geocoding API — when GOOGLE_MAPS_API_KEY is set (PENDING: key
//     decision flagged in the brief). One call returns centroid + county.
//  2. Free no-key fallback (works today):
//     zippopotam.us  → ZIP centroid, city, state
//     FCC Area API   → county name/FIPS for that centroid
//
// Response: { zip, lat, lng, city, state, county, provider }

import { Router } from "express";
import { fetchJson } from "../lib/http.js";
import { cached } from "../lib/cache.js";
import { getGoogleMapsApiKey } from "../config.js";

const router = Router();

async function geocodeGoogle(zip) {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?components=` +
    encodeURIComponent(`postal_code:${zip}|country:US`) +
    `&key=${getGoogleMapsApiKey()}`;
  const data = await fetchJson(url);
  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(`Google geocode failed: ${data.status}`);
  }
  const result = data.results[0];
  const comp = (type) =>
    result.address_components.find((c) => c.types.includes(type))?.long_name || null;
  return {
    zip,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    city: comp("locality") || comp("sublocality") || null,
    state: result.address_components.find((c) => c.types.includes("administrative_area_level_1"))
      ?.short_name || null,
    county: (comp("administrative_area_level_2") || "").replace(/ County$/i, "") || null,
    provider: "google",
  };
}

async function geocodeFree(zip) {
  const zp = await fetchJson(`https://api.zippopotam.us/us/${zip}`);
  const place = zp.places?.[0];
  if (!place) throw new Error(`ZIP ${zip} not found`);
  const lat = Number(place.latitude);
  const lng = Number(place.longitude);

  let county = null;
  try {
    const fcc = await fetchJson(
      `https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lng}&format=json`,
      { retries: 1 }
    );
    county = fcc.results?.[0]?.county_name?.replace(/ County$/i, "") || null;
  } catch {
    // County lookup is best-effort; centroid + state are enough to route.
  }

  return {
    zip,
    lat,
    lng,
    city: place["place name"] || null,
    state: place["state abbreviation"] || null,
    county,
    provider: "zippopotam+fcc (free fallback — set GOOGLE_MAPS_API_KEY for Google)",
  };
}

/** Geocode a free-text address (Nominatim). Used to place pins when parcel centroid is missing. */
export async function geocodeAddress(query) {
  const q = String(query || "").trim();
  if (q.length < 8) throw new Error("Address too short");
  return cached(`geocode:addr:${q.toLowerCase()}`, 7 * 24 * 60 * 60 * 1000, async () => {
    if (getGoogleMapsApiKey()) {
      try {
        const url =
          `https://maps.googleapis.com/maps/api/geocode/json?address=` +
          encodeURIComponent(q) +
          `&key=${getGoogleMapsApiKey()}`;
        const data = await fetchJson(url);
        if (data.status === "OK" && data.results?.[0]) {
          const loc = data.results[0].geometry.location;
          return { lat: loc.lat, lng: loc.lng, provider: "google", query: q };
        }
      } catch {
        /* fall through */
      }
    }
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=` +
      encodeURIComponent(q);
    const data = await fetchJson(url, {
      retries: 1,
      headers: { "User-Agent": "PremierSales/1.0 (premierchi.com; sales-map)" },
    });
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit) throw new Error("Address not found");
    return {
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      provider: "nominatim",
      query: q,
    };
  });
}

export async function geocodeZip(zip) {
  return cached(`geocode:${zip}`, 24 * 60 * 60 * 1000, async () => {
    if (getGoogleMapsApiKey()) {
      try {
        return await geocodeGoogle(zip);
      } catch {
        return geocodeFree(zip); // key quota/error → still work
      }
    }
    return geocodeFree(zip);
  });
}

router.get("/", async (req, res) => {
  const address = String(req.query.address || req.query.q || "").trim();
  if (address) {
    try {
      return res.json(await geocodeAddress(address));
    } catch (e) {
      return res.status(502).json({ error: `Address geocoding failed: ${e.message}` });
    }
  }
  const zip = String(req.query.zip || "").trim();
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({
      error: "Provide ?zip=60108 or ?address=123 Main St, Addison, IL",
    });
  }
  try {
    res.json(await geocodeZip(zip));
  } catch (e) {
    res.status(502).json({ error: `Geocoding failed: ${e.message}` });
  }
});

export default router;
