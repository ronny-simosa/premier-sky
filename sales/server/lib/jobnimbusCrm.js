// JobNimbus CRM write path for Premier Sales (contacts + tasks).
// Uses the same JOBNIMBUS_API_KEY as Sky; Sky itself stays GET-only in server/jn.js.
// Docs: POST /api1/contacts · POST /api1/tasks

import {
  getJobnimbusApiKey,
  getJobnimbusApiUrl,
  getJobnimbusContactType,
  getJobnimbusContactStatus,
  getJobnimbusTaskType,
} from "../config.js";

const JN_BASE = () => (getJobnimbusApiUrl() || "https://app.jobnimbus.com/api1").replace(/\/$/, "");

function configured() {
  return Boolean(getJobnimbusApiKey());
}

/** Cached account/settings (workflows + task types). */
let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL_MS = 10 * 60 * 1000;

async function fetchAccountSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  const data = await jnRequest("GET", "account/settings");
  settingsCache = data || {};
  settingsCacheAt = now;
  return settingsCache;
}

function contactWorkflows(settings) {
  return (settings?.workflows || []).filter(
    (w) => String(w.object_type || "").toLowerCase() === "contact"
  );
}

function activeStatuses(workflow) {
  return (workflow?.status || []).filter((s) => s && s.is_active !== false && !s.is_archived);
}

/**
 * Pick a valid contact workflow + status for this JN account.
 * JobNimbus rejects inactive workflows on create (e.g. Commercial is_active=false → Invalid record_type_name).
 * Premier active contact types: Customer (Active/Inactive), plus Adjuster/Supplier/etc.
 */
export async function resolveContactWorkflow() {
  const wantedType = getJobnimbusContactType();
  const wantedStatus = getJobnimbusContactStatus();
  let settings = null;
  try {
    settings = await fetchAccountSettings();
  } catch (e) {
    return {
      record_type_name: "Customer",
      status_name: "Active",
      source: "fallback",
      error: e.message,
    };
  }

  const workflows = contactWorkflows(settings);
  const activeWorkflows = workflows.filter((w) => w.is_active === true);

  const findPair = (typeName, statusName, { activeOnly = true } = {}) => {
    const pool = activeOnly ? activeWorkflows : workflows;
    const wf = pool.find((w) => String(w.name).toLowerCase() === String(typeName).toLowerCase());
    if (!wf) return null;
    const st = activeStatuses(wf).find(
      (s) => String(s.name).toLowerCase() === String(statusName).toLowerCase()
    );
    return st ? { record_type_name: wf.name, status_name: st.name } : null;
  };

  // 1) Explicit env pair — only if that workflow is active in JN
  const fromEnv = findPair(wantedType, wantedStatus, { activeOnly: true });
  if (fromEnv) return { ...fromEnv, source: "env" };

  // 2) Prefer Customer / Active (only active workflow suitable for new Sales contacts)
  const preferred = [
    ["Customer", "Active"],
    ["Test", "New"],
    ["Customer", "Inactive"],
  ];
  for (const [t, s] of preferred) {
    const hit = findPair(t, s, { activeOnly: true });
    if (hit) return { ...hit, source: "preferred" };
  }

  // 3) Env type name if active, with first/lead-like status
  const envWf = activeWorkflows.find(
    (w) => String(w.name).toLowerCase() === String(wantedType).toLowerCase()
  );
  if (envWf) {
    const statuses = activeStatuses(envWf);
    const leadish =
      statuses.find((s) => s.is_lead) ||
      statuses.find((s) => /lead|new|active/i.test(s.name)) ||
      statuses[0];
    if (leadish) {
      return {
        record_type_name: envWf.name,
        status_name: leadish.name,
        source: "env-type",
      };
    }
  }

  // 4) First active contact workflow
  for (const wf of activeWorkflows) {
    const statuses = activeStatuses(wf);
    if (!statuses.length) continue;
    const leadish =
      statuses.find((s) => s.is_lead) ||
      statuses.find((s) => /lead|new|active/i.test(s.name)) ||
      statuses[0];
    return {
      record_type_name: wf.name,
      status_name: leadish.name,
      source: "first-available",
    };
  }

  return { record_type_name: "Customer", status_name: "Active", source: "hard-fallback" };
}

export async function resolveTaskType() {
  const wanted = getJobnimbusTaskType();
  try {
    const settings = await fetchAccountSettings();
    const types = (settings.taskTypes || []).filter((t) => t.IsActive !== false);
    const hit = types.find(
      (t) => String(t.TypeName || t.name || "").toLowerCase() === String(wanted).toLowerCase()
    );
    if (hit) return hit.TypeName || hit.name;
    if (types[0]) return types[0].TypeName || types[0].name;
  } catch {
    /* ignore */
  }
  return wanted || "Task";
}

async function jnRequest(method, path, body) {
  const key = getJobnimbusApiKey();
  if (!key) {
    const err = new Error("JOBNIMBUS_API_KEY not configured");
    err.code = "NO_KEY";
    throw err;
  }
  const url = `${JN_BASE()}/${String(path).replace(/^\//, "")}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error || data.detail)) ||
      text.slice(0, 240) ||
      `JobNimbus HTTP ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function parseAddress(lead) {
  const raw = String(lead.address || "").trim();
  const zip = String(lead.zip || "").replace(/\D/g, "").slice(0, 5);
  const m = raw.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d+)?\s*$/i);
  if (m) {
    return {
      address_line1: m[1].trim(),
      city: m[2].trim(),
      state_text: m[3].toUpperCase(),
      zip: m[4],
    };
  }
  const m2 = raw.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s*$/i);
  if (m2) {
    return {
      address_line1: m2[1].trim(),
      city: m2[2].trim(),
      state_text: m2[3].toUpperCase(),
      zip: zip || "",
    };
  }
  return {
    address_line1: raw || "Address pending",
    city: "",
    state_text: "IL",
    zip: zip || "",
  };
}

function buildDescription(lead) {
  const lines = [
    `Premier Sales lead ${lead.id || ""}`.trim(),
    lead.priority ? `Priority: ${lead.priority} · Score: ${lead.leadScore ?? "—"}` : null,
    lead.hailWindRisk ? `Storm risk: ${lead.hailWindRisk}` : null,
    lead.roofSqFt ? `Roof ~${Math.round(lead.roofSqFt).toLocaleString("en-US")} sf` : null,
    lead.roofAge != null ? `Est. roof age: ${lead.roofAge} yrs` : null,
    lead.propertyType ? `Type: ${lead.propertyType}` : null,
    lead.salesNotes ? `Notes: ${lead.salesNotes}` : null,
  ].filter(Boolean);
  if (Array.isArray(lead.stormHistory) && lead.stormHistory.length) {
    lines.push(
      "Storms: " +
        lead.stormHistory
          .slice(0, 3)
          .map((s) => `${s.date} ${s.type}`)
          .join("; ")
    );
  }
  return lines.join("\n").slice(0, 1900);
}

export async function previewContactPayload(lead) {
  const addr = parseAddress(lead);
  const company = String(lead.ownerEntity || lead.name || addr.address_line1).trim();
  const wf = await resolveContactWorkflow();
  return {
    company,
    display_name: company,
    ...addr,
    email: lead.contactEmail || "",
    mobile_phone: lead.contactPhone || "",
    record_type_name: wf.record_type_name,
    status_name: wf.status_name,
    workflowSource: wf.source,
    description: buildDescription(lead),
    geo:
      lead.lat != null && lead.lng != null
        ? { lat: Number(lead.lat), lon: Number(lead.lng) }
        : null,
    missingPhone: !lead.contactPhone,
    missingEmail: !lead.contactEmail,
  };
}

export async function previewTaskPayload(lead, dueDate) {
  const when = dueDate ? new Date(`${dueDate}T12:00:00`) : null;
  const valid = when && !Number.isNaN(when.getTime());
  const taskType = await resolveTaskType();
  return {
    title: `Follow up: ${lead.address || lead.name || lead.id}`,
    record_type_name: taskType,
    date_start: valid ? Math.floor(when.getTime() / 1000) : null,
    dueDate: valid ? dueDate : null,
    needsDueDate: !valid,
    relatedJnid: lead.jnid || lead._jnid || null,
  };
}

async function findExistingContact(lead) {
  const company = String(lead.ownerEntity || lead.name || "").trim();
  const addr = parseAddress(lead);
  const query = [company, addr.address_line1, addr.zip].filter(Boolean).join(" ").trim();
  if (query.length < 3) return null;

  try {
    const filter = {
      must: [
        {
          query: {
            query,
            fields: ["company", "display_name", "address_line1", "email", "mobile_phone"],
          },
        },
      ],
    };
    const data = await jnRequest(
      "GET",
      `contacts?size=8&from=0&sort_field=date_updated&sort_direction=desc&filter=${encodeURIComponent(JSON.stringify(filter))}`
    );
    const results = data?.results || [];
    if (!results.length) return null;

    const zip = addr.zip;
    const companyLower = company.toLowerCase();
    const streetLower = addr.address_line1.toLowerCase();
    const scored = results.map((c) => {
      let s = 0;
      const cCompany = String(c.company || c.display_name || "").toLowerCase();
      const cAddr = String(c.address_line1 || "").toLowerCase();
      const cZip = String(c.zip || "").replace(/\D/g, "").slice(0, 5);
      if (
        companyLower &&
        cCompany &&
        (cCompany === companyLower || cCompany.includes(companyLower) || companyLower.includes(cCompany))
      ) {
        s += 3;
      }
      if (
        streetLower &&
        cAddr &&
        (cAddr.includes(streetLower.slice(0, 12)) || streetLower.includes(cAddr.slice(0, 12)))
      ) {
        s += 2;
      }
      if (zip && cZip === zip) s += 2;
      return { c, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored[0].s >= 3 ? scored[0].c : null;
  } catch {
    return null;
  }
}

function contactAppUrl(jnid) {
  if (!jnid) return null;
  return `https://app.jobnimbus.com/contact/${encodeURIComponent(jnid)}`;
}

export async function pushLeadToCRM(lead, { forceNew = false } = {}) {
  if (!configured()) {
    return {
      success: false,
      stub: true,
      error: "JobNimbus API key not configured on the server.",
    };
  }
  if (!lead || typeof lead !== "object") {
    return { success: false, error: "Missing lead payload." };
  }

  const preview = await previewContactPayload(lead);
  if (!forceNew) {
    const existing = await findExistingContact(lead);
    if (existing?.jnid) {
      const jnid = existing.jnid;
      const jnUrl = contactAppUrl(jnid);
      return {
        success: true,
        created: false,
        existing: true,
        jnid,
        jnUrl,
        contact: existing,
        preview,
        note: `Contact already in JobNimbus (${existing.display_name || existing.company || jnid}). Linked — not duplicated.`,
      };
    }
  }

  const body = {
    record_type_name: preview.record_type_name,
    status_name: preview.status_name,
    company: preview.company,
    display_name: preview.display_name,
    address_line1: preview.address_line1,
    city: preview.city || undefined,
    state_text: preview.state_text || undefined,
    zip: preview.zip || undefined,
    description: preview.description,
  };
  if (preview.email) body.email = preview.email;
  if (preview.mobile_phone) body.mobile_phone = preview.mobile_phone;
  if (preview.geo) body.geo = preview.geo;

  const created = await jnRequest("POST", "contacts", body);
  const jnid = created?.jnid || created?.id;
  if (!jnid) {
    return { success: false, error: "JobNimbus did not return a contact id.", data: created };
  }
  const jnUrl = contactAppUrl(jnid);
  return {
    success: true,
    created: true,
    existing: false,
    jnid,
    jnUrl,
    contact: created,
    preview,
    note: `Contact created in JobNimbus (${preview.company}) as ${preview.record_type_name} · ${preview.status_name}.`,
  };
}

export async function createFollowUpTask(lead, dueDate) {
  if (!configured()) {
    return {
      success: false,
      stub: true,
      error: "JobNimbus API key not configured on the server.",
    };
  }
  if (!lead || typeof lead !== "object") {
    return { success: false, error: "Missing lead payload." };
  }

  const taskPrev = await previewTaskPayload(lead, dueDate);
  if (taskPrev.needsDueDate) {
    return {
      success: false,
      error: "Choose a follow-up date before creating the task.",
      needsDueDate: true,
    };
  }

  let jnid = lead.jnid || lead._jnid || null;
  let contactNote = null;
  if (!jnid) {
    const pushed = await pushLeadToCRM(lead, { forceNew: false });
    if (!pushed.success) return pushed;
    jnid = pushed.jnid;
    contactNote = pushed.note;
  }

  const body = {
    title: taskPrev.title,
    date_start: taskPrev.date_start,
    record_type_name: taskPrev.record_type_name,
    related: [{ id: jnid }],
  };

  const created = await jnRequest("POST", "tasks", body);
  return {
    success: true,
    jnid,
    jnUrl: contactAppUrl(jnid),
    taskId: created?.jnid || created?.id || null,
    task: created,
    contactNote,
    note: `Follow-up task created in JobNimbus for ${dueDate}.`,
  };
}

export { configured as jnCrmConfigured, contactAppUrl };
