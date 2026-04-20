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
}

interface Stats {
  monthlyRows: number | null;
  dailyRows: number | null;
  lastReceivedAt: string | null;
}

export default function DashboardPage() {
  const [recent, setRecent] = useState<EmailLogRow[]>([]);
  const [flagged, setFlagged] = useState<EmailLogRow[]>([]);
  const [stats, setStats] = useState<Stats>({ monthlyRows: null, dailyRows: null, lastReceivedAt: null });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErr(null);
      try {
        // Run all four queries in parallel for a faster first paint
        const [recentRes, flaggedRes, monthlyCountRes, dailyCountRes] = await Promise.all([
          supabase
            .from('email_log')
            .select('id, sender, subject, received_at, attachments_found, attachments_processed, status, error_messages')
            .order('received_at', { ascending: false })
            .limit(20),
          supabase
            .from('email_log')
            .select('id, sender, subject, received_at, attachments_found, attachments_processed, status, error_messages')
            .in('status', ['failed', 'partial'])
            .order('received_at', { ascending: false })
            .limit(10),
          supabase.from('production_monthly').select('*', { count: 'exact', head: true }),
          supabase.from('production_daily').select('*', { count: 'exact', head: true }),
        ]);

        if (cancelled) return;

        if (recentRes.error) throw new Error(`recent: ${recentRes.error.message}`);
        if (flaggedRes.error) throw new Error(`flagged: ${flaggedRes.error.message}`);
        if (monthlyCountRes.error) throw new Error(`monthly count: ${monthlyCountRes.error.message}`);
        if (dailyCountRes.error) throw new Error(`daily count: ${dailyCountRes.error.message}`);

        setRecent((recentRes.data ?? []) as EmailLogRow[]);
        setFlagged((flaggedRes.data ?? []) as EmailLogRow[]);
        setStats({
          monthlyRows: monthlyCountRes.count ?? 0,
          dailyRows: dailyCountRes.count ?? 0,
          lastReceivedAt: recentRes.data?.[0]?.received_at ?? null,
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
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <PageHeader
        title="Dashboard"
        subtitle="Live view of inbox processing, flagged imports, and stored production totals."
      />

      {err && <ErrorBanner message={err} />}

      {/* Top stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        <StatCard label="Monthly rows in storage" value={formatInt(stats.monthlyRows)} loading={loading} />
        <StatCard label="Daily rows in storage" value={formatInt(stats.dailyRows)} loading={loading} />
        <StatCard label="Last email received" value={formatRelative(stats.lastReceivedAt)} loading={loading} />
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
          <EmailLogTable rows={flagged} showErrors={true} />
        )}
      </Card>

      {/* Recent activity */}
      <Card title="Recent email processing activity" subtitle="Most recent 20 messages delivered to the production inbox.">
        {loading ? <SkeletonRow /> : <EmailLogTable rows={recent} showErrors={false} />}
      </Card>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
 * Sub-components
 * ────────────────────────────────────────────────────────────── */

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  // Dashboard page title is rendered in Slipstream Accent 1 (purple) per brand direction.
  // The subtitle stays gray so the eye catches the title first.
  return (
    <div>
      <h2 style={{ margin: 0, color: colors.brandPurple, fontSize: '22px', fontWeight: 700 }}>{title}</h2>
      <p style={{ margin: '4px 0 0 0', color: colors.darkGray, fontSize: '14px' }}>{subtitle}</p>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  // Cards on the dashboard use the Slipstream light-green background and
  // Slipstream Accent-5 orange for their primary text (titles + subtitles).
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: children ? '16px' : 0 }}>
        <h3 style={{ margin: 0, color: colors.brandOrange, fontSize: '16px', fontWeight: 600 }}>{title}</h3>
        {subtitle && (
          <p style={{ margin: '2px 0 0 0', color: colors.brandOrange, fontSize: '13px', opacity: 0.9 }}>{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  // Stat cards: light-green card (from cardStyle) with orange label and value.
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: '12px', color: colors.brandOrange, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '26px',
          fontWeight: 700,
          color: colors.brandOrange,
          marginTop: '6px',
          minHeight: '30px',
        }}
      >
        {loading ? '…' : value}
      </div>
    </div>
  );
}

function EmailLogTable({ rows, showErrors }: { rows: EmailLogRow[]; showErrors: boolean }) {
  if (rows.length === 0) {
    return <div style={{ color: colors.brandOrange, fontSize: '13px' }}>No entries yet.</div>;
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
              {showErrors && (
                <td style={{ ...tdStyle, color: colors.brandOrange, fontSize: '12px', maxWidth: '360px' }}>
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

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    completed: { bg: `${colors.success}22`, fg: colors.success },
    partial: { bg: `${colors.warning}22`, fg: colors.warning },
    failed: { bg: `${colors.danger}22`, fg: colors.danger },
    skipped: { bg: `${colors.darkGray}22`, fg: colors.darkGray },
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
    <div style={{ color: colors.brandOrange, fontSize: '13px', fontStyle: 'italic' }}>Loading…</div>
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

/* ──────────────────────────────────────────────────────────────
 * Shared inline styles
 * ────────────────────────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  // Dashboard cards use the Slipstream light-green tint (~60% of Accent 3)
  // with orange text per brand direction.
  backgroundColor: colors.brandGreenLight,
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
  color: colors.brandOrange,
  fontWeight: 700,
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  padding: '8px 10px',
  // Slightly deeper green separator so the header row still has structure
  // on the light-green card background.
  borderBottom: `1px solid ${colors.brandGreen}`,
};

const tdStyle: React.CSSProperties = {
  padding: '10px',
  borderBottom: `1px solid ${colors.brandGreen}33`, // 20% alpha — soft rule between rows
  color: colors.brandOrange,
  verticalAlign: 'top',
};
