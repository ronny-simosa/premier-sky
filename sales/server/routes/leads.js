// GET /api/leads?zip=60108&radius=10&types=Commercial,Retail
// The orchestration route: geocode → route to footprint/parcel source →
// stub-fill storm/permits/contacts → merge pipeline → SAMPLE_LEADS-shaped
// records. Response tells the frontend exactly what's live vs. stubbed.
//
// Quota discipline (free / metered APIs):
//  - Full response cached ~30m (same ZIP/radius/types)
//  - MS footprints: top LEADS_MS_TOP only (default 40)
//  - Roof/Solar/Places: top LEADS_ENRICH_TOP only (default 12), aborted on timeout
//  - Core parcel/owner data always returned for the full list

import { Router } from "express";
import { geocodeZip } from "./geocode.js";
import { pickSource } from "../lib/routeSource.js";
import { getStormHistory } from "../stubs/storm.js";
import { buildLeads, selectTopRecords } from "../lib/mergeLead.js";
import { enrichWithMsFootprints } from "../sources/msbuildings.js";
import { analyzeRoofSurface } from "../lib/roofIntel.js";
import { enrichWithSolar } from "../sources/googleSolar.js";
import { enrichWithPlaces } from "../sources/googlePlaces.js";
import { applyOverrides } from "../lib/db.js";
import { cacheGet, cacheSet } from "../lib/cache.js";

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function fillMissingLeadCoords(leads, geo) {
  const missing = leads.filter((l) => l.lat == null || l.lng == null);
  if (!missing.length || geo?.lat == null || geo?.lng == null) {
    return { filled: 0, missing: missing.length };
  }
  let filled = 0;
  for (const lead of missing) {
    const seed = String(lead._provenance?.sourceId || lead.id || lead.address || "");
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const dLat = ((h % 97) - 48) * 0.00035;
    const dLng = ((((h / 97) | 0) % 97) - 48) * 0.00035;
    lead.lat = Number(geo.lat) + dLat;
    lead.lng = Number(geo.lng) + dLng;
    lead._approxGeo = true;
    lead._geoProvider = "zip-centroid-offset";
    filled += 1;
  }
  return { filled, missing: missing.length };
}

// Satellite roof-surface pass — bounded concurrency; stops when signal aborts.
async function enrichRoofSurfaces(records, { concurrency = 4, signal } = {}) {
  const queue = records.filter((r) => r.lat != null);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      if (signal?.aborted) return;
      const rec = queue[idx++];
      try {
        rec.roofSurface = await analyzeRoofSurface({
          ring: rec.footprintRing,
          lat: rec.lat,
          lng: rec.lng,
          roofSqFt: rec.buildingSqFt || rec.parcelAreaSqFt,
        });
      } catch {
        /* best-effort */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
}

const router = Router();

router.get("/", async (req, res) => {
  const zip = String(req.query.zip || "").trim();
  const radius = Math.min(Math.max(Number(req.query.radius) || 10, 1), 15);
  const types = String(req.query.types || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: "Provide a 5-digit ZIP: /api/leads?zip=60108&radius=10" });
  }

  const typesKey = types.slice().sort().join(",");
    const responseKey = `leads:v3:${zip}:${radius}:${typesKey}`;
  const responseTtlMs = envInt("LEADS_CACHE_MS", 30 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
  if (responseTtlMs > 0) {
    const cached = cacheGet(responseKey);
    if (cached) {
      return res.json({ ...cached, cache: "hit" });
    }
  }

  try {
    const geo = await geocodeZip(zip);
    const source = pickSource(geo);
    const [footprintResult, storm] = await Promise.all([
      source.search(geo.lat, geo.lng, radius),
      getStormHistory(geo.lat, geo.lng, radius), // STUB
    ]);

    if (!footprintResult.live) {
      return res.json({
        leads: [],
        live: false,
        geo,
        sourceUsed: footprintResult.sourceMeta.name,
        note: footprintResult.note || "Source not available for this market yet.",
      });
    }

    const top = selectTopRecords(footprintResult.records);
    const msTop = envInt("LEADS_MS_TOP", 40, 0, top.length || 60);
    if (source.key === "DUPAGE" && msTop > 0) {
      await enrichWithMsFootprints(top.slice(0, msTop));
    }

    // Deep enrich only the highest-opportunity slice (saves Esri/Google quota).
    const enrichTop = envInt("LEADS_ENRICH_TOP", 12, 0, top.length || 60);
    const enrichMs = envInt("LEADS_ENRICH_MS", 1500, 0, 8000);
    const deep = enrichTop > 0 ? top.slice(0, enrichTop) : [];
    if (enrichMs > 0 && deep.length) {
      const ac = new AbortController();
      const work = Promise.all([
        enrichRoofSurfaces(deep, { signal: ac.signal }),
        enrichWithSolar(deep, { signal: ac.signal }),
        enrichWithPlaces(deep, { signal: ac.signal }),
      ]);
      await Promise.race([
        work,
        new Promise((resolve) => setTimeout(resolve, enrichMs)),
      ]);
      ac.abort(); // stop remaining workers — don't keep burning quota after respond
    }

    let leads = buildLeads({
      geo,
      footprintResult: { ...footprintResult, records: top, allRecords: footprintResult.records },
      storm,
    });
    applyOverrides(leads);
    if (types.length) leads = leads.filter((l) => types.includes(l.propertyType));

    const beforeCoords = leads.filter((l) => l.lat != null && l.lng != null).length;
    const geoFill = fillMissingLeadCoords(leads, geo);
    const withCoords = leads.filter((l) => l.lat != null && l.lng != null).length;

    const payload = {
      leads,
      live: true,
      geo,
      sourceUsed: footprintResult.sourceMeta.name,
      servedBy: footprintResult.servedBy || "live",
      stubbedDomains: ["storm history", "permits", "contact enrichment", "property manager"],
      note: footprintResult.note || null,
      enrichBudgetMs: enrichMs,
      enrichTop,
      msTop,
      coords: {
        withCoords,
        total: leads.length,
        filled: geoFill.filled,
        missingBefore: leads.length - beforeCoords,
      },
      cache: "miss",
    };
    if (responseTtlMs > 0 && leads.length) cacheSet(responseKey, { ...payload, cache: "hit" }, responseTtlMs);
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: `Lead search failed: ${e.message}`, leads: [], live: false });
  }
});

export default router;
