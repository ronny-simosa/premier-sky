// POST /api/lead-score — standalone Lead Value Score qualifier.
// Exact input/output contract from lead_value_score_prompt.md, so inbound
// flows (Zapier, web forms, Premier Sky) can qualify leads without touching
// the prospecting pipeline. Deterministic — no LLM involved.
//
// curl -X POST http://localhost:3000/api/lead-score \
//   -H 'Content-Type: application/json' \
//   -d '{"lead_type":"commercial","roof_area_sqft":22000,"state":"IL",...}'

import { Router } from "express";
import { scoreLeadValue } from "../lib/leadValueScore.js";

const router = Router();

router.post("/", (req, res) => {
  const input = req.body || {};
  if (!["commercial", "residential"].includes(input.lead_type)) {
    return res.status(400).json({
      error: 'lead_type must be "commercial" or "residential"',
      expected_fields: [
        "lead_type", "roof_type", "roof_area_sqft", "state", "zip_code",
        "property_value_tier", "distance_from_office_minutes",
        "recent_storm_event", "historical_storm_zone", "roof_age_years",
        "decision_maker_access", "portfolio_size", "lead_source",
      ],
    });
  }
  res.json(scoreLeadValue(input));
});

export default router;
