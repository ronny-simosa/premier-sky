// LIVE — Kane County parcels (MapServer KanePINList / Parcels_v2025).
// Owner (TaxName), site address, ZIP, and land-use codes — free public GIS.
// Verified July 2026: envelope queries work; UseCode 0060=Commercial,
// 0080=Industrial. Residential/farm/exempt filtered via propClass mapping.

import { queryEnvelope } from "../lib/arcgis.js";
import { cached } from "../lib/cache.js";
import { radiusToEnvelope, filterToRadius } from "../lib/geo.js";
import { SOURCES } from "../config.js";

const OUT_FIELDS = [
  "PIN",
  "TaxName",
  "SiteAddress",
  "SiteCity",
  "SiteZip",
  "UseCode",
  "UseCodeDescription",
  "MailingAddress",
  "MailingAddress2",
  "MailingCity",
  "MailingState",
  "MailingZip",
  "RecordedAcreage",
  "Municipality",
];

function clean(v) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
  return s || null;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Map Kane use text/code → DuPage-style letter for mergeLead target filter. */
export function mapKaneUseToClass(useCode, useDesc) {
  const code = String(useCode || "").trim();
  const d = String(useDesc || "").toLowerCase();
  if (code === "0060" || /\bcommercial\b|\bretail\b|\boffice\b/.test(d)) return "C";
  if (code === "0080" || /\bindustr|\bwarehouse|\bmanufactur/.test(d)) return "I";
  if (/\bapart|\bmulti|\bcondo|\bflats\b|\bhousing\b/.test(d)) return "M";
  if (/\bexempt|\bgovern|\bschool|\bchurch|\bpark\b/.test(d)) return "E";
  if (/\bfarm|\bagricult/.test(d)) return "F";
  if (/\bresidential\b|\bres improved|\bsingle family|\bvacant\b/.test(d)) return "R";
  return "R";
}

export async function searchKane(lat, lng, radiusMiles) {
  const key = `kane:${lat.toFixed(4)}:${lng.toFixed(4)}:${radiusMiles}`;

  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const envelope = radiusToEnvelope(lat, lng, radiusMiles);
    const { features, exceededCap } = await queryEnvelope(
      SOURCES.KANE.endpoint,
      envelope,
      OUT_FIELDS,
      { maxRecords: 8000, pageSize: 1000, timeoutMs: 25000 }
    );

    let records = features.map((a) => {
      const useCode = clean(a.UseCode);
      const useDesc = clean(a.UseCodeDescription);
      return {
        source: SOURCES.KANE.key,
        sourceId: clean(a.PIN),
        address: clean(a.SiteAddress),
        city: clean(a.SiteCity),
        zip: clean(a.SiteZip),
        ownerEntity: clean(a.TaxName),
        ownerMailing: clean(
          [a.MailingAddress, a.MailingAddress2, a.MailingCity, a.MailingState, a.MailingZip]
            .filter(Boolean)
            .join(", ")
        ),
        propClass: mapKaneUseToClass(useCode, useDesc),
        useDesc,
        acreage: toNumber(a.RecordedAcreage),
        municipality: clean(a.Municipality),
        lat: a._centroidLat ?? null,
        lng: a._centroidLng ?? null,
      };
    });

    records = filterToRadius(records, lat, lng, radiusMiles);

    return {
      sourceMeta: SOURCES.KANE,
      records,
      live: true,
      note: exceededCap
        ? "Result cap reached — narrow the radius for complete coverage."
        : null,
    };
  });
}
