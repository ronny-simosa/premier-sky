// Premier Sales Developer Machine — backend.
// Serves the frontend from public/ and proxies all external data calls so
// the browser never talks to third-party APIs directly (CORS + rate limits).

import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PORT, GOOGLE_MAPS_API_KEY, REGRID_API_KEY, JOBNIMBUS_API_KEY } from "./config.js";
import geocodeRouter from "./routes/geocode.js";
import footprintsRouter from "./routes/footprints.js";
import leadsRouter from "./routes/leads.js";
import crmRouter from "./routes/crm.js";
import leadScoreRouter from "./routes/leadScore.js";
import overridesRouter from "./routes/overrides.js";
import { isStormIntelLive } from "./lib/stormLive.js";
import weatherRouter from "./routes/weather.js";

const app = express();
app.use(express.json());

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir));

app.use("/api/geocode", geocodeRouter);
app.use("/api/footprints", footprintsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/crm", crmRouter);
app.use("/api/lead-score", leadScoreRouter);
app.use("/api/lead-overrides", overridesRouter);
// Sky-parity weather layers for Lead Map (SPC / reports / storm-score).
app.use("/api", weatherRouter);

// Health/status: which integrations are live vs. stubbed.
app.get("/api/status", async (_req, res) => {
  const stormLive = await isStormIntelLive();
  res.json({
    live: {
      "footprints-chicago": true,
      "parcels-assessor-dupage": true,
      "footprints-cook": "with local fallback",
      "footprints-microsoft": true,
      "roof-intel-satellite": true,
      geocoding: GOOGLE_MAPS_API_KEY ? "google" : "free fallback",
      persistence: "sqlite",
      ...(stormLive ? { "storms (NOAA LSR + SPC)": true } : {}),
      ...(GOOGLE_MAPS_API_KEY
        ? { "google-solar": true, "business-contacts (Places)": true }
        : {}),
    },
    stubbed: {
      ...(GOOGLE_MAPS_API_KEY
        ? {}
        : { "google-solar (needs key)": true, "business-contacts (needs key)": true }),
      ...(stormLive ? {} : { "storms (Premier Sky pending)": true }),
      permits: true,
      "person-contacts/email (vendor pending)": true,
      "jobnimbus-crm": !JOBNIMBUS_API_KEY,
      "regrid (non-IL markets)": !REGRID_API_KEY,
    },
  });
});

app.listen(PORT, () => {
  console.log(`Premier Sales Developer Machine → http://localhost:${PORT}`);
  if (!GOOGLE_MAPS_API_KEY)
    console.log("  [dep] GOOGLE_MAPS_API_KEY not set — geocoding uses free fallback providers.");
  if (!REGRID_API_KEY)
    console.log("  [dep] REGRID_API_KEY not set — non-IL markets are stubbed.");
  if (!JOBNIMBUS_API_KEY)
    console.log("  [dep] JOBNIMBUS_API_KEY not set — CRM push is a no-op stub.");
});
