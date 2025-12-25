-- =====================================================
-- Google Sheets ↔ MySQL Sync Platform
-- PostgreSQL Database Setup Script
-- =====================================================

-- Step 1: Create the database
-- Run this first as postgres superuser or a user with CREATEDB privilege
-- Example: psql -U postgres
CREATE DATABASE sheets_sync_metadata;

-- Step 2: Connect to the newly created database
-- \c sheets_sync_metadata

-- Step 3: Run the schema migration
-- (This is the content from 001_initial_schema.sql)

-- =====================================================
-- Sync Configurations Table
-- =====================================================
CREATE TABLE IF NOT EXISTS sync_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    sheet_id VARCHAR(255) NOT NULL,
    sheet_range VARCHAR(100),
    db_connection_string TEXT NOT NULL,
    db_table_name VARCHAR(255) NOT NULL,
    column_mapping JSONB NOT NULL,
    conflict_strategy VARCHAR(50) NOT NULL DEFAULT 'last_write_wins',
    sync_interval_seconds INTEGER NOT NULL DEFAULT 30,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for active configs lookup
CREATE INDEX IF NOT EXISTS idx_sync_configs_active ON sync_configs(is_active) WHERE is_active = true;

-- =====================================================
-- Sync State Table
-- =====================================================
CREATE TABLE IF NOT EXISTS sync_state (
    config_id UUID PRIMARY KEY REFERENCES sync_configs(id) ON DELETE CASCADE,
    last_sheet_etag VARCHAR(255),
    last_sheet_sync_at TIMESTAMP WITH TIME ZONE,
    last_db_sync_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    last_error_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- Sync History Table
-- =====================================================
CREATE TABLE IF NOT EXISTS sync_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_id UUID NOT NULL REFERENCES sync_configs(id) ON DELETE CASCADE,
    sync_id UUID NOT NULL,
    direction VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    rows_affected INTEGER,
    conflicts_detected INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    metadata JSONB
);

-- Indexes for history queries
CREATE INDEX IF NOT EXISTS idx_sync_history_config ON sync_history(config_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_history_status ON sync_history(status);

-- =====================================================
-- Conflicts Table
-- =====================================================
CREATE TABLE IF NOT EXISTS conflicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_id UUID NOT NULL REFERENCES sync_configs(id) ON DELETE CASCADE,
    sync_id UUID NOT NULL,
    row_identifier VARCHAR(255) NOT NULL,
    conflicting_columns TEXT[] NOT NULL,
    sheet_value JSONB NOT NULL,
    db_value JSONB NOT NULL,
    resolved_value JSONB,
    resolution_strategy VARCHAR(50),
    resolution_winner VARCHAR(50),
    is_resolved BOOLEAN NOT NULL DEFAULT false,
    detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for conflict queries
CREATE INDEX IF NOT EXISTS idx_conflicts_config ON conflicts(config_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved ON conflicts(is_resolved) WHERE is_resolved = false;

-- =====================================================
-- Functions for automatic timestamp updates
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for automatic timestamp updates
CREATE TRIGGER update_sync_configs_updated_at
    BEFORE UPDATE ON sync_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sync_state_updated_at
    BEFORE UPDATE ON sync_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- Verification Query
-- =====================================================
-- Run this to verify all tables were created successfully
SELECT 
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Expected output:
-- conflicts (12 columns)
-- sync_configs (12 columns)
-- sync_history (11 columns)
-- sync_state (7 columns)
