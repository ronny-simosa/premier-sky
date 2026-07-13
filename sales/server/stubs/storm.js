// ============================== STUB ========================================
// Storm / hail / wind history. Real integration pending vendor decision:
// NOAA/NWS/CSU, or Premier's own "Premier Sky" / StormTracker app
// (Node/Express, already built, deployable on Railway — separate project).
// Replace getStormHistory() with a call to that service when ready.
// ============================================================================

export async function getStormHistory(lat, lng, radiusMiles) {
  return {
    stub: true,
    events: [
      // Shape matches SAMPLE_LEADS stormHistory entries.
      { date: "2023-06-29", type: "Hail", detail: "STUB — 1.5in hail reported within 2 mi radius (demo placeholder)" },
      { date: "2024-04-02", type: "Wind", detail: "STUB — straight-line wind gusts to 68 mph within 3 mi (demo placeholder)" },
    ],
    hailWindRisk: "High", // STUB — will be computed from real event data
  };
}
