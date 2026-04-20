/**
 * Stewardship.IS brand palette — Slipstream edition.
 *
 * Color system:
 *   - Navy family is for dark surfaces (header, footer) and primary text on light backgrounds.
 *   - "primary" (blue) is the action color — used for CTAs like "Sign in" and "Generate & Download."
 *   - "brandGreen" is Slipstream Accent 3 — replaces the old teal as the brand accent
 *     (wordmark highlight, active nav indicator, help-callout border). Action (blue) and
 *     brand accent (green) stay separate so the UI has a two-layer hierarchy: green says
 *     "this is ours," blue says "click here to do something."
 *   - "logoAccent" is black — the solid block on the logo mark on light surfaces. On the navy
 *     header we pass white explicitly (see Layout.tsx) so the mark stays legible on dark.
 *   - Slipstream Accent 1 (purple) and Accent 5 (orange) drive the Dashboard page treatment:
 *       · purple for the "Dashboard" page title
 *       · orange for the text inside the light-green stat/activity cards
 *   - Gray scale is tuned to read well on both the navy header and the off-white page background.
 *   - Status colors are distinct hues (dark green/orange/red/blue) — separate from brandGreen,
 *     so a "completed" pill doesn't read the same as the brand wordmark.
 *
 * Usage note: every component pulls from this file so palette changes are a one-file edit.
 */

export const colors = {
  // ── Navy family (dark surfaces, primary text on light) ──
  midnightNavy: '#0F2A44', // primary.700 — header & footer bg, body text on light

  // ── Primary action color ──
  primary: '#1F4FD8', // primary.500 — Sign in, Generate & Download, primary buttons
  primaryLight: '#E6ECFF', // primary.100 — soft bg tint for primary-accented callouts

  // ── Brand accent (Slipstream Accent 3 — main green) ──
  brandGreen: '#A7EA52', // wordmark highlight, active nav underline, help-callout border
  brandGreenLight: '#E4F7C4', // light tint — dashboard card backgrounds

  // ── Logo accent (black on light surfaces; Layout.tsx overrides to white on the navy header) ──
  logoAccent: '#000000',

  // ── Slipstream secondary accents (used on Dashboard page) ──
  brandPurple: '#4E67C8', // Slipstream Accent 1 — "Dashboard" page title
  brandOrange: '#FFA751', // Slipstream Accent 5 — card text on light-green cards

  // ── Neutrals ──
  white: '#FFFFFF', // gray.0
  lightGray: '#F5F7FA', // gray.50 — page background
  mediumGray: '#D5DBE3', // gray.200 — borders, dividers
  darkGray: '#6B7280', // gray.500 — muted text on light backgrounds
  steelBlue: '#B6BFCB', // gray.300 — muted text on the navy header (inactive nav, user email, footer)

  // ── Status ──
  success: '#2E7D32', // success.500 — dark green (kept distinct from brandGreen)
  successBg: '#E8F5E9', // success.100
  warning: '#ED8B00', // warning.500 — orange (kept distinct from brandOrange)
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
