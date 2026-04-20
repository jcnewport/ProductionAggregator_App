/**
 * Deep Current palette — the S.IS brand colors.
 *
 * Used across every component as inline style references. Keeping these here
 * (rather than as CSS variables alone) so TypeScript catches typos and IDE
 * autocomplete suggests the right token while building pages.
 */

export const colors = {
  midnightNavy: '#0A1628',
  steelBlue: '#4A6FA5',
  electricTeal: '#00BFA6',

  white: '#FFFFFF',
  lightGray: '#F0F2F5',
  mediumGray: '#D7DCE2',
  darkGray: '#6B7380',

  // Status colors tuned to harmonize with the palette
  success: '#00BFA6',        // same teal
  warning: '#E8A33D',
  danger: '#D94A4A',
  info: '#4A6FA5',           // same steel blue
} as const;

export type ColorToken = keyof typeof colors;

/**
 * Small helper — consistent card shadow used across the app.
 */
export const shadows = {
  card: '0 1px 3px rgba(10, 22, 40, 0.08), 0 1px 2px rgba(10, 22, 40, 0.04)',
  cardHover: '0 4px 12px rgba(10, 22, 40, 0.12), 0 2px 4px rgba(10, 22, 40, 0.06)',
} as const;
