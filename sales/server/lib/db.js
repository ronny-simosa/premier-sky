// Persistence — SQLite via better-sqlite3 (single file, zero config).
// Stores everything the sales team writes that must survive a reload:
// lead status, notes, follow-up dates, and field corrections.
//
// Keyed by the lead's STABLE source id (county PIN / building id), NOT the
// PSL-#### display id — that counter regenerates on every search.
//
// On Railway, mount a volume at data/ so the DB survives redeploys.

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const DB_PATH = fileURLToPath(new URL("../../data/psdm.db", import.meta.url));

let db = null;
function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_overrides (
      source_id      TEXT PRIMARY KEY,   -- county PIN / building id
      source         TEXT,               -- DUPAGE | CHICAGO | COOK
      status         TEXT,               -- New/Contacted/Follow-up/Proposal/Closed/Not Interested
      sales_notes    TEXT,
      follow_up_date TEXT,
      corrections    TEXT,               -- JSON: rep-verified field fixes {field: {value, note}}
      updated_at     TEXT NOT NULL
    );
  `);
  return db;
}

export function getOverride(sourceId) {
  if (!sourceId) return null;
  return getDb().prepare("SELECT * FROM lead_overrides WHERE source_id = ?").get(sourceId) || null;
}

export function getOverrides(sourceIds) {
  if (!sourceIds.length) return new Map();
  const ph = sourceIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM lead_overrides WHERE source_id IN (${ph})`)
    .all(...sourceIds);
  return new Map(rows.map((r) => [r.source_id, r]));
}

export function saveOverride(sourceId, { source, status, salesNotes, followUpDate, corrections }) {
  const existing = getOverride(sourceId);
  const merged = {
    source: source ?? existing?.source ?? null,
    status: status ?? existing?.status ?? null,
    sales_notes: salesNotes ?? existing?.sales_notes ?? null,
    follow_up_date: followUpDate ?? existing?.follow_up_date ?? null,
    corrections:
      corrections != null ? JSON.stringify(corrections) : (existing?.corrections ?? null),
  };
  getDb()
    .prepare(
      `INSERT INTO lead_overrides (source_id, source, status, sales_notes, follow_up_date, corrections, updated_at)
       VALUES (@source_id, @source, @status, @sales_notes, @follow_up_date, @corrections, @updated_at)
       ON CONFLICT(source_id) DO UPDATE SET
         source = excluded.source, status = excluded.status, sales_notes = excluded.sales_notes,
         follow_up_date = excluded.follow_up_date, corrections = excluded.corrections,
         updated_at = excluded.updated_at`
    )
    .run({ source_id: sourceId, ...merged, updated_at: new Date().toISOString() });
  return getOverride(sourceId);
}

/** Merge saved overrides into freshly built leads (matched by sourceId). */
export function applyOverrides(leads) {
  const ids = leads.map((l) => l._provenance?.sourceId).filter(Boolean);
  const map = getOverrides(ids);
  for (const lead of leads) {
    const o = map.get(lead._provenance?.sourceId);
    if (!o) continue;
    if (o.status) lead.status = o.status;
    if (o.sales_notes) lead.salesNotes = o.sales_notes;
    if (o.follow_up_date) lead.followUpDate = o.follow_up_date;
    if (o.corrections) {
      try {
        lead._corrections = JSON.parse(o.corrections);
        for (const [field, fix] of Object.entries(lead._corrections)) {
          if (fix && fix.value !== undefined) lead[field] = fix.value; // rep-verified beats estimated
        }
      } catch {
        /* corrupt corrections JSON — surface nothing rather than crash */
      }
    }
  }
  return leads;
}
