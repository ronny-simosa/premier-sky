// JobNimbus phases (mirror of assets/js/jn-phases.js). Labels are English;
// the Sky UI localizes via i18n using phaseId.
const PHASES = [
  { id: "lost", label: "Lost", match: (s) => /lost|denied|invalid|bad debt|no damage/i.test(s) },
  { id: "closed", label: "Closed / Paid", match: (s) => /paid|closed|final close|warranty process|submit final invoice|close project/i.test(s) },
  { id: "sold", label: "Signed contract", match: (s) => /signed contract|repair sold|roofr approved/i.test(s) },
  { id: "production", label: "Production", match: (s) => /ready to build|in progress|coordinat|materials arrived|city process|production|permit|job completed|approve bid|^0\d\.|bidding documents|missing permit|new project management/i.test(s) },
  { id: "estimate", label: "Estimate", match: (s) => /estimat|bid|present|contract sent|demo completed|take off|checklist|write estimate|ready to present/i.test(s) },
  { id: "hold", label: "On hold", match: (s) => /on hold|next season|overdue|pending payment|reach out next season|week-2|no warranty/i.test(s) },
  { id: "lead", label: "Leads / Follow-up", match: (s) => /lead|follow.?up|appointment|wake up|24h|unresponsive|potential|repair lead/i.test(s) },
  { id: "other", label: "Other", match: () => true }
];

export function getPhase(status) {
  const s = String(status || "");
  for (const p of PHASES) {
    if (p.id === "other") continue;
    if (p.match(s)) return p;
  }
  return PHASES.find((p) => p.id === "other");
}

export function enrichJob(job) {
  const phase = getPhase(job.status);
  return { ...job, phaseId: phase.id, phaseLabel: phase.label };
}
