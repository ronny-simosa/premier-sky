// Central config: env vars + the VERIFIED data-source endpoints.
// Endpoint verification history (July 8, 2026):
//  - Chicago: the prototype's hz9b-7nh8 is a map VIEW with no data columns —
//    it silently returns []. syp8-uezg is the real "Building Footprints"
//    dataset (updated June 2025) and includes bldg_sq_fo / year_built /
//    no_stories / no_of_units / address fields.
//  - DuPage: OpenData/Parcels no longer exists ("Service not started",
//    removed from folder listing). ParcelsWithRealEstateCC is the current
//    layer — 337k parcels WITH assessor attributes (owner, assessed value,
//    property class). Point+distance queries silently return 0 features on
//    this server; envelope/polygon geometry queries work.
//  - Cook: FeatureServer URL resolved via ArcGIS Hub item API. Query
//    capability confirmed from Hub metadata, but the host was unreachable
//    (full timeouts) when tested — hence the cached-extract fallback.

export const PORT = Number(process.env.PORT) || 3000;

/** Always read process.env at call time (safe if load-env runs after an import). */
function env(name, fallback = "") {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return fallback;
  return String(v).trim();
}

export function getGoogleMapsApiKey() { return env("GOOGLE_MAPS_API_KEY"); }
export function getRegridApiKey() { return env("REGRID_API_KEY"); }
export function getJobnimbusApiKey() { return env("JOBNIMBUS_API_KEY"); }
export function getJobnimbusApiUrl() {
  return env("JOBNIMBUS_API_URL", "https://app.jobnimbus.com/api1");
}
export function getJobnimbusContactType() { return env("JOBNIMBUS_CONTACT_TYPE", "Customer"); }
export function getJobnimbusContactStatus() { return env("JOBNIMBUS_CONTACT_STATUS", "Active"); }
export function getJobnimbusTaskType() { return env("JOBNIMBUS_TASK_TYPE", "Task"); }

// Legacy named exports (snapshot). Prefer getters above for keys loaded via load-env.
export const GOOGLE_MAPS_API_KEY = env("GOOGLE_MAPS_API_KEY");
export const REGRID_API_KEY = env("REGRID_API_KEY");
export const JOBNIMBUS_API_KEY = env("JOBNIMBUS_API_KEY");
export const JOBNIMBUS_API_URL = env("JOBNIMBUS_API_URL", "https://app.jobnimbus.com/api1");
/** Must match JobNimbus Settings → Contact workflows */
export const JOBNIMBUS_CONTACT_TYPE = env("JOBNIMBUS_CONTACT_TYPE", "Customer");
export const JOBNIMBUS_CONTACT_STATUS = env("JOBNIMBUS_CONTACT_STATUS", "Active");
/** Must match JobNimbus Settings → Task types */
export const JOBNIMBUS_TASK_TYPE = env("JOBNIMBUS_TASK_TYPE", "Task");
export const SOURCES = {
  CHICAGO: {
    key: "CHICAGO",
    name: "City of Chicago Data Portal (Building Footprints)",
    endpoint: "https://data.cityofchicago.org/resource/syp8-uezg.json",
    cost: "Free",
    kind: "building-footprints",
  },
  DUPAGE: {
    key: "DUPAGE",
    name: "DuPage County GIS — ParcelsWithRealEstateCC (parcels + assessor)",
    endpoint:
      "https://gis.dupageco.org/arcgis/rest/services/DuPage_County_IL/ParcelsWithRealEstateCC/FeatureServer/0/query",
    cost: "Free",
    kind: "parcels-with-assessor",
  },
  COOK: {
    key: "COOK",
    name: "Cook County Open Data — Suburban Building Footprints, 2008",
    endpoint:
      "https://gis.cookcountyil.gov/traditional/rest/services/buildingFootprint_2008/MapServer/0/query",
    // Hub item behind https://hub.arcgis.com/datasets/2a56689103554ec9b7e9e40ed622b374_0
    hubDatasetId: "2a56689103554ec9b7e9e40ed622b374_0",
    cost: "Free — 2008 LiDAR vintage, verify for new construction",
    kind: "building-footprints",
  },
  KANE: {
    key: "KANE",
    name: "Kane County GIS — Parcels_v2025 (owner + site address + use code)",
    endpoint:
      "https://gistech.countyofkane.org/arcgis/rest/services/KanePINList/MapServer/0/query",
    cost: "Free",
    kind: "parcels-with-assessor",
  },
  DEKALB: {
    key: "DEKALB",
    name: "DeKalb County parcels (ArcGIS Online — owner + site address + zone)",
    endpoint:
      "https://services7.arcgis.com/hEXJrPwm89CLXBYe/arcgis/rest/services/DeKalbIL_Parcels/FeatureServer/0/query",
    cost: "Free",
    kind: "parcels-with-assessor",
  },
  REGRID: {
    key: "REGRID",
    name: "Regrid Parcel API (paid fallback outside IL open-data coverage)",
    endpoint: "https://app.regrid.com/api/v2",
    cost: "$375-500/mo (Standard/Premium) — FL, WI, MD, VA/DC markets",
    kind: "parcels",
  },
};

// Local compacted extract used when the Cook County server is unreachable
// (one small record per footprint: id/type/sqft/centroid).
// Populate with: npm run fetch-cook-extract
export const COOK_EXTRACT_PATH = new URL(
  "../data/cook-footprints-compact.json",
  import.meta.url
);
