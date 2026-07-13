// LIVE — DuPage County ParcelsWithRealEstateCC (ArcGIS FeatureServer).
// Replaces the retired OpenData/Parcels service. This layer is a two-for-one:
// parcel geometry AND assessor attributes (owner, assessed values, property
// class) — it covers both the "footprint" and most of the "assessor" API
// hooks for DuPage ZIPs.
//
// Verified quirk: point+distance queries silently return 0 features on this
// server even though supportsQueryWithDistance=true. Envelope queries work,
// so we buffer the radius into an envelope ourselves and trim to the true
// circle using returned centroids.

import { queryEnvelope } from "../lib/arcgis.js";
import { cached } from "../lib/cache.js";
import { radiusToEnvelope, filterToRadius } from "../lib/geo.js";
import { SOURCES } from "../config.js";

const OUT_FIELDS = [
  "PIN",
  "PROPADDRL1",
  "PROPCITY",
  "PROPZIP",
  "BILLNAME",
  "BILLADDRL1",
  "BILLADDRL2",
  "REA017_PROP_CLASS",
  "REA017_FCV_LAND",
  "REA017_FCV_IMP",
  "REA017_FCV_TOTAL",
  "ACREAGE",
  "MUNICIPALITY",
  "MAJOR_PROPERTY_OWNER",
  "Shape__Area",
];

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// County fields are fixed-width space-padded ("BLOOMINGDALE      ") — trim.
function clean(v) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
  return s || null;
}

/**
 * Returns normalized parcel records:
 * { source, sourceId(PIN), address, city, zip, ownerEntity, ownerMailing,
 *   propClass, assessedLand, assessedImprovement, assessedTotal, acreage,
 *   municipality, majorOwner, parcelAreaSqFt, lat, lng, distanceMiles }
 */
export async function searchDuPage(lat, lng, radiusMiles) {
  const key = `dupage:${lat.toFixed(4)}:${lng.toFixed(4)}:${radiusMiles}`;

  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const envelope = radiusToEnvelope(lat, lng, radiusMiles);
    const { features, exceededCap } = await queryEnvelope(
      SOURCES.DUPAGE.endpoint,
      envelope,
      OUT_FIELDS,
      { maxRecords: 8000 }
    );

    let records = features.map((a) => ({
      source: SOURCES.DUPAGE.key,
      sourceId: clean(a.PIN),
      address: clean(a.PROPADDRL1),
      city: clean(a.PROPCITY),
      zip: clean(a.PROPZIP),
      ownerEntity: clean(a.BILLNAME),
      ownerMailing: clean([a.BILLADDRL1, a.BILLADDRL2].filter(Boolean).join(", ")),
      propClass: a.REA017_PROP_CLASS != null ? String(a.REA017_PROP_CLASS).trim() : null,
      assessedLand: toNumber(a.REA017_FCV_LAND),
      assessedImprovement: toNumber(a.REA017_FCV_IMP),
      assessedTotal: toNumber(a.REA017_FCV_TOTAL),
      acreage: toNumber(a.ACREAGE),
      municipality: clean(a.MUNICIPALITY),
      majorOwner: clean(a.MAJOR_PROPERTY_OWNER),
      // Layer is in IL State Plane East (ft), so Shape__Area is sq ft.
      parcelAreaSqFt: toNumber(a.Shape__Area),
      lat: a._centroidLat ?? null,
      lng: a._centroidLng ?? null,
    }));

    records = filterToRadius(records, lat, lng, radiusMiles);

    return {
      sourceMeta: SOURCES.DUPAGE,
      records,
      live: true,
      note: exceededCap
        ? "Result cap reached — narrow the radius for complete coverage."
        : null,
    };
  });
}
