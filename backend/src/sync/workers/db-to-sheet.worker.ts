import { v4 as uuidv4 } from 'uuid';

import { metadataDB } from '../../database/metadata-db';
import { MySQLAdapter } from '../../adapters/mysql.adapter';
import { GoogleSheetsAdapter } from '../../adapters/google-sheets.adapter';

import { ChangeDetector } from '../change-detector';
import { conflictResolver } from '../conflict-resolver';
import { deduplicator } from '../deduplicator';

import logger from '../../utils/logger';
import type {
    SyncConfig,
    SyncDirection,
    SyncStatus,
    MySQLChangeLogEntry,
} from '../../types';

import {
    incrementSyncCounter,
    observeSyncLatency,
} from '../../utils/metrics';


/**
 * DB → Sheet Sync Worker
 * 
 * Responsibility: Sync data FROM MySQL TO Google Sheets
 * 
 * Algorithm:
 * 1. Poll MySQL __sync_change_log for unprocessed changes
 * 2. Filter out changes with sourceTag='from_sheet' (infinite loop prevention)
 * 3. Fetch current Sheet data
 * 4. Apply DB changes to Sheet using batch updates
 * 5. Mark change log entries as processed
 * 6. Update sync state
 * 7. Log sync history
 * 
 * Loop Prevention (CRITICAL):
 * - Only process changes where source_tag != 'from_sheet'
 * - This prevents syncing changes that originated from Sheet
 * - Each operation has unique operationId for idempotency
 * 
 * Change Types:
 * - INSERT: Append new row to Sheet
 * - UPDATE: Update existing row in Sheet
 * - DELETE: Clear row in Sheet (Sheets API limitation)
 */

export class DbToSheetWorker {
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
            direction: 'db_to_sheet',
        });
    }

    /**
     * Execute DB → Sheet sync
     */
    async execute(): Promise<void> {
        const startTime = Date.now();
        const syncId = uuidv4();

        this.workLogger.info({ syncId }, 'Starting DB → Sheet sync');

        // Create sync history entry
        const syncHistory = await metadataDB.createSyncHistory({
            sync_config_id: this.config.id!,
            direction: 'db_to_sheet' as SyncDirection,
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

            // 1. Poll change log for unprocessed changes
            // CRITICAL: Exclude changes with source_tag='from_sheet' to prevent loops
            this.workLogger.debug('Polling MySQL change log');
            const changeLogEntries = await this.dbAdapter.getChangeLog({
                processed: false,
                excludeSourceTag: 'from_sheet', // ← INFINITE LOOP PREVENTION
                limit: 1000,
            });

            if (changeLogEntries.length === 0) {
                this.workLogger.info('No unprocessed changes in change log');
                await metadataDB.updateSyncHistory(syncHistory.id, {
                    completed_at: new Date(),
                    status: 'success' as SyncStatus,
                    metadata: { message: 'No changes detected' },
                });
                incrementSyncCounter('db_to_sheet', 'success_no_changes');
                return;
            }

            this.workLogger.info(
                { changeCount: changeLogEntries.length },
                'Found unprocessed DB changes'
            );

            // 2. Fetch current Sheet data
            const sheetData = await googleSheetsAdapter.getRange(
                this.config.sheet_id,
                this.config.sheet_range || 'Sheet1'
            );

            const sheetRows = this.convertSheetDataToRows(sheetData.values);

            // 3. Build map of Sheet rows by primary key for fast lookup
            const primaryKey = this.getPrimaryKeyColumn();
            const sheetRowMap = new Map<string | number, { index: number; data: Record<string, unknown> }>();

            for (let i = 0; i < sheetRows.length; i++) {
                const rowId = sheetRows[i][primaryKey];
                if (rowId !== undefined && rowId !== null) {
                    sheetRowMap.set(String(rowId), { index: i + 1, data: sheetRows[i] }); // +1 for header row
                }
            }

            // 4. Process change log entries and build batch updates
            const batchUpdates: Array<{ range: string; values: unknown[][] }> = [];
            const rowsToAppend: unknown[][] = [];
            const operationId = uuidv4();

            // Check idempotency
            if (await deduplicator.isProcessed(operationId)) {
                this.workLogger.warn({ operationId }, 'Operation already processed, skipping');
                return;
            }

            for (const entry of changeLogEntries) {
                const rowData = entry.row_data;
                const rowId = rowData[primaryKey];

                if (!rowId) {
                    this.workLogger.warn({ entry }, 'Change log entry missing primary key, skipping');
                    continue;
                }

                switch (entry.operation) {
                    case 'INSERT': {
                        // Append new row to Sheet
                        const sheetRow = this.convertRowToSheetFormat(rowData);
                        rowsToAppend.push(sheetRow);
                        break;
                    }

                    case 'UPDATE': {
                        // Update existing row in Sheet
                        const existingRow = sheetRowMap.get(String(rowId));
                        if (existingRow) {
                            const sheetRow = this.convertRowToSheetFormat(rowData);
                            const range = `${this.getSheetName()}!A${existingRow.index + 1}`;
                            batchUpdates.push({ range, values: [sheetRow] });
                        } else {
                            // Row doesn't exist in Sheet - treat as insert
                            const sheetRow = this.convertRowToSheetFormat(rowData);
                            rowsToAppend.push(sheetRow);
                        }
                        break;
                    }

                    case 'DELETE': {
                        // Clear row in Sheet (Sheets API limitation - can't truly delete)
                        const existingRow = sheetRowMap.get(String(rowId));
                        if (existingRow) {
                            const emptyRow = new Array(Object.keys(this.config.column_mapping).length).fill('');
                            const range = `${this.getSheetName()}!A${existingRow.index + 1}`;
                            batchUpdates.push({ range, values: [emptyRow] });
                        }
                        break;
                    }
                }
            }

            // 5. Apply changes to Sheet
            let rowsAffected = 0;

            if (batchUpdates.length > 0) {
                this.workLogger.info({ count: batchUpdates.length }, 'Applying batch updates to Sheet');
                await googleSheetsAdapter.batchUpdate(this.config.sheet_id, batchUpdates);
                rowsAffected += batchUpdates.length;
            }

            if (rowsToAppend.length > 0) {
                this.workLogger.info({ count: rowsToAppend.length }, 'Appending rows to Sheet');
                await googleSheetsAdapter.appendRows(
                    this.config.sheet_id,
                    this.config.sheet_range || 'Sheet1',
                    rowsToAppend
                );
                rowsAffected += rowsToAppend.length;
            }

            // 6. Mark change log entries as processed
            const changeLogIds = changeLogEntries.map((e) => e.id);
            await this.dbAdapter.markChangesProcessed(changeLogIds);

            // Mark operation as processed
            await deduplicator.markProcessed(operationId, {
                direction: 'db_to_sheet',
                rowsAffected,
                changeLogIds: changeLogIds.map(id => String(id)),
            });

            // 7. Update sync state
            await metadataDB.upsertSyncState({
                sync_config_id: this.config.id!,
                last_db_sync_at: new Date(),
                db_last_change_id: changeLogEntries[changeLogEntries.length - 1]?.id || null,
            });

            // 8. Update sync history
            await metadataDB.updateSyncHistory(syncHistory.id, {
                completed_at: new Date(),
                status: 'success' as SyncStatus,
                rows_affected: rowsAffected,
                conflicts_detected: 0, // Conflicts handled in Sheet→DB direction
            });

            const duration = Date.now() - startTime;
            this.workLogger.info(
                { rowsAffected, duration },
                'DB → Sheet sync completed successfully'
            );

            incrementSyncCounter('db_to_sheet', 'success');
            observeSyncLatency('db_to_sheet', duration);
        } catch (error) {
            this.workLogger.error({ error }, 'DB → Sheet sync failed');

            await metadataDB.updateSyncHistory(syncHistory.id, {
                completed_at: new Date(),
                status: 'failed' as SyncStatus,
                error_message: error instanceof Error ? error.message : String(error),
            });

            incrementSyncCounter('db_to_sheet', 'failed');
            throw error;
        } finally {
            await this.dbAdapter.close();
        }
    }

    /**
     * Convert Sheet data (2D array) to row objects
     */
    private convertSheetDataToRows(values: unknown[][]): Record<string, unknown>[] {
        if (values.length === 0) return [];

        const headers = values[0];
        const columnNames = headers.map((_, index) => {
            const columnLetter = this.indexToColumnLetter(index);
            return this.config.column_mapping[columnLetter] || columnLetter;
        });

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
     * Convert row object to Sheet format (array of values)
     */
    private convertRowToSheetFormat(row: Record<string, unknown>): unknown[] {
        const result: unknown[] = [];

        // Get sorted column letters (A, B, C, ...)
        const columnLetters = Object.keys(this.config.column_mapping).sort();

        for (const letter of columnLetters) {
            const columnName = this.config.column_mapping[letter];
            result.push(row[columnName] ?? '');
        }

        return result;
    }

    /**
     * Get primary key column name
     */
    private getPrimaryKeyColumn(): string {
        return this.config.column_mapping['A'] || 'id';
    }

    /**
     * Get sheet name from range
     */
    private getSheetName(): string {
        const range = this.config.sheet_range || 'Sheet1';
        return range.split('!')[0] || 'Sheet1';
    }

    /**
     * Convert column index to letter
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
