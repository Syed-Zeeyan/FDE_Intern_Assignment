import { z } from 'zod';

/**
 * Conflict resolution strategies
 */
export enum ConflictStrategy {
    LAST_WRITE_WINS = 'last_write_wins',
    SHEET_WINS = 'sheet_wins',
    DB_WINS = 'db_wins',
    MANUAL = 'manual',
}

/**
 * Sync direction
 */
export enum SyncDirection {
    SHEET_TO_DB = 'sheet_to_db',
    DB_TO_SHEET = 'db_to_sheet',
}

/**
 * Sync status
 */
export enum SyncStatus {
    RUNNING = 'running',
    SUCCESS = 'success',
    FAILED = 'failed',
    PARTIAL = 'partial',
}

/**
 * Sync configuration schema
 */
export const syncConfigSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(255),
    sheet_id: z.string().min(1),
    sheet_range: z.string().optional(),
    db_connection_string: z.string().min(1),
    db_table_name: z.string().min(1).max(255),
    column_mapping: z.record(z.string()), // { "A": "id", "B": "name", ... }
    conflict_strategy: z.nativeEnum(ConflictStrategy).default(ConflictStrategy.LAST_WRITE_WINS),
    sync_interval_seconds: z.number().int().min(5).max(3600).default(30),
    is_active: z.boolean().default(true),
});

export type SyncConfig = z.infer<typeof syncConfigSchema>;

/**
 * Sync state
 */
export interface SyncState {
    sync_config_id: string;
    last_sheet_sync_at: Date | null;
    last_db_sync_at: Date | null;
    sheet_etag: string | null;
    sheet_revision_id: string | null;
    db_last_change_id: bigint | null;
}

/**
 * Sync history entry
 */
export interface SyncHistory {
    id: string;
    sync_config_id: string;
    direction: SyncDirection;
    rows_affected: number;
    conflicts_detected: number;
    started_at: Date;
    completed_at: Date | null;
    status: SyncStatus;
    error_message: string | null;
    metadata: Record<string, unknown> | null;
}

/**
 * Conflict entry
 */
export interface Conflict {
    id: string;
    sync_config_id: string;
    sync_history_id: string;
    row_identifier: string;
    sheet_value: Record<string, unknown> | null;
    db_value: Record<string, unknown> | null;
    sheet_timestamp: Date | null;
    db_timestamp: Date | null;
    resolution_strategy: ConflictStrategy;
    resolved_at: Date | null;
    resolved_value: Record<string, unknown> | null;
    created_at: Date;
}

/**
 * Change detection result
 */
export interface ChangeDetectionResult {
    inserts: Array<Record<string, unknown>>;
    updates: Array<{
        identifier: string | number;
        data: Record<string, unknown>;
    }>;
    deletes: Array<string | number>;
}

/**
 * Sync job payload
 */
export interface SyncJobPayload {
    configId: string;
    syncId: string;
    correlationId: string;
}

/**
 * Circuit breaker states
 */
export enum CircuitBreakerState {
    CLOSED = 'closed',
    OPEN = 'open',
    HALF_OPEN = 'half_open',
}

/**
 * WebSocket events
 */
export enum WebSocketEvent {
    SYNC_STARTED = 'sync:started',
    SYNC_PROGRESS = 'sync:progress',
    SYNC_COMPLETED = 'sync:completed',
    SYNC_ERROR = 'sync:error',
    CONFLICT_DETECTED = 'conflict:detected',
    METRICS_UPDATE = 'metrics:update',
    SUBSCRIBE = 'subscribe',
    UNSUBSCRIBE = 'unsubscribe',
}

/**
 * MySQL change log entry
 */
export interface MySQLChangeLogEntry {
    id: bigint;
    table_name: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    row_data: Record<string, unknown>;
    changed_at: Date;
    processed: boolean;
    source_tag?: string;
}
