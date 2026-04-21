/**
 * ExportPanel — shared UI for both Monthly and Daily export pages.
 *
 * UI direction (2026-04-21): same "Enterprise Confident" card + button tokens
 * used across the app. Primary CTA is dark-navy (not blue) to match the
 * rest of the chrome; teal is reserved for brand accents like the help-
 * callout's left border and inline status chips.
 *
 * Props control the differences:
 *   - inputType: "month" (YYYY-MM) vs "date" (YYYY-MM-DD)
 *   - apiPath:   "/api/export/monthly" or "/api/export/daily"
 *   - helpText:  explanation shown under the header
 *
 * The download flow is unchanged:
 *   1. User picks start + end dates/months
 *   2. Optional operator filter (single-select for now)
 *   3. Click "Generate & Download"
 *   4. We hit the API with the user's session's JWT
 *   5. API streams back the XLSX; we trigger a browser download
 */

import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../utils/supabase';
import { colors, shadows, radii } from '../theme';

interface ExportPanelProps {
  pageTitle: string;
  pageSubtitle: string;
  inputType: 'month' | 'date';
  apiPath: '/api/export/monthly' | '/api/export/daily';
  /** Placeholder for the start field (e.g. "2026-01") */
  startPlaceholder: string;
  endPlaceholder: string;
  /** Info callout shown below the form */
  helpText: string;
}

interface Operator {
  id: string;
  name: string;
}

export default function ExportPanel({
  pageTitle,
  pageSubtitle,
  inputType,
  apiPath,
  startPlaceholder,
  endPlaceholder,
  helpText,
}: ExportPanelProps) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorId, setOperatorId] = useState<string>(''); // '' = all
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ rowCount: number; wellCount: number; filename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the operator list once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: e } = await supabase
        .from('operators')
        .select('id, name')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (e) {
        console.warn('[ExportPanel] Could not load operators:', e.message);
        return;
      }
      setOperators((data ?? []) as Operator[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!start || !end) {
      setError('Please fill in both start and end.');
      return;
    }

    setSubmitting(true);

    try {
      const params = new URLSearchParams({ start, end });
      if (operatorId) params.append('operator_id', operatorId);
      const url = `${apiPath}?${params.toString()}`;

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? '';

      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          const j = await res.json();
          throw new Error(j?.error || `Request failed (HTTP ${res.status})`);
        }
        const t = await res.text();
        throw new Error(t.slice(0, 300) || `Request failed (HTTP ${res.status})`);
      }

      const rowCount = parseInt(res.headers.get('X-Export-Row-Count') ?? '0', 10) || 0;
      const wellCount = parseInt(res.headers.get('X-Export-Well-Count') ?? '0', 10) || 0;
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filenameMatch = /filename="?([^";]+)"?/.exec(disposition);
      const filename = filenameMatch?.[1] ?? 'ComboCurve_Export.xlsx';

      const blob = await res.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(objectUrl);

      setResult({ rowCount, wellCount, filename });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sis-stagger" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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
          {pageTitle}
        </h2>
        <p style={{ margin: '6px 0 0 0', color: colors.textMuted, fontSize: '14px' }}>{pageSubtitle}</p>
      </div>

      <form
        onSubmit={onSubmit}
        className="sis-hover-lift"
        style={{
          backgroundColor: colors.surface,
          border: `1px solid ${colors.borderCard}`,
          borderRadius: radii.xl,
          padding: '26px',
          boxShadow: shadows.card,
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <label style={labelStyle}>
            <span style={labelTextStyle}>Start {inputType === 'month' ? 'month' : 'date'}</span>
            <input
              required
              type={inputType === 'month' ? 'month' : 'date'}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder={startPlaceholder}
              className="sis-input"
            />
          </label>
          <label style={labelStyle}>
            <span style={labelTextStyle}>End {inputType === 'month' ? 'month' : 'date'}</span>
            <input
              required
              type={inputType === 'month' ? 'month' : 'date'}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder={endPlaceholder}
              className="sis-input"
            />
          </label>
        </div>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Operator (optional)</span>
          <select
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value)}
            className="sis-input"
            style={{ backgroundColor: colors.surface }}
          >
            <option value="">All operators</option>
            {operators.map((op) => (
              <option key={op.id} value={op.id}>
                {op.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="sis-btn sis-btn-primary"
          style={{ alignSelf: 'flex-start' }}
        >
          {submitting ? 'Generating…' : 'Generate & Download'}
        </button>
      </form>

      {error && (
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
          <strong>Export failed:</strong> {error}
        </div>
      )}

      {result && (
        <div
          style={{
            backgroundColor: colors.successBg,
            color: colors.midnightNavy,
            border: `1px solid ${colors.success}55`,
            borderRadius: radii.lg,
            padding: '12px 14px',
            fontSize: '13px',
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: colors.success }}>Download started.</strong> {result.filename} —{' '}
          {result.rowCount.toLocaleString()} rows across {result.wellCount.toLocaleString()} wells.
        </div>
      )}

      <div
        style={{
          backgroundColor: colors.tealLight,
          borderLeft: `3px solid ${colors.electricTeal}`,
          padding: '14px 16px',
          fontSize: '13px',
          color: colors.midnightNavy,
          lineHeight: 1.6,
          borderRadius: `0 ${radii.md} ${radii.md} 0`,
        }}
      >
        {helpText}
      </div>
    </div>
  );
}

/* Shared label styles ---------------------------------------------------- */

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelTextStyle: React.CSSProperties = {
  fontSize: '13px',
  color: colors.midnightNavy,
  fontWeight: 600,
};
