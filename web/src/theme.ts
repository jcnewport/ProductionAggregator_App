/**
 * Stewardship.IS brand palette + shared design tokens.
 *
 * Visual direction (chosen 2026-04-21): "Enterprise Confident" base with two
 * accents borrowed from other directions:
 *   - Option B's pulsing LIVE badge and auto-refresh indicator (using @keyframes
 *     liveGlow in index.css)
 *   - Option A's subtle hover-lift on cards (shadows.cardHover + transitions.card)
 *
 * The look: crisp light-mode, strong typography, connected stat bar with
 * sparklines, dark-navy primary button, inline status tags — financial-grade
 * software, Stripe/Ramp feel.
 *
 * The Deep Current palette is unchanged. Every hex here comes from the
 * approved 10-color palette. What's new below is structure — radii,
 * transitions, secondary neutrals tuned for the light-mode canvas, and a
 * sparkline stroke color for the dashboard stat cards.
 *
 * Usage note: every component pulls from this file so palette changes are a
 * one-file edit.
 */

export const colors = {
  // ── Navy family (dark surfaces, primary text on light) ──
  midnightNavy: '#212745', // palette Dark 2 — header text, body text on light, primary button
  midnightNavyHover: '#2A3155', // one step lighter — primary button :hover state

  // ── Primary action color ──
  primary: '#4E67C8', // palette Accent 1 — kept for backwards compatibility / secondary CTAs
  primaryLight: '#DBE0F4', // palette Accent 1 tint row 2 — soft bg tint for primary-accented callouts

  // ── Brand accent (teal) ──
  electricTeal: '#5DCEAF', // palette Accent 4 — logo accent, LIVE badge, active nav dot
  tealLight: '#DEF5EF', // palette Accent 4 tint row 2
  tealBright: '#4AE3B8', // slightly more saturated teal for hover glow on LIVE indicator

  // ── Neutrals (tuned for the new light-mode canvas) ──
  white: '#FFFFFF', // palette Light 1
  pageBg: '#FAFBFC', // NEW — page canvas (slightly warmer than pure white)
  surface: '#FFFFFF', // card surface on the canvas
  surfaceHover: '#F7F8FC', // card-hover tint
  surfaceMuted: '#F2F3F7', // table header bg, nav pill hover
  lightGray: '#F2F2F2', // LEGACY — kept so older components don't break
  mediumGray: '#D9D9D9', // LEGACY borders
  borderSoft: '#F0F2F6', // NEW — table row dividers (very subtle)
  borderCard: '#E4E7ED', // NEW — card borders, table outer border
  darkGray: '#595959', // LEGACY muted text
  textMuted: '#5A6378', // NEW — secondary text on light bg (nav, labels)
  steelBlue: '#C7CCE4', // palette Dark 2 tint row 2 — kept for any lingering navy surfaces

  // ── Status ──
  success: '#2E7D32',
  successBg: '#E8F5E9',
  warning: '#FF8021',
  warningBg: '#FFE6D2',
  danger: '#F14124',
  dangerBg: '#FCDAD3',
  info: '#5ECCF3',
  infoBg: '#DDF5FD',
} as const;

export type ColorToken = keyof typeof colors;

/**
 * Shadow tokens. `card` is the default resting shadow (very subtle — we lean
 * on the 1px borderCard to separate cards from the canvas). `cardHover` is
 * the lift we apply on hover for interactive cards (Option A's hover lift).
 * Shadow tint is the navy (palette Dark 2) so it harmonizes with the palette.
 */
export const shadows = {
  card: '0 1px 2px rgba(33, 39, 69, 0.04)',
  cardHover: '0 4px 16px rgba(33, 39, 69, 0.08), 0 2px 6px rgba(33, 39, 69, 0.04)',
  // LIVE badge glow — used at the header and on the auto-refresh indicator
  tealGlow: '0 0 0 3px rgba(93, 206, 175, 0.15)',
} as const;

/**
 * Radius tokens. We use 14px for cards (the "Enterprise Confident" spec),
 * 10px for buttons and form controls, 8px for smaller inline chips, and
 * 999px for pill-shaped status badges.
 */
export const radii = {
  sm: '6px',
  md: '8px',
  lg: '10px',
  xl: '14px',
  pill: '999px',
} as const;

/**
 * Shared transition curves. `card` is the hover lift used on cards and stat
 * tiles. `snappy` is for small affordances (buttons, tabs) that should feel
 * immediate. Both use a cubic-bezier that overshoots very slightly for a
 * "premium" feel without being bouncy.
 */
export const transitions = {
  card: 'all 0.25s cubic-bezier(.2,.9,.3,1.2)',
  snappy: 'all 0.18s cubic-bezier(.2,.9,.3,1.2)',
} as const;

/**
 * Spark-line stroke color used on dashboard stat cards. Kept separate from
 * `colors.electricTeal` in case we ever want the sparkline to sit at a
 * slightly different opacity/weight than the brand accent itself.
 */
export const sparkColor = colors.electricTeal;
