// ============================================================================
// Weather-layer API routes for Sales Lead Map (Sky parity).
 // When Sales runs under Sky (sky.premierchi.com/sales), the main server already
 // exposes /api/spc, /api/spc-reports, /api/storm-score. These routes keep the
 // standalone Sales developer machine able to load the same layers.
// ============================================================================

import { Router } from "express";
import { cached } from "../lib/cache.js";
import { loadSpcOutlook, slimSpcGeoJson } from "../lib/spcOutlook.js";
import { loadStormScoreHotspots } from "../lib/stormScoreLite.js";

const NWS_UA = "PremierSales/1.0 (weather-layers; +https://premiergroup.com)";
const REPORTS_TTL_MS = 5 * 60 * 1000;

const router = Router();

/** GET /api/spc?day=1&type=cat|hail — NOAA SPC outlook GeoJSON */
router.get("/spc", async (req, res) => {
  const day = ["1", "2", "3"].includes(String(req.query.day)) ? Number(req.query.day) : 1;
  const type = ["cat", "hail", "torn", "wind"].includes(String(req.query.type))
    ? String(req.query.type)
    : "cat";
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const outlook = await loadSpcOutlook({ day, type });
    // Slim props for cat overlays; hail keeps fill/LABEL for probability colors.
    if (type === "cat") {
      res.json(slimSpcGeoJson(outlook) || { type: "FeatureCollection", features: [] });
    } else {
      res.json({
        type: "FeatureCollection",
        day,
        outlookType: type,
        at: outlook.at,
        features: (outlook.features || []).map((f) => ({
          type: "Feature",
          geometry: f.geometry,
          properties: {
            LABEL: f.properties?.LABEL ?? null,
            LABEL2: f.properties?.LABEL2 ?? null,
            DN: f.properties?.DN ?? null,
            fill: f.properties?.fill ?? null,
            stroke: f.properties?.stroke ?? null,
          },
        })),
      });
    }
  } catch (e) {
    res.status(502).json({ error: `SPC unavailable: ${e.message}` });
  }
});

/** GET /api/spc-reports?period=today — SPC hail CSV (text) */
router.get("/spc-reports", async (req, res) => {
  const period = ["today", "yesterday"].includes(String(req.query.period))
    ? String(req.query.period)
    : "today";
  res.set("Access-Control-Allow-Origin", "*");
  res.type("text/csv");
  try {
    const text = await cached(`storm:spc-reports:${period}`, REPORTS_TTL_MS, async () => {
      const url = `https://www.spc.noaa.gov/climo/reports/${period}_hail.csv`;
      const r = await fetch(url, { headers: { "User-Agent": NWS_UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: `SPC reports unavailable: ${e.message}` });
  }
});

/**
 * GET /api/storm-score?zone=IL
 * Sky-compatible shape for Lead Map markers. Uses the Sales lite scorer
 * (SPC reports + outlook) when the full Sky monitor pipeline isn't available.
 */
router.get("/storm-score", async (req, res) => {
  const zone =
    String(req.query.zone || "IL")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "IL";
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const pack = await loadStormScoreHotspots({ state: zone });
    const hotspots = (pack.hotspots || []).map((h) => ({
      lat: h.lat,
      lon: h.lon,
      label: h.label,
      score: {
        total: h.score,
        tier: h.tier,
        breakdown: h.breakdown || [],
        label: h.label,
      },
    }));
    res.json({ zone, hotspots, at: pack.at, source: "sales-storm-score-lite" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

export default router;
