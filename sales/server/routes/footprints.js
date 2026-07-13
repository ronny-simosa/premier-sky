// GET /api/footprints?zip=60108&radius=10
// Backend replacement for the prototype's browser-side fetchBuildingFootprint()
// — same response shape the "Live building footprint check" box expects,
// now proxied (no CORS exposure) with retry, caching, and real geocoding.

import { Router } from "express";
import { geocodeZip } from "./geocode.js";
import { pickSource } from "../lib/routeSource.js";

const router = Router();

router.get("/", async (req, res) => {
  const zip = String(req.query.zip || "").trim();
  const radius = Math.min(Math.max(Number(req.query.radius) || 10, 1), 15);
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: "Provide a 5-digit ZIP: /api/footprints?zip=60108&radius=10" });
  }

  try {
    const geo = await geocodeZip(zip);
    const { search } = pickSource(geo);
    const result = await search(geo.lat, geo.lng, radius);
    res.json({
      sourceUsed: result.sourceMeta.name,
      cost: result.sourceMeta.cost,
      live: result.live,
      buildingCount: result.live ? result.records.length : null,
      servedBy: result.servedBy || "live",
      geo,
      note: result.note || null,
    });
  } catch (e) {
    res.status(502).json({
      sourceUsed: null,
      live: false,
      buildingCount: null,
      error: e.message,
      note: `Live call failed: ${e.message}`,
    });
  }
});

export default router;
