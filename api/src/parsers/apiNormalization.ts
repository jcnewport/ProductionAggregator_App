/**
 * API (Oil & Gas well identifier) Normalization & Validation
 * -----------------------------------------------------------
 * One canonical place for turning an operator-reported API string (or number)
 * into the project-standard `{ api10, api14 }` pair, and for rejecting
 * bogus values BEFORE they land in the wells table.
 *
 * Why this exists:
 *   We had ~12 copies of an ad-hoc `normalizeApi` helper scattered across
 *   individual parsers. Most of them used `padStart(10, '0')` for api10
 *   and `padEnd(14, '0')` for api14 — which produces INCONSISTENT results
 *   for short inputs (api14.slice(0,10) !== api10) and, worse, silently
 *   creates junk API10s like:
 *     - "0042301413"  (8-digit Mewbourne API left-padded with leading zeros)
 *     - "4230000000"  (empty-ish cell padded to 10 trailing zeros)
 *     - "4230140000"  (6-digit partial API right-padded)
 *
 *   Those bogus values created garbage duplicate wells that had to be
 *   hand-cleaned during the Task #54 cross-check. This module makes sure
 *   we never reintroduce them.
 *
 * Project API convention (from project_instructions):
 *   - API14 = state(2) + county(3) + well(5) + sidetrack(2) + completion(2)
 *   - Sources supply 8-, 10-, 12-, or 14-digit variants.
 *   - 14 given → derive api10 by truncating to first 10.
 *   - 10, 12 given → api10 is the first 10; api14 is right-padded with "0000".
 *   - 8 given → append "00" to the well segment to pad well to 5 chars, then
 *     right-pad with "0000" for sidetrack + completion. (Industry convention.)
 *   - ALWAYS store api10 as a 10-char TEXT string (leading zeros matter, e.g.
 *     Kansas "1507109999").
 *
 * Invariant guaranteed by this module:
 *   If `normalizeApi(x)` returns a non-empty `{ api10, api14 }`, then
 *     api10.length === 10, api14.length === 14, api14.slice(0, 10) === api10.
 */

/** Input accepted — strings, numbers (Excel), or nullish. */
export type RawApi = string | number | null | undefined;

/** A fully-normalized API pair. Empty strings if the input had no digits. */
export interface ApiPair {
  api10: string;
  api14: string;
}

/** A validation outcome with human-readable reason on failure. */
export interface ApiValidation {
  valid: boolean;
  api10: string;
  api14: string;
  reason?: string;
}

/**
 * Turn a raw operator-reported API value into `{ api10, api14 }`.
 *
 * Handles the project-spec widths: 8, 10, 12, 14. For 8-digit inputs we
 * zero-pad the well segment to the left (so "42301413" → "4230100413",
 * matching the industry state+county+zero-padded-well convention).
 *
 * IMPORTANT: this normalizer does NOT validate the result. It will happily
 * return `{ api10: "0000000000", api14: "00000000000000" }` for input "0".
 * Call `isValidApi10` or `normalizeAndValidateApi` when you need to block
 * bogus values from reaching storage.
 */
export function normalizeApi(raw: RawApi): ApiPair {
  if (raw === null || raw === undefined) return { api10: '', api14: '' };

  // Excel numbers: JS Number string form preserves full precision for
  // integers ≤ 2^53 (which comfortably covers all valid API14 values up
  // to 99999999999999 = ~1e14 < 9e15). No scientific-notation loss.
  const digits = String(raw).replace(/\D/g, '');
  if (digits === '') return { api10: '', api14: '' };

  let api14: string;

  if (digits.length >= 14) {
    // 14+ digits: take the first 14 as-is. Any extra is operator noise.
    api14 = digits.slice(0, 14);
  } else if (digits.length === 8) {
    // 8-digit API: state(2) + county(3) + well(3). Pad well → 5 chars
    // by inserting "00" between county and well segments. Then right-pad
    // sidetrack(2) + completion(2) with "0000".
    const state = digits.slice(0, 2);
    const county = digits.slice(2, 5);
    const well3 = digits.slice(5, 8);
    api14 = state + county + '00' + well3 + '0000';
  } else if (digits.length >= 9 && digits.length < 14) {
    // 10, 11, 12, 13 (or 9-digit outlier): right-pad to 14 with "0"s.
    // For 9-digit inputs (rare, malformed) we still produce a 14-char
    // string so the invariant holds; the validator will catch it.
    api14 = digits.padEnd(14, '0');
  } else {
    // <8 digits: too short to be any recognized API format. Return as-is
    // right-padded so api14.slice(0,10) === api10 invariant still holds.
    // The validator will reject these.
    api14 = digits.padEnd(14, '0');
  }

  const api10 = api14.slice(0, 10);
  return { api10, api14 };
}

/** The 52 US states and territories that issue API numbers (first 2 digits).
 *  Source: API standard https://en.wikipedia.org/wiki/API_well_number
 *  We don't need a strict allow-list in the validator — "not all zeros"
 *  is enough to catch the known bogus patterns — but this is useful for
 *  future stricter checks. */
const VALID_STATE_CODES = new Set([
  '01', '02', '03', '04', '05', '06', '08', '09', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '24', '25', '26', '27', '29', '30', '31', '32',
  '33', '34', '35', '36', '37', '38', '39', '40', '41', '42',
  '43', '44', '45', '46', '47', '48', '49', '50', '51', '53',
  '55', '56',
]);

/**
 * Validate an api10 string. Returns true only if the value is structurally
 * plausible: 10 digits, nonzero state code, nonzero county segment, and no
 * trailing-zero padding artifacts.
 *
 * This catches the three known bogus patterns and any future variant:
 *   - "0042301413"  → fails (state "00" — no state has code 00)
 *   - "4230000000"  → fails (ends in "0000" — padding artifact)
 *   - "4230140000"  → fails (ends in "0000" — padding artifact)
 *
 * Real-world note on the trailing-zero rule:
 *   Real APIs effectively never end in "0000". Well-number assignment
 *   increments sequentially per well within a county, and regulators do
 *   not reserve round-thousand numbers as placeholders. Across Kyle's 75
 *   canonical ComboCurve wells, zero end in "0000". This heuristic has
 *   near-zero false-positive risk and high signal on padding bugs.
 */
export function isValidApi10(api10: string): boolean {
  if (typeof api10 !== 'string' || api10.length !== 10) return false;
  if (!/^\d{10}$/.test(api10)) return false;

  const state = api10.slice(0, 2);
  const county = api10.slice(2, 5);
  const well = api10.slice(5, 10);

  // Reject "00" state (most common leading-zero-pad bug from padStart)
  if (state === '00') return false;

  // Reject all-zero county (partial padding bug)
  if (county === '000') return false;

  // Reject all-zero well (padding-artifact bug)
  if (well === '00000') return false;

  // Reject trailing "0000" — real APIs never end this way, but every
  // padding bug produces it. The well number slot is 5 digits; a well
  // ending in "0000" means only the first digit of the well is nonzero
  // (e.g. "40000"), which is structurally a right-pad artifact.
  if (api10.slice(-4) === '0000') return false;

  return true;
}

/**
 * Convenience: normalize + validate in one call. Returns a structured result
 * so callers can log WHY an API was rejected without guessing.
 */
export function normalizeAndValidateApi(raw: RawApi): ApiValidation {
  const { api10, api14 } = normalizeApi(raw);
  if (!api10) {
    return { valid: false, api10, api14, reason: 'empty or non-digit input' };
  }
  if (!isValidApi10(api10)) {
    return {
      valid: false,
      api10,
      api14,
      reason: bogusReason(api10),
    };
  }
  // Invariant check — should always hold given normalizeApi, but guard anyway.
  if (api14.slice(0, 10) !== api10) {
    return {
      valid: false,
      api10,
      api14,
      reason: `invariant broken: api14 prefix "${api14.slice(0, 10)}" !== api10 "${api10}"`,
    };
  }
  return { valid: true, api10, api14 };
}

/** Human-readable reason for why an api10 failed validation. */
function bogusReason(api10: string): string {
  if (api10.length !== 10) return `wrong length: ${api10.length} digits`;
  if (!/^\d{10}$/.test(api10)) return 'contains non-digit characters';
  if (api10.slice(0, 2) === '00') return 'state code "00" — leading-zero-pad artifact';
  if (api10.slice(2, 5) === '000') return 'county "000" — padding artifact';
  if (api10.slice(5, 10) === '00000') return 'well segment "00000" — padding artifact';
  if (api10.slice(-4) === '0000') return 'trailing "0000" — right-pad artifact';
  return 'unknown';
}

/** Soft validator — returns true if state code is in the known US list.
 *  Not called by default; available for future stricter enforcement. */
export function hasKnownStateCode(api10: string): boolean {
  return VALID_STATE_CODES.has(api10.slice(0, 2));
}
