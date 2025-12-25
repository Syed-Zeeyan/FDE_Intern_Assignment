import logger from '../utils/logger';
import { ConflictStrategy } from '../types';
import type { RowData } from './change-detector';

/**
 * Conflict Resolver - Detects and resolves data conflicts
 * 
 * What is a conflict?
 * A conflict occurs when the SAME row is modified in BOTH Sheet and DB
 * after the last successful sync, affecting overlapping columns.
 * 
 * Detection Logic:
 * 1. Track changes from both sources (Sheet and DB)
 * 2. Find rows modified in BOTH sources (by primary key)
 * 3. Check if timestamps indicate both changed after last sync
 * 4. Verify overlapping columns were modified
 * 
 * Resolution Strategies:
 * 1. LAST_WRITE_WINS - Compare timestamps, winner = most recent
 * 2. SHEET_WINS - Always prefer Sheet data
 * 3. DB_WINS - Always prefer database data
 * 4. MANUAL - Queue for user resolution
 */

export interface ConflictDetectionInput {
    sheetChanges: Array<{
        rowId: string | number;
        data: RowData;
        timestamp: Date;
        columns: string[];
    }>;
    dbChanges: Array<{
        rowId: string | number;
        data: RowData;
        timestamp: Date;
        columns: string[];
    }>;
    lastSyncTime: Date;
}

export interface DetectedConflict {
    rowId: string | number;
    sheetValue: RowData;
    dbValue: RowData;
    sheetTimestamp: Date;
    dbTimestamp: Date;
    conflictingColumns: string[];
}

export interface ResolvedConflict {
    rowId: string | number;
    winner: 'sheet' | 'db' | 'manual';
    resolvedValue: RowData | null;
    strategy: ConflictStrategy;
}

export class ConflictResolver {
    /**
     * Detect conflicts between Sheet and DB changes
     * 
     * @param input - Changes from both sources with timestamps
     * @returns Array of detected conflicts
     */
    detectConflicts(input: ConflictDetectionInput): DetectedConflict[] {
        const conflicts: DetectedConflict[] = [];

        // Build map of DB changes by row ID for O(1) lookup
        const dbChangeMap = new Map<string | number, typeof input.dbChanges[0]>();
        for (const dbChange of input.dbChanges) {
            dbChangeMap.set(dbChange.rowId, dbChange);
        }

        // Check each Sheet change for conflicts with DB changes
        for (const sheetChange of input.sheetChanges) {
            const dbChange = dbChangeMap.get(sheetChange.rowId);

            if (!dbChange) continue; // No DB change for this row - no conflict

            // Both changes must be after last sync to be a conflict
            const sheetAfterSync = sheetChange.timestamp > input.lastSyncTime;
            const dbAfterSync = dbChange.timestamp > input.lastSyncTime;

            if (!sheetAfterSync || !dbAfterSync) continue;

            // Check for overlapping columns
            const overlappingColumns = this.findOverlappingColumns(
                sheetChange.columns,
                dbChange.columns
            );

            if (overlappingColumns.length > 0) {
                conflicts.push({
                    rowId: sheetChange.rowId,
                    sheetValue: sheetChange.data,
                    dbValue: dbChange.data,
                    sheetTimestamp: sheetChange.timestamp,
                    dbTimestamp: dbChange.timestamp,
                    conflictingColumns: overlappingColumns,
                });

                logger.warn(
                    {
                        rowId: sheetChange.rowId,
                        conflictingColumns: overlappingColumns,
                        sheetTimestamp: sheetChange.timestamp,
                        dbTimestamp: dbChange.timestamp,
                    },
                    'Conflict detected'
                );
            }
        }

        return conflicts;
    }

    /**
     * Resolve a conflict using the specified strategy
     * 
     * @param conflict - Detected conflict
     * @param strategy - Resolution strategy
     * @returns Resolved conflict with winner and resolved value
     */
    resolveConflict(
        conflict: DetectedConflict,
        strategy: ConflictStrategy
    ): ResolvedConflict {
        switch (strategy) {
            case ConflictStrategy.LAST_WRITE_WINS:
                return this.resolveLWW(conflict);

            case ConflictStrategy.SHEET_WINS:
                return this.resolveSheetWins(conflict);

            case ConflictStrategy.DB_WINS:
                return this.resolveDbWins(conflict);

            case ConflictStrategy.MANUAL:
                return this.resolveManual(conflict);

            default:
                logger.error({ strategy }, 'Unknown conflict strategy, defaulting to LWW');
                return this.resolveLWW(conflict);
        }
    }

    /**
     * Last-Write-Wins: Compare timestamps
     */
    private resolveLWW(conflict: DetectedConflict): ResolvedConflict {
        const winner =
            conflict.sheetTimestamp > conflict.dbTimestamp ? 'sheet' : 'db';

        const resolvedValue = winner === 'sheet' ? conflict.sheetValue : conflict.dbValue;

        logger.info(
            {
                rowId: conflict.rowId,
                winner,
                sheetTimestamp: conflict.sheetTimestamp,
                dbTimestamp: conflict.dbTimestamp,
            },
            'Conflict resolved (LWW)'
        );

        return {
            rowId: conflict.rowId,
            winner,
            resolvedValue,
            strategy: ConflictStrategy.LAST_WRITE_WINS,
        };
    }

    /**
     * Sheet-Wins: Always prefer Sheet data
     */
    private resolveSheetWins(conflict: DetectedConflict): ResolvedConflict {
        logger.info({ rowId: conflict.rowId }, 'Conflict resolved (Sheet Wins)');

        return {
            rowId: conflict.rowId,
            winner: 'sheet',
            resolvedValue: conflict.sheetValue,
            strategy: ConflictStrategy.SHEET_WINS,
        };
    }

    /**
     * DB-Wins: Always prefer database data
     */
    private resolveDbWins(conflict: DetectedConflict): ResolvedConflict {
        logger.info({ rowId: conflict.rowId }, 'Conflict resolved (DB Wins)');

        return {
            rowId: conflict.rowId,
            winner: 'db',
            resolvedValue: conflict.dbValue,
            strategy: ConflictStrategy.DB_WINS,
        };
    }

    /**
     * Manual: Queue for user resolution
     */
    private resolveManual(conflict: DetectedConflict): ResolvedConflict {
        logger.info({ rowId: conflict.rowId }, 'Conflict queued for manual resolution');

        return {
            rowId: conflict.rowId,
            winner: 'manual',
            resolvedValue: null,
            strategy: ConflictStrategy.MANUAL,
        };
    }

    /**
     * Find columns that exist in both arrays
     */
    private findOverlappingColumns(cols1: string[], cols2: string[]): string[] {
        const set1 = new Set(cols1);
        return cols2.filter((col) => set1.has(col));
    }

    /**
     * Helper: Extract modified columns from row data
     * (Used when building conflict detection input)
     */
    static extractModifiedColumns(data: RowData): string[] {
        return Object.keys(data);
    }

    /**
     * Helper: Build timestamp from row data
     * Assumes an 'updated_at' or similar column exists
     */
    static extractTimestamp(
        data: RowData,
        timestampColumn: string = 'updated_at'
    ): Date {
        const value = data[timestampColumn];

        if (value instanceof Date) {
            return value;
        }

        if (typeof value === 'string' || typeof value === 'number') {
            return new Date(value);
        }

        // Fallback: use current time
        logger.warn(
            { data, timestampColumn },
            'No valid timestamp found, using current time'
        );
        return new Date();
    }
}

export const conflictResolver = new ConflictResolver();
export default conflictResolver;
