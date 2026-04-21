/**
 * ExportHistoryPage — Task #77
 *
 * Shows a paginated list of every ComboCurve export that's been generated,
 * newest first. Each row has a "Download" button that 302-redirects to a
 * short-lived Supabase Storage signed URL and triggers a browser download.
 *
 * UI direction (2026-04-21): "Enterprise Confident" treatment applied — the
 * filter bar and table are single bordered cards, the type-badge pills use
 * the shared palette, and the pager buttons use the .sis-btn-secondary
 * class so hover/disabled states come straight from index.css.
 *
 * Backend endpoints used:
 *   GET  /api/exports                  — list
 *   GET  /api/exports/:id/download     — 302 to signed URL
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../utils/supabase';
import { colors, shadows, radii } from '../theme';

type ExportType = 'monthly' | 'daily';

interface ExportRow {
  id: string;
  export_type: ExportType;
  date_range_start: string | null;
  date_range_end: string | null;
  operator_filter: string[] | null;
  well_filter: string[] | null;
  row_count: number | null;
  file_path: string | null;
  file_size_bytes: number | null;
  generated_by: string | null;
  generated_at: string | null;
}

interface ListResponse {
  ok: boolean;
  rows: ExportRow[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

const PAGE_SIZE = 25;

export default function ExportHistoryPage() {
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<'' | ExportType>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (typeFilter) params.set('type', typeFilter);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? '';

      const res = await fetch(`/api/exports?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const json: ListResponse = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setRows(json.rows);
      setTotal(json.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [offset, typeFilter, reloadTick]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  // Resetting to page 0 when filters change
  useEffect(() => {
    setOffset(0);
  }, [typeFilter]);

  const handleDownload = (id: string) => {
    window.open(`/api/exports/${id}/download`, '_blank', 'noopener');
  };

  const pageFrom = rows.length === 0 ? 0 : offset + 1;
  const pageTo = offset + rows.length;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

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
          Export History
        </h2>
        <p style={{ margin: '6px 0 0 0', color: colors.textMuted, fontSize: '14px' }}>
          Every ComboCurve export that's been generated — re-download any prior file.
        </p>
      </div>

      <div
        style={{
          backgroundColor: colors.surface,
          border: `1px solid ${colors.borderCard}`,
          borderRadius: radii.xl,
          padding: '16px 20px',
          boxShadow: shadows.card,
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
          <span style={{ color: colors.midnightNavy, fontWeight: 600 }}>Type:</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as '' | ExportType)}
            className="sis-input"
            style={{ padding: '7px 10px', fontSize: '13px', width: 'auto' }}
          >
            <option value="">All</option>
            <option value="monthly">Monthly</option>
            <option value="daily">Daily</option>
          </select>
        </label>

        <button
          onClick={() => setReloadTick((t) => t + 1)}
          disabled={loading}
          className="sis-btn sis-btn-secondary sis-btn-sm"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        <span style={{ marginLeft: 'auto', color: colors.textMuted, fontSize: '13px' }}>
          {total === 0
            ? 'No exports yet'
            : `Showing ${pageFrom}–${pageTo} of ${total.toLocaleString()}`}
        </span>
      </div>

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
          <strong>Couldn't load history:</strong> {error}
        </div>
      )}

      <div
        className="sis-hover-lift"
        style={{
          backgroundColor: colors.surface,
          border: `1px solid ${colors.borderCard}`,
          borderRadius: radii.xl,
          boxShadow: shadows.card,
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '13px' }}>
          <thead>
            <tr>
              <th style={thStyle}>Generated</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Date range</th>
              <th style={thStyle}>Rows</th>
              <th style={thStyle}>Size</th>
              <th style={thStyle}>Filters</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '28px',
                    textAlign: 'center',
                    color: colors.textMuted,
                  }}
                >
                  No exports match this filter. Generate one from the Monthly or Daily Export page.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <ExportHistoryRow key={r.id} row={r} onDownload={handleDownload} />
            ))}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
          alignItems: 'center',
        }}
      >
        <button
          disabled={!hasPrev || loading}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          className="sis-btn sis-btn-secondary sis-btn-sm"
        >
          ← Previous
        </button>
        <button
          disabled={!hasNext || loading}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          className="sis-btn sis-btn-secondary sis-btn-sm"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function ExportHistoryRow({
  row,
  onDownload,
}: {
  row: ExportRow;
  onDownload: (id: string) => void;
}) {
  const generated = useMemo(() => {
    if (!row.generated_at) return '—';
    const d = new Date(row.generated_at);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, [row.generated_at]);

  const dateRange = row.date_range_start && row.date_range_end
    ? `${row.date_range_start} → ${row.date_range_end}`
    : '—';

  const size = row.file_size_bytes ? formatBytes(row.file_size_bytes) : '—';

  const filters: string[] = [];
  if (row.operator_filter && row.operator_filter.length > 0) {
    filters.push(`${row.operator_filter.length} operator${row.operator_filter.length > 1 ? 's' : ''}`);
  }
  if (row.well_filter && row.well_filter.length > 0) {
    filters.push(`${row.well_filter.length} well${row.well_filter.length > 1 ? 's' : ''}`);
  }
  const filterLabel = filters.length === 0 ? 'None' : filters.join(', ');

  const typeBadgeBg =
    row.export_type === 'monthly' ? colors.primaryLight : colors.tealLight;
  const typeBadgeColor =
    row.export_type === 'monthly' ? colors.primary : '#0e6b52';

  return (
    <tr className="sis-row">
      <td style={tdStyle}>{generated}</td>
      <td style={tdStyle}>
        <span
          style={{
            display: 'inline-block',
            padding: '3px 10px',
            borderRadius: radii.pill,
            backgroundColor: typeBadgeBg,
            color: typeBadgeColor,
            fontWeight: 700,
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          {row.export_type}
        </span>
      </td>
      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{dateRange}</td>
      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>{row.row_count?.toLocaleString() ?? '—'}</td>
      <td style={tdStyle}>{size}</td>
      <td style={tdStyle}>{filterLabel}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        <button
          onClick={() => onDownload(row.id)}
          disabled={!row.file_path}
          className="sis-btn sis-btn-primary sis-btn-sm"
        >
          Download
        </button>
      </td>
    </tr>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const thStyle: React.CSSProperties = {
  padding: '11px 14px',
  textAlign: 'left',
  fontWeight: 600,
  color: colors.textMuted,
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.6px',
  backgroundColor: colors.pageBg,
  borderBottom: `1px solid ${colors.borderCard}`,
};

const tdStyle: React.CSSProperties = {
  padding: '12px 14px',
  color: colors.midnightNavy,
  borderBottom: `1px solid ${colors.borderSoft}`,
  verticalAlign: 'middle',
};
