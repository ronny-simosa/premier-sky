// ============================================================================
// MERGE PIPELINE — takes footprint/parcel + assessor + storm + permit +
// contact data and produces lead records in the EXACT shape the frontend
// expects (see SAMPLE_LEADS in public/index.html).
//
// Field provenance by source:
//   CHICAGO  → buildingSqFt (bldg_sq_fo), yearBuilt, stories, units, address
//   DUPAGE   → ownerEntity (BILLNAME), propertyValue (REA017_FCV_TOTAL,
//              assessed), address, parcel area, property class, municipality
//   COOK     → buildingSqFt (footprint Shape_Area), building type
//   stormLive → stormHistory, hailWindRisk (IEM LSR), spcCategory/spcRisk (SPC
//               Day-1 outlook), stormScoreNearby (SPC reports hotspot score)
//   stubs    → recentPermits, contact info (person-level)
//
// Every estimated/stubbed field is listed in lead._provenance so the team
// can see what's real vs. placeholder while the remaining vendors are wired.
// ============================================================================

import {
  scoreLeadValue,
  classificationToPriority,
  applyStormPriorityFloor,
  assessedToTier,
  OFFICE,
  MINUTES_PER_MILE,
} from "./leadValueScore.js";
import { distanceMiles } from "./geo.js";

let leadCounter = 0;

// Pipeline-generated leads are proactive prospecting, not inbound — scored
// with the most conservative lead_source (+3) until the team decides how
// machine-prospected leads should weigh against referrals/ads.
const PIPELINE_LEAD_SOURCE = "storm_chasing_d2d";

// --- Property-type classification -------------------------------------------
// DuPage REA017_PROP_CLASS letter codes, derived empirically July 2026 by
// sampling the county's highest-improvement parcels per class (no official
// public table exists):
//   R=Residential  C=Commercial  I=Industrial  M=Multifamily (Wheaton Center
//   towers etc.)  A=small multifamily  E=Exempt (gov/schools/churches)
//   O=Open space/golf  F=Farm  T=O'Hare leaseholds  L/N=small residential
// Only C/I/M/A are roofing-lead targets; the rest are EXCLUDED (this is what
// keeps Hinsdale mansions and golf courses out of the results).
const DUPAGE_CLASS_MAP = { C: "Commercial", I: "Industrial", M: "Multifamily", A: "Multifamily" };
const HOA_RE = /condo|hoa|homeowner|association/i;

function isTargetProperty(rec) {
  if (rec.ownerEntity && HOA_RE.test(rec.ownerEntity)) return true; // HOAs can sit in R/E classes
  if (rec.propClass) return Boolean(DUPAGE_CLASS_MAP[rec.propClass]);
  return true; // no class data (Chicago/Cook) — keep, size filter applies
}

function estimatePropertyType(rec) {
  if (rec.ownerEntity && HOA_RE.test(rec.ownerEntity)) return "HOA/Condo";
  if (rec.propClass && DUPAGE_CLASS_MAP[rec.propClass]) {
    rec._classSource = "county"; // real assessor class, not a guess
    return DUPAGE_CLASS_MAP[rec.propClass];
  }
  if (rec.units && rec.units >= 5) return "Multifamily";
  if (rec.buildingType && /industrial|warehouse/i.test(rec.buildingType)) return "Industrial";
  return "Commercial";
}

// --- Roof size estimate ------------------------------------------------------
// Roof area ≈ building footprint. Chicago gives building sq ft + stories;
// Cook gives the footprint polygon area directly; DuPage gives only parcel
// area, so we apply a typical suburban commercial lot-coverage ratio.
const DUPAGE_LOT_COVERAGE = 0.28; // TODO: replace with real footprints when available
function estimateRoofSqFt(rec) {
  if (rec.source === "COOK" && rec.buildingSqFt) return rec.buildingSqFt;
  if (rec.buildingSqFt) {
    const stories = rec.stories && rec.stories > 0 ? rec.stories : 1;
    return Math.round(rec.buildingSqFt / stories);
  }
  if (rec.parcelAreaSqFt) return Math.round(rec.parcelAreaSqFt * DUPAGE_LOT_COVERAGE);
  return null;
}

// --- SCORING — Lead Value Score rubric (lib/leadValueScore.js) --------------
// Derives the rubric's inputs from what the pipeline actually knows.
// Storm booleans come from live IEM LSR proximity when stormLive succeeds;
// SPC Day-1 category and storm-score hotspot proximity also feed urgency.
// Still estimated: decision-maker access (contacts), drive-time (straight-line).
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function deriveScoreInput({ rec, geo, roofSqFt, roofAge, storm, ownerCounts }) {
  const events = storm.events || [];
  const recentStorm = events.some(
    (e) => Date.now() - new Date(e.date).getTime() <= TWO_YEARS_MS
  );
  const historicalZone =
    events.length > 0 || ["High", "Severe"].includes(storm.hailWindRisk);

  // Per-building coords when the source provides them; otherwise the ZIP
  // centroid (NOT distance-from-search-center, which would understate the
  // drive and inflate the geography score).
  const milesFromOffice =
    rec.lat != null
      ? distanceMiles(OFFICE.lat, OFFICE.lng, rec.lat, rec.lng)
      : distanceMiles(OFFICE.lat, OFFICE.lng, geo.lat, geo.lng);

  return {
    lead_type: "commercial", // pipeline targets commercial property types only
    roof_type: null,
    roof_area_sqft: roofSqFt || 0,
    state: geo.state,
    zip_code: rec.zip || geo.zip,
    property_value_tier: assessedToTier(rec.assessedTotal ?? null),
    distance_from_office_minutes:
      milesFromOffice != null ? Math.round(milesFromOffice * MINUTES_PER_MILE) : null,
    recent_storm_event: recentStorm,
    historical_storm_zone: historicalZone,
    roof_age_years: roofAge,
    spc_category: storm.spcCategory || null,
    storm_score_nearby: storm.stormScoreNearby?.score ?? null,
    // Owner-occupied (Places business name matches county owner) → the
    // business phone reaches the decision-maker's org. Tenant → intermediary.
    decision_maker_access: rec.placeContact?.ownerMatch
      ? "direct"
      : rec.placeContact
        ? "intermediary"
        : "unknown",
    portfolio_size: rec.ownerEntity ? (ownerCounts.get(rec.ownerEntity) ?? 1) : 1,
    lead_source: PIPELINE_LEAD_SOURCE,
  };
}

function narrativeFor(lead, { stormStubbed } = {}) {
  const bits = [];
  if (lead.roofAge != null) bits.push(`~${lead.roofAge}-year-old roof (from year built ${lead.yearBuilt})`);
  if (lead.roofSqFt) bits.push(`~${lead.roofSqFt.toLocaleString("en-US")} sf roof area`);
  if (lead.ownerEntity) bits.push(`owner of record: ${lead.ownerEntity}`);
  if (!stormStubbed && lead.stormHistory?.length) {
    bits.push(`${lead.stormHistory.length} nearby storm report(s) (NOAA LSR)`);
  }
  if (lead.spcRisk) bits.push(`SPC ${lead.spcRisk}`);
  if (lead.stormScoreNearby?.score != null) {
    bits.push(`storm-score ${lead.stormScoreNearby.score} nearby`);
  }
  const base = bits.length ? bits.join(", ") : "Property identified in the search area";
  const caveat = stormStubbed
    ? " Storm signals are placeholder data (live LSR unavailable); permit signals still pending."
    : " Permit signals are still pending municipal wiring.";
  return {
    reason: `${base}.${caveat}`,
    salesAngle:
      lead.roofAge != null && lead.roofAge >= 15
        ? "Roof is at or past typical mid-life — lead with a preventative condition assessment."
        : !stormStubbed && lead.stormHistory?.length
          ? "Recent storm reports nearby — lead with a post-storm roof condition check."
          : "Introduce Premier Group and offer a complimentary baseline roof assessment.",
    outreachMessage:
      `Hi — we're reaching out about the property at ${lead.address || "your building"}. ` +
      `We're offering complimentary commercial roof condition assessments in the area and ` +
      `would be glad to schedule a quick walk of the roof at your convenience.`,
  };
}

/**
 * selectTopRecords(records, maxLeads) → highest-opportunity raw records.
 * For parcel sources, require an assessed IMPROVEMENT (a structure) — raw
 * parcel area alone surfaces golf courses and vacant land as "huge roofs".
 * Rank by improvement value when available (proxy for structure size),
 * falling back to estimated roof area for footprint sources.
 * Exported so routes can enrich just the top N (e.g. Microsoft footprint
 * lookups for DuPage) before the full lead build.
 */
export function selectTopRecords(records, maxLeads = 60) {
  return records
    .filter(isTargetProperty) // county class filter: drop residential/exempt/golf/farm
    .filter((rec) => rec.assessedImprovement == null || rec.assessedImprovement > 10000)
    .map((rec) => ({
      rec,
      size: estimateRoofSqFt(rec) || 0,
      rank: rec.assessedImprovement ?? estimateRoofSqFt(rec) ?? 0,
    }))
    .filter((x) => x.size >= 5000) // skip single-family-scale structures
    .sort((a, b) => b.rank - a.rank)
    .slice(0, maxLeads)
    .map((x) => x.rec);
}

/**
 * buildLeads({ geo, footprintResult, storm, stormFor, maxLeads })
 * → array of lead records matching SAMPLE_LEADS shape, sorted by score.
 * Prefer stormFor(lat,lng) for per-lead live proximity; storm is the batch
 * fallback (stub) when the live provider is down.
 * footprintResult.allRecords (optional): full pre-selection record set, so
 * the portfolio signal isn't skewed when records were already top-N trimmed.
 */
export function buildLeads({ geo, footprintResult, storm, stormFor, maxLeads = 60 }) {
  const currentYear = new Date().getFullYear();
  const ranked = selectTopRecords(footprintResult.records, maxLeads);

  // Portfolio signal: same owner-of-record on multiple parcels in the search
  // area counts as a multi-property portfolio for the rubric (+10).
  const ownerCounts = new Map();
  for (const rec of footprintResult.allRecords ?? footprintResult.records) {
    if (rec.ownerEntity) ownerCounts.set(rec.ownerEntity, (ownerCounts.get(rec.ownerEntity) ?? 0) + 1);
  }

  return ranked
    .map((rec) => {
      // Google Solar (when key is live) measures the actual roof surface
      // including pitch — it beats any footprint-derived estimate.
      const roofSqFt = rec.solarRoof?.areaSqFt ?? estimateRoofSqFt(rec);
      const yearBuilt = rec.yearBuilt || null;
      const roofAge = yearBuilt ? Math.max(0, currentYear - yearBuilt) : null;
      const lat = rec.lat ?? geo.lat;
      const lng = rec.lng ?? geo.lng;
      const stormData = stormFor ? stormFor(lat, lng) : storm || { events: [], hailWindRisk: "Low", stub: true };
      const stormEvents = stormData.events || [];
      const stormStubbed = Boolean(stormData.stub);
      const permits = []; // permits stub returns none — wired per-municipality later

      const valueScore = scoreLeadValue(
        deriveScoreInput({ rec, geo, roofSqFt, roofAge, storm: stormData, ownerCounts })
      );
      const score = valueScore.lead_value_score;
      const rubricPriority = classificationToPriority(valueScore.classification);
      const priority = applyStormPriorityFloor(rubricPriority, stormData);
      const address =
        rec.address ||
        (rec.lat != null ? `(unaddressed footprint near ${rec.lat.toFixed(4)}, ${rec.lng.toFixed(4)})` : "Address pending");

      const lead = {
        id: `PSL-${String(2000 + ++leadCounter)}`,
        name: rec.buildingName || rec.ownerEntity || address,
        address: rec.city ? `${address}, ${rec.city}, IL ${rec.zip || ""}`.trim() : address,
        zip: rec.zip || geo.zip,
        distanceMiles: rec.distanceMiles ?? null,
        lat: rec.lat ?? null,
        lng: rec.lng ?? null,
        propertyType: estimatePropertyType(rec),
        manager: null, // contact enrichment pending
        ownerEntity: rec.ownerEntity || null,
        buildingSqFt: rec.buildingSqFt || null,
        roofSqFt,
        roofType: null, // no public source — needs enrichment or inspection
        roofSurface: rec.roofSurface ?? null, // satellite estimate (roofIntel.js)
        solarRoof: rec.solarRoof ?? null, // Google Solar measurement (key-gated)
        yearBuilt,
        roofAge,
        propertyValue: rec.assessedTotal || null, // assessed, not market — see provenance
        lastSaleDate: null,
        stormHistory: stormEvents,
        hailWindRisk: stormData.hailWindRisk || "Low",
        spcCategory: stormData.spcCategory || null,
        spcRisk: stormData.spcRisk || null,
        stormScoreNearby: stormData.stormScoreNearby || null,
        recentPermits: permits,
        leadScore: score,
        priority,
        priorityBeforeStormFloor: rubricPriority !== priority ? rubricPriority : undefined,
        classification: valueScore.classification, // 4-level rubric class (hot/warm/cool/low_priority)
        complianceFlag: valueScore.compliance_flag,
        recommendedAction: valueScore.recommended_action,
        contactName: rec.placeContact?.name ?? null,
        contactPhone: rec.placeContact?.phone ?? null,
        contactEmail: null, // Places has no emails — needs the person-level vendor
        contactWebsite: rec.placeContact?.website ?? null,
        contactIsOwnerMatch: rec.placeContact ? Boolean(rec.placeContact.ownerMatch) : null,
        status: "New",
      };

      Object.assign(lead, narrativeFor(lead, { stormStubbed }));

      const stormRealNote = stormStubbed
        ? null
        : [
            `stormHistory/hailWindRisk = NOAA IEM LSR within ~5 mi (live)${stormData.nearbyCount != null ? `, ${stormData.nearbyCount} nearby report(s)` : ""}`,
            stormData.spcCategory
              ? `spcCategory/spcRisk = SPC Day-1 categorical outlook (${stormData.spcCategory} / ${stormData.spcRisk})`
              : "spcCategory = not inside an active SPC categorical polygon (Day-1)",
            stormData.stormScoreNearby
              ? `stormScoreNearby = Sky-style score ${stormData.stormScoreNearby.score} (${stormData.stormScoreNearby.tier}) · ${stormData.stormScoreNearby.distanceMiles} mi from SPC report hotspot`
              : null,
            rubricPriority !== priority
              ? `priority floored ${rubricPriority} → ${priority} by storm signals (SPC / LSR / storm-score)`
              : null,
          ]
            .filter(Boolean)
            .join("; ");

      lead._leadValueScore = valueScore; // full rubric breakdown (score_breakdown etc.)
      lead._provenance = {
        source: rec.source,
        sourceId: rec.sourceId,
        real: [
          ...Object.keys(lead).filter(
            (k) =>
              !k.startsWith("_") &&
              lead[k] != null &&
              ![
                "stormHistory",
                "hailWindRisk",
                "spcCategory",
                "spcRisk",
                "stormScoreNearby",
                "leadScore",
                "priority",
                "priorityBeforeStormFloor",
                "reason",
                "salesAngle",
                "outreachMessage",
                "status",
                "id",
              ].includes(k)
          ),
          ...(stormStubbed ? [] : ["stormHistory", "hailWindRisk"]),
          ...(stormData.spcCategory ? ["spcCategory", "spcRisk"] : []),
          ...(stormData.stormScoreNearby ? ["stormScoreNearby"] : []),
        ],
        stubbed: [
          ...(stormStubbed ? ["stormHistory", "hailWindRisk"] : []),
          "recentPermits",
          "manager",
          "contactEmail",
          ...(rec.placeContact ? [] : ["contactName", "contactPhone"]),
        ],
        estimated: [
          rec._classSource === "county"
            ? `propertyType = county assessor class ('${rec.propClass}' → ${lead.propertyType}) — real data`
            : "propertyType (heuristic — no assessor class available for this source)",
          rec.solarRoof
            ? `roofSqFt = Google Solar API (measured roof surface, ${rec.solarRoof.segments} segments, imagery ${rec.solarRoof.imageryDate ?? "n/a"})`
            : rec.footprintSource === "MS_BUILDINGS"
            ? `roofSqFt = Microsoft Building Footprints (${rec.footprintCount} building(s) detected on the parcel — real footprint, not an estimate)`
            : rec.source === "DUPAGE"
              ? `roofSqFt (parcel area × ${DUPAGE_LOT_COVERAGE} coverage — MS footprint lookup unavailable)`
              : "roofSqFt (footprint ÷ stories)",
          ...(rec.placeContact
            ? [
                rec.placeContact.ownerMatch
                  ? "contact = Google Places, business matches owner of record (owner-occupant — direct line to the decision-making org)"
                  : "contact = Google Places, business operating at the address (likely TENANT, not the owner — can refer to PM/owner)",
              ]
            : []),
          "propertyValue = county assessed value, not market value",
          stormStubbed
            ? "leadScore = Lead Value Score rubric — storm inputs stubbed (LSR unavailable); SPC/storm-score may still be live"
            : "leadScore = Lead Value Score rubric — LSR + SPC + storm-score urgency; decision_maker_access may be unknown; drive-time is straight-line estimate",
          ...(stormRealNote ? [stormRealNote] : []),
        ],
      };
      return lead;
    })
    .sort((a, b) => b.leadScore - a.leadScore);
}
