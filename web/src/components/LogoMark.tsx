/**
 * LogoMark — the Stewardship.IS abstract mark, rendered inline as SVG
 * so we can re-color it to suit any surface.
 *
 * The icon has two elements:
 *   - The "stripes" (multiple thin parallelograms) — usually rendered in a muted gray
 *   - The "accent" (one solid block) — usually rendered in the brand teal
 *
 * Exposing both as props lets us use a brighter stripe on the dark navy header
 * and a softer gray stripe on the white login card without duplicating the SVG.
 */

interface LogoMarkProps {
  /** Rendered width/height in px (keeps 1:1 aspect ratio). */
  size?: number;
  /** Color of the gray-stripe elements. Defaults to a neutral gray that reads on white. */
  stripe?: string;
  /** Color of the solid accent block. Defaults to brand teal. */
  accent?: string;
  /** Extra inline styles (e.g., margin) the caller wants to apply. */
  style?: React.CSSProperties;
}

export default function LogoMark({
  size = 32,
  stripe = '#98A2B3',
  accent = '#2FA4A9',
  style,
}: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 250 250"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Stewardship.IS"
      style={style}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M207.527 130.511H122.106L126.225 115.413H211.647L207.527 130.511ZM213.159 109.868H127.737L132.091 93.9121H217.514L213.159 109.868ZM219.026 88.3672H133.604L137.956 72.4141H223.379L219.026 88.3672ZM224.892 66.8691H139.47L143.823 50.9121H229.246L224.892 66.8691ZM230.759 45.3672H145.336L149.256 31H234.679L230.759 45.3672ZM19.7654 183.199H105.188L101.423 197H16L19.7654 183.199ZM120.688 131.015H35.0777L23.1833 174.61H108.793L120.688 131.015Z"
        fill={stripe}
      />
      <path
        d="M23.1812 174.654L35.1524 130.76H121.345L108.576 174.654H23.1812Z"
        fill={accent}
      />
    </svg>
  );
}
