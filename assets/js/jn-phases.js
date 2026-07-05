// ===========================================================================
// JobNimbus · fases del pipeline y colores (agrupa decenas de status en 7 fases)
// ===========================================================================
(function () {
  const PHASES = [
    {
      id: "lost",
      label: "Perdido",
      short: "Perdido",
      color: "#ff6b6b",
      match: (s) => /lost|denied|invalid|bad debt|no damage/i.test(s)
    },
    {
      id: "closed",
      label: "Cerrado / Pagado",
      short: "Cerrado",
      color: "#868e96",
      match: (s) => /paid|closed|final close|warranty process|submit final invoice|close project/i.test(s)
    },
    {
      id: "sold",
      label: "Contrato firmado",
      short: "Vendido",
      color: "#51cf66",
      match: (s) => /signed contract|repair sold|roofr approved/i.test(s)
    },
    {
      id: "production",
      label: "Producción",
      short: "Producción",
      color: "#ff922b",
      match: (s) =>
        /ready to build|in progress|coordinat|materials arrived|city process|production|permit|job completed|approve bid|^0\d\.|bidding documents|missing permit|new project management/i.test(s)
    },
    {
      id: "estimate",
      label: "Estimación",
      short: "Estimación",
      color: "#9775fa",
      match: (s) =>
        /estimat|bid|present|contract sent|demo completed|take off|checklist|write estimate|ready to present/i.test(s)
    },
    {
      id: "hold",
      label: "En espera",
      short: "Espera",
      color: "#fcc419",
      match: (s) =>
        /on hold|next season|overdue|pending payment|reach out next season|week-2|no warranty/i.test(s)
    },
    {
      id: "lead",
      label: "Leads / Seguimiento",
      short: "Leads",
      color: "#4dabf7",
      match: (s) =>
        /lead|follow.?up|appointment|wake up|24h|unresponsive|potential|repair lead/i.test(s)
    },
    {
      id: "other",
      label: "Otros",
      short: "Otros",
      color: "#adb5bd",
      match: () => true
    }
  ];

  const byId = Object.fromEntries(PHASES.map((p) => [p.id, p]));

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
      out[p.id] = { phase: p, count: 0, statuses: {} };
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
    groupByPhase,
    orderedPhases,
    escapeHtml
  };
})();
