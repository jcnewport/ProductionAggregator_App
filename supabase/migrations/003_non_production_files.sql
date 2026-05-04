-- ============================================================
-- Migration 003: Non-Production Files
-- Applied: 2026-05-04
--
-- Purpose:
--   Some attachments arriving at S.IS_AD_Prod@stewardship.is are NOT
--   production data — drilling reports, well-tracking spreadsheets,
--   ComboCurve templates, etc. The non-production filter chain in
--   api/src/parsers/nonProductionFilters.ts already classifies them
--   as 'ignored' (vs 'failed') so they don't pollute the flagged-
--   review queue.
--
--   This migration adds an audit + retrieval layer:
--     1. A new `non_production_files` table that records each ignored
--        attachment (one row per attachment, FK to email_log).
--     2. A new private `non-production-files` storage bucket so the
--        physical files live separately from production-data files.
--        Production-data lifecycle policies (retention, audit) won't
--        get muddled with operational drilling reports.
--     3. RLS policies mirroring the production-data tables.
--
--   The email poller (after this migration ships) MOVES files from
--   `production-files` → `non-production-files` when the dispatcher
--   classifies the attachment as ignored. The DB row keeps the
--   storage_path so the dashboard can hand out signed URLs for view.
--
--   Inline-image attachments (email-signature graphics) are deliberately
--   NOT recorded here — they're throwaway noise. Only "real" non-
--   production files (drilling reports, tracking sheets, templates,
--   catalogs, test exports) get logged. The poller decides this by
--   checking the filter name.
-- ============================================================

CREATE TABLE non_production_files (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scoping (mirrors production_monthly / production_daily).
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Source email — can be NULL for backfill rows where we couldn't
  -- match (shouldn't happen in steady state but defensive).
  email_log_id       uuid REFERENCES email_log(id) ON DELETE SET NULL,
  -- File identity.
  filename           text NOT NULL,
  mime_type          text,
  file_bytes         bigint,
  -- Classification — what the filter said about it.
  category           text NOT NULL,        -- e.g. "drilling report (Peloton WellView)"
  filter_name        text NOT NULL,        -- e.g. "peloton-wellview-daily-drilling"
  reason             text,                 -- the human-readable note from detect()
  -- Email context — denormalized so the dashboard can render without
  -- an extra join (and survives email_log row deletion).
  sender             text,
  subject            text,
  email_received_at  timestamptz,
  -- Storage pointer.
  storage_bucket     text NOT NULL DEFAULT 'non-production-files',
  storage_path       text NOT NULL,        -- e.g. "2026/05/<gmail_msg_id>_<filename>"
  -- Bookkeeping.
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- One row per (email_log, filename) — re-running the email poller
  -- on the same message must not duplicate.
  CONSTRAINT non_production_files_email_filename_unique UNIQUE (email_log_id, filename)
);

CREATE INDEX non_production_files_tenant_received_idx
  ON non_production_files (tenant_id, email_received_at DESC NULLS LAST);

CREATE INDEX non_production_files_email_log_idx
  ON non_production_files (email_log_id);

CREATE INDEX non_production_files_filter_idx
  ON non_production_files (filter_name);

-- RLS — same shape as production tables: super-admins (no JWT claim) get
-- full access via service_role, normal authenticated users see only
-- rows for their tenant.
ALTER TABLE non_production_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users read own tenant non_production_files"
  ON non_production_files
  FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_tenants
      WHERE user_id = auth.uid()
        AND COALESCE(is_super_admin, false) = true
    )
  );

CREATE POLICY "Service role manages non_production_files"
  ON non_production_files
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Storage bucket — private (signed URLs only).
INSERT INTO storage.buckets (id, name, public)
VALUES ('non-production-files', 'non-production-files', false)
ON CONFLICT (id) DO NOTHING;

-- Authenticated users can read non-production files (UI uses signed URLs
-- via the API; this policy is for direct authenticated reads).
CREATE POLICY "Authenticated users can read non-production files"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'non-production-files');

-- Service role (the email poller) can write.
CREATE POLICY "Service role manages non-production-files objects"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'non-production-files')
  WITH CHECK (bucket_id = 'non-production-files');

COMMENT ON TABLE non_production_files IS
  'Audit log of email attachments classified as non-production by the filter chain (drilling reports, tracking sheets, templates). Files live in storage bucket non-production-files. See api/src/services/nonProductionFilesStore.ts.';
