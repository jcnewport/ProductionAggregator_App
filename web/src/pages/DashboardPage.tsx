/**
 * DashboardPage — home screen after login.
 *
 * UI direction (chosen 2026-04-21): "Enterprise Confident" base with two
 * borrowed accents:
 *   - A connected 4-stat bar (single bordered card with dividers between
 *     stats) topped with mini sparklines
 *   - A subtle hover-lift on cards (className="sis-hover-lift" — Option A)
 *   - A pulsing "LIVE · auto-refresh 15m" indicator on the Recent Activity
 *     card (className="sis-live-dot" — Option B)
 *
 * Three sections:
 *   1. Summary stats (monthly rows, daily rows, last-email-received, rows flagged)
 *   2. Flagged imports + row-level rejections
 *   3. Recent email processing activity (auto-refreshes every 15 minutes while
 *      the tab is active so Caleb's dashboard stays warm without clicking
 *      Refresh; manual Refresh in the header is always available for on-demand)
 *
 * Everything is read directly from Supabase via the authenticated session —
 * no custom API endpoint needed. If/when multi-tenancy is added, RLS filters
 * will constrain results without any frontend change.
 *
 * Refresh behavior (changed 2026-04-29):
 *   - The header "Refresh" button does TWO things in sequence:
 *       1. POSTs to /api/poll, which triggers runPollingPass() on the backend
 *          (the same function the 15-min cron runs). Pulls anything new from
 *          Gmail and writes it to email_log + production_*.
 *       2. Re-reads the database so any new rows surface in the UI.
 *     This was a deliberate UX choice: "Refresh" should mean "show me the
 *     latest" — and "the latest" includes mail that hasn't been polled yet.
 *     The button is super-admin gated by /api/poll itself; if a non-admin
 *     ever sees it, they get a clear error toast.
 *   - The 15-min auto-refresh tick still ONLY re-reads the DB. It doesn't
 *     trigger a poll, because the cron is already polling on its own
 *     schedule and we don't want to double up.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../utils/supabase';
import { colors, shadows, radii, transitions, sparkColor } from '../theme';

interface EmailLogRow {
  id: string;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  attachments_found: number | null;
  attachments_processed: number | null;
  status: string;
  error_messages: string[] | null;
  // Task #62 retry columns. All nullable because the DB defaults
  // take effect on insert, but older rows (pre-migration) will still
  // surface here if anything cached them before the backfill.
  retry_count: number | null;
  max_retries: number | null;
  is_retryable: boolean | null;
  next_retry_at: string | null;
  last_retry_outcome: string | null;
}

interface Stats {
  monthlyRows: number | null;
  dailyRows: number | null;
  lastReceivedAt: string | null;
  flaggedRowCount: number | null;
}

interface FlaggedRow {
  id: string;
  source_file_name: string;
  reason: string;
  attempted_well_name: string | null;
  attempted_api10: string | null;
  created_at: string;
}

/** How often the dashboard silently re-fetches to keep the Recent Activity
 * table warm. 15 min keeps the view fresh without hammering Supabase or
 * burning quota — operators only send a couple of emails a day, so a faster
 * cadence buys nothing. Manual Refresh in the header is always available
 * for an on-demand pull. Paused when the tab isn't visible. */
const AUTO_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

export default function DashboardPage() {
  const [recent, setRecent] = useState<EmailLogRow[]>([]);
  const [flagged, setFlagged] = useState<EmailLogRow[]>([]);
  const [flaggedRows, setFlaggedRows] = useState<FlaggedRow[]>([]);
  const [stats, setStats] = useState<Stats>({
    monthlyRows: null,
    dailyRows: null,
    lastReceivedAt: null,
    flaggedRowCount: null,
  });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  // Nonce bumped when we need to re-fetch (after a Retry Now click, manual
  // refresh, or the 15-minute auto-refresh tick).
  const [reloadTick, setReloadTick] = useState(0);

  // Manual-refresh state. isRefreshing gates the button so it can't be
  // double-clicked while a poll is in flight; refreshResult is a transient
  // status message we show in the header for ~6 seconds after the refresh
  // completes so Caleb has confirmation of what just happened.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<
    | { tone: 'success' | 'info' | 'danger'; message: string }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErr(null);
      try {
        // Run all queries in parallel for a faster first paint
        const [
          recentRes,
          flaggedRes,
          monthlyCountRes,
          dailyCountRes,
          flaggedRowsRes,
          flaggedRowCountRes,
        ] = await Promise.all([
          supabase
            .from('email_log')
            .select(
              'id, sender, subject, received_at, attachments_found, attachments_processed, status, error_messages, retry_count, max_retries, is_retryable, next_retry_at, last_retry_outcome'
            )
            .order('received_at', { ascending: false })
            .limit(20),
          supabase
            .from('email_log')
            .select(
              'id, sender, subject, received_at, attachments_found, attachments_processed, status, error_messages, retry_count, max_retries, is_retryable, next_retry_at, last_retry_outcome'
            )
            .in('status', ['failed', 'partial'])
            .order('received_at', { ascending: false })
            .limit(10),
          supabase.from('production_monthly').select('*', { count: 'exact', head: true }),
          supabase.from('production_daily').select('*', { count: 'exact', head: true }),
          // Row-level rejections from the storage-layer validator.
          // Separate from email_log.status because one file can reject some
          // rows while still storing others successfully.
          supabase
            .from('flagged_records')
            .select('id, source_file_name, reason, attempted_well_name, attempted_api10, created_at')
            .order('created_at', { ascending: false })
            .limit(15),
          supabase.from('flagged_records').select('*', { count: 'exact', head: true }),
        ]);

        if (cancelled) return;

        if (recentRes.error) throw new Error(`recent: ${recentRes.error.message}`);
        if (flaggedRes.error) throw new Error(`flagged: ${flaggedRes.error.message}`);
        if (monthlyCountRes.error) throw new Error(`monthly count: ${monthlyCountRes.error.message}`);
        if (dailyCountRes.error) throw new Error(`daily count: ${dailyCountRes.error.message}`);
        if (flaggedRowsRes.error) throw new Error(`flagged_records: ${flaggedRowsRes.error.message}`);
        if (flaggedRowCountRes.error) throw new Error(`flagged_records count: ${flaggedRowCountRes.error.message}`);

        setRecent((recentRes.data ?? []) as EmailLogRow[]);
        setFlagged((flaggedRes.data ?? []) as EmailLogRow[]);
        setFlaggedRows((flaggedRowsRes.data ?? []) as FlaggedRow[]);
        setStats({
          monthlyRows: monthlyCountRes.count ?? 0,
          dailyRows: dailyCountRes.count ?? 0,
          lastReceivedAt: recentRes.data?.[0]?.received_at ?? null,
          flaggedRowCount: flaggedRowCountRes.count ?? 0,
        });
        setLastRefreshedAt(new Date());
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // Auto-refresh ticker (borrowed from Option B's "live feel"). Silent
  // refresh — we only bump reloadTick, which triggers the effect above.
  // Paused whenever the tab isn't visible so we don't burn Supabase quota
  // on a backgrounded window.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setReloadTick((n) => n + 1);
      }
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  // Internal "just re-read the DB" — used by the auto-refresh tick (which
  // doesn't poll Gmail because the backend cron is already doing that on
  // its own schedule) and by manual refresh after the poll finishes.
  const reloadFromDb = () => setReloadTick((n) => n + 1);

  /**
   * Manual Refresh — does both halves of "show me the latest":
   *   1. POSTs to /api/poll, which triggers runPollingPass() on the backend.
   *      That goes out to Gmail, downloads any new attachments, runs them
   *      through the parsers, and writes the results to email_log +
   *      production_*. Same function the 15-min cron runs.
   *   2. Re-reads the database so any new rows surface in the UI.
   *
   * Returns in 5–20 seconds typically (most of that is the Gmail round-trip
   * + parsing). Toast in the header confirms what happened: "Found 2 new
   * messages" or "Inbox is clear — no new messages."
   *
   * The endpoint is requireSuperAdmin-gated on the backend. If a non-admin
   * ever clicks this, we surface the 403 as a user-facing error. The 15-min
   * auto-refresh tick deliberately does NOT call /api/poll — it just re-reads
   * the DB — to avoid doubling up on the cron's polling schedule.
   */
  async function handleRefresh() {
    setIsRefreshing(true);
    setRefreshResult(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? '';

      const resp = await fetch('/api/poll', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const json = await resp.json();
      if (!resp.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${resp.status}`);
      }
      const n = json.messagesProcessed ?? 0;
      setRefreshResult({
        tone: n > 0 ? 'success' : 'info',
        message:
          n === 0
            ? 'Inbox is clear — no new messages.'
            : `Found ${n} new message${n === 1 ? '' : 's'}.`,
      });
      // Pull the freshly-written rows into the dashboard tables.
      reloadFromDb();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRefreshResult({
        tone: 'danger',
        message: `Couldn't reach the inbox: ${msg}`,
      });
      // Even on poll failure, do a DB re-read so at least the rest of the
      // dashboard reflects the most recent state.
      reloadFromDb();
    } finally {
      setIsRefreshing(false);
    }
  }

  // Auto-clear the result toast after ~6 seconds so it doesn't hang
  // around forever on a quiet morning.
  useEffect(() => {
    if (!refreshResult) return;
    const id = window.setTimeout(() => setRefreshResult(null), 6000);
    return () => window.clearTimeout(id);
  }, [refreshResult]);

  return (
    <div className="sis-stagger" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <PageHeader
        title="Dashboard"
        subtitle="Live view of inbox processing, flagged imports, and stored production totals."
        onRefresh={handleRefresh}
        loading={loading}
        refreshing={isRefreshing}
        refreshResult={refreshResult}
      />

      {err && <ErrorBanner message={err} />}

      {/* Connected stat bar — single card, internal dividers between stats. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          backgroundColor: colors.surface,
          border: `1px solid ${colors.borderCard}`,
          borderRadius: radii.xl,
          boxShadow: shadows.card,
          overflow: 'hidden',
        }}
      >
        <StatCell
          label="Monthly rows in storage"
          value={formatInt(stats.monthlyRows)}
          loading={loading}
          spark={[18, 15, 17, 10, 12, 6, 4]}
        />
        <StatCell
          label="Daily rows in storage"
          value={formatInt(stats.dailyRows)}
          loading={loading}
          spark={[14, 12, 15, 10, 11, 7, 5]}
          borderLeft
        />
        <StatCell
          label="Last email received"
          value={formatRelative(stats.lastReceivedAt)}
          loading={loading}
          smaller
          borderLeft
        />
        <StatCell
          label="Rows flagged for review"
          value={formatInt(stats.flaggedRowCount)}
          loading={loading}
          flag={Boolean(stats.flaggedRowCount && stats.flaggedRowCount > 0)}
          borderLeft
        />
      </div>

      {/* Flagged imports */}
      <Card
        title="Flagged imports needing attention"
        subtitle={
          flagged.length === 0
            ? 'All recent imports processed cleanly. Nothing to review.'
            : `${flagged.length} recent import${flagged.length === 1 ? '' : 's'} finished with errors.`
        }
        tag={flagged.length === 0 ? { text: 'clean', tone: 'success' } : { text: `${flagged.length} item${flagged.length === 1 ? '' : 's'}`, tone: 'warning' }}
      >
        {loading ? (
          <SkeletonRow />
        ) : flagged.length === 0 ? (
          <EmptyState message="All clear." detail="No failed or partial imports in the recent activity log." />
        ) : (
          <EmailLogTable rows={flagged} showErrors={true} onRetrySuccess={reloadFromDb} />
        )}
      </Card>

      {/* Row-level rejections */}
      <Card
        title="Row-level rejections"
        subtitle={
          flaggedRows.length === 0
            ? 'No individual rows have been rejected by the storage-layer validator. Inbox is clean at the row level.'
            : `${flaggedRows.length} most recent row${flaggedRows.length === 1 ? '' : 's'} rejected by API10 validation or other storage-time checks.`
        }
        tag={flaggedRows.length === 0 ? { text: 'clean', tone: 'success' } : { text: `${flaggedRows.length} item${flaggedRows.length === 1 ? '' : 's'}`, tone: 'warning' }}
      >
        {loading ? (
          <SkeletonRow />
        ) : flaggedRows.length === 0 ? (
          <EmptyState message="All clear." detail="Every row from the last 15 imports passed API10 validation." />
        ) : (
          <FlaggedRowsTable rows={flaggedRows} />
        )}
      </Card>

      {/* Recent activity — auto-refreshes every 15 minutes */}
      <Card
        title="Recent email processing activity"
        subtitle="Most recent 20 messages delivered to the production inbox."
        liveIndicator={lastRefreshedAt}
      >
        {loading ? (
          <SkeletonRow />
        ) : (
          <EmailLogTable rows={recent} showErrors={false} onRetrySuccess={reloadFromDb} />
        )}
      </Card>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Sub-components
 * ────────────────────────────────────────────────────────────── */

function PageHeader({
  title,
  subtitle,
  onRefresh,
  loading,
  refreshing,
  refreshResult,
}: {
  title: string;
  subtitle: string;
  onRefresh: () => void;
  loading: boolean;
  refreshing: boolean;
  refreshResult: { tone: 'success' | 'info' | 'danger'; message: string } | null;
}) {
  // Toast colour map — uses the same semantic colour tokens as the rest
  // of the dashboard so it doesn't stand out as a one-off design.
  const toastPalette: Record<
    'success' | 'info' | 'danger',
    { bg: string; fg: string; border: string }
  > = {
    success: {
      bg: `${colors.success}18`,
      fg: colors.success,
      border: `${colors.success}40`,
    },
    info: {
      bg: `${colors.info}18`,
      fg: '#1d6a89',
      border: `${colors.info}40`,
    },
    danger: {
      bg: colors.dangerBg,
      fg: colors.danger,
      border: `${colors.danger}40`,
    },
  };

  // Three button states:
  //   - "Refresh"      idle
  //   - "Checking…"    while the Gmail poll is in flight
  //   - "Refreshing…"  while the post-poll DB read is in flight
  // We pick the most informative label for whatever's happening right now.
  const buttonLabel = refreshing
    ? 'Checking…'
    : loading
    ? 'Refreshing…'
    : 'Refresh';

  return (
    <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: '16px' }}>
      <div>
        <h2
          style={{
            margin: 0,
            color: colors.midnightNavy,
            fontSize: '28px',
            fontWeight: 700,
            letterSpacing: '-0.5px',
          }}
        >
          {title}
        </h2>
        <p style={{ margin: '6px 0 0 0', color: colors.textMuted, fontSize: '14px' }}>{subtitle}</p>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '8px',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onRefresh}
          disabled={loading || refreshing}
          className="sis-btn sis-btn-secondary"
          style={{ whiteSpace: 'nowrap' }}
          title="Check the inbox for new emails and reload the dashboard. Takes 5–20 seconds."
        >
          {buttonLabel}
        </button>
        {refreshResult && (
          <div
            role="status"
            aria-live="polite"
            style={{
              backgroundColor: toastPalette[refreshResult.tone].bg,
              color: toastPalette[refreshResult.tone].fg,
              border: `1px solid ${toastPalette[refreshResult.tone].border}`,
              borderRadius: radii.pill,
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 600,
              maxWidth: '420px',
              textAlign: 'right',
            }}
          >
            {refreshResult.message}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Card — white surface with a 1px borderCard, hover-lift from Option A, and
 * an optional tag chip + optional LIVE indicator in the header row.
 */
function Card({
  title,
  subtitle,
  children,
  tag,
  liveIndicator,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  tag?: { text: string; tone: 'success' | 'warning' | 'info' };
  liveIndicator?: Date | null;
}) {
  return (
    <div className="sis-hover-lift" style={cardStyle}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'start',
          marginBottom: children ? '18px' : 0,
          gap: '12px',
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              color: colors.midnightNavy,
              fontSize: '16px',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            {title}
            {tag && <TagChip text={tag.text} tone={tag.tone} />}
          </h3>
          {subtitle && (
            <p style={{ margin: '4px 0 0 0', color: colors.textMuted, fontSize: '13px' }}>{subtitle}</p>
          )}
        </div>
        {liveIndicator !== undefined && (
          <LiveIndicator lastRefreshedAt={liveIndicator} />
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * LiveIndicator — pulsing teal dot + "Live · auto-refresh 15m". The heartbeat
 * of the dashboard. Shows the relative time of the last refresh in a tooltip.
 */
function LiveIndicator({ lastRefreshedAt }: { lastRefreshedAt: Date | null }) {
  const tooltip = lastRefreshedAt
    ? `Last refreshed ${lastRefreshedAt.toLocaleTimeString()}`
    : 'Refreshing every 15 minutes';
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '11px',
        fontWeight: 600,
        color: colors.success,
        backgroundColor: 'rgba(46, 125, 50, 0.08)',
        padding: '4px 10px',
        borderRadius: radii.pill,
        border: '1px solid rgba(46, 125, 50, 0.2)',
        whiteSpace: 'nowrap',
      }}
    >
      <span className="sis-live-dot" style={{ backgroundColor: colors.success }} />
      Live · auto-refresh 15m
    </span>
  );
}

/**
 * StatCell — one segment of the connected stat bar. Has an optional
 * sparkline (passed as an array of numeric heights) and a `flag` mode that
 * re-colors the delta row to amber.
 */
function StatCell({
  label,
  value,
  loading,
  spark,
  smaller,
  flag,
  borderLeft,
}: {
  label: string;
  value: string;
  loading: boolean;
  spark?: number[];
  smaller?: boolean;
  flag?: boolean;
  borderLeft?: boolean;
}) {
  return (
    <div
      style={{
        padding: '22px 22px',
        position: 'relative',
        borderLeft: borderLeft ? `1px solid ${colors.borderCard}` : 'none',
        transition: transitions.snappy,
      }}
    >
      <div style={{ fontSize: '12px', fontWeight: 500, color: colors.textMuted }}>{label}</div>
      <div
        className="sis-tabular"
        style={{
          fontSize: smaller ? '22px' : '30px',
          fontWeight: 700,
          color: colors.midnightNavy,
          marginTop: '8px',
          letterSpacing: '-1px',
          minHeight: '32px',
        }}
      >
        {loading ? '…' : value}
      </div>
      {flag && (
        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.warning, marginTop: '4px' }}>
          ⚠ needs attention
        </div>
      )}
      {spark && !loading && (
        <Sparkline points={spark} />
      )}
    </div>
  );
}

/**
 * Sparkline — bare 52×22 SVG polyline. Numeric array is mapped to y-values
 * (0 = bottom, 22 = top). Used on the two high-volume stat tiles; the other
 * two tiles (last-email, flagged-count) deliberately omit the sparkline so
 * the row stays visually balanced.
 */
function Sparkline({ points }: { points: number[] }) {
  const w = 52;
  const h = 22;
  const max = Math.max(...points, 1);
  const step = w / (points.length - 1);
  const d = points
    .map((p, i) => {
      const x = i * step;
      const y = h - (p / max) * (h - 2) - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      style={{ position: 'absolute', right: '18px', bottom: '18px', opacity: 0.55 }}
      aria-hidden="true"
    >
      <path d={d} fill="none" stroke={sparkColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small chip shown next to section titles like "1 item" or "clean". */
function TagChip({ text, tone }: { text: string; tone: 'success' | 'warning' | 'info' }) {
  const palette: Record<'success' | 'warning' | 'info', { bg: string; fg: string }> = {
    success: { bg: colors.tealLight, fg: '#0e6b52' },
    warning: { bg: colors.warningBg, fg: '#a24c0c' },
    info: { bg: colors.infoBg, fg: '#1d6a89' },
  };
  const { bg, fg } = palette[tone];
  return (
    <span
      style={{
        fontSize: '10px',
        fontWeight: 700,
        padding: '3px 8px',
        borderRadius: radii.sm,
        textTransform: 'uppercase',
        letterSpacing: '0.6px',
        background: bg,
        color: fg,
        verticalAlign: 'middle',
      }}
    >
      {text}
    </span>
  );
}

/** Empty state for clean sections — warmer than "No entries yet." */
function EmptyState({ message, detail }: { message: string; detail: string }) {
  return (
    <div
      style={{
        padding: '36px',
        background: colors.pageBg,
        borderRadius: radii.lg,
        color: colors.textMuted,
        fontSize: '13px',
        textAlign: 'center',
      }}
    >
      <strong style={{ color: colors.success }}>{message}</strong> {detail}
    </div>
  );
}

function EmailLogTable({
  rows,
  showErrors,
  onRetrySuccess,
}: {
  rows: EmailLogRow[];
  showErrors: boolean;
  onRetrySuccess?: () => void;
}) {
  if (rows.length === 0) {
    return <div style={{ color: colors.textMuted, fontSize: '13px' }}>No entries yet.</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Received</th>
            <th style={thStyle}>Sender</th>
            <th style={thStyle}>Subject</th>
            <th style={thStyle}>Attachments</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Retry</th>
            {showErrors && <th style={thStyle}>Details</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="sis-row">
              <td style={tdStyle}>{formatDateTime(r.received_at)}</td>
              <td style={tdStyle}>{r.sender ?? '—'}</td>
              <td style={tdStyle}>{truncate(r.subject ?? '—', 60)}</td>
              <td style={tdStyle}>
                {r.attachments_processed ?? 0}/{r.attachments_found ?? 0}
              </td>
              <td style={tdStyle}>
                <StatusPill status={r.status} />
              </td>
              <td style={tdStyle}>
                <RetryCell row={r} onSuccess={onRetrySuccess} />
              </td>
              {showErrors && (
                <td style={{ ...tdStyle, color: colors.textMuted, fontSize: '12px', maxWidth: '360px' }}>
                  {(r.error_messages ?? []).slice(0, 2).map((m, i) => (
                    <div key={i}>{truncate(m, 200)}</div>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * RetryCell — the "Attempt N/5" badge + "Retry Now" button + "Reprocess" button.
 *
 * What you see depends on the row state:
 *   • Never retried, clean status (completed/ignored)           → —
 *   • Has been retried before                                   → "Attempt N/5" badge
 *   • Status failed/partial AND retry_count < max_retries AND
 *     last outcome wasn't "permanent_failure"                    → "Retry Now" button
 *   • Status failed/partial AND retry_count >= max_retries      → "Exhausted" text
 *   • is_retryable=true AND next_retry_at in future             → "Auto-retry at {time}"
 *   • Status failed/partial (ANY reason, incl. terminal)         → "↻ Reprocess" button
 *
 * Behavior is unchanged from the prior version of this component; only the
 * button styling has been updated to match the rest of the new UI.
 */
function RetryCell({ row, onSuccess }: { row: EmailLogRow; onSuccess?: () => void }) {
  const [busy, setBusy] = useState(false);               // "Retry Now" spinner
  const [reprocessing, setReprocessing] = useState(false); // "Reprocess" spinner
  const [localErr, setLocalErr] = useState<string | null>(null);

  const retryCount = row.retry_count ?? 0;
  const maxRetries = row.max_retries ?? 5;
  const canRetry =
    (row.status === 'failed' || row.status === 'partial') &&
    retryCount < maxRetries &&
    row.last_retry_outcome !== 'permanent_failure';
  const canReprocess = row.status === 'failed' || row.status === 'partial';
  const exhausted = retryCount >= maxRetries;
  const scheduledIso = row.is_retryable ? row.next_retry_at : null;

  async function handleClick() {
    setBusy(true);
    setLocalErr(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? '';

      const resp = await fetch('/api/admin/retry-now', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ emailLogId: row.id }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${resp.status}`);
      }
      onSuccess?.();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function handleReprocess() {
    setReprocessing(true);
    setLocalErr(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? '';

      const resp = await fetch('/api/admin/reprocess-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ emailLogId: row.id }),
      });
      const json = await resp.json();
      if (!resp.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${resp.status}`);
      }
      onSuccess?.();
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
      setReprocessing(false);
    }
  }

  if (retryCount === 0 && !canRetry && !scheduledIso && !canReprocess) {
    return <span style={{ color: colors.textMuted, fontSize: '12px' }}>—</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {retryCount > 0 && (
        <RetryBadge
          count={retryCount}
          max={maxRetries}
          outcome={row.last_retry_outcome}
          exhausted={exhausted}
        />
      )}
      {canRetry && (
        <button
          onClick={handleClick}
          disabled={busy || reprocessing}
          className="sis-btn sis-btn-teal sis-btn-sm"
          style={{ width: 'fit-content' }}
          title="Retry this email now, bypassing the automatic backoff"
        >
          {busy ? 'Retrying…' : 'Retry Now'}
        </button>
      )}
      {canReprocess && (
        <button
          onClick={handleReprocess}
          disabled={busy || reprocessing}
          className="sis-btn sis-btn-secondary sis-btn-sm"
          style={{ width: 'fit-content' }}
          title="Re-fetch this attachment and run it through the dispatcher again. Useful after a code deploy adds new parser support."
        >
          {reprocessing ? 'Reprocessing…' : '↻ Reprocess'}
        </button>
      )}
      {!canRetry && scheduledIso && (
        <span style={{ fontSize: '11px', color: colors.textMuted }}>
          Auto-retry {formatRelativeFuture(scheduledIso)}
        </span>
      )}
      {exhausted && !canRetry && (
        <span style={{ fontSize: '11px', color: colors.danger }}>Retries exhausted</span>
      )}
      {localErr && (
        <span style={{ fontSize: '11px', color: colors.danger, maxWidth: 180 }}>
          {truncate(localErr, 80)}
        </span>
      )}
    </div>
  );
}

function RetryBadge({
  count,
  max,
  outcome,
  exhausted,
}: {
  count: number;
  max: number;
  outcome: string | null;
  exhausted: boolean;
}) {
  const { bg, fg } = badgePalette(outcome, exhausted);
  return (
    <span
      style={{
        backgroundColor: bg,
        color: fg,
        padding: '2px 8px',
        borderRadius: radii.pill,
        fontSize: '11px',
        fontWeight: 600,
        display: 'inline-block',
        width: 'fit-content',
      }}
      title={outcome ? `Last retry outcome: ${outcome}` : undefined}
    >
      Attempt {count}/{max}
    </span>
  );
}

function badgePalette(
  outcome: string | null,
  exhausted: boolean
): { bg: string; fg: string } {
  if (exhausted) return { bg: `${colors.danger}22`, fg: colors.danger };
  if (outcome === 'success') return { bg: `${colors.success}22`, fg: colors.success };
  if (outcome === 'permanent_failure') return { bg: `${colors.danger}22`, fg: colors.danger };
  if (outcome === 'transient_failure') return { bg: `${colors.warning}22`, fg: colors.warning };
  return { bg: `${colors.info}22`, fg: colors.info };
}

function FlaggedRowsTable({ rows }: { rows: FlaggedRow[] }) {
  if (rows.length === 0) {
    return <div style={{ color: colors.textMuted, fontSize: '13px' }}>No rejections.</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>When</th>
            <th style={thStyle}>Source File</th>
            <th style={thStyle}>Attempted Well</th>
            <th style={thStyle}>API10</th>
            <th style={thStyle}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="sis-row">
              <td style={tdStyle}>{formatDateTime(r.created_at)}</td>
              <td style={tdStyle}>{truncate(r.source_file_name, 48)}</td>
              <td style={tdStyle}>{r.attempted_well_name ?? '—'}</td>
              <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '12px' }}>
                {r.attempted_api10 ?? '—'}
              </td>
              <td style={{ ...tdStyle, color: colors.textMuted, fontSize: '12px', maxWidth: '320px' }}>
                {r.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; dot: string }> = {
    completed: { bg: `${colors.success}18`, fg: colors.success, dot: colors.success },
    partial:   { bg: `${colors.warning}18`, fg: colors.warning, dot: colors.warning },
    failed:    { bg: `${colors.danger}18`,  fg: colors.danger,  dot: colors.danger },
    skipped:   { bg: `${colors.darkGray}18`, fg: colors.darkGray, dot: colors.darkGray },
    ignored:   { bg: `${colors.darkGray}18`, fg: colors.darkGray, dot: colors.darkGray },
    processing:{ bg: `${colors.info}18`,    fg: '#1d6a89',       dot: '#1d6a89' },
    pending:   { bg: `${colors.info}18`,    fg: '#1d6a89',       dot: '#1d6a89' },
  };
  const { bg, fg, dot } = map[status] ?? { bg: colors.lightGray, fg: colors.darkGray, dot: colors.darkGray };
  return (
    <span
      style={{
        backgroundColor: bg,
        color: fg,
        padding: '3px 10px',
        borderRadius: radii.pill,
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'capitalize',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: dot,
          display: 'inline-block',
        }}
      />
      {status}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        backgroundColor: colors.dangerBg,
        color: colors.danger,
        border: `1px solid ${colors.danger}33`,
        borderRadius: radii.lg,
        padding: '12px 14px',
        fontSize: '13px',
      }}
    >
      <strong>Couldn't load dashboard:</strong> {message}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div style={{ color: colors.textMuted, fontSize: '13px', fontStyle: 'italic' }}>Loading…</div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Small formatting helpers (unchanged)
 * ────────────────────────────────────────────────────────────── */

function formatInt(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return d.toLocaleDateString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatRelativeFuture(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return 'momentarily';
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'momentarily';
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr${hrs === 1 ? '' : 's'}`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `in ${days} day${days === 1 ? '' : 's'}`;
  return 'on ' + d.toLocaleDateString();
}

/* ──────────────────────────────────────────────────────────────
 * Shared inline styles
 * ────────────────────────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  backgroundColor: colors.surface,
  border: `1px solid ${colors.borderCard}`,
  borderRadius: radii.xl,
  padding: '24px',
  boxShadow: shadows.card,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: '13px',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  color: colors.textMuted,
  fontWeight: 600,
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.6px',
  padding: '10px 12px',
  backgroundColor: colors.pageBg,
  borderBottom: `1px solid ${colors.borderCard}`,
};

const tdStyle: React.CSSProperties = {
  padding: '12px',
  borderBottom: `1px solid ${colors.borderSoft}`,
  color: colors.midnightNavy,
  verticalAlign: 'top',
};
