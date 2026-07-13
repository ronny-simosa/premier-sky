// ===========================================================================
// JobNimbus · pipeline phases + colors (groups dozens of statuses into 7 phases)
// Labels come from i18n (jn.phase.*); English fallbacks if I18n is not ready.
// ===========================================================================
(function () {
  const FALLBACK = {
    lost: { label: "Lost", short: "Lost" },
    closed: { label: "Closed / Paid", short: "Closed" },
    sold: { label: "Signed contract", short: "Sold" },
    production: { label: "Production", short: "Production" },
    estimate: { label: "Estimate", short: "Estimate" },
    hold: { label: "On hold", short: "Hold" },
    lead: { label: "Leads / Follow-up", short: "Leads" },
    other: { label: "Other", short: "Other" }
  };

  const PHASES = [
    {
      id: "lost",
      color: "#ff6b6b",
      match: (s) => /lost|denied|invalid|bad debt|no damage/i.test(s)
    },
    {
      id: "closed",
      color: "#868e96",
      match: (s) => /paid|closed|final close|warranty process|submit final invoice|close project/i.test(s)
    },
    {
      id: "sold",
      color: "#51cf66",
      match: (s) => /signed contract|repair sold|roofr approved/i.test(s)
    },
    {
      id: "production",
      color: "#ff922b",
      match: (s) =>
        /ready to build|in progress|coordinat|materials arrived|city process|production|permit|job completed|approve bid|^0\d\.|bidding documents|missing permit|new project management/i.test(s)
    },
    {
      id: "estimate",
      color: "#9775fa",
      match: (s) =>
        /estimat|bid|present|contract sent|demo completed|take off|checklist|write estimate|ready to present/i.test(s)
    },
    {
      id: "hold",
      color: "#fcc419",
      match: (s) =>
        /on hold|next season|overdue|pending payment|reach out next season|week-2|no warranty/i.test(s)
    },
    {
      id: "lead",
      color: "#4dabf7",
      match: (s) =>
        /lead|follow.?up|appointment|wake up|24h|unresponsive|potential|repair lead/i.test(s)
    },
    {
      id: "other",
      color: "#adb5bd",
      match: () => true
    }
  ];

  const byId = Object.fromEntries(PHASES.map((p) => [p.id, p]));

  function t(key, fallback) {
    if (window.I18n) {
      const v = window.I18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  function label(phaseOrId) {
    const id = typeof phaseOrId === "string" ? phaseOrId : phaseOrId?.id;
    const fb = FALLBACK[id] || FALLBACK.other;
    return t(`jn.phase.${id}`, fb.label);
  }

  function short(phaseOrId) {
    const id = typeof phaseOrId === "string" ? phaseOrId : phaseOrId?.id;
    const fb = FALLBACK[id] || FALLBACK.other;
    return t(`jn.phase.${id}Short`, fb.short);
  }

  /** Phase object with localized label/short for UI templates. */
  function localized(phase) {
    const p = typeof phase === "string" ? byId[phase] : phase;
    if (!p) return { ...byId.other, label: label("other"), short: short("other") };
    return { ...p, label: label(p), short: short(p) };
  }

  function getPhase(status) {
    const s = String(status || "");
    for (const p of PHASES) {
      if (p.id === "other") continue;
      if (p.match(s)) return p;
    }
    return byId.other;
  }

  function color(status) {
    return getPhase(status).color;
  }

  /** Agrupa conteos { status: n } → { phaseId: { phase, count, statuses: {status:n} } } */
  function groupByPhase(byStatus) {
    const out = {};
    for (const p of PHASES) {
      out[p.id] = { phase: localized(p), count: 0, statuses: {} };
    }
    for (const [status, n] of Object.entries(byStatus || {})) {
      const ph = getPhase(status);
      out[ph.id].count += n;
      out[ph.id].statuses[status] = n;
    }
    return out;
  }

  function orderedPhases(grouped) {
    return PHASES.map((p) => grouped[p.id]).filter((g) => g.count > 0);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.JNPhases = {
    PHASES,
    getPhase,
    color,
    label,
    short,
    localized,
    groupByPhase,
    orderedPhases,
    escapeHtml
  };
})();
