// Routes a geocoded location to the right footprint/parcel source.
// Replaces the prototype's hardcoded DEMO_ZIP_COUNTY_MAP — real geocoding
// gives us city/county, so ZIPs spanning county lines route correctly.

import { searchChicago } from "../sources/chicago.js";
import { searchDuPage } from "../sources/dupage.js";
import { searchCook } from "../sources/cook.js";
import { searchKane } from "../sources/kane.js";
import { searchDeKalb } from "../sources/dekalb.js";
import { searchRegrid } from "../sources/regrid.js";

export function pickSource(geo) {
  if (geo.state !== "IL") return { key: "REGRID", search: searchRegrid };
  if ((geo.city || "").toLowerCase() === "chicago") return { key: "CHICAGO", search: searchChicago };
  const county = (geo.county || "").toLowerCase();
  if (county.includes("cook")) return { key: "COOK", search: searchCook };
  if (county.includes("dupage") || county.includes("du page"))
    return { key: "DUPAGE", search: searchDuPage };
  if (county.includes("kane")) return { key: "KANE", search: searchKane };
  if (county.includes("dekalb") || county.includes("de kalb"))
    return { key: "DEKALB", search: searchDeKalb };
  // Other IL counties (Will, Lake, McHenry…) — open GIS timed out or not wired yet.
  return { key: "REGRID", search: searchRegrid };
}
