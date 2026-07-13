// PATCH /api/lead-overrides/:sourceId — persist what the sales team writes:
// status, notes, follow-up date, and field corrections (the human
// verification loop: a rep who visited the property beats any estimate).

import { Router } from "express";
import { saveOverride, getOverride } from "../lib/db.js";

const router = Router();

router.get("/:sourceId", (req, res) => {
  res.json(getOverride(req.params.sourceId) || {});
});

router.patch("/:sourceId", (req, res) => {
  const { source, status, salesNotes, followUpDate, corrections } = req.body || {};
  const VALID_STATUS = ["New", "Contacted", "Follow-up", "Proposal", "Closed", "Not Interested"];
  if (status && !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(", ")}` });
  }
  try {
    const saved = saveOverride(req.params.sourceId, {
      source,
      status,
      salesNotes,
      followUpDate,
      corrections,
    });
    res.json({ success: true, saved });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
