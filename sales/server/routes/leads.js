// GET /api/leads?zip=60108&radius=10&types=Commercial,Retail
// The orchestration route: geocode → route to footprint/parcel source →
// stub-fill storm/permits/contacts → merge pipeline → SAMPLE_LEADS-shaped
// records. Response tells the frontend exactly what's live vs. stubbed.

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

// Satellite roof-surface pass over the top records — bounded concurrency,
// best-effort (a failed tile just means no surface row for that lead).
async function enrichRoofSurfaces(records, { concurrency = 5 } = {}) {
  const queue = records.filter((r) => r.lat != null);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const rec = queue[idx++];
      rec.roofSurface = await analyzeRoofSurface({
        ring: rec.footprintRing,
        lat: rec.lat,
        lng: rec.lng,
        roofSqFt: rec.buildingSqFt || rec.parcelAreaSqFt,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
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

    // DuPage publishes no building footprints — enrich the top parcels with
    // REAL footprint areas from Microsoft Building Footprints before scoring
    // (replaces the parcel-area × lot-coverage roof estimate).
    const top = selectTopRecords(footprintResult.records);
    if (source.key === "DUPAGE") await enrichWithMsFootprints(top);

    // Roof/solar/places enrichment is nice-to-have but can take many seconds
    // (satellite tiles × N leads). Cap wait so map/list stay responsive.
    const enrichMs = Math.min(Math.max(Number(process.env.LEADS_ENRICH_MS) || 1200, 0), 8000);
    if (enrichMs > 0) {
      await Promise.race([
        Promise.all([
          enrichRoofSurfaces(top),
          enrichWithSolar(top),
          enrichWithPlaces(top),
        ]),
        new Promise((resolve) => setTimeout(resolve, enrichMs)),
      ]);
    }

    let leads = buildLeads({
      geo,
      footprintResult: { ...footprintResult, records: top, allRecords: footprintResult.records },
      storm,
    });
    applyOverrides(leads); // saved statuses/notes/corrections from the team
    if (types.length) leads = leads.filter((l) => types.includes(l.propertyType));

    res.json({
      leads,
      live: true,
      geo,
      sourceUsed: footprintResult.sourceMeta.name,
      servedBy: footprintResult.servedBy || "live",
      stubbedDomains: ["storm history", "permits", "contact enrichment", "property manager"],
      note: footprintResult.note || null,
      enrichBudgetMs: enrichMs,
    });
  } catch (e) {
    res.status(502).json({ error: `Lead search failed: ${e.message}`, leads: [], live: false });
  }
});

export default router;
