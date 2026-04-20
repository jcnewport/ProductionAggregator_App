/**
 * ExportPanel — shared UI for both Monthly and Daily export pages.
 *
 * Props control the differences:
 *   - inputType: "month" (YYYY-MM) vs "date" (YYYY-MM-DD)
 *   - apiPath:   "/api/export/monthly" or "/api/export/daily"
 *   - helpText:  explanation shown under the header
 *
 * The download flow:
 *   1. User picks start + end dates/months
 *   2. Optional operator filter (single-select for now)
 *   3. Click "Generate & Download"
 *   4. We hit the API with the user's session's JWT (via fetch + Supabase access token)
 *   5. API streams back the XLSX; we trigger a browser download
 *
 * Why fetch + manual download (instead of a simple <a href>):
 *   - The API expects an Authorization header (future-ready for auth-gated exports)
 *   - We can show loading state, row/well count from response headers, and
 *     surface error JSON gracefully
 */

import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../utils/supabase';
import { colors, shadows } from '../theme';

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
      // Build the URL with query params
      const params = new URLSearchParams({ start, end });
      if (operatorId) params.append('operator_id', operatorId);
      const url = `${apiPath}?${params.toString()}`;

      // Get the current session for the Authorization header. If the API later
      // enforces JWT, this Just Works. Today it's permissive but harmless.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? '';

      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!res.ok) {
        // The API returns JSON error bodies. Try to parse, fall back to text.
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          const j = await res.json();
          throw new Error(j?.error || `Request failed (HTTP ${res.status})`);
        }
        const t = await res.text();
        throw new Error(t.slice(0, 300) || `Request failed (HTTP ${res.status})`);
      }

      // Pull counts from response headers (set by api/src/routes/exports.ts)
      const rowCount = parseInt(res.headers.get('X-Export-Row-Count') ?? '0', 10) || 0;
      const wellCount = parseInt(res.headers.get('X-Export-Well-Count') ?? '0', 10) || 0;
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filenameMatch = /filename="?([^";]+)"?/.exec(disposition);
      const filename = filenameMatch?.[1] ?? 'ComboCurve_Export.xlsx';

      // Trigger the browser download
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h2 style={{ margin: 0, color: colors.midnightNavy, fontSize: '22px', fontWeight: 700 }}>{pageTitle}</h2>
        <p style={{ margin: '4px 0 0 0', color: colors.darkGray, fontSize: '14px' }}>{pageSubtitle}</p>
      </div>

      <form
        onSubmit={onSubmit}
        style={{
          backgroundColor: colors.white,
          borderRadius: '8px',
          padding: '22px',
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
              style={inputStyle}
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
              style={inputStyle}
            />
          </label>
        </div>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Operator (optional)</span>
          <select
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value)}
            style={{ ...inputStyle, backgroundColor: colors.white }}
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
          style={{
            alignSelf: 'flex-start',
            // CTA color = primary blue (matches the Sign-in button on Login).
            // Teal is reserved for brand accents like the help-callout border
            // and the logo mark — not for action buttons.
            backgroundColor: submitting ? colors.darkGray : colors.primary,
            color: colors.white,
            border: 'none',
            padding: '11px 22px',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: submitting ? 'wait' : 'pointer',
          }}
        >
          {submitting ? 'Generating…' : 'Generate & Download'}
        </button>
      </form>

      {error && (
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
          <strong>Export failed:</strong> {error}
        </div>
      )}

      {result && (
        <div
          style={{
            backgroundColor: `${colors.success}18`,
            color: colors.midnightNavy,
            border: `1px solid ${colors.success}55`,
            borderRadius: '6px',
            padding: '12px 14px',
            fontSize: '13px',
            lineHeight: 1.5,
          }}
        >
          <strong>Download started.</strong> {result.filename} —{' '}
          {result.rowCount.toLocaleString()} rows across {result.wellCount.toLocaleString()} wells.
        </div>
      )}

      <div
        style={{
          backgroundColor: colors.lightGray,
          borderLeft: `3px solid ${colors.electricTeal}`,
          padding: '14px 16px',
          fontSize: '13px',
          color: colors.midnightNavy,
          lineHeight: 1.55,
        }}
      >
        {helpText}
      </div>
    </div>
  );
}

/* Shared input styles ---------------------------------------------------- */

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelTextStyle: React.CSSProperties = {
  fontSize: '13px',
  color: colors.midnightNavy,
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: '6px',
  border: `1px solid ${colors.mediumGray}`,
  fontSize: '14px',
  fontFamily: 'inherit',
  outline: 'none',
};
