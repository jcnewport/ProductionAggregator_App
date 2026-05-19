# 01 · Master Template — ComboCurve 16-Column Format

This is the **gold-standard output format** that every export from the app must conform to. ComboCurve (the reserves software the tenant uses downstream) expects exactly these 16 columns in this order.

Reference file in the repo: `ComboCurve_Prod_Template.csv` (12,250 sample rows, 27 unique wells, Jan 2024–Sep 2025).

## Schema

| # | Column | Type | Required | Description | Mapping notes |
|---|---|---|---|---|---|
| 1 | **Well ID** | Integer | No | Internal ComboCurve ID | Lookup against `combocurve_wells` (Caleb's import). Not always known. |
| 2 | **Well Name** | String | Yes | Full well name | Fuzzy-match across operator abbreviations. API is the authoritative join key. |
| 3 | **API14** | String(14) | Yes (if known) | Full 14-digit API number | Structure: State(2) + County(3) + Well(5) + Sidetrack(2) + Completion(2). Derive from API10 by padding `"0000"` if needed. |
| 4 | **API10** | String(10) | Yes | Truncated API | First 10 digits of API14. **Always TEXT, never numeric.** Leading zeros matter (e.g. `"0423013684"`). |
| 5 | **Prod Date** | Date (M/D/YYYY) | Yes | Production date | Normalize all formats to M/D/YYYY for the export. Monthly = first-of-month convention. |
| 6 | **Gas Prod** | Decimal | No | Gross gas produced (MCF) | Aliases: "Gross Gas", "Gas Volume", "MCFPD", "Total Gas", "New Prod Gas (MCF)". |
| 7 | **Gas Sales** | Decimal | No | Gas sold (MCF) | Aliases: "Net Gas", "Sales Gas", "Gas Delivered", "GasSales". If source only has ONE gas column, map to Gas Prod and leave Gas Sales blank. |
| 8 | **Oil Prod** | Decimal | No | Gross oil produced (BBL) | Aliases: "Gross Oil", "Oil Volume", "BOPD", "Total Oil", "Alloc Oil (bbl)". |
| 9 | **Oil Sales** | Decimal | No | Oil sold (BBL) | Aliases: "Net Oil", "Sales Oil", "OilSales". Same single-column fallback as gas. |
| 10 | **Water Prod** | Decimal | No | Water produced (BBL) | Aliases: "Water", "BWPD", "Alloc Wat (bbl)", "WaterProd". **Capture always** — even SWD/injection wells report water prod. |
| 11 | **Choke** | Decimal or String | No | Choke setting | Nullable. Format may be `"64/64"` — store as text or convert based on operator's convention. |
| 12 | **Tubing Pres.** | Decimal (PSI) | No | Tubing-head pressure | Aliases: "THP", "FTP", "Tubing Pressure", "Tubing". |
| 13 | **Casing Pres** | Decimal (PSI) | No | Casing-head pressure | Aliases: "CHP", "Casing Pressure", "CP", "Casing". |
| 14 | **Hours Down** | Decimal | No | Downtime hours | Aliases: "Down Time Hours". Nullable. |
| 15 | **Water Inj** | Decimal (BBL) | No | Water injection volume | Aliases: "Water Inject", "WaterInj". Most wells are 0 or blank, but capture when reported. |
| 16 | **Downtime Reason** | String | No | Reason for downtime | Aliases: "Down Time Reason". Nullable. May include free-form notes. |

## Important constraints

- **Column ORDER is fixed.** ComboCurve imports by column position, not header name. Do not reorder.
- **Empty values:** leave cells blank (not `0`, not `"N/A"`, not `null` strings) unless the value is genuinely zero.
- **API10 is the join key.** Even if a well has no `combocurve_well_id` yet, API10 must be present for the export to be usable.
- **Negative production values are valid.** BS&W corrections, allocation true-ups, and other accounting adjustments can produce negative `oil_prod` / `gas_prod` values. **Never filter them out.**

## Daily vs Monthly granularity

The same 16-column template is used for BOTH the daily export and the monthly export. The only difference is the granularity of the `Prod Date` column:

- **Monthly export:** one row per well per month, `Prod Date` = first-of-month (e.g. `3/1/2026`).
- **Daily export:** one row per well per day, `Prod Date` = actual production date (e.g. `3/15/2026`).

Per project rule: **daily data is never rolled up into monthly.** They live in separate tables and produce separate exports.

## Where the template logic lives in code

- Builder: `api/src/services/comboCurveExport.ts`
- Endpoint: `api/src/routes/exports.ts` (`GET /api/export/monthly` and `GET /api/export/daily`)
- Frontend: `web/src/components/ExportPanel.tsx` (shared by Monthly/Daily pages)
