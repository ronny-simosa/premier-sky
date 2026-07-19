// POST /api/crm/leads  → create/link JobNimbus contact
// POST /api/crm/tasks  → create follow-up task (creates/links contact if needed)
// POST /api/crm/preview → payload preview for confirm UI
// GET  /api/crm/status  → configured + resolved workflow/status

import { Router } from "express";
import {
  pushLeadToCRM,
  createFollowUpTask,
  previewContactPayload,
  previewTaskPayload,
  jnCrmConfigured,
  resolveContactWorkflow,
  resolveTaskType,
} from "../lib/jobnimbusCrm.js";
import { saveOverride } from "../lib/db.js";

const router = Router();

function persistJnid(lead, jnid, { status } = {}) {
  const sourceId = lead?._provenance?.sourceId;
  if (!sourceId || !jnid) return;
  try {
    // Once linked to JobNimbus, keep jnid and mark as Contacted unless already further along.
    const nextStatus =
      status ||
      (lead.status && lead.status !== "New" ? lead.status : "Contacted");
    saveOverride(sourceId, {
      source: lead._provenance?.source,
      jnid,
      status: nextStatus,
      salesNotes: lead.salesNotes,
      followUpDate: lead.followUpDate,
    });
  } catch (e) {
    console.warn("[crm] could not persist jnid:", e.message);
  }
}

router.get("/status", async (_req, res) => {
  const configured = jnCrmConfigured();
  if (!configured) return res.json({ configured: false });
  try {
    const [wf, taskType] = await Promise.all([resolveContactWorkflow(), resolveTaskType()]);
    res.json({
      configured: true,
      contactType: wf.record_type_name,
      contactStatus: wf.status_name,
      workflowSource: wf.source,
      taskType,
    });
  } catch (e) {
    res.json({ configured: true, error: e.message });
  }
});

router.post("/preview", async (req, res) => {
  try {
    const { lead, dueDate, kind } = req.body || {};
    if (!lead) return res.status(400).json({ error: "lead required" });
    if (kind === "task") {
      return res.json({
        kind: "task",
        preview: await previewTaskPayload(lead, dueDate),
        configured: jnCrmConfigured(),
      });
    }
    res.json({
      kind: "contact",
      preview: await previewContactPayload(lead),
      configured: jnCrmConfigured(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post("/leads", async (req, res) => {
  try {
    const lead = req.body?.lead || req.body;
    const forceNew = Boolean(req.body?.forceNew);
    const result = await pushLeadToCRM(lead, { forceNew });
    if (result.success && result.jnid) {
      persistJnid(lead, result.jnid, {
        status: result.created || result.updated ? "Contacted" : (lead.status !== "New" ? lead.status : "Contacted"),
      });
    }
    res.status(result.success ? 200 : 502).json(result);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

router.post("/tasks", async (req, res) => {
  try {
    const lead = req.body?.lead;
    const dueDate = req.body?.dueDate;
    const forceNew = Boolean(req.body?.forceNew);
    const result = await createFollowUpTask(lead, dueDate, { forceNew });
    if (result.success && result.jnid) {
      persistJnid(lead, result.jnid, { status: "Follow-up" });
    }
    res.status(result.success ? 200 : result.needsDueDate ? 400 : 502).json(result);
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

export default router;
