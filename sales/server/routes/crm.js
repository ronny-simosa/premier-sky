// POST /api/crm/leads  → push lead to JobNimbus (STUB until key + mapping)
// POST /api/crm/tasks  → create follow-up task (STUB)

import { Router } from "express";
import { pushLeadToCRM, createFollowUpTask } from "../stubs/jobnimbus.js";

const router = Router();

router.post("/leads", async (req, res) => {
  try {
    res.json(await pushLeadToCRM(req.body));
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

router.post("/tasks", async (req, res) => {
  try {
    res.json(await createFollowUpTask(req.body?.lead, req.body?.dueDate));
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

export default router;
