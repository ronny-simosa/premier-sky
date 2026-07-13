// Google Places API (New) — the business info you see on Google Maps:
// name, phone, website. Used as the FIRST contact layer for leads.
//
// HONESTY MODEL: the Places listing is the business OPERATING at the
// address, not necessarily the property owner. We fuzzy-match the business
// name against the county's owner-of-record (BILLNAME):
//   match    → owner-occupied: that phone reaches the decision-maker's org
//              (Lead Value Score: decision_maker_access = "direct", +10)
//   no match → likely tenant: still valuable (can refer to owner/PM; on
//              NNN leases tenants often handle roof maintenance) but
//              labeled as such and scored "intermediary" (+3)
// Person-level contacts / emails / LLC unmasking still need the paid
// enrichment vendor (Reonomy/ATTOM/Realie) — this doesn't replace that.

import { fetchJson } from "../lib/http.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { GOOGLE_MAPS_API_KEY } from "../config.js";

export function placesAvailable() {
  return Boolean(GOOGLE_MAPS_API_KEY);
}

// Types that are never the building's occupant-of-interest.
const SKIP_TYPES = new Set(["atm", "parking", "bus_station", "transit_station"]);

const STOPWORDS = new Set([
  "LLC", "INC", "CO", "CORP", "LTD", "LP", "LLP", "TRUST", "TR", "COMPANY",
  "GROUP", "HOLDINGS", "PROPERTIES", "PROPERTY", "MGMT", "MANAGEMENT",
  "THE", "OF", "AND", "&", "ENTERPRISES", "INVESTMENTS", "PARTNERS",
]);

function nameTokens(s) {
  return new Set(
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  );
}

/** Fuzzy owner match: any significant token shared between the two names. */
export function namesMatch(ownerEntity, businessName) {
  const a = nameTokens(ownerEntity);
  const b = nameTokens(businessName);
  if (!a.size || !b.size) return false;
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/**
 * Businesses near a point (Places API New searchNearby).
 * Returns [{name, phone, website, types}] or [] — best-effort.
 */
export async function placesNear(lat, lng, radiusM = 80) {
  if (!placesAvailable() || lat == null) return [];
  const key = `places:${lat.toFixed(5)}:${lng.toFixed(5)}:${Math.round(radiusM)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask":
          "places.displayName,places.nationalPhoneNumber,places.websiteUri,places.types,places.businessStatus",
      },
      body: JSON.stringify({
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: radiusM },
        },
        maxResultCount: 8,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Places ${res.status}`);
    const data = await res.json();
    const places = (data.places || [])
      .filter(
        (p) =>
          p.businessStatus === "OPERATIONAL" &&
          !(p.types || []).some((t) => SKIP_TYPES.has(t))
      )
      .map((p) => ({
        name: p.displayName?.text || null,
        phone: p.nationalPhoneNumber || null,
        website: p.websiteUri || null,
        types: p.types || [],
      }));
    return cacheSet(key, places, 7 * 24 * 3600 * 1000);
  } catch {
    return cacheSet(key, [], 3600 * 1000);
  }
}

/**
 * Enrich records with the best on-site business contact.
 * Sets rec.placeContact = {name, phone, website, ownerMatch}.
 */
export async function enrichWithPlaces(records, { concurrency = 5 } = {}) {
  if (!placesAvailable()) return;
  const queue = records.filter((r) => r.lat != null);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const rec = queue[idx++];
      // Radius scaled to the parcel, so mall neighbors don't bleed in.
      const sideFt = Math.sqrt(rec.parcelAreaSqFt || rec.buildingSqFt || 40000);
      const radiusM = Math.min(Math.max((sideFt / 2) * 0.3048, 40), 120);
      const places = await placesNear(rec.lat, rec.lng, radiusM);
      if (!places.length) continue;
      const ownerMatched = rec.ownerEntity
        ? places.find((p) => namesMatch(rec.ownerEntity, p.name))
        : null;
      const withPhone = places.find((p) => p.phone);
      const best = ownerMatched || withPhone || places[0];
      if (best) {
        rec.placeContact = { ...best, ownerMatch: Boolean(ownerMatched) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
