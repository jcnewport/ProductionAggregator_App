-- ============================================================
-- ProductionAggregator_App — Core Database Schema
-- Migration 001: create_core_tables
-- Applied: 2026-04-15
--
-- Creates all tables for Phase 1:
--   operators, wells, well_name_aliases,
--   production_monthly, production_daily,
--   format_mappings, email_log, exports
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. OPERATORS
CREATE TABLE operators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  sender_email_patterns TEXT[] DEFAULT '{}',
  contact_info JSONB DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. FORMAT MAPPINGS
CREATE TABLE format_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID REFERENCES operators(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'xlsx', 'xls', 'csv')),
  data_type TEXT NOT NULL CHECK (data_type IN ('monthly', 'daily', 'weekly')),
  mapping_config JSONB NOT NULL DEFAULT '{}',
  identification_rules JSONB DEFAULT '{}',
  version INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. WELLS
CREATE TABLE wells (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  well_name TEXT NOT NULL,
  api14 TEXT,
  api10 TEXT,
  combocurve_well_id INTEGER,
  operator_id UUID REFERENCES operators(id),
  location_metadata JSONB DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_api10 UNIQUE (api10)
);

CREATE INDEX idx_wells_api14 ON wells(api14);
CREATE INDEX idx_wells_api10 ON wells(api10);
CREATE INDEX idx_wells_name ON wells(well_name);

-- 4. WELL NAME ALIASES
CREATE TABLE well_name_aliases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alias TEXT NOT NULL,
  well_id UUID NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_alias UNIQUE (alias)
);

CREATE INDEX idx_aliases_alias ON well_name_aliases(alias);

-- 5. EMAIL LOG
CREATE TABLE email_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gmail_message_id TEXT UNIQUE,
  sender TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ,
  attachments_found INTEGER DEFAULT 0,
  attachments_processed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'partial', 'failed', 'skipped')),
  error_messages TEXT[],
  operator_id UUID REFERENCES operators(id),
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_email_log_status ON email_log(status);
CREATE INDEX idx_email_log_received ON email_log(received_at DESC);

-- 6. PRODUCTION MONTHLY
CREATE TABLE production_monthly (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  well_id UUID REFERENCES wells(id),
  well_name TEXT,
  api14 TEXT,
  api10 TEXT,
  combocurve_well_id INTEGER,
  prod_date DATE NOT NULL,
  gas_prod DECIMAL,
  gas_sales DECIMAL,
  oil_prod DECIMAL,
  oil_sales DECIMAL,
  water_prod DECIMAL,
  choke TEXT,
  tubing_pres DECIMAL,
  casing_pres DECIMAL,
  hours_down DECIMAL,
  water_inj DECIMAL,
  downtime_reason TEXT,
  days_on DECIMAL,
  operator_id UUID REFERENCES operators(id),
  source_email_id UUID REFERENCES email_log(id),
  source_file_name TEXT,
  extra_fields JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_monthly_well_date UNIQUE (well_id, prod_date)
);

CREATE INDEX idx_monthly_prod_date ON production_monthly(prod_date);
CREATE INDEX idx_monthly_well ON production_monthly(well_id);
CREATE INDEX idx_monthly_operator ON production_monthly(operator_id);

-- 7. PRODUCTION DAILY (NEVER rolled up into monthly)
CREATE TABLE production_daily (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  well_id UUID REFERENCES wells(id),
  well_name TEXT,
  api14 TEXT,
  api10 TEXT,
  combocurve_well_id INTEGER,
  prod_date DATE NOT NULL,
  gas_prod DECIMAL,
  gas_sales DECIMAL,
  oil_prod DECIMAL,
  oil_sales DECIMAL,
  water_prod DECIMAL,
  choke TEXT,
  tubing_pres DECIMAL,
  casing_pres DECIMAL,
  hours_down DECIMAL,
  water_inj DECIMAL,
  downtime_reason TEXT,
  days_on DECIMAL,
  operator_id UUID REFERENCES operators(id),
  source_email_id UUID REFERENCES email_log(id),
  source_file_name TEXT,
  extra_fields JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_daily_well_date UNIQUE (well_id, prod_date)
);

CREATE INDEX idx_daily_prod_date ON production_daily(prod_date);
CREATE INDEX idx_daily_well ON production_daily(well_id);
CREATE INDEX idx_daily_operator ON production_daily(operator_id);

-- 8. EXPORTS
CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  export_type TEXT NOT NULL CHECK (export_type IN ('monthly', 'daily')),
  date_range_start DATE,
  date_range_end DATE,
  operator_filter UUID[],
  well_filter UUID[],
  row_count INTEGER,
  file_path TEXT,
  file_size_bytes BIGINT,
  generated_by UUID,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update timestamps trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_operators_updated
  BEFORE UPDATE ON operators FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trigger_format_mappings_updated
  BEFORE UPDATE ON format_mappings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trigger_wells_updated
  BEFORE UPDATE ON wells FOR EACH ROW EXECUTE FUNCTION update_updated_at();
