// Downloads the Cook County "Suburban Building Footprints, 2008" dataset via
// the ArcGIS Hub download API and compacts it into data/cook-footprints-compact.json
// (one small record per building: id, type, sqft, centroid lat/lng).
//
// Why compact: the raw GeoJSON is hundreds of MB — too big to JSON.parse in
// one shot (V8 string limit) and wasteful to keep in RAM. Hub conveniently
// emits one feature per line, so we stream-parse line by line.
//
// Verified July 2026: this download works even while gis.cookcountyil.gov
// itself is unreachable — Hub serves it from its own cache.

import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SOURCES, COOK_EXTRACT_PATH } from "../server/config.js";

const url = `https://opendata.arcgis.com/api/v3/datasets/${SOURCES.COOK.hubDatasetId}/downloads/data?format=geojson&spatialRefId=4326`;
const dest = fileURLToPath(COOK_EXTRACT_PATH);

console.log(`Streaming Cook County extract from ArcGIS Hub (large file, be patient)...`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) {
  console.error(`Hub responded ${res.status} — if the export is still generating, re-run in a few minutes.`);
  process.exit(1);
}

function centroidOf(geometry) {
  if (!geometry) return [null, null];
  // Outer ring: Polygon → coordinates[0]; MultiPolygon → coordinates[0][0].
  const ring =
    geometry.type === "Polygon"
      ? geometry.coordinates?.[0]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates?.[0]?.[0]
        : null;
  if (!Array.isArray(ring) || !ring.length || !Array.isArray(ring[0])) return [null, null];
  let sLng = 0;
  let sLat = 0;
  for (const p of ring) {
    sLng += p[0];
    sLat += p[1];
  }
  return [sLat / ring.length, sLng / ring.length];
}

const out = createWriteStream(dest);
out.write("[\n");
const rl = createInterface({ input: Readable.fromWeb(res.body) });

let count = 0;
let skipped = 0;
for await (const line of rl) {
  const trimmed = line.trim().replace(/,$/, "");
  if (!trimmed.startsWith('{ "type": "Feature"') && !trimmed.startsWith('{"type":"Feature"')) continue;
  let feature;
  try {
    feature = JSON.parse(trimmed);
  } catch {
    skipped++;
    continue;
  }
  const p = feature.properties || {};
  const [lat, lng] = centroidOf(feature.geometry);
  const sqft = Number(p.ShapeSTArea ?? p.Shape_Area);
  const rec = {
    id: p.OBJECTID ?? null,
    type: p.Type ?? null,
    sqft: Number.isFinite(sqft) ? Math.round(sqft) : null,
    lat: lat != null ? Math.round(lat * 1e6) / 1e6 : null,
    lng: lng != null ? Math.round(lng * 1e6) / 1e6 : null,
  };
  out.write((count ? ",\n" : "") + JSON.stringify(rec));
  count++;
  if (count % 100000 === 0) console.log(`  ...${count.toLocaleString()} footprints processed`);
}
out.write("\n]\n");
out.end();
await new Promise((r) => out.on("finish", r));

console.log(`Done: ${count.toLocaleString()} footprints (${skipped} unparseable lines skipped)`);
console.log(`Saved → ${dest}`);
console.log("sources/cook.js will use this extract whenever the live server is unreachable.");
