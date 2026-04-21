/**
 * DashboardPage — home screen after login.
 *
 * Two sections:
 *   1. Summary stats (total monthly rows, total daily rows, last-email-received time)
 *   2. Recent email processing activity (last 20 rows from email_log)
 *   3. Flagged imports needing attention (status in ('failed', 'partial') within the last 30 days)
 *
 * Everything is read directly from Supabase via the authenticated session —
 * no custom API endpoint needed. If/when multi-tenancy is added, RLS filters
 * will constrain results without any frontend change.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../utils/supabase';
import { colors, shadows } from '../theme';

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

  // Nonce bumped when we need to re-fetch (e.g. after a Retry Now click).
  const [reloadTick, setReloadTick] = useState(0);

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

  const handleRefresh = () => setReloadTick((n) => n + 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <PageHeader
        title="Dashboard"
        subtitle="Live view of inbox processing, flagged imports, and stored production totals."
      />

      {err && <ErrorBanner message={err} />}

      {/* Top stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        <StatCard label="Monthly rows in storage" value={formatInt(stats.monthlyRows)} loading={loading} />
        <StatCard label="Daily rows in storage" value={formatInt(stats.dailyRows)} loading={loading} />
        <StatCard label="Last email received" value={formatRelative(stats.lastReceivedAt)} loading={loading} />
        <StatCard label="Rows flagged for review" value={formatInt(stats.flaggedRowCount)} loading={loading} />
      </div>

      {/* Flagged */}
      <Card
        title="Flagged imports needing attention"
        subtitle={
          flagged.length === 0
            ? 'All recent imports processed cleanly. Nothing to review.'
            : `${flagged.length} recent import${flagged.length === 1 ? '' : 's'} finished with errors.`
        }
      >
        {loading ? (
          <SkeletonRow />
        ) : flagged.length === 0 ? null : (
          <EmailLogTable rows={flagged} showErrors={true} onRetrySuccess={handleRefresh} />
        )}
      </Card>

      {/* Row-level rejections — individual rows within otherwise-successful files */}
      <Card
        title="Row-level rejections"
        subtitle={
          flaggedRows.length === 0
            ? 'No individual rows have been rejected by the storage-layer validator. Inbox is clean at the row level.'
            : `${flaggedRows.length} most recent row${flaggedRows.length === 1 ? '' : 's'} rejected by API10 validation or other storage-time checks.`
        }
      >
        {loading ? <SkeletonRow /> : flaggedRows.length === 0 ? null : <FlaggedRowsTable rows={flaggedRows} />}
      </Card>

      {/* Recent activity */}
      <Card title="Recent email processing activity" subtitle="Most recent 20 messages delivered to the production inbox.">
        {loading ? (
          <SkeletonRow />
        ) : (
          <EmailLogTable rows={recent} showErrors={false} onRetrySuccess={handleRefresh} />
        )}
      </Card>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Sub-components
 * ────────────────────────────────────────────────────────────── */

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 style={{ margin: 0, color: colors.midnightNavy, fontSize: '22px', fontWeight: 700 }}>{title}</h2>
      <p style={{ margin: '4px 0 0 0', color: colors.darkGray, fontSize: '14px' }}>{subtitle}</p>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: children ? '16px' : 0 }}>
        <h3 style={{ margin: 0, color: colors.midnightNavy, fontSize: '16px', fontWeight: 600 }}>{title}</h3>
        {subtitle && (
          <p style={{ margin: '2px 0 0 0', color: colors.darkGray, fontSize: '13px' }}>{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: '12px', color: colors.darkGray, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '26px',
          fontWeight: 700,
          color: colors.midnightNavy,
          marginTop: '6px',
          minHeight: '30px',
        }}
      >
        {loading ? '…' : value}
      </div>
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
    return <div style={{ color: colors.darkGray, fontSize: '13px' }}>No entries yet.</div>;
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
            <tr key={r.id}>
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
                <td style={{ ...tdStyle, color: colors.darkGray, fontSize: '12px', maxWidth: '360px' }}>
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
 * RetryCell — the "Attempt N/5" badge + "Retry Now" button.
 *
 * What you see depends on the row state:
 *   • Never retried, clean status (completed/ignored)           → —
 *   • Has been retried before                                   → "Attempt N/5" badge
 *   • Status failed/partial AND retry_count < max_retries       → Retry Now button
 *   • Status failed/partial AND retry_count >= max_retries      → "Exhausted" text
 *   • is_retryable=true AND next_retry_at in future             → "Auto-retry at {time}"
 *
 * The button POSTs to /api/admin/retry-now with the row id,
 * then calls onSuccess so the parent re-fetches the row state.
 */
function RetryCell({ row, onSuccess }: { row: EmailLogRow; onSuccess?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const retryCount = row.retry_count ?? 0;
  const maxRetries = row.max_retries ?? 5;
  const canRetry =
    (row.status === 'failed' || row.status === 'partial') &&
    retryCount < maxRetries &&
    row.last_retry_outcome !== 'permanent_failure';
  const exhausted = retryCount >= maxRetries;
  const scheduledIso = row.is_retryable ? row.next_retry_at : null;

  async function handleClick() {
    setBusy(true);
    setLocalErr(null);
    try {
      // Attach the Supabase session token so /api/admin's requireAuth
      // middleware (Task #78) accepts the request.
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
    // If success: parent will re-fetch and this component will unmount/remount
    // with fresh state, so no need to setBusy(false).
  }

  // Nothing interesting to show — keep the cell tidy.
  if (retryCount === 0 && !canRetry && !scheduledIso) {
    return <span style={{ color: colors.darkGray, fontSize: '12px' }}>—</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
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
          disabled={busy}
          style={retryButtonStyle(busy)}
          title="Retry this email now, bypassing the automatic backoff"
        >
          {busy ? 'Retrying…' : 'Retry Now'}
        </button>
      )}
      {!canRetry && scheduledIso && (
        <span style={{ fontSize: '11px', color: colors.darkGray }}>
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
        padding: '2px 7px',
        borderRadius: '9px',
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

function retryButtonStyle(busy: boolean): React.CSSProperties {
  return {
    backgroundColor: busy ? colors.mediumGray : colors.electricTeal,
    color: busy ? colors.darkGray : colors.white,
    border: 'none',
    borderRadius: '4px',
    padding: '4px 10px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    width: 'fit-content',
    letterSpacing: '0.3px',
  };
}

function FlaggedRowsTable({ rows }: { rows: FlaggedRow[] }) {
  if (rows.length === 0) {
    return <div style={{ color: colors.darkGray, fontSize: '13px' }}>No rejections.</div>;
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
            <tr key={r.id}>
              <td style={tdStyle}>{formatDateTime(r.created_at)}</td>
              <td style={tdStyle}>{truncate(r.source_file_name, 48)}</td>
              <td style={tdStyle}>{r.attempted_well_name ?? '—'}</td>
              <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '12px' }}>
                {r.attempted_api10 ?? '—'}
              </td>
              <td style={{ ...tdStyle, color: colors.darkGray, fontSize: '12px', maxWidth: '320px' }}>
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
  const map: Record<string, { bg: string; fg: string }> = {
    completed: { bg: `${colors.success}22`, fg: colors.success },
    partial: { bg: `${colors.warning}22`, fg: colors.warning },
    failed: { bg: `${colors.danger}22`, fg: colors.danger },
    skipped: { bg: `${colors.darkGray}22`, fg: colors.darkGray },
    // "Ignored" = known-non-production file (tracking sheet, template, etc.)
    // classified BEFORE reaching any parser. Quiet success, not an error.
    ignored: { bg: `${colors.darkGray}22`, fg: colors.darkGray },
    processing: { bg: `${colors.info}22`, fg: colors.info },
    pending: { bg: `${colors.info}22`, fg: colors.info },
  };
  const { bg, fg } = map[status] ?? { bg: colors.lightGray, fg: colors.darkGray };
  return (
    <span
      style={{
        backgroundColor: bg,
        color: fg,
        padding: '3px 8px',
        borderRadius: '10px',
        fontSize: '12px',
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      {status}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        backgroundColor: '#FEF2F2',
        color: colors.danger,
        border: `1px solid ${colors.danger}33`,
        borderRadius: '6px',
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
    <div style={{ color: colors.darkGray, fontSize: '13px', fontStyle: 'italic' }}>Loading…</div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Small formatting helpers
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

/**
 * Relative-time formatter oriented toward the future ("in 12 min", "in 2 hr").
 * Used for the "Auto-retry at …" hint on rows that are queued for a
 * future retry attempt. Falls back to an absolute date if > 14 days out.
 */
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
  backgroundColor: colors.white,
  borderRadius: '8px',
  padding: '20px',
  boxShadow: shadows.card,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '13px',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  color: colors.darkGray,
  fontWeight: 600,
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  padding: '8px 10px',
  borderBottom: `1px solid ${colors.mediumGray}`,
};

const tdStyle: React.CSSProperties = {
  padding: '10px',
  borderBottom: `1px solid ${colors.lightGray}`,
  color: colors.midnightNavy,
  verticalAlign: 'top',
};
