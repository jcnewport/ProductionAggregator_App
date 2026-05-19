# 02 · Operator Format Catalog

Every operator format we currently parse, with the file shape, the mapping quirks, and the live state.

## Live operator inventory (as of 2026-05-19)

| Operator | Wells in DB | Notes |
|---|---:|---|
| Arlo | 1 | Single-well partner report (XLSX) |
| BTA Oil Producers | 20 | Two parsers: WIO Mailout PDF (monthly), Daily Per-Well XLSX |
| Chevron | 2 | Generic CSV path |
| ConocoPhillips | 8 | PDS Daily PDF |
| Diamondback Energy | 2 | PDS Monthly + Daily PDF |
| Diversified Energy | 277 | PDS Monthly + Daily PDF (largest single operator) |
| EOG Resources | 31 | PDS Monthly + Daily PDF |
| Frio Energy Holdings | 0 | Tenant-side aggregator; ingest is from member operators |
| Matador Resources Company | 6 | PDS Monthly + Daily PDF |
| Mewbourne Oil Company | 11 | PDS Monthly + Daily PDF (8-digit APIs — special padding) |
| Notting Hill Energy LLC | 2 | Generic XLSX path |
| OXY (Anadarko / Occidental) | 120 | PDS Monthly + Daily PDF |
| Strata Production | 4 | Generic CSV |
| XTO Energy (ExxonMobil) | 9 | PDS Monthly + Daily PDF |
| Various (Frio family) | 20 | Catch-all bucket for partner reports |

## The PDSWDX family

Five operators distribute production via the **PDS Energy Well Data Exchange** platform: Anadarko/OXY, ConocoPhillips, Diamondback, Diversified, EOG, Matador, Mewbourne, and XTO. PDS reports come as **PDFs** with consistent-ish tabular layouts, but each operator's PDS report has slightly different column sets.

**Common PDS header text** (used for detection):
```
Monthly Production Estimates  ← or "Daily Production Estimates"
[operator name / logo]
Statement Generated [date] by PDS Well Data Exchange User: [name]
```

### Format 1 · PDSWDX — Anadarko / OXY (Monthly)

- **File:** `PDSWDX-MP-Anadarko-MONTHLY.pdf` (sample in repo root)
- **Parser:** `api/src/parsers/pdsAnadarkoMonthly.ts`
- **Columns:** Well ID, Well Name, API (14-digit), Prod Date (YYYY-MM-DD), Oil Prod, Gas Prod, Water Prod, Oil Sales, Gas Sales, Water Inject, Days On
- **Quirks:**
  - Column order differs from EOG (Oil Prod before Gas Prod)
  - Date format `YYYY-MM-DD` → normalize
  - "Days On" → no direct template column; store as metadata or treat as inverse of Hours Down
  - Includes SWD wells (OAK, TREME) with only Water Prod and zero oil/gas — still capture
- **Wells:** FLEA FLICKER, OAK, TREME pads

### Format 2 · PDSWDX — EOG Resources (Monthly)

- **File:** `PDSWDX-MP-EOG-MONTHLY.pdf`
- **Parser:** `api/src/parsers/pdsEogMonthly.ts`
- **Columns:** Well Name, Well ID, API (14-digit), Prod Date (YYYY-MM-DD), DaysOn, Oil Prod, Oil Sales, Gas Prod, Gas Sales, Water Prod, Water Inj
- **Quirks:**
  - Column ORDER differs from Anadarko (Well Name first, then Well ID)
  - Some rows have NEGATIVE Oil Prod values (BS&W corrections) — store as-is, do not filter
- **Wells:** LINK VJ RANCH, STONE CUTTER pads

### Format 3 · PDSWDX — Mewbourne Oil Company (Monthly)

- **File:** `PDSWDX-MP-mewbourne-MONTHLY.pdf`
- **Parser:** `api/src/parsers/pdsMewbourneMonthly.ts`
- **Columns:** Well Num, Well Name, API (**8-digit!**), Compl.ID, Prod Date (YYYY-MM-DD), BTU, Oil Begin, Oil Prod, OilSales, Oil End, Gas Prod, GasSales, Water Prod, DaysOn
- **Mapping complexity: HIGH**
  - Extra columns: BTU, Oil Begin, Oil End, Compl.ID
  - API is only 8 digits — needs padding (`"00"` + 8 digits = 10) or operator-specific completion lookup
  - **"Oil Begin" and "Oil End" are tank gauge inventory** — do NOT map to Oil Prod/Sales
- **Footer:** "Mewbourne only provides Daily production for first 2 years of well life."
- **Wells:** ARMSTRONG, BUFFALO TRACE, LEX, MARATHON ROAD, PALOMA pads

### Format 4 · PDSWDX — XTO Energy (Monthly)

- **File:** `PDSWDX-MP-XTO-MONTHLY.pdf`
- **Parser:** `api/src/parsers/pdsXtoMonthly.ts`
- **Columns:** Well Num (API-like), Well Name, Prod Date, Producing Status, OilProd, OilSales, OilCum, GasProd, GasSales, GasCum, GasInj, WaterProd, WaterInj, Pressure Base, Well Status
- **Mapping complexity: HIGH**
  - Cumulative columns (OilCum, GasCum) — do NOT map to template (those are running totals)
  - "Producing Status" and "Well Status" are metadata
  - "Pressure Base" is regulatory (15.03 psi standard)
  - "GasInj" is gas injection — store as metadata, not in template
- **Notes:** large values. Some historical data has impossible OilProd values (488,042 BBL in one month — data artifacts). 7 pages.

### Format 5 · PDSWDX — ConocoPhillips / Concho (Daily)

- **File:** `PDSWDX-DP-conocophillips-DAILY.pdf`
- **Parser:** `api/src/parsers/pdsConocoPhillipsDaily.ts`
- **Columns:** Well ID, Well Name, Completion No, API (12-digit), Prod Date, Oil Prod, Oil Sales, Gas Prod, Gas Sales, Water Prod, Tubing Pres., Casing Pres., BHP
- **Quirks:**
  - 12-digit API — truncate to 10
  - "BHP" (bottomhole pressure) is extra — store as metadata
  - Oil Sales appears blank in samples
- **Same wells:** AFTERMATH EAST A UNIT 303H (also reported via Aftermath CSV; Aftermath takes precedence — see [parsers: precedence](../backend/02-parsers.md#precedence-and-the-aftermath-rule))

### Other PDS Daily parsers

- **Mewbourne Daily** (`pdsMewbourneDaily.ts`) — same 8-digit API quirk as Monthly
- **Anadarko Daily** (`pdsAnadarkoDaily.ts`), **EOG Daily** (`pdsEogDaily.ts`), **XTO Daily** (`pdsXtoDaily.ts`) — daily twins of their monthly siblings
- **Diamondback Daily/Monthly**, **Matador Daily/Monthly**, **Diversified Daily/Monthly** — added 2026-04-28 (commit `0456512`) via the PDS Daily parser pattern (see `docs/backend/05-adding-a-new-parser.md`)

## Direct operator exports (non-PDS)

### Format 6 · Aftermath Dailies (CSV)

- **File:** `2026.04.07 Aftermath Dailies.csv` (231 KB, 2,029 rows)
- **Parser:** `api/src/parsers/aftermathDailiesCsv.ts`
- **Operator:** Aftermath (a Concho/ConocoPhillips affiliate)
- **Columns:** WELL ID, COMPLETION NO, WELL NAME, API (10-digit), PRODDATE (M/D/YYYY), OIL PROD, OIL SALES (blank!), GAS PROD, GAS SALES, WATER PROD, TUBING PRESSURE, CASING PRESSURE, BOTTOMHOLE PRESSURE
- **Quirks:**
  - WELL ID and COMPLETION NO are scientific notation (`"1.00E+14"`) — parse as integers
  - Oil Sales column is empty
  - 10-digit API
- **Precedence:** when both Aftermath CSV and PDS ConocoPhillips Daily PDF are received for the same well/date, Aftermath wins (see [parsers: precedence](../backend/02-parsers.md#precedence-and-the-aftermath-rule)).

### Format 7 · Arlo Partner Report (XLSX)

- **File:** `2026.03.30 Arlo Production.xlsx` (single sheet "partner-report", 31 rows / 1 well / 1 month)
- **Parser:** `api/src/parsers/arloPartnerReportXlsx.ts`
- **Columns:** Date, Well Name, (blank), API # (numeric `4211534077`), Oil Production, Gas Production, Water Production, Tubing, Casing, PIP, HZ, Comments
- **Quirks:**
  - Only Prod columns, no Sales
  - "PIP" (pump intake pressure) and "HZ" (hertz/frequency) are extra — store as metadata
  - No Choke, no Hours Down
- **Sole well:** Arlo Country 45-09B 2DN

### Format 8 · BTA Oil Producers — WIO Mailout (PDF)

- **File:** `February 2026 West Pecos Trading WIO Mailout.pdf` (1 page, 4 wells, monthly)
- **Parser:** `api/src/parsers/btaWioMailoutPdf.ts`
- **Operator:** BTA Oil Producers, LLC (Midland, TX)
- **Columns:** Investor (= well name), Date (M/DD/YYYY), Oil Prod, Oil Sold, Gas Prod, Gas Sold
- **Mapping complexity: MEDIUM**
  - **No API number at all** — needs `well_name_aliases` lookup
  - No Water Prod, no pressure data
  - "Investor" header is actually the well name
- **Wells:** Box Elder 23-14-11 State Com #4H, Box Elder 24-13-12 State Com #3H, Hideout 24-13 State Com #1H, Hideout 24-13 State Com #2H

### Format 9 · BTA Daily Production (XLSX, multi-sheet)

- **File:** `March 2026 Daily Production.xlsx`
- **Parser:** `api/src/parsers/btaDailyPerWellXlsx.ts`
- **Type:** XLSX with **one sheet per well** ("Hideout 1H", "Hideout 2H", "Box Elder 3H", "Box Elder 4H"), ~33 rows each
- **Columns per sheet:** Well Site (compound: name + code + well num), Date, Oil, Gas, Water, Tubing Pressure, Casing Pressure, Choke, Down Time Hours, Down Time Reason, Down Time Notes
- **Quirks:**
  - Multi-sheet — iterate every sheet
  - "Well Site" is compound like `"Hideout 24-13 State Com #1H (PSHA) - 2211506"` — parse name + well num
  - Choke is `"64/64"` format (string)

### Format 10 · Hierarchical Monthly Report (XLSX)

- **File:** `Monthly Report.xlsx`
- **Parser:** `api/src/parsers/hierarchicalAllocatedXlsx.ts` (XLSX) and `hierarchicalAllocatedPdf.ts` (PDF twin)
- **Operator:** Unknown / generic
- **Structure:** hierarchical — well-name row (with monthly total), then indented date rows beneath
- **Columns:** Completion Name/Date, Alloc Oil (bbl), Alloc Wat (bbl), New Prod Gas (MCF)
- **Mapping complexity: HIGH**
  - Hierarchical: parent + indented children
  - Only 3 volume columns, no Sales, no pressure, no API
  - "Alloc" = allocated production = equivalent to Prod
  - Indented date rows have leading whitespace — strip it
  - No API → well-name alias lookup required
  - Negative values (allocation corrections) — preserve

### Format 11 · Frio Daily / Monthly Production (XLSX) — Joynapp / WEnergy

- **Source:** emails from `Joynapp@wenergysoftware.com`
- **Daily parser:** `api/src/parsers/frioDailyProductionXlsx.ts`
- **Monthly parser:** `api/src/parsers/frioMonthlyProductionXlsx.ts`
- **Detection:** mutually exclusive — daily and monthly arrive from the same sender; the parsers' `detect()` methods inspect the file content to route correctly
- **Added:** Daily on 2026-04-?? ; Monthly on 2026-05-04 (commit `97ca1a8`)

### Format 12 · Generic CSV / XLSX fallbacks

- **Parsers:** `genericProductionCsv.ts`
- **Purpose:** route CSV files that don't match a specific operator format. The dispatcher tries this LAST so operator-specific parsers always win.
- **Field discovery:** uses header aliases (see `apiNormalization.ts` for cross-format helpers).

## Non-production filters (NOT operator formats)

These are filters that route emails AWAY from the parser dispatcher:

- Peloton WellView Daily Drilling Reports
- ConocoPhillips workover reports
- ComboCurve template echoes (the file we send out being sent back to us)
- Well-tracking spreadsheets
- Lease Operating Statements (LOS)

See `api/src/parsers/nonProductionFilters.ts` for the full list. Files matching these patterns land in `non_production_files` and are excluded from the dashboard's "needs review" queue.

## Adding a new operator format

See [backend/05-adding-a-new-parser.md](../backend/05-adding-a-new-parser.md) for the recipe.
