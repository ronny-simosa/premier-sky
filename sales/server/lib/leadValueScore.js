// ============================================================================
// LEAD VALUE SCORE — Premier Group's lead qualifier.
// Implements the exact rules from "Lead Value Score: Prompt de Clasificación
// Deployable" (lead_value_score_prompt.md). The rubric is fully deterministic,
// so it runs as plain code — no LLM call needed; same inputs, same outputs,
// zero cost, auditable point by point.
//
// Two consumers:
//   1. POST /api/lead-score — standalone qualifier for inbound flows
//      (Zapier / custom backend), exact input/output contract from the doc.
//   2. The lead pipeline (lib/mergeLead.js) — derives the rubric inputs from
//      county/GIS data and scores every generated lead.
// ============================================================================

const HIGH_VALUE_STATES = ["IL", "MD", "VA", "DC"];

/**
 * scoreLeadValue(input) → exact output shape from the spec:
 * { lead_value_score, classification, score_breakdown, compliance_flag,
 *   recommended_action, notes }
 */
export function scoreLeadValue(input) {
  const isCommercial = input.lead_type === "commercial";
  const breakdown = {};

  // --- 1. Tipo y tamaño del proyecto (máx 25) ---
  let pts = isCommercial ? 15 : 8;
  const area = Number(input.roof_area_sqft) || 0;
  if (isCommercial) {
    pts += area > 15000 ? 10 : area >= 5000 ? 5 : 2;
  } else {
    pts += area > 3000 ? 10 : area >= 1500 ? 5 : 2;
  }
  breakdown.project_type_size = pts;

  // --- 2. Geografía y valor de zona (máx 20) ---
  let geo = 0;
  const tier = input.property_value_tier;
  geo += tier === "high" ? 10 : tier === "medium" ? 6 : 2;
  let complianceFlag = null;
  const state = input.state;
  if (HIGH_VALUE_STATES.includes(state)) geo += 5;
  else if (state === "FL") {
    geo += 5;
    complianceFlag = "FL_no_insurance_language";
  } // WI and anything else: +0
  const mins = Number(input.distance_from_office_minutes);
  if (Number.isFinite(mins)) geo += mins < 30 ? 5 : mins <= 60 ? 2 : 0;
  breakdown.geography_value = geo;

  // --- 3. Daño y urgencia (máx 25) ---
  let urgency = 0;
  if (input.recent_storm_event === true) urgency += 15;
  else if (input.historical_storm_zone === true) urgency += 5;
  const age = Number(input.roof_age_years);
  if (Number.isFinite(age)) {
    if (age >= 15) urgency += 10;
    else if (age >= 10) urgency += 5;
  }
  breakdown.damage_urgency = urgency;

  // --- 4. Específico comercial (máx 20, solo commercial) ---
  if (isCommercial) {
    let com = 0;
    com += input.decision_maker_access === "direct" ? 10 : 3;
    com += Number(input.portfolio_size) >= 2 ? 10 : 3;
    breakdown.commercial_specific = com;
  } else {
    breakdown.commercial_specific = null;
  }

  // --- 5. Fuente del lead (máx 10) ---
  const sourcePts =
    { referral: 10, organic_seo_gbp: 7, paid_ads: 5, storm_chasing_d2d: 3 }[
      input.lead_source
    ] ?? 3;
  breakdown.lead_source = sourcePts;

  // --- Total + normalización residencial (subtotal sobre 80 → sobre 100) ---
  let subtotal =
    breakdown.project_type_size +
    breakdown.geography_value +
    breakdown.damage_urgency +
    (breakdown.commercial_specific ?? 0) +
    breakdown.lead_source;
  const score = Math.min(100, isCommercial ? subtotal : Math.round(subtotal * (100 / 80)));

  const classification =
    score >= 80 ? "hot" : score >= 55 ? "warm" : score >= 30 ? "cool" : "low_priority";

  const actions = {
    hot: "Contacto inmediato, prioridad máxima",
    warm: "Contactar dentro de 24-48 horas",
    cool: "Agregar a secuencia de nurture, seguimiento programado",
    low_priority: "Lista de largo plazo, revisar si cambian las señales",
  };

  const noteBits = [
    isCommercial ? "Lead comercial" : "Lead residencial",
    area ? `techo ~${area.toLocaleString("en-US")} sqft` : null,
    input.recent_storm_event
      ? "tormenta reciente confirmada"
      : input.historical_storm_zone
        ? "zona con historial de tormentas"
        : null,
    Number.isFinite(age) ? `techo de ${age} años` : null,
    isCommercial && Number(input.portfolio_size) >= 2
      ? `portafolio de ${input.portfolio_size} propiedades`
      : null,
    isCommercial && input.decision_maker_access === "direct"
      ? "acceso directo a decision maker"
      : null,
  ].filter(Boolean);

  return {
    lead_value_score: score,
    classification,
    score_breakdown: breakdown,
    compliance_flag: complianceFlag,
    recommended_action: actions[classification],
    notes: noteBits.join(", ") + ".",
  };
}

// --- Mapping helpers for the pipeline --------------------------------------

/** 4-level rubric classification → the frontend's 3-level priority. */
export function classificationToPriority(classification) {
  return classification === "hot" ? "Hot" : classification === "warm" ? "Warm" : "Cold";
}

// Premier HQ (Bloomingdale, IL) — used to estimate drive time for the
// distance_from_office_minutes input. TODO: replace with exact office
// coordinates / a real drive-time API when the Google key lands.
export const OFFICE = { lat: 41.9569, lng: -88.0803 };
export const MINUTES_PER_MILE = 2.2; // ~27 mph suburban average — estimate

// property_value_tier from county ASSESSED value. TODO: confirm thresholds
// with the sales team (assessed ≠ market; DuPage FCV runs ~1/3 of market).
export function assessedToTier(assessedTotal) {
  if (assessedTotal == null) return "medium"; // unknown — don't punish missing data
  if (assessedTotal >= 1_000_000) return "high";
  if (assessedTotal >= 250_000) return "medium";
  return "low";
}
