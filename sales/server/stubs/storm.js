// ============================== STUB (FALLBACK ONLY) ========================
// Real proximity lives in lib/stormLive.js (IEM LSR). This module is used only
// when the live provider fails (network / IEM outage). Never treat stub events
// as real storm signal in the UI when live is available.
// ============================================================================

export async function getStormHistory(lat, lng, radiusMiles) {
  return {
    stub: true,
    live: false,
    events: [
      {
        date: "2023-06-29",
        type: "Hail",
        detail: "STUB — 1.5in hail reported within 2 mi radius (demo placeholder)",
      },
      {
        date: "2024-04-02",
        type: "Wind",
        detail: "STUB — straight-line wind gusts to 68 mph within 3 mi (demo placeholder)",
      },
    ],
    hailWindRisk: "High", // STUB — live path computes from real LSR magnitudes
  };
}
