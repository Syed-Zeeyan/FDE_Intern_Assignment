import logger from '../utils/logger';
import type { ChangeDetectionResult } from '../types';

/**
 * Change detector - Diffs two datasets to identify inserts, updates, and deletes
 * 
 * This is the core algorithm for detecting what changed between:
 * - Google Sheets data (current) vs MySQL data (baseline)
 * - MySQL data (current) vs Google Sheets data (baseline)
 * 
 * Algorithm:
 * 1. Build maps of current and baseline data by primary key
 * 2. Iterate current data:
 *    - If key not in baseline → INSERT
 *    - If key in baseline but data differs → UPDATE
 * 3. Iterate baseline data:
 *    - If key not in current → DELETE
 */

export interface RowData {
    [key: string]: unknown;
}

export interface ChangeDetectorOptions {
    primaryKey: string; // Column name that serves as primary key
    ignoreColumns?: string[]; // Columns to ignore in comparison
}

export class ChangeDetector {
    private readonly options: ChangeDetectorOptions;

    constructor(options: ChangeDetectorOptions) {
        this.options = options;
    }

    /**
     * Detect changes between current and baseline datasets
     * 
     * @param current - Current state of data (e.g., from Sheet)
     * @param baseline - Baseline state of data (e.g., from DB)
     * @returns ChangeDetectionResult with inserts, updates, deletes
     */
    detect(current: RowData[], baseline: RowData[]): ChangeDetectionResult {
        const result: ChangeDetectionResult = {
            inserts: [],
            updates: [],
            deletes: [],
        };

        // Build baseline map for O(1) lookups
        const baselineMap = new Map<string | number, RowData>();
        for (const row of baseline) {
            const key = this.getPrimaryKeyValue(row);
            if (key !== null) {
                baselineMap.set(key, row);
            }
        }

        // Build current map for O(1) lookups
        const currentMap = new Map<string | number, RowData>();
        for (const row of current) {
            const key = this.getPrimaryKeyValue(row);
            if (key !== null) {
                currentMap.set(key, row);
            }
        }

        // Detect inserts and updates
        for (const row of current) {
            const key = this.getPrimaryKeyValue(row);
            if (key === null) continue;

            const baselineRow = baselineMap.get(key);

            if (!baselineRow) {
                // New row - INSERT
                result.inserts.push(row);
            } else {
                // Existing row - check if data changed
                if (this.hasChanged(row, baselineRow)) {
                    result.updates.push({
                        identifier: key,
                        data: row,
                    });
                }
            }
        }

        // Detect deletes
        for (const row of baseline) {
            const key = this.getPrimaryKeyValue(row);
            if (key === null) continue;

            if (!currentMap.has(key)) {
                // Row exists in baseline but not in current - DELETE
                result.deletes.push(key);
            }
        }

        logger.debug(
            {
                inserts: result.inserts.length,
                updates: result.updates.length,
                deletes: result.deletes.length,
            },
            'Change detection completed'
        );

        return result;
    }

    /**
     * Get primary key value from a row
     */
    private getPrimaryKeyValue(row: RowData): string | number | null {
        const value = row[this.options.primaryKey];

        if (value === undefined || value === null || value === '') {
            return null;
        }

        if (typeof value === 'string' || typeof value === 'number') {
            return value;
        }

        // Convert to string for complex types
        return String(value);
    }

    /**
     * Check if two rows have different data
     * Ignores primary key and configured ignore columns
     */
    private hasChanged(current: RowData, baseline: RowData): boolean {
        const ignoreSet = new Set([
            this.options.primaryKey,
            ...(this.options.ignoreColumns || []),
        ]);

        // Get all column names from both rows
        const allColumns = new Set([
            ...Object.keys(current),
            ...Object.keys(baseline),
        ]);

        for (const column of allColumns) {
            if (ignoreSet.has(column)) continue;

            const currentValue = current[column];
            const baselineValue = baseline[column];

            if (!this.valuesEqual(currentValue, baselineValue)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Deep equality check for values
     */
    private valuesEqual(a: unknown, b: unknown): boolean {
        // Handle null/undefined
        if (a === null || a === undefined) {
            return b === null || b === undefined;
        }
        if (b === null || b === undefined) {
            return false;
        }

        // Handle primitives
        if (typeof a !== 'object' || typeof b !== 'object') {
            // Coerce to string for comparison (handles number vs string)
            return String(a).trim() === String(b).trim();
        }

        // Handle dates
        if (a instanceof Date && b instanceof Date) {
            return a.getTime() === b.getTime();
        }

        // Handle objects (shallow comparison)
        const aKeys = Object.keys(a as object);
        const bKeys = Object.keys(b as object);

        if (aKeys.length !== bKeys.length) {
            return false;
        }

        for (const key of aKeys) {
            if (!this.valuesEqual((a as RowData)[key], (b as RowData)[key])) {
                return false;
            }
        }

        return true;
    }
}
