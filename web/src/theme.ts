/**
 * Stewardship.IS brand palette.
 *
 * All hex values are drawn from the user-provided 10-color palette (Light 1,
 * Dark 1, Light 2, Dark 2, + 6 Accents, with two tint rows). The visual
 * hierarchy matches the prior design that was approved on-screen:
 *   - Navy family: Dark 2 — header/footer background and primary body text
 *   - "primary" blue: Accent 1 — CTAs like "Sign in" and "Generate & Download"
 *   - "electricTeal" (brand accent): Accent 4 — logo accent, wordmark highlight,
 *     active nav underline, help-callout border. Keeping a clear separation
 *     between action (blue) and brand accent (teal) gives the UI a two-layer
 *     hierarchy: teal says "this is ours," blue says "click here to do something."
 *   - Gray scale: palette row 2/3 neutrals — tuned to read on both navy and white.
 *   - Status colors: warning/danger/info use palette accents 5/6/2. Success stays
 *     on a semantic dark green (not palette Accent 3) because A7EA52 is a vivid
 *     lime that would read as "highlighter" in small status pills.
 *
 * Usage note: every component pulls from this file so palette changes are a
 * one-file edit.
 */

export const colors = {
  // ── Navy family (dark surfaces, primary text on light) ──
  midnightNavy: '#212745', // palette Dark 2 — header & footer bg, body text on light

  // ── Primary action color ──
  primary: '#4E67C8', // palette Accent 1 — Sign in, Generate & Download, primary buttons
  primaryLight: '#DBE0F4', // palette Accent 1 tint row 2 — soft bg tint for primary-accented callouts

  // ── Brand accent (teal) ──
  electricTeal: '#5DCEAF', // palette Accent 4 — logo accent, active nav underline, brand highlights
  tealLight: '#DEF5EF', // palette Accent 4 tint row 2

  // ── Neutrals ──
  white: '#FFFFFF', // palette Light 1
  lightGray: '#F2F2F2', // palette neutral row 2 — page background
  mediumGray: '#D9D9D9', // palette neutral row 3 — borders, dividers
  darkGray: '#595959', // palette neutral row 3 — muted text on light backgrounds
  steelBlue: '#C7CCE4', // palette Dark 2 tint row 2 — muted text on the navy header

  // ── Status ──
  success: '#2E7D32', // semantic dark green (kept — palette Accent 3 #A7EA52 is too vivid for pills)
  successBg: '#E8F5E9',
  warning: '#FF8021', // palette Accent 5 — orange
  warningBg: '#FFE6D2', // palette Accent 5 tint row 2
  danger: '#F14124', // palette Accent 6 — red
  dangerBg: '#FCDAD3', // palette Accent 6 tint row 2
  info: '#5ECCF3', // palette Accent 2 — cyan
  infoBg: '#DDF5FD', // palette Accent 2 tint row 2
} as const;

export type ColorToken = keyof typeof colors;

/**
 * Small helper — consistent card shadow used across the app.
 * Shadow tint mirrors the new navy (palette Dark 2) so shadows harmonize with
 * the header instead of carrying the old navy hue.
 */
export const shadows = {
  card: '0 1px 3px rgba(33, 39, 69, 0.08), 0 1px 2px rgba(33, 39, 69, 0.04)',
  cardHover: '0 4px 12px rgba(33, 39, 69, 0.12), 0 2px 4px rgba(33, 39, 69, 0.06)',
} as const;
