# Premier Sales Developer Machine

Internal sales-intelligence tool for **Premier Group Roofing & Construction** (Bloomingdale, IL). Finds and ranks commercial roofing leads by ZIP + radius: 0–100 lead score, Hot/Warm/Cold priority, property/owner intelligence, AI outreach suggestions.

## Quick start

```bash
npm install
npm start            # → http://localhost:3000  (PORT=3100 npm start if 3000 is busy)
npm run smoke        # verify live data sources
npm run fetch-cook-extract   # one-time: download Cook County offline fallback (~61MB compacted)
```

No API keys required to run — geocoding and IL property data use free public sources. Copy `.env.example` → `.env` when keys become available.

## Architecture

Single-page frontend (`public/index.html`, no build step) served by Express (`server/`). **All external API calls are proxied through the backend** — the browser never talks to third-party APIs (avoids CORS + rate-limit exposure).

```
GET /api/geocode?zip=        ZIP → lat/lng/city/county   (Google when key set; free fallback live)
GET /api/footprints?zip=&radius=   building/parcel count by source (the "live check" box)
GET /api/leads?zip=&radius=&types= full pipeline: geocode → route → fetch → merge → lead records
POST /api/crm/leads, /api/crm/tasks   JobNimbus push (stub)
POST /api/lead-score         standalone Lead Value Score qualifier (for Zapier/inbound flows)
PATCH /api/lead-overrides/:sourceId   persist status/notes/follow-up/corrections (SQLite)
GET /api/status              which integrations are live vs stubbed
```

## Lead Value Score

Lead scoring implements the **Lead Value Score rubric** (`lead_value_score_prompt.md`) as deterministic code in `server/lib/leadValueScore.js` — no LLM call needed, same inputs → same outputs, auditable point by point. Validated against the spec's worked example (100/hot, breakdown 25/20/25/20/10).

- **Pipeline leads** are scored automatically; each lead carries `_leadValueScore` with the full `score_breakdown`, plus `classification` (hot/warm/cool/low_priority — mapped to the UI's Hot/Warm/Cold), `complianceFlag` (FL insurance-language reminder), and `recommendedAction`.
- **Inbound leads** can be qualified via `POST /api/lead-score` with the exact input JSON from the spec.
- **Portfolio signal is live**: the same owner-of-record on ≥2 parcels in the search area earns the +10 portfolio points (DuPage).
- **Honest ceiling**: with storm data stubbed (no event <24 months) and `decision_maker_access=unknown`, the max pipeline score today is ~66 (warm). Leads can only become "hot" once Premier Sky/NOAA storm data and contact enrichment are connected — by design, not by accident.
- Pipeline-generated leads use the conservative `lead_source="storm_chasing_d2d"` (+3) until the team decides how machine-prospected leads should weigh.

## Data source status

| Source | Status | Notes |
|---|---|---|
| Chicago building footprints | ✅ **LIVE** | Socrata dataset **`syp8-uezg`**. ⚠️ The originally-researched `hz9b-7nh8` is a map *view* with no data columns — it silently returns `[]`. Corrected July 2026. Bonus fields: building sq ft, year built, stories, units, address. |
| DuPage parcels **+ assessor** | ✅ **LIVE** | **`DuPage_County_IL/ParcelsWithRealEstateCC/FeatureServer/0`** (the old `OpenData/Parcels` was retired). Includes owner of record, assessed values, property class — covers the assessor hook for DuPage free. ⚠️ Point+distance queries silently return 0 on this server; we use envelope queries + client-side radius trim. DuPage publishes **no** dedicated building-footprint layer (`...ParcelViewer_FP` is cadastral linework only). |
| Cook County suburban footprints | ✅ **LIVE w/ fallback** | Real endpoint (resolved via ArcGIS Hub item API): `gis.cookcountyil.gov/traditional/rest/services/buildingFootprint_2008/MapServer/0`. The county server is frequently unreachable — `npm run fetch-cook-extract` downloads the dataset from Hub's cache (works even when the county host is down) and the source falls back to it automatically. 2008 LiDAR vintage — verify recent construction. |
| Microsoft Building Footprints | ✅ **LIVE** | Esri-hosted MSBFP2 FeatureServer (AI-detected footprints, nationwide, free). Enriches DuPage leads with REAL building footprint areas — replaces the parcel-area × 28% roof estimate. ⚠️ The layer's `Shape__Area` is Web Mercator m² (inflated ~1.81× at this latitude); we compute true areas from the returned geometry. |
| Google Solar API | ✅ **LIVE** (key set July 2026) | `sources/googleSolar.js` — per-building roof area, segment count, and pitch (the closest Roofr-style measurement via API). Activates automatically when `GOOGLE_MAPS_API_KEY` is set + Solar API enabled on the Cloud project. Billed per request — only called for top-ranked leads, cached 7 days. When present, its measured area replaces footprint-derived `roofSqFt`. |
| Geocoding | ✅ **LIVE (Google)** | zippopotam.us (centroid) + FCC Area API (county). **Pending decision:** `GOOGLE_MAPS_API_KEY` switches to Google Geocoding automatically. |
| Regrid (FL/WI/MD/VA-DC) | ❌ stub | Needs API key ($375–500/mo; 30-day free sandbox). |
| Storm/hail/wind history | ❌ stub | Pending: NOAA/NWS/CSU or Premier Sky / StormTracker (already built, separate project). |
| Municipal permits | ❌ stub | Per-municipality. Chicago has an open permits dataset (`ydr8-5enu`) — easy first wire-up. |
| Business contacts (Google Places) | ✅ **LIVE** | `sources/googlePlaces.js` — the business operating at each address (name, phone, website) from Google Maps. Fuzzy-matched against the county owner-of-record: match → **owner-occupied** (phone reaches the decision-maker's org; Lead Value Score `decision_maker_access=direct` +10); no match → labeled "likely tenant". First run: 54/60 leads with phone, 15 owner-occupied confirmed. |
| Person-level contacts / emails | ❌ stub | Places has no emails or person names. Vendor TBD (Reonomy / ATTOM / Realie.ai) for LLC unmasking + direct contacts. DuPage owner name + mailing address already live. |
| JobNimbus CRM | ❌ stub | Custom backend integration planned (Zapier ruled out — API limitations found in prior inspector-monitoring project). |

## Roof intel (satellite surface classification)

`server/lib/roofIntel.js` samples Esri World Imagery pixels inside each building footprint and classifies the roof surface: reflective white membrane (TPO/PVC/coating), dark membrane (EPDM/BUR), gray (metal/aged), or mixed (gravel/RTUs). Guards: vegetation-dominant samples (offset MS footprints) return "no analysis" instead of a wrong classification; every result carries confidence + sample count and is labeled *estimado, no inspección*. This is a prioritization/pitch signal — measurement-grade reports (EagleView/Roofr/drone) still apply before proposals. When the Google key lands, Google Solar API can add per-segment pitch/area.

## Persistence

SQLite (`data/psdm.db`, better-sqlite3) stores what the team writes: lead status, notes, follow-up dates, and field corrections — keyed by the stable county PIN/building id, so they survive restarts and re-searches. Corrections are the human verification loop: a rep-verified value overrides any estimate. On Railway, mount a volume at `data/`.

## Property classes (DuPage) — derived empirically

No official public table exists for `REA017_PROP_CLASS`; meanings were derived July 2026 by sampling the county's highest-improvement parcels per class: **R**=Residential, **C**=Commercial, **I**=Industrial, **M**=Multifamily, **A**=small multifamily, **E**=Exempt (gov/schools/churches), **O**=golf/open space, **F**=Farm, **T**=O'Hare leaseholds. Only C/I/M/A (+HOA by owner-name) become leads — this is what keeps Hinsdale mansions and golf courses out of results, and it makes the property-type filter real for DuPage.

## UI (redesigned July 2026)

Three screens, no duplication: **Dashboard** (search bar + stats + interactive map + top-8 opportunities + data-source status panel — everything updates in place on search), **Lead Results** (full table/cards with all filters — storm, min roof, priority, sort — plus an opt-in map toggle), and **Lead Profile** (property record, satellite mini-map, roof intel, sales tools). The old separate Search Panel page was removed; its filters moved into Dashboard/Results. The source-status panel reads `/api/status` live.

## Map

Lead Results shows an interactive Leaflet map (markers colored Hot/Warm/Cold, click → lead profile); the Lead Profile page shows a satellite mini-map **defaulting to Esri World Imagery so reps can see the actual roof** before calling. Free tiles (OpenStreetMap + Esri), no API key; swappable to Google tiles when that key is decided. Leads carry `lat`/`lng` from live sources (parcel/building centroids) — demo `SAMPLE_LEADS` have no coordinates, and the map says so.

## Deploy (Railway)

`railway.json` is included. Steps: (1) push this repo to GitHub, (2) Railway → New Project → Deploy from GitHub repo, (3) add a **Volume** mounted at `/app/data` (SQLite DB + Cook extract survive redeploys), (4) run `npm run fetch-cook-extract` once from the service shell, (5) set env vars from `.env.example` as keys arrive. Railway injects `PORT` automatically. Same pattern as Premier Sky.

## Honesty markers

- Every lead carries `_provenance` listing which fields are **real**, **estimated**, and **stubbed**.
- Stubbed modules live in `server/stubs/` with `STUB` banners; API responses include `stubbedDomains`.
- The lead **score is a placeholder model** (`lib/mergeLead.js` → `scoreLead`) until storm + permit data are live — those carry most of the ranking signal.
- `propertyValue` is county **assessed** value, not market value.
- DuPage roof sq ft comes from Microsoft Building Footprints (real detected buildings, summed per parcel); the parcel-area × lot-coverage estimate remains only as fallback when the MS lookup fails.

## Known limitations / next steps

1. DuPage class codes are empirically derived (no official table) — spot-check `M` vs industrial-flex parcels; Chicago/Cook still use the heuristic property type.
2. Cook footprints have no addresses/ownership — needs a join against Cook assessor parcels (future source).
3. Envelope result cap: 8,000 records per query — wide radii in dense areas report "cap reached" in the response note.
4. Frontend falls back to `SAMPLE_LEADS` demo data if the backend is unreachable (toast announces it).
