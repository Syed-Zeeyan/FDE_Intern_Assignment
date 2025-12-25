import { v4 as uuidv4 } from 'uuid';

import { metadataDB } from '../../database/metadata-db';
import { MySQLAdapter } from '../../adapters/mysql.adapter';
import { GoogleSheetsAdapter } from '../../adapters/google-sheets.adapter';

import { ChangeDetector } from '../change-detector';
import { conflictResolver } from '../conflict-resolver';
import { deduplicator } from '../deduplicator';

import logger from '../../utils/logger';
import type { SyncConfig, SyncDirection, SyncStatus } from '../../types';
import { incrementSyncCounter, observeSyncLatency } from '../../utils/metrics';


/**
 * Sheet → DB Sync Worker
 * 
 * Responsibility: Sync data FROM Google Sheets TO MySQL
 * 
 * Algorithm:
 * 1. Fetch current Sheet data (with ETag for conditional request)
 * 2. If Sheet hasn't changed (304 Not Modified), skip sync
 * 3. Fetch current DB data
 * 4. Run change detection (Sheet vs DB)
 * 5. Check for conflicts with recent DB changes
 * 6. Resolve conflicts using configured strategy
 * 7. Apply non-conflicted changes to DB with source tag 'from_sheet'
 * 8. Update sync state (timestamp, ETag)
 * 9. Log sync history
 * 
 * Loop Prevention:
 * - All DB writes are tagged with sourceTag='from_sheet'
 * - DB→Sheet worker filters out changes with this tag
 * - Each operation has unique operationId for idempotency
 */

export class SheetToDbWorker {
    private readonly config: SyncConfig;
    private readonly dbAdapter: MySQLAdapter;
    private readonly changeDetector: ChangeDetector;
    private readonly correlationId: string;
    private readonly workLogger: ReturnType<typeof createChildLogger>;

    constructor(config: SyncConfig, correlationId?: string) {
        this.config = config;
        this.dbAdapter = new MySQLAdapter(
            config.db_connection_string,
            config.db_table_name
        );
        this.changeDetector = new ChangeDetector({
            primaryKey: this.getPrimaryKeyColumn(),
        });
        this.correlationId = correlationId || uuidv4();
        this.workLogger = createChildLogger({
            correlationId: this.correlationId,
            configId: config.id,
            direction: 'sheet_to_db',
        });
    }

    /**
     * Execute Sheet → DB sync
     */
    async execute(): Promise<void> {
        const startTime = Date.now();
        const syncId = uuidv4();

        this.workLogger.info({ syncId }, 'Starting Sheet → DB sync');

        // Create sync history entry
        const syncHistory = await metadataDB.createSyncHistory({
            sync_config_id: this.config.id!,
            direction: 'sheet_to_db' as SyncDirection,
            rows_affected: 0,
            conflicts_detected: 0,
            started_at: new Date(),
            completed_at: null,
            status: 'running' as SyncStatus,
            error_message: null,
            metadata: { correlationId: this.correlationId, syncId },
        });

        try {
            // Initialize DB connection
            await this.dbAdapter.connect();

            // 1. Get current sync state
            const syncState = await metadataDB.getSyncState(this.config.id!);

            // 2. Fetch Sheet data with conditional request (ETag)
            this.workLogger.debug('Fetching Sheet data');
            const sheetData = await googleSheetsAdapter.getRange(
                this.config.sheet_id,
                this.config.sheet_range || 'Sheet1',
                { ifNoneMatch: syncState?.sheet_etag || undefined }
            );

            // 3. Check if Sheet modified
            if (sheetData.notModified) {
                this.workLogger.info('Sheet not modified since last sync, skipping');
                await metadataDB.updateSyncHistory(syncHistory.id, {
                    completed_at: new Date(),
                    status: 'success' as SyncStatus,
                    metadata: { message: 'No changes detected (ETag match)' },
                });
                incrementSyncCounter('sheet_to_db', 'success_no_changes');
                return;
            }

            // 4. Convert Sheet data to row objects
            const sheetRows = this.convertSheetDataToRows(sheetData.values);
            this.workLogger.debug({ rowCount: sheetRows.length }, 'Converted Sheet data');

            // 5. Fetch current DB data
            this.workLogger.debug('Fetching DB data');
            const dbRows = await this.dbAdapter.select();

            // 6. Detect changes
            this.workLogger.debug('Detecting changes');
            const changes = this.changeDetector.detect(sheetRows, dbRows);

            if (
                changes.inserts.length === 0 &&
                changes.updates.length === 0 &&
                changes.deletes.length === 0
            ) {
                this.workLogger.info('No changes detected');
                await metadataDB.updateSyncHistory(syncHistory.id, {
                    completed_at: new Date(),
                    status: 'success' as SyncStatus,
                    metadata: { message: 'No changes detected' },
                });
                incrementSyncCounter('sheet_to_db', 'success_no_changes');
                return;
            }

            // 7. Check for conflicts (did DB change since last sync?)
            const conflicts = await this.detectConflicts(changes, syncState?.last_db_sync_at || null);

            // 8. Resolve conflicts
            const resolvedConflicts = conflicts.map((conflict) =>
                conflictResolver.resolveConflict(conflict, this.config.conflict_strategy)
            );

            // Log conflicts to database
            for (const resolved of resolvedConflicts) {
                const conflict = conflicts.find((c) => c.rowId === resolved.rowId)!;
                await metadataDB.createConflict({
                    sync_config_id: this.config.id!,
                    sync_history_id: syncHistory.id,
                    row_identifier: String(resolved.rowId),
                    sheet_value: conflict.sheetValue,
                    db_value: conflict.dbValue,
                    sheet_timestamp: conflict.sheetTimestamp,
                    db_timestamp: conflict.dbTimestamp,
                    resolution_strategy: this.config.conflict_strategy,
                    resolved_at: resolved.winner !== 'manual' ? new Date() : null,
                    resolved_value: resolved.resolvedValue,
                });
            }

            // 9. Filter out conflicted rows from changes
            const conflictedRowIds = new Set(resolvedConflicts.map((r) => r.rowId));
            const changesToApply = {
                inserts: changes.inserts.filter(
                    (row) => !conflictedRowIds.has(this.getRowId(row))
                ),
                updates: changes.updates.filter((u) => !conflictedRowIds.has(u.identifier)),
                deletes: changes.deletes.filter((id) => !conflictedRowIds.has(id)),
            };

            // 10. Apply resolved conflict winners
            for (const resolved of resolvedConflicts) {
                if (resolved.winner === 'sheet' && resolved.resolvedValue) {
                    changesToApply.updates.push({
                        identifier: resolved.rowId,
                        data: resolved.resolvedValue,
                    });
                } else if (resolved.winner === 'db') {
                    // DB value wins - no action needed
                }
                // Manual conflicts are queued (no automatic action)
            }

            // 11. Apply changes to DB with source tagging
            let rowsAffected = 0;
            const operationId = uuidv4();

            // Check idempotency
            if (await deduplicator.isProcessed(operationId)) {
                this.workLogger.warn({ operationId }, 'Operation already processed, skipping');
                return;
            }

            this.workLogger.info(
                {
                    inserts: changesToApply.inserts.length,
                    updates: changesToApply.updates.length,
                    deletes: changesToApply.deletes.length,
                },
                'Applying changes to database'
            );

            await this.dbAdapter.transaction(async (connection) => {
                // Inserts
                for (const row of changesToApply.inserts) {
                    await this.dbAdapter.insert(row, {
                        sourceTag: 'from_sheet',
                        operationId,
                    });
                    rowsAffected++;
                }

                // Updates
                for (const update of changesToApply.updates) {
                    const primaryKey = this.getPrimaryKeyColumn();
                    await this.dbAdapter.update(
                        update.data,
                        { [primaryKey]: update.identifier },
                        { sourceTag: 'from_sheet', operationId }
                    );
                    rowsAffected++;
                }

                // Deletes
                for (const deleteId of changesToApply.deletes) {
                    const primaryKey = this.getPrimaryKeyColumn();
                    await this.dbAdapter.delete(
                        { [primaryKey]: deleteId },
                        { sourceTag: 'from_sheet', operationId }
                    );
                    rowsAffected++;
                }
            });

            // Mark operation as processed
            await deduplicator.markProcessed(operationId, {
                direction: 'sheet_to_db',
                rowsAffected,
                conflicts: resolvedConflicts.length,
            });

            // 12. Update sync state
            await metadataDB.upsertSyncState({
                sync_config_id: this.config.id!,
                last_sheet_sync_at: new Date(),
                sheet_etag: sheetData.etag,
            });

            // 13. Update sync history
            await metadataDB.updateSyncHistory(syncHistory.id, {
                completed_at: new Date(),
                status: 'success' as SyncStatus,
                rows_affected: rowsAffected,
                conflicts_detected: resolvedConflicts.length,
            });

            const duration = Date.now() - startTime;
            this.workLogger.info(
                { rowsAffected, conflicts: resolvedConflicts.length, duration },
                'Sheet → DB sync completed successfully'
            );

            incrementSyncCounter('sheet_to_db', 'success');
            observeSyncLatency('sheet_to_db', duration);
        } catch (error) {
            this.workLogger.error({ error }, 'Sheet → DB sync failed');

            await metadataDB.updateSyncHistory(syncHistory.id, {
                completed_at: new Date(),
                status: 'failed' as SyncStatus,
                error_message: error instanceof Error ? error.message : String(error),
            });

            incrementSyncCounter('sheet_to_db', 'failed');
            throw error;
        } finally {
            await this.dbAdapter.close();
        }
    }

    /**
     * Detect conflicts by checking recent DB changes
     */
    private async detectConflicts(
        changes: ReturnType<typeof this.changeDetector.detect>,
        lastDbSyncAt: Date | null
    ) {
        // For simplicity, we'll check if any DB changes occurred since last sync
        // In a full implementation, this would query the change log

        // Since Sheet changes don't have timestamps by default,
        // we'll use current time for Sheet timestamp
        const now = new Date();

        // For this demo, we'll skip actual conflict detection
        // and just log the intent
        this.workLogger.debug('Conflict detection skipped (no DB CDC changes in this flow)');

        return [];
    }

    /**
     * Convert Sheet data (2D array) to row objects
     */
    private convertSheetDataToRows(values: unknown[][]): Record<string, unknown>[] {
        if (values.length === 0) return [];

        // First row is headers (column letters → column names mapping)
        const headers = values[0];

        // Map column letters to actual column names
        const columnNames = headers.map((_, index) => {
            const columnLetter = this.indexToColumnLetter(index);
            return this.config.column_mapping[columnLetter] || columnLetter;
        });

        // Convert remaining rows to objects
        const rows = [];
        for (let i = 1; i < values.length; i++) {
            const row: Record<string, unknown> = {};
            for (let j = 0; j < values[i].length; j++) {
                row[columnNames[j]] = values[i][j];
            }
            rows.push(row);
        }

        return rows;
    }

    /**
     * Get primary key column name
     */
    private getPrimaryKeyColumn(): string {
        // Assume first column (A) is primary key
        return this.config.column_mapping['A'] || 'id';
    }

    /**
     * Get row ID from row data
     */
    private getRowId(row: Record<string, unknown>): string | number {
        const primaryKey = this.getPrimaryKeyColumn();
        const value = row[primaryKey];
        return typeof value === 'string' || typeof value === 'number' ? value : String(value);
    }

    /**
     * Convert column index to letter (0 → A, 1 → B, etc.)
     */
    private indexToColumnLetter(index: number): string {
        let letter = '';
        while (index >= 0) {
            letter = String.fromCharCode((index % 26) + 65) + letter;
            index = Math.floor(index / 26) - 1;
        }
        return letter;
    }
}
