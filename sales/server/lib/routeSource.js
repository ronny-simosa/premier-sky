// Routes a geocoded location to the right footprint/parcel source.
// Replaces the prototype's hardcoded DEMO_ZIP_COUNTY_MAP — real geocoding
// gives us city/county, so ZIPs spanning county lines route correctly.

import { searchChicago } from "../sources/chicago.js";
import { searchDuPage } from "../sources/dupage.js";
import { searchCook } from "../sources/cook.js";
import { searchRegrid } from "../sources/regrid.js";

export function pickSource(geo) {
  if (geo.state !== "IL") return { key: "REGRID", search: searchRegrid };
  if ((geo.city || "").toLowerCase() === "chicago") return { key: "CHICAGO", search: searchChicago };
  const county = (geo.county || "").toLowerCase();
  if (county.includes("cook")) return { key: "COOK", search: searchCook };
  if (county.includes("dupage") || county.includes("du page"))
    return { key: "DUPAGE", search: searchDuPage };
  // Other IL counties (Kane, Will, Lake...) have no wired open-data source
  // yet — Regrid stub reports itself honestly.
  return { key: "REGRID", search: searchRegrid };
}
