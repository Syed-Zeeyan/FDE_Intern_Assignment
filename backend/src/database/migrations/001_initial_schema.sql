-- PostgreSQL metadata database schema

-- Sync configurations table
CREATE TABLE IF NOT EXISTS sync_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    sheet_id VARCHAR(255) NOT NULL,
    sheet_range VARCHAR(100),
    db_connection_string TEXT NOT NULL, -- Encrypted in production
    db_table_name VARCHAR(255) NOT NULL,
    column_mapping JSONB NOT NULL, -- {"A": "id", "B": "name", ...}
    conflict_strategy VARCHAR(50) DEFAULT 'last_write_wins',
    sync_interval_seconds INT DEFAULT 30 CHECK (sync_interval_seconds >= 5 AND sync_interval_seconds <= 3600),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sync state table (one per config)
CREATE TABLE IF NOT EXISTS sync_state (
    sync_config_id UUID PRIMARY KEY REFERENCES sync_configs(id) ON DELETE CASCADE,
    last_sheet_sync_at TIMESTAMP,
    last_db_sync_at TIMESTAMP,
    sheet_etag VARCHAR(255),
    sheet_revision_id VARCHAR(255),
    db_last_change_id BIGINT
);

-- Sync history table (audit log)
CREATE TABLE IF NOT EXISTS sync_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_config_id UUID REFERENCES sync_configs(id) ON DELETE CASCADE,
    direction VARCHAR(20) NOT NULL CHECK (direction IN ('sheet_to_db', 'db_to_sheet')),
    rows_affected INT DEFAULT 0,
    conflicts_detected INT DEFAULT 0,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'failed', 'partial')),
    error_message TEXT,
    metadata JSONB
);

-- Conflicts table
CREATE TABLE IF NOT EXISTS conflicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_config_id UUID REFERENCES sync_configs(id) ON DELETE CASCADE,
    sync_history_id UUID REFERENCES sync_history(id) ON DELETE CASCADE,
    row_identifier VARCHAR(255) NOT NULL,
    sheet_value JSONB,
    db_value JSONB,
    sheet_timestamp TIMESTAMP,
    db_timestamp TIMESTAMP,
    resolution_strategy VARCHAR(50),
    resolved_at TIMESTAMP,
    resolved_value JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sync_configs_active ON sync_configs(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_sync_history_config ON sync_history(sync_config_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflicts_config ON conflicts(sync_config_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved ON conflicts(sync_config_id) WHERE resolved_at IS NULL;

-- Updated_at trigger for sync_configs
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_sync_configs_updated_at BEFORE UPDATE ON sync_configs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE sync_configs IS 'Stores bidirectional sync configurations between Google Sheets and MySQL';
COMMENT ON TABLE sync_state IS 'Tracks sync state metadata (ETags, timestamps, change IDs) per configuration';
COMMENT ON TABLE sync_history IS 'Audit log of all sync operations with performance metrics';
COMMENT ON TABLE conflicts IS 'Records detected conflicts and their resolutions';
