// ============================== STUB ========================================
// Contact enrichment (property manager / owner contact details).
// Vendor not yet selected — candidates discussed: Reonomy (LLC unmasking,
// $400/mo/user), ATTOM, Realie.ai (budget option).
// NOTE: DuPage parcels already provide owner entity + mailing address for
// free (BILLNAME/BILLADDR via sources/dupage.js) — this stub only needs to
// add phone/email/person-level data.
// ============================================================================

export async function enrichContact(ownerEntity, address) {
  return {
    stub: true,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
  };
}
