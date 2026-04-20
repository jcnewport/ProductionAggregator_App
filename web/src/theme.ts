/**
 * Stewardship.IS brand palette.
 *
 * Color system:
 *   - Navy family is for dark surfaces (header, footer) and primary text on light backgrounds.
 *   - "primary" (blue) is the action color — used for CTAs like "Sign in" and "Generate & Download."
 *   - "electricTeal" is the brand accent — logo highlight, active nav indicator, help-callout border.
 *     Keeping a clear separation between action (blue) and brand accent (teal) gives the UI a nice
 *     two-layer hierarchy: teal says "this is ours," blue says "click here to do something."
 *   - Gray scale is tuned to read well on both the navy header and the off-white page background.
 *   - Status colors are distinct hues (green/orange/red/blue) — no longer reusing teal for success,
 *     so a successful-green chip and a brand-teal logo don't get confused.
 *
 * Usage note: every component pulls from this file so palette changes are a one-file edit.
 */

export const colors = {
  // ── Navy family (dark surfaces, primary text on light) ──
  midnightNavy: '#0F2A44', // primary.700 — header & footer bg, body text on light

  // ── Primary action color ──
  primary: '#1F4FD8', // primary.500 — Sign in, Generate & Download, primary buttons
  primaryLight: '#E6ECFF', // primary.100 — soft bg tint for primary-accented callouts

  // ── Brand accent (teal) ──
  electricTeal: '#2FA4A9', // secondary.teal.500 — logo accent, active nav underline, brand highlights
  tealLight: '#E6F6F7', // secondary.teal.100

  // ── Neutrals ──
  white: '#FFFFFF', // gray.0
  lightGray: '#F5F7FA', // gray.50 — page background
  mediumGray: '#D5DBE3', // gray.200 — borders, dividers
  darkGray: '#6B7280', // gray.500 — muted text on light backgrounds
  steelBlue: '#B6BFCB', // gray.300 — muted text on the navy header (inactive nav, user email, footer)

  // ── Status ──
  success: '#2E7D32', // success.500 — green
  successBg: '#E8F5E9', // success.100
  warning: '#ED8B00', // warning.500 — orange
  warningBg: '#FFF4E5', // warning.100
  danger: '#C62828', // error.500 — red
  dangerBg: '#FDECEC', // error.100
  info: '#0288D1', // info.500 — blue
  infoBg: '#E6F4FA', // info.100
} as const;

export type ColorToken = keyof typeof colors;

/**
 * Small helper — consistent card shadow used across the app.
 */
export const shadows = {
  card: '0 1px 3px rgba(15, 42, 68, 0.08), 0 1px 2px rgba(15, 42, 68, 0.04)',
  cardHover: '0 4px 12px rgba(15, 42, 68, 0.12), 0 2px 4px rgba(15, 42, 68, 0.06)',
} as const;
