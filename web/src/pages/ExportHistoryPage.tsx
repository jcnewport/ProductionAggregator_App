/**
 * ExportHistoryPage — Task #77
 *
 * Shows a paginated list of every ComboCurve export that's been generated,
 * newest first. Each row has a "Download" button that 302-redirects to a
 * short-lived Supabase Storage signed URL and triggers a browser download.
 *
 * Backend endpoints used:
 *   GET  /api/exports                  — list
 *   GET  /api/exports/:id/download     — 302 to signed URL
 *
 * Why a dedicated page and not part of the export-generation panel?
 *   The generation panel is action-focused (pick range → download). History
 *   is a different mental mode — "what have I already pulled?" — and benefits
 *   from its own screen with filters and pagination.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../utils/supabase';
import { colors, shadows } from '../theme';

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
    // 302 redirect from the API — browser will follow to the signed URL
    // and start the download. Opening in a new tab keeps the history page
    // in place and avoids any weirdness if the signed URL 404s.
    window.open(`/api/exports/${id}/download`, '_blank', 'noopener');
  };

  const pageFrom = rows.length === 0 ? 0 : offset + 1;
  const pageTo = offset + rows.length;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h2
          style={{
            margin: 0,
            color: colors.midnightNavy,
            fontSize: '22px',
            fontWeight: 700,
          }}
        >
          Export History
        </h2>
        <p style={{ margin: '4px 0 0 0', color: colors.darkGray, fontSize: '14px' }}>
          Every ComboCurve export that's been generated — re-download any prior file.
        </p>
      </div>

      <div
        style={{
          backgroundColor: colors.white,
          borderRadius: '8px',
          padding: '18px',
          boxShadow: shadows.card,
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
          <span style={{ color: colors.midnightNavy, fontWeight: 500 }}>Type:</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as '' | ExportType)}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: `1px solid ${colors.mediumGray}`,
              fontSize: '13px',
              backgroundColor: colors.white,
            }}
          >
            <option value="">All</option>
            <option value="monthly">Monthly</option>
            <option value="daily">Daily</option>
          </select>
        </label>

        <button
          onClick={() => setReloadTick((t) => t + 1)}
          disabled={loading}
          style={{
            padding: '6px 14px',
            borderRadius: '6px',
            backgroundColor: colors.electricTeal,
            color: colors.white,
            border: 'none',
            fontSize: '13px',
            fontWeight: 600,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        <span style={{ marginLeft: 'auto', color: colors.darkGray, fontSize: '13px' }}>
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
            borderRadius: '6px',
            padding: '12px 14px',
            fontSize: '13px',
          }}
        >
          <strong>Couldn't load history:</strong> {error}
        </div>
      )}

      <div
        style={{
          backgroundColor: colors.white,
          borderRadius: '8px',
          boxShadow: shadows.card,
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ backgroundColor: colors.lightGray }}>
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
                    padding: '24px',
                    textAlign: 'center',
                    color: colors.darkGray,
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
          style={pagerButtonStyle(hasPrev && !loading)}
        >
          ← Previous
        </button>
        <button
          disabled={!hasNext || loading}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          style={pagerButtonStyle(hasNext && !loading)}
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
    row.export_type === 'monthly' ? colors.primary : colors.midnightNavy;

  return (
    <tr style={{ borderTop: `1px solid ${colors.mediumGray}55` }}>
      <td style={tdStyle}>{generated}</td>
      <td style={tdStyle}>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 10px',
            borderRadius: '10px',
            backgroundColor: typeBadgeBg,
            color: typeBadgeColor,
            fontWeight: 600,
            fontSize: '12px',
            textTransform: 'uppercase',
          }}
        >
          {row.export_type}
        </span>
      </td>
      <td style={tdStyle}>{dateRange}</td>
      <td style={tdStyle}>{row.row_count?.toLocaleString() ?? '—'}</td>
      <td style={tdStyle}>{size}</td>
      <td style={tdStyle}>{filterLabel}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        <button
          onClick={() => onDownload(row.id)}
          disabled={!row.file_path}
          style={{
            padding: '5px 12px',
            borderRadius: '4px',
            backgroundColor: row.file_path ? colors.primary : colors.mediumGray,
            color: colors.white,
            border: 'none',
            fontSize: '12px',
            fontWeight: 600,
            cursor: row.file_path ? 'pointer' : 'not-allowed',
          }}
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
  padding: '10px 14px',
  textAlign: 'left',
  fontWeight: 600,
  color: colors.midnightNavy,
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  color: colors.midnightNavy,
  verticalAlign: 'middle',
};

function pagerButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: '6px',
    border: `1px solid ${colors.mediumGray}`,
    backgroundColor: colors.white,
    color: active ? colors.midnightNavy : colors.darkGray,
    fontSize: '13px',
    cursor: active ? 'pointer' : 'not-allowed',
    opacity: active ? 1 : 0.5,
  };
}
