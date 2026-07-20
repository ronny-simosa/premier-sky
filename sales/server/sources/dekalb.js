// LIVE — DeKalb County parcels (ArcGIS Online FeatureServer).
// Owner + site address + zoning. Zoning is coarser than DuPage/Kane class
// codes — we map Zone_Code letters (B/C/I/M/…) when possible and fall back
// to keeping owner-named commercial entities via mergeLead HOA/heuristic paths.

import { queryEnvelope } from "../lib/arcgis.js";
import { cached } from "../lib/cache.js";
import { radiusToEnvelope, filterToRadius } from "../lib/geo.js";
import { SOURCES } from "../config.js";

const OUT_FIELDS = [
  "Parcel_Number",
  "Owner",
  "SiteAddress",
  "MailingAddress",
  "TaxBillMailedTo",
  "Zone_Code",
  "Special_Use",
  "net_taxable_value",
  "gross_current_acres",
  "Shape__Area",
];

function clean(v) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
  return s || null;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Map DeKalb Zone_Code (e.g. C-1, I-1, MFR) → DuPage-style letter. */
export function mapDeKalbZoneToClass(zoneCode, ownerEntity) {
  const z = String(zoneCode || "").toUpperCase().trim();
  const owner = String(ownerEntity || "");
  if (!z || z === "NONE" || z === "NULL") {
    // Many DeKalb rows lack zoning — keep only org-looking owners, not households.
    if (/\b(llc|l\.l\.c|inc|corp|ltd|co\b|company|properties|associates|trust|church|school|university|hospital|center|plaza|mall|bank|ministry)\b/i.test(owner))
      return "C";
    return "R";
  }
  if (/^C\b|^CBD|^B-|^B\d|COMM|BUS/.test(z)) return "C";
  if (/^I\b|^M\b|IND|MANUF/.test(z) && !/^MFR|^MR/.test(z)) return "I";
  if (/MFR|MULTI|R-?[345]|APT/.test(z)) return "M";
  if (/^A\b|AG|FARM/.test(z)) return "F";
  if (/^R\b|RES|SFR/.test(z)) return "R";
  if (/OS|OPEN|PARK|CONS/.test(z)) return "O";
  return null;
}

export async function searchDeKalb(lat, lng, radiusMiles) {
  const key = `dekalb:${lat.toFixed(4)}:${lng.toFixed(4)}:${radiusMiles}`;

  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const envelope = radiusToEnvelope(lat, lng, radiusMiles);
    const { features, exceededCap } = await queryEnvelope(
      SOURCES.DEKALB.endpoint,
      envelope,
      OUT_FIELDS,
      { maxRecords: 8000, pageSize: 2000, timeoutMs: 25000 }
    );

    let records = features.map((a) => {
      const zone = clean(a.Zone_Code);
      const addr = clean(a.SiteAddress);
      const ownerEntity = clean(a.Owner) || clean(a.TaxBillMailedTo);
      // SiteAddress often includes "CITY, IL ZIP" — pull city/zip when present.
      let city = null;
      let zip = null;
      if (addr) {
        const m = addr.match(/,\s*([A-Za-z .'-]+),\s*IL\s+(\d{5})/i);
        if (m) {
          city = clean(m[1]);
          zip = m[2];
        }
      }
      return {
        source: SOURCES.DEKALB.key,
        sourceId: clean(a.Parcel_Number) || (a.OBJECTID != null ? String(a.OBJECTID) : null),
        address: addr,
        city,
        zip,
        ownerEntity,
        ownerMailing: clean(a.MailingAddress),
        propClass: mapDeKalbZoneToClass(zone, ownerEntity),
        useDesc: zone,
        assessedTotal: toNumber(a.net_taxable_value),
        acreage: toNumber(a.gross_current_acres),
        parcelAreaSqFt: toNumber(a.Shape__Area),
        lat: a._centroidLat ?? null,
        lng: a._centroidLng ?? null,
      };
    });

    records = filterToRadius(records, lat, lng, radiusMiles);

    return {
      sourceMeta: SOURCES.DEKALB,
      records,
      live: true,
      note: exceededCap
        ? "Result cap reached — narrow the radius for complete coverage."
        : null,
    };
  });
}
