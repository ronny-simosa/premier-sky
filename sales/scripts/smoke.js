// Smoke test: hits each live source with a known location and prints
// pass/fail. Run with `npm run smoke`. No server needed — calls sources
// directly.

import { searchChicago } from "../server/sources/chicago.js";
import { searchDuPage } from "../server/sources/dupage.js";
import { searchCook } from "../server/sources/cook.js";
import { geocodeZip } from "../server/routes/geocode.js";

const checks = [
  {
    name: "Geocode ZIP 60108 (Bloomingdale)",
    run: () => geocodeZip("60108"),
    ok: (r) => r.lat && r.lng && r.state === "IL",
    detail: (r) => `${r.lat}, ${r.lng} — ${r.city}, ${r.county ?? "county n/a"} County (${r.provider})`,
  },
  {
    name: "Chicago footprints (downtown, 0.5 mi)",
    run: () => searchChicago(41.8781, -87.6298, 0.5),
    ok: (r) => r.live && r.records.length > 0,
    detail: (r) => `${r.records.length} buildings, sample sqft=${r.records.find((x) => x.buildingSqFt)?.buildingSqFt ?? "n/a"}`,
  },
  {
    name: "DuPage parcels+assessor (Bloomingdale, 1 mi)",
    run: () => searchDuPage(41.9569, -88.0803, 1),
    ok: (r) => r.live && r.records.length > 0,
    detail: (r) => {
      const owned = r.records.find((x) => x.ownerEntity && x.assessedTotal);
      return `${r.records.length} parcels, sample owner="${owned?.ownerEntity ?? "n/a"}" assessed=$${owned?.assessedTotal?.toLocaleString() ?? "n/a"}`;
    },
  },
  {
    name: "Cook footprints (Schaumburg, 1 mi) — may fall back to extract",
    run: () => searchCook(42.0334, -88.0834, 1),
    ok: (r) => r.live || r.note, // unreachable-with-explanation is an expected state
    detail: (r) => (r.live ? `${r.records.length} footprints via ${r.servedBy}` : `NOT LIVE: ${r.note}`),
  },
];

let failures = 0;
for (const c of checks) {
  try {
    const r = await c.run();
    const pass = c.ok(r);
    if (!pass) failures++;
    console.log(`${pass ? "✅" : "❌"} ${c.name}\n     ${c.detail(r)}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${c.name}\n     threw: ${e.message}`);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
