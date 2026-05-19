# 03 · Oil & Gas Domain Rules

The non-obvious business rules that govern how we interpret operator data. If you don't have an oil & gas background, read this before touching any parser code.

## Volume units

| Commodity | Standard unit | Notes |
|---|---|---|
| **Oil** | BBL (barrel, ~42 US gallons) | Always BBL in our world. Some international or legacy formats use cubic meters; convert at ingest if encountered. |
| **Gas** | MCF (thousand cubic feet) | **Not** MMCF (million). If a source reports MMCF, multiply by 1,000. |
| **Water** | BBL | Same as oil. |
| **Pressure** | PSI | Tubing, casing, BHP, PIP — all PSI unless explicitly noted. |

## Gross vs. net

This is the most common cause of "the export numbers don't match what I expected" complaints.

- **"Production" / "Prod" = GROSS** — what came out of the wellhead.
- **"Sales" / "Sold" = NET** — what was delivered to the purchaser after deductions (line loss, BS&W, fuel use, plant inefficiency, marketing fees).

**Rule:** if a source has only ONE oil or gas figure, map it to the **Prod** column and leave **Sales** blank. Never duplicate the same number into both columns. The downstream user can interpret a blank Sales column; they cannot interpret a falsified Sales = Prod equivalence.

## API number formats

API numbers identify a well uniquely in the US. There are several lengths in the wild:

| Length | Source | Example | What to do |
|---|---|---|---|
| 8-digit | Mewbourne | `21063587` | Pad with 2 leading zeros → 10-digit. Cross-reference completion ID. |
| 10-digit | Aftermath, Arlo | `4230135870` | Use as-is. Already in canonical form. |
| 12-digit | ConocoPhillips | `423013587000` | Truncate last 2 → 10-digit. |
| 14-digit | Anadarko, EOG, Frio family | `42301358700001` | Truncate last 4 → 10-digit. Store the full 14 in `api14`. |

**Canonical storage:**
- `wells.api10` and `production_*.api10` are always **TEXT(10)** with leading zeros preserved.
- `wells.api14` is **TEXT(14)** when known. Derive from API10 by appending `"0000"` if only API10 is provided.

**Structure of a 14-digit API:**
```
4   23   01368   43   00     01
│   │    │       │    │      │
│   │    │       │    │      └─ Completion (rarely used; usually 01)
│   │    │       │    └────────  Sidetrack (00 unless wellbore deviates)
│   │    │       └─────────────  Well number within county (assigned sequentially)
│   │    └─────────────────────  Reservoir code (5-digit)
│   └──────────────────────────  County FIPS (3-digit)
└──────────────────────────────  State (2-digit; 42 = TX, 30 = NM, 35 = OK)
```

## Well name variations

Operators abbreviate well names differently in different reports. The same well can appear as:
- `Hideout 24-13 State Com #1H`
- `Hideout 24-13 State Com #1H (PSHA) - 2211506`
- `HIDEOUT 24-13 ST COM 1H`
- `Hideout 1H` (sheet name in a per-well workbook)

**Resolution strategy:**
1. **API is the authoritative join key.** If a row has an API, resolve well by API first.
2. **Fall back to well-name alias.** `well_name_aliases` table maps known alternate names → canonical `wells.id`.
3. **Last resort: fuzzy match.** Using Postgres `pg_trgm` (similarity). Implemented in `services/wellNameResolver.ts`. Threshold tuned conservatively to avoid false positives.
4. **If still no match:** create a flagged record. Never silently assign data to the wrong well.

## Date formats

- **YYYY-MM-DD** — PDS PDFs, most CSVs from modern systems
- **M/D/YYYY** — Excel exports (especially Aftermath, Arlo)
- **JavaScript Date / Excel serial** — XLSX cells when the column is typed as Date (xlsx library returns serial number; convert via `new Date((serial - 25569) * 86400 * 1000)`)
- **Monthly date convention:** some sources use first-of-month (`2026-01-01`), some use last-of-month (`2026-01-31`). **Normalize to first-of-month** for storage.

## Days On vs Hours Down

Two different ways to express the same concept (well's uptime in a period):

- **Days On** = number of days the well produced (max = days in month / week)
- **Hours Down** = hours the well was offline

They're inverses. In the master template:
- `Hours Down` is column 14 (template-native)
- `Days On` is stored as metadata in `extra_fields` JSONB when reported

Don't try to convert one to the other if only one is reported — the conversion isn't lossless (a well might be down for 4 hours total spread across 8 different days, which is "Days On = 22 out of 30" or "Hours Down = 4" — those describe different operational realities).

## Negative production values

**Valid. Do not filter.**

Reasons a row can legitimately have negative oil or gas:
- BS&W correction — water content of an earlier oil sale was higher than reported, so a negative oil entry is booked to balance
- Allocation true-up — multi-well lease where the allocation percentage was wrong; corrections book negative on one well and positive on another
- Tank gauge correction — tank inventory adjustment

**Rule:** store as-is. Never apply `MAX(value, 0)`. Never `ABS(value)`. Never drop the row.

## Cumulative columns

The XTO format (and a few others) has cumulative columns: `OilCum`, `GasCum`. These are running totals from first production.

**Do NOT map cumulative columns to the master template.** The template tracks periodic (monthly/daily) volumes only. Cumulative columns are useful for QA but not for export.

## Tank-gauge inventory

The Mewbourne format includes `Oil Begin` and `Oil End` — opening and closing tank gauge readings. These describe **inventory**, not production. They do not map to Oil Prod or Oil Sales.

If you ever see a parser pulling these into the Prod/Sales columns, that's a bug.

## SWD and injection wells

Saltwater Disposal (SWD) wells and water injection wells:
- Report Water Prod = 0 (or close to it) — they don't produce water, they receive it
- Report Water Inj = the disposed/injected volume
- Report oil/gas = 0

We capture them anyway. They appear in the export with their water inj column populated. Downstream tooling (ComboCurve) handles them via well-type metadata.

## "Pressure Base" (XTO)

XTO reports `Pressure Base = 15.03 psi`. This is the regulatory standard for "atmospheric pressure" used in gas measurement under Texas Railroad Commission rules. It is not actual well pressure. Do not map it to Tubing/Casing/BHP.
