import { Pool, PoolClient, QueryResult } from 'pg';
import { postgresConnectionString } from '../config';
import logger from '../utils/logger';
import type { SyncConfig, SyncState, SyncHistory, Conflict } from '../types';

/**
 * PostgreSQL metadata database connection pool
 */
class MetadataDB {
    private pool: Pool;

    constructor() {
        this.pool = new Pool({
            connectionString: postgresConnectionString,
            max: 20,
            min: 5,
            idleTimeoutMillis: 600000, // 10 minutes
            connectionTimeoutMillis: 5000,
        });

        this.pool.on('error', (err) => {
            logger.error({ error: err }, 'PostgreSQL pool error');
        });

        this.pool.on('connect', () => {
            logger.debug('PostgreSQL client connected');
        });
    }

    /**
     * Execute a query
     */
    async query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
        const start = Date.now();
        try {
            const result = await this.pool.query<T>(text, params);
            const duration = Date.now() - start;
            logger.debug({ query: text, duration, rows: result.rowCount }, 'Executed query');
            return result;
        } catch (error) {
            logger.error({ error, query: text, params }, 'Query failed');
            throw error;
        }
    }

    /**
     * Get a client for transaction
     */
    async getClient(): Promise<PoolClient> {
        return await this.pool.connect();
    }

    /**
     * Execute a transaction
     */
    async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.getClient();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Health check
     */
    async healthCheck(): Promise<boolean> {
        try {
            await this.query('SELECT 1');
            return true;
        } catch (error) {
            logger.error({ error }, 'PostgreSQL health check failed');
            return false;
        }
    }

    /**
     * Close all connections
     */
    async close() {
        await this.pool.end();
        logger.info('PostgreSQL pool closed');
    }

    // === Sync Config Operations ===

    async createSyncConfig(config: Omit<SyncConfig, 'id'>): Promise<SyncConfig> {
        const result = await this.query<SyncConfig>(
            `INSERT INTO sync_configs (
        name, sheet_id, sheet_range, db_connection_string, db_table_name,
        column_mapping, conflict_strategy, sync_interval_seconds, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
            [
                config.name,
                config.sheet_id,
                config.sheet_range || null,
                config.db_connection_string,
                config.db_table_name,
                JSON.stringify(config.column_mapping),
                config.conflict_strategy,
                config.sync_interval_seconds,
                config.is_active,
            ]
        );
        return result.rows[0];
    }

    async getSyncConfig(id: string): Promise<SyncConfig | null> {
        const result = await this.query<SyncConfig>(
            'SELECT * FROM sync_configs WHERE id = $1',
            [id]
        );
        return result.rows[0] || null;
    }

    async getAllSyncConfigs(activeOnly: boolean = false): Promise<SyncConfig[]> {
        const query = activeOnly
            ? 'SELECT * FROM sync_configs WHERE is_active = true ORDER BY created_at DESC'
            : 'SELECT * FROM sync_configs ORDER BY created_at DESC';
        const result = await this.query<SyncConfig>(query);
        return result.rows;
    }

    async updateSyncConfig(id: string, updates: Partial<SyncConfig>): Promise<SyncConfig | null> {
        const fields: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        Object.entries(updates).forEach(([key, value]) => {
            if (value !== undefined && key !== 'id' && key !== 'created_at') {
                fields.push(`${key} = $${paramIndex}`);
                values.push(key === 'column_mapping' ? JSON.stringify(value) : value);
                paramIndex++;
            }
        });

        if (fields.length === 0) return null;

        values.push(id);
        const result = await this.query<SyncConfig>(
            `UPDATE sync_configs SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
            values
        );
        return result.rows[0] || null;
    }

    async deleteSyncConfig(id: string): Promise<boolean> {
        const result = await this.query('DELETE FROM sync_configs WHERE id = $1', [id]);
        return (result.rowCount ?? 0) > 0;
    }

    // === Sync State Operations ===

    async getSyncState(configId: string): Promise<SyncState | null> {
        const result = await this.query<SyncState>(
            'SELECT * FROM sync_state WHERE sync_config_id = $1',
            [configId]
        );
        return result.rows[0] || null;
    }

    async upsertSyncState(state: Partial<SyncState> & { sync_config_id: string }): Promise<SyncState> {
        const result = await this.query<SyncState>(
            `INSERT INTO sync_state (
        sync_config_id, last_sheet_sync_at, last_db_sync_at, 
        sheet_etag, sheet_revision_id, db_last_change_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (sync_config_id) DO UPDATE SET
        last_sheet_sync_at = COALESCE(EXCLUDED.last_sheet_sync_at, sync_state.last_sheet_sync_at),
        last_db_sync_at = COALESCE(EXCLUDED.last_db_sync_at, sync_state.last_db_sync_at),
        sheet_etag = COALESCE(EXCLUDED.sheet_etag, sync_state.sheet_etag),
        sheet_revision_id = COALESCE(EXCLUDED.sheet_revision_id, sync_state.sheet_revision_id),
        db_last_change_id = COALESCE(EXCLUDED.db_last_change_id, sync_state.db_last_change_id)
      RETURNING *`,
            [
                state.sync_config_id,
                state.last_sheet_sync_at || null,
                state.last_db_sync_at || null,
                state.sheet_etag || null,
                state.sheet_revision_id || null,
                state.db_last_change_id || null,
            ]
        );
        return result.rows[0];
    }

    // === Sync History Operations ===

    async createSyncHistory(history: Omit<SyncHistory, 'id'>): Promise<SyncHistory> {
        const result = await this.query<SyncHistory>(
            `INSERT INTO sync_history (
        sync_config_id, direction, rows_affected, conflicts_detected,
        started_at, completed_at, status, error_message, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
            [
                history.sync_config_id,
                history.direction,
                history.rows_affected,
                history.conflicts_detected,
                history.started_at,
                history.completed_at || null,
                history.status,
                history.error_message || null,
                history.metadata ? JSON.stringify(history.metadata) : null,
            ]
        );
        return result.rows[0];
    }

    async updateSyncHistory(id: string, updates: Partial<SyncHistory>): Promise<SyncHistory | null> {
        const fields: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        Object.entries(updates).forEach(([key, value]) => {
            if (value !== undefined && key !== 'id') {
                fields.push(`${key} = $${paramIndex}`);
                values.push(key === 'metadata' ? JSON.stringify(value) : value);
                paramIndex++;
            }
        });

        if (fields.length === 0) return null;

        values.push(id);
        const result = await this.query<SyncHistory>(
            `UPDATE sync_history SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
            values
        );
        return result.rows[0] || null;
    }

    async getSyncHistory(configId: string, limit: number = 100): Promise<SyncHistory[]> {
        const result = await this.query<SyncHistory>(
            'SELECT * FROM sync_history WHERE sync_config_id = $1 ORDER BY started_at DESC LIMIT $2',
            [configId, limit]
        );
        return result.rows;
    }

    // === Conflict Operations ===

    async createConflict(conflict: Omit<Conflict, 'id' | 'created_at'>): Promise<Conflict> {
        const result = await this.query<Conflict>(
            `INSERT INTO conflicts (
        sync_config_id, sync_history_id, row_identifier, sheet_value, db_value,
        sheet_timestamp, db_timestamp, resolution_strategy
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
            [
                conflict.sync_config_id,
                conflict.sync_history_id,
                conflict.row_identifier,
                conflict.sheet_value ? JSON.stringify(conflict.sheet_value) : null,
                conflict.db_value ? JSON.stringify(conflict.db_value) : null,
                conflict.sheet_timestamp || null,
                conflict.db_timestamp || null,
                conflict.resolution_strategy,
            ]
        );
        return result.rows[0];
    }

    async resolveConflict(id: string, resolvedValue: Record<string, unknown>): Promise<Conflict | null> {
        const result = await this.query<Conflict>(
            `UPDATE conflicts 
       SET resolved_at = NOW(), resolved_value = $1 
       WHERE id = $2 
       RETURNING *`,
            [JSON.stringify(resolvedValue), id]
        );
        return result.rows[0] || null;
    }

    async getUnresolvedConflicts(configId: string): Promise<Conflict[]> {
        const result = await this.query<Conflict>(
            'SELECT * FROM conflicts WHERE sync_config_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC',
            [configId]
        );
        return result.rows;
    }
}

// Global instance
export const metadataDB = new MetadataDB();
export default metadataDB;
