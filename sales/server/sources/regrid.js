// STUB — Regrid Parcel API (paid fallback for FL, WI, MD, VA/DC markets).
// Not connected: requires an API key ($375-500/mo Standard/Premium plan;
// 30-day free sandbox available). Set REGRID_API_KEY in .env and implement
// the query below when the plan decision is made.
//
// Docs: https://regrid.com/api — query pattern will be roughly:
//   GET https://app.regrid.com/api/v2/parcels/point?lat=..&lon=..&radius=..
//   Authorization: Bearer ${REGRID_API_KEY}

import { REGRID_API_KEY } from "../config.js";
import { SOURCES } from "../config.js";

export async function searchRegrid(lat, lng, radiusMiles) {
  if (!REGRID_API_KEY) {
    return {
      sourceMeta: SOURCES.REGRID,
      records: [],
      live: false,
      stub: true,
      note: "Regrid API key not configured — non-IL markets are stubbed until a plan is purchased (30-day sandbox available).",
    };
  }
  // TODO(regrid): implement once key exists. Normalize to the same record
  // shape as sources/dupage.js (parcels) / sources/chicago.js (footprints).
  return {
    sourceMeta: SOURCES.REGRID,
    records: [],
    live: false,
    stub: true,
    note: "Regrid key present but the query implementation is pending vendor-plan confirmation.",
  };
}
