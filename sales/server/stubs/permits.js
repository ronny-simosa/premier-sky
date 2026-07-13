// ============================== STUB ========================================
// Municipal permit data — per-municipality APIs, vendor/source decisions
// pending. Chicago has an open permits dataset (Socrata ydr8-5enu) that can
// be wired with the same pattern as sources/chicago.js when prioritized.
// ============================================================================

export async function getPermits(address, city) {
  return {
    stub: true,
    permits: [
      // Shape matches SAMPLE_LEADS recentPermits entries.
    ],
  };
}
