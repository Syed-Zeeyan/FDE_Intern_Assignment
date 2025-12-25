import { metadataDB } from '../database/metadata-db';
import { SheetToDbWorker } from './workers/sheet-to-db.worker';
import { DbToSheetWorker } from './workers/db-to-sheet.worker';
import { deadLetterQueue } from './dead-letter-queue';
import { retry, isRetryableError } from '../utils/retry';
import { getWebSocketServer } from '../websocket/sync-events';
import { config } from '../config';
import logger from '../utils/logger';
import type { SyncConfig } from '../types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Sync Orchestrator with Retry and DLQ Integration
 * 
 * Changes from Phase 3:
 * - Added retry wrapper around worker executions
 * - Failed jobs moved to Dead Letter Queue after max retries
 * - Exponential backoff for transient failures
 * 
 * NOTE: This is still synchronous (not queue-based).
 * In full production, replace with Bull/BullMQ workers.
 */

export class SyncOrchestrator {
    private isRunning: boolean = false;
    private syncIntervalMs: number = 10000; // 10 seconds default

    constructor() {
        logger.info('Sync Orchestrator initialized (with retry + DLQ)');
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Orchestrator already running');
            return;
        }

        this.isRunning = true;
        logger.info('Starting sync orchestrator');

        await this.syncCycle();

        setInterval(async () => {
            if (this.isRunning) {
                await this.syncCycle();
            }
        }, this.syncIntervalMs);
    }

    stop() {
        this.isRunning = false;
        logger.info('Sync orchestrator stopped');
    }

    private async syncCycle() {
        try {
            const configs = await metadataDB.getAllSyncConfigs(true);

            if (configs.length === 0) {
                logger.debug('No active sync configurations');
                return;
            }

            logger.info({ configCount: configs.length }, 'Starting sync cycle');

            for (const config of configs) {
                await this.syncConfigWithRetry(config);
            }

            logger.info('Sync cycle completed');
        } catch (error) {
            logger.error({ error }, 'Sync cycle failed');
        }
    }

    /**
     * Execute sync with retry and DLQ handling
     */
    private async syncConfigWithRetry(config: SyncConfig) {
        const configLogger = logger.child({ configId: config.id, configName: config.name });

        try {
            const syncState = await metadataDB.getSyncState(config.id!);
            const now = new Date();

            const lastSheetSync = syncState?.last_sheet_sync_at;
            const lastDbSync = syncState?.last_db_sync_at;

            const sheetSyncNeeded =
                !lastSheetSync ||
                now.getTime() - lastSheetSync.getTime() >= config.sync_interval_seconds * 1000;

            const dbSyncNeeded =
                !lastDbSync ||
                now.getTime() - lastDbSync.getTime() >= config.sync_interval_seconds * 1000;

            if (!sheetSyncNeeded && !dbSyncNeeded) {
                configLogger.debug('Sync not needed yet (within interval)');
                return;
            }

            configLogger.info('Executing bi-directional sync with retry');

            // Execute Sheet → DB with retry
            if (sheetSyncNeeded) {
                await this.executeWithRetry(
                    'sheet_to_db',
                    config,
                    async () => {
                        const worker = new SheetToDbWorker(config);
                        await worker.execute();
                    }
                );
            }

            // Execute DB → Sheet with retry
            if (dbSyncNeeded) {
                await this.executeWithRetry(
                    'db_to_sheet',
                    config,
                    async () => {
                        const worker = new DbToSheetWorker(config);
                        await worker.execute();
                    }
                );
            }

            configLogger.info('Bi-directional sync completed');
        } catch (error) {
            configLogger.error({ error }, 'Sync failed for config (moved to DLQ)');
        }
    }

    /**
     * Execute worker with retry, move to DLQ on permanent failure
     */
    private async executeWithRetry(
        direction: 'sheet_to_db' | 'db_to_sheet',
        config: SyncConfig,
        worker: () => Promise<void>
    ): Promise<void> {
        const jobId = `${config.id}-${direction}-${Date.now()}`;
        const firstAttemptAt = new Date();

        try {
            await retry(
                worker,
                {
                    maxAttempts: 5, // Max retry attempts
                    baseDelay: 1000,
                    maxDelay: 30000,
                    jitter: true,
                    retryableErrors: isRetryableError,
                },
                { jobId, direction, configId: config.id }
            );
        } catch (error) {
            // All retries failed - move to DLQ
            await deadLetterQueue.add({
                jobId,
                payload: { configId: config.id, direction },
                error: error instanceof Error ? error.message : String(error),
                stackTrace: error instanceof Error ? error.stack : undefined,
                attemptsMade: 5, // Max retry attempts
                firstAttemptAt,
                lastAttemptAt: new Date(),
                failureReason: isRetryableError(error) ? 'max_retries' : 'non_retryable_error',
            });

            throw error; // Re-throw to log at orchestrator level
        }
    }

    async triggerManualSync(configId: string): Promise<void> {
        logger.info({ configId }, 'Triggering manual sync');

        const config = await metadataDB.getSyncConfig(configId);
        if (!config) {
            throw new Error(`Config not found: ${configId}`);
        }

        if (!config.is_active) {
            throw new Error(`Config is not active: ${configId}`);
        }

        await this.syncConfigWithRetry(config);
    }
    /**
     * Trigger immediate sync for a specific configuration (manual trigger)
     * Used by API endpoints to execute sync on-demand
     */
    async triggerImmediateSync(config: SyncConfig): Promise<void> {
        logger.info({ configId: config.id, configName: config.name }, 'Manual sync triggered');
        await this.syncConfigWithRetry(config);
    }
}

// Export singleton instance
export const syncOrchestrator = new SyncOrchestrator();
export default syncOrchestrator;
