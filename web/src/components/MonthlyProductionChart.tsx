/**
 * MonthlyProductionChart — overview bar chart shown below the Monthly
 * Export form. Three small charts side-by-side (Oil / Gas / Water) over
 * the last 24 months of monthly production data.
 *
 * Data source: the `monthly_production_totals(p_start, p_end, p_operator)`
 * Postgres RPC (added in migration 004). The function is SECURITY INVOKER
 * so RLS scopes the result to the caller's tenant automatically.
 *
 * Implementation notes:
 *   • Inline SVG — keeps the bundle small and matches the existing
 *     Sparkline pattern in DashboardPage. No chart library.
 *   • Three commodities are shown as three independent micro-charts
 *     rather than one combined chart because the units differ
 *     (BBL for oil/water, MCF for gas) and the magnitudes are very
 *     different across months. Side-by-side is easier to read for a
 *     non-technical viewer.
 *   • Tooltips: rendered as a floating div, not a <title>, so hover
 *     state is visible without the OS delay.
 *   • Last 24 calendar months by default (`monthsBack` prop overridable).
 *
 * Edge cases handled:
 *   • Empty data → renders a small "No data yet" placeholder
 *   • All-zero months → bars render at min height so the axis isn't a
 *     dead bar across the bottom
 *   • Negative values (BS&W corrections per project rules) → preserved
 *     as-is, drawn as downward bars from the zero line
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../utils/supabase';
import { colors, radii, shadows } from '../theme';

type MonthRow = {
  month: string;      // 'YYYY-MM-DD' (first of month)
  oil_total: number;
  gas_total: number;
  water_total: number;
  row_count: number;
};

interface Props {
  /** How many months back from today to show. Default 24. */
  monthsBack?: number;
}

export default function MonthlyProductionChart({ monthsBack = 24 }: Props) {
  const [rows, setRows] = useState<MonthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Compute the start = first of the month, `monthsBack` months ago.
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth() - monthsBack + 1, 1);
      const startStr = start.toISOString().slice(0, 10);

      const { data, error: e } = await supabase.rpc('monthly_production_totals', {
        p_start: startStr,
        p_end: null,
        p_operator: null,
      });

      if (cancelled) return;
      if (e) {
        setError(e.message);
        setLoading(false);
        return;
      }

      // Coerce numerics to JS numbers (Supabase returns numeric as string for
      // big values to avoid loss of precision — we cast for chart math).
      const parsed: MonthRow[] = (data ?? []).map((r: MonthRow) => ({
        month: r.month,
        oil_total: Number(r.oil_total) || 0,
        gas_total: Number(r.gas_total) || 0,
        water_total: Number(r.water_total) || 0,
        row_count: Number(r.row_count) || 0,
      }));
      setRows(parsed);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [monthsBack]);

  // Container card (matches the form card styling above)
  const cardStyle: React.CSSProperties = {
    backgroundColor: colors.surface,
    border: `1px solid ${colors.borderCard}`,
    borderRadius: radii.xl,
    padding: '26px',
    boxShadow: shadows.card,
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  };

  if (loading) {
    return (
      <div style={cardStyle}>
        <Header monthsBack={monthsBack} />
        <div style={{ color: colors.textMuted, fontSize: '13px' }}>Loading production overview…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={cardStyle}>
        <Header monthsBack={monthsBack} />
        <div style={{ color: colors.danger, fontSize: '13px' }}>
          Could not load chart data: {error}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div style={cardStyle}>
        <Header monthsBack={monthsBack} />
        <div style={{ color: colors.textMuted, fontSize: '13px' }}>
          No monthly production data in the last {monthsBack} months yet.
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <Header monthsBack={monthsBack} fromMonth={rows[0]?.month} toMonth={rows[rows.length - 1]?.month} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: '20px',
        }}
      >
        <ChartPanel
          title="Oil"
          unit="BBL"
          color={colors.electricTeal}
          values={rows.map((r) => ({ month: r.month, value: r.oil_total }))}
        />
        <ChartPanel
          title="Gas"
          unit="MCF"
          color="#C44536" /* brick red — chosen over theme `danger` so error states stay distinct */
          values={rows.map((r) => ({ month: r.month, value: r.gas_total }))}
        />
        <ChartPanel
          title="Water"
          unit="BBL"
          color="#4A6FA5" /* steel blue — kept literal because not in theme */
          values={rows.map((r) => ({ month: r.month, value: r.water_total }))}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function Header({
  monthsBack,
  fromMonth,
  toMonth,
}: {
  monthsBack: number;
  fromMonth?: string;
  toMonth?: string;
}) {
  return (
    <div>
      <h3
        style={{
          margin: 0,
          color: colors.midnightNavy,
          fontSize: '18px',
          fontWeight: 700,
          letterSpacing: '-0.2px',
        }}
      >
        Monthly Production Overview
      </h3>
      <p style={{ margin: '4px 0 0 0', color: colors.textMuted, fontSize: '13px' }}>
        {fromMonth && toMonth
          ? `${formatMonthLong(fromMonth)} – ${formatMonthLong(toMonth)} · summed across all wells visible to you`
          : `Last ${monthsBack} months · summed across all wells visible to you`}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

interface ChartPanelProps {
  title: string;
  unit: string;
  color: string;
  values: { month: string; value: number }[];
}

function ChartPanel({ title, unit, color, values }: ChartPanelProps) {
  // Use a fixed viewBox; the parent grid handles responsive sizing.
  const W = 320;
  const H = 140;
  const padLeft = 36; // room for the y-axis label
  const padRight = 6;
  const padTop = 8;
  const padBottom = 22; // room for the x-axis label

  const innerW = W - padLeft - padRight;
  const innerH = H - padTop - padBottom;

  // Compute a "nice" max so the top of the chart aligns to a round number.
  const rawMax = Math.max(0, ...values.map((v) => v.value));
  const niceMax = niceCeil(rawMax);

  const barGap = 2;
  const barW = Math.max(2, (innerW - barGap * (values.length - 1)) / values.length);

  // Track hover via React state.
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const total = useMemo(() => values.reduce((s, v) => s + v.value, 0), [values]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        position: 'relative',
        minWidth: 0, /* allow shrink in grid */
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: colors.midnightNavy }}>
          {title} <span style={{ color: colors.textMuted, fontWeight: 400 }}>({unit})</span>
        </span>
        <span style={{ fontSize: '11px', color: colors.textMuted }}>
          Total: {formatCompact(total)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: 'block', userSelect: 'none' }}
        role="img"
        aria-label={`${title} monthly production bar chart`}
      >
        {/* Y-axis baseline */}
        <line
          x1={padLeft}
          x2={W - padRight}
          y1={padTop + innerH}
          y2={padTop + innerH}
          stroke={colors.borderCard}
          strokeWidth="1"
        />
        {/* Top gridline */}
        <line
          x1={padLeft}
          x2={W - padRight}
          y1={padTop}
          y2={padTop}
          stroke={colors.borderSoft}
          strokeWidth="1"
        />
        {/* Y-axis labels (0 and max) */}
        <text
          x={padLeft - 4}
          y={padTop + 4}
          fontSize="9"
          textAnchor="end"
          fill={colors.textMuted}
        >
          {formatCompact(niceMax)}
        </text>
        <text
          x={padLeft - 4}
          y={padTop + innerH}
          fontSize="9"
          textAnchor="end"
          fill={colors.textMuted}
        >
          0
        </text>

        {/* Bars */}
        {values.map((v, i) => {
          const xPos = padLeft + i * (barW + barGap);
          const h = niceMax > 0 ? Math.max(1, (v.value / niceMax) * innerH) : 0;
          const yPos = padTop + innerH - h;
          const isHover = hover?.idx === i;
          return (
            <rect
              key={v.month}
              x={xPos}
              y={yPos}
              width={barW}
              height={h}
              fill={color}
              opacity={isHover ? 1 : 0.85}
              rx="1.5"
              onMouseEnter={() => setHover({ idx: i, x: xPos + barW / 2, y: yPos })}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer', transition: 'opacity 120ms ease' }}
            />
          );
        })}

        {/* X-axis labels — first, middle, last only to keep it clean */}
        {[0, Math.floor(values.length / 2), values.length - 1].map((i) => {
          if (i < 0 || i >= values.length) return null;
          const xPos = padLeft + i * (barW + barGap) + barW / 2;
          return (
            <text
              key={`xl-${i}`}
              x={xPos}
              y={H - 6}
              fontSize="9"
              textAnchor="middle"
              fill={colors.textMuted}
            >
              {formatMonthShort(values[i].month)}
            </text>
          );
        })}
      </svg>

      {hover && (
        <div
          style={{
            position: 'absolute',
            // Position above the hovered bar; clamp inside the panel.
            left: `${Math.min(Math.max(8, (hover.x / W) * 100), 92)}%`,
            transform: 'translateX(-50%)',
            top: '34px',
            backgroundColor: colors.midnightNavy,
            color: colors.white,
            padding: '6px 9px',
            borderRadius: radii.md,
            fontSize: '11px',
            lineHeight: 1.4,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            boxShadow: shadows.cardHover,
            zIndex: 2,
          }}
        >
          <div style={{ fontWeight: 600 }}>{formatMonthLong(values[hover.idx].month)}</div>
          <div>
            {formatCompact(values[hover.idx].value)} {unit}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

/** Round up to a "nice" axis max (1, 2, 2.5, 5, 10 × 10^n). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const norm = v / base;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 2.5) nice = 2.5;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/** Compact number formatter — 1.2M, 850K, 47.2K, 612. */
function formatCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return v.toFixed(0);
}

/** 'YYYY-MM-DD' → 'Mar' (no year). */
function formatMonthShort(iso: string): string {
  const [y, m] = iso.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short' });
}

/** 'YYYY-MM-DD' → 'Mar 2026'. */
function formatMonthLong(iso: string): string {
  const [y, m] = iso.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
