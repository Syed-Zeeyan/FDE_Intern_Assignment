import mysql from 'mysql2/promise';
import logger from '../utils/logger';
import type { MySQLChangeLogEntry } from '../types';

/**
 * MySQL adapter for target database
 * Handles connection pooling, CDC, and data operations
 */
export class MySQLAdapter {
    private pool: mysql.Pool | null = null;
    private readonly connectionString: string;
    private readonly tableName: string;

    constructor(connectionString: string, tableName?: string) {
        this.connectionString = connectionString;
        this.tableName = tableName || '';
    }

    /**
     * Initialize connection pool
     */
    async connect() {
        if (this.pool) return;

        this.pool = mysql.createPool({
            uri: this.connectionString,
            waitForConnections: true,
            connectionLimit: 10,
            maxIdle: 2,
            idleTimeout: 600000, // 10 minutes
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
        });

        logger.info({ tableName: this.tableName }, 'MySQL connection pool created');
    }

    /**
     * Ensure pool is connected
     */
    private ensureConnected() {
        if (!this.pool) {
            throw new Error('MySQL pool not initialized. Call connect() first.');
        }
    }

    /**
     * Execute a query
     */
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
        this.ensureConnected();
        const [rows] = await this.pool!.execute(sql, params);
        return rows as T[];
    }

    /**
     * Execute a transaction
     */
    async transaction<T>(callback: (connection: mysql.PoolConnection) => Promise<T>): Promise<T> {
        this.ensureConnected();
        const connection = await this.pool!.getConnection();
        await connection.beginTransaction();

        try {
            const result = await callback(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
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
            logger.error({ error }, 'MySQL health check failed');
            return false;
        }
    }

    /**
     * Close connection pool
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            logger.info({ tableName: this.tableName }, 'MySQL connection pool closed');
        }
    }

    // === Data Operations ===

    /**
     * Select rows from table
     */
    async select(where?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
        let sql = `SELECT * FROM ${this.escapeId(this.tableName)}`;
        const params: unknown[] = [];

        if (where && Object.keys(where).length > 0) {
            const conditions = Object.keys(where).map((key, index) => {
                params.push(where[key]);
                return `${this.escapeId(key)} = ?`;
            });
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        return await this.query(sql, params);
    }

    /**
     * Insert a row
     */
    async insert(
        tableName: string,
        data: Record<string, unknown>,
        metadata?: { sourceTag?: string; operationId?: string }
    ): Promise<void> {
        const connection = await this.pool!.getConnection();
        try {
            // Set source tag for CDC
            if (metadata?.sourceTag) {
                await connection.query('SET @sync_source_tag = ?', [metadata.sourceTag]);
            }

            const keys = Object.keys(data);
            const placeholders = keys.map(() => '?').join(', ');
            const escapedKeys = keys.map(k => this.escapeId(k)).join(', ');
            const updateClause = keys
                .map(key => `${this.escapeId(key)} = VALUES(${this.escapeId(key)})`)
                .join(', ');

            const sql = `
  INSERT INTO ${this.escapeId(tableName)} (${escapedKeys})
  VALUES (${placeholders})
  ON DUPLICATE KEY UPDATE ${updateClause}
`;


            await connection.execute(sql, Object.values(data));
            logger.debug({ tableName, data, metadata }, 'Inserted row');
        } finally {
            await connection.query('SET @sync_source_tag = NULL');
            connection.release();
        }
    }

    /**
     * Update rows
     */
    async update(
        data: Record<string, unknown>,
        where: Record<string, unknown>,
        metadata?: { sourceTag?: string; operationId?: string }
    ): Promise<void> {
        const connection = await this.pool!.getConnection();
        try {
            if (metadata?.sourceTag) {
                await connection.query('SET @sync_source_tag = ?', [metadata.sourceTag]);
            }

            const setClause = Object.keys(data).map((key) => `${this.escapeId(key)} = ?`).join(', ');
            const whereClause = Object.keys(where).map((key) => `${this.escapeId(key)} = ?`).join(' AND ');
            const sql = `UPDATE ${this.escapeId(this.tableName)} SET ${setClause} WHERE ${whereClause}`;

            await connection.execute(sql, [...Object.values(data), ...Object.values(where)]);
            logger.debug({ tableName: this.tableName, data, where, metadata }, 'Updated row');
        } finally {
            await connection.query('SET @sync_source_tag = NULL');
            connection.release();
        }
    }

    /**
     * Delete rows
     */
    async delete(
        where: Record<string, unknown>,
        metadata?: { sourceTag?: string; operationId?: string }
    ): Promise<void> {
        const connection = await this.pool!.getConnection();
        try {
            if (metadata?.sourceTag) {
                await connection.query('SET @sync_source_tag = ?', [metadata.sourceTag]);
            }

            const whereClause = Object.keys(where).map((key) => `${this.escapeId(key)} = ?`).join(' AND ');
            const sql = `DELETE FROM ${this.escapeId(this.tableName)} WHERE ${whereClause}`;

            await connection.execute(sql, Object.values(where));
            logger.debug({ tableName: this.tableName, where, metadata }, 'Deleted row');
        } finally {
            await connection.query('SET @sync_source_tag = NULL');
            connection.release();
        }
    }

    // === CDC Operations ===

    /**
     * Get unprocessed changes from change log
     */
    async getChangeLog(options: {
        processed?: boolean;
        excludeSourceTag?: string;
        limit?: number;
    } = {}): Promise<MySQLChangeLogEntry[]> {
        let sql = `SELECT * FROM __sync_change_log WHERE table_name = ?`;
        const params: unknown[] = [this.tableName];

        if (options.processed !== undefined) {
            sql += ' AND processed = ?';
            params.push(options.processed);
        }

        if (options.excludeSourceTag) {
            sql += ' AND (source_tag IS NULL OR source_tag != ?)';
            params.push(options.excludeSourceTag);
        }

        sql += ' ORDER BY changed_at ASC';

        if (options.limit) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        const rows = await this.query<MySQLChangeLogEntry>(sql, params);
        return rows;
    }

    /**
     * Mark change log entries as processed
     */
    async markChangesProcessed(ids: bigint[]): Promise<void> {
        if (ids.length === 0) return;

        const placeholders = ids.map(() => '?').join(', ');
        const sql = `UPDATE __sync_change_log SET processed = TRUE WHERE id IN (${placeholders})`;

        await this.query(sql, ids);
        logger.debug({ count: ids.length }, 'Marked changes as processed');
    }

    /**
     * Create sync triggers for this table
     */
    async createTriggers(primaryKeyColumn: string, columns: string[]): Promise<void> {
        const connection = await this.pool!.getConnection();
        try {
            // Drop existing triggers
            await this.dropTriggers(connection);

            // Build column mapping for JSON_OBJECT
            const columnPairs = columns.map((col) => `'${col}', NEW.${this.escapeId(col)}`).join(', ');

            // INSERT trigger
            const insertTrigger = `
        CREATE TRIGGER ${this.escapeId(this.tableName)}_sync_insert
        AFTER INSERT ON ${this.escapeId(this.tableName)}
        FOR EACH ROW
        BEGIN
          DECLARE source_tag_var VARCHAR(50);
          SET source_tag_var = COALESCE(@sync_source_tag, 'external');
          INSERT INTO __sync_change_log (table_name, operation, row_data, source_tag)
          VALUES ('${this.tableName}', 'INSERT', JSON_OBJECT(${columnPairs}), source_tag_var);
        END
      `;

            // UPDATE trigger
            const updateTrigger = `
        CREATE TRIGGER ${this.escapeId(this.tableName)}_sync_update
        AFTER UPDATE ON ${this.escapeId(this.tableName)}
        FOR EACH ROW
        BEGIN
          DECLARE source_tag_var VARCHAR(50);
          SET source_tag_var = COALESCE(@sync_source_tag, 'external');
          INSERT INTO __sync_change_log (table_name, operation, row_data, source_tag)
          VALUES ('${this.tableName}', 'UPDATE', JSON_OBJECT(${columnPairs}), source_tag_var);
        END
      `;

            // DELETE trigger
            const deleteTrigger = `
        CREATE TRIGGER ${this.escapeId(this.tableName)}_sync_delete
        AFTER DELETE ON ${this.escapeId(this.tableName)}
        FOR EACH ROW
        BEGIN
          DECLARE source_tag_var VARCHAR(50);
          SET source_tag_var = COALESCE(@sync_source_tag, 'external');
          INSERT INTO __sync_change_log (table_name, operation, row_data, source_tag)
          VALUES ('${this.tableName}', 'DELETE', JSON_OBJECT('${primaryKeyColumn}', OLD.${this.escapeId(primaryKeyColumn)}), source_tag_var);
        END
      `;

            await connection.query(insertTrigger);
            await connection.query(updateTrigger);
            await connection.query(deleteTrigger);

            logger.info({ tableName: this.tableName }, 'Created sync triggers');
        } finally {
            connection.release();
        }
    }

    /**
     * Drop sync triggers
     */
    async dropTriggers(connection?: mysql.PoolConnection): Promise<void> {
        const conn = connection || await this.pool!.getConnection();
        try {
            await conn.query(`DROP TRIGGER IF EXISTS ${this.escapeId(this.tableName)}_sync_insert`);
            await conn.query(`DROP TRIGGER IF EXISTS ${this.escapeId(this.tableName)}_sync_update`);
            await conn.query(`DROP TRIGGER IF EXISTS ${this.escapeId(this.tableName)}_sync_delete`);
            logger.info({ tableName: this.tableName }, 'Dropped sync triggers');
        } finally {
            if (!connection) conn.release();
        }
    }

    /**
     * Escape identifier (table/column name)
     */
    private escapeId(identifier: string): string {
        return `\`${identifier.replace(/`/g, '``')}\``;
    }
}
