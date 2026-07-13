// ============================== STUB ========================================
// JobNimbus CRM integration — push leads, create follow-up tasks, sync status.
// Prior project finding: JobNimbus's API limitations ruled out a pure-Zapier
// approach for inspector monitoring; a custom backend integration (this file)
// is the plan here too. Requires JOBNIMBUS_API_KEY in .env.
// API base: https://app.jobnimbus.com/api1/ (contacts, jobs, tasks endpoints).
// ============================================================================

import { JOBNIMBUS_API_KEY } from "../config.js";

export async function pushLeadToCRM(lead) {
  if (!JOBNIMBUS_API_KEY) {
    return { success: true, stub: true, note: "JobNimbus not connected — lead NOT actually sent." };
  }
  // TODO(jobnimbus): POST /api1/contacts with mapped lead fields.
  return { success: true, stub: true, note: "JobNimbus key present but push implementation pending." };
}

export async function createFollowUpTask(lead, dueDate) {
  if (!JOBNIMBUS_API_KEY) {
    return { success: true, stub: true, note: "JobNimbus not connected — task NOT actually created." };
  }
  // TODO(jobnimbus): POST /api1/tasks linked to the pushed contact.
  return { success: true, stub: true, note: "JobNimbus key present but task implementation pending." };
}
