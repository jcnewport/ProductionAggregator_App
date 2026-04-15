-- ============================================================
-- Migration 002: RLS Policies + Storage Bucket
-- Applied: 2026-04-15
-- ============================================================

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE format_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wells ENABLE ROW LEVEL SECURITY;
ALTER TABLE well_name_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

-- Read policies for authenticated users
CREATE POLICY "Authenticated users can read operators" ON operators FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read format_mappings" ON format_mappings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read wells" ON wells FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read well_name_aliases" ON well_name_aliases FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read email_log" ON email_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read production_monthly" ON production_monthly FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read production_daily" ON production_daily FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read exports" ON exports FOR SELECT TO authenticated USING (true);

-- Exports insert policy (only own records)
CREATE POLICY "Authenticated users can create own exports" ON exports FOR INSERT TO authenticated WITH CHECK (generated_by = auth.uid());

-- Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('production-files', 'production-files', false);

CREATE POLICY "Authenticated users can read production files" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'production-files');
CREATE POLICY "Authenticated users can upload production files" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'production-files');
