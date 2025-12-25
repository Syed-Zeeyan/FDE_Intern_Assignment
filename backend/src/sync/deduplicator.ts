import Redis from 'ioredis';
import { config, redisConnectionString } from '../config';
import logger from '../utils/logger';

/**
 * Deduplicator - Idempotency checker using Redis
 * 
 * Purpose: Prevent duplicate processing of sync operations
 * 
 * How it works:
 * 1. Each sync operation has a unique operationId (UUID)
 * 2. Before processing, check if operationId exists in Redis
 * 3. If exists → skip (already processed)
 * 4. If not exists → mark as processed and continue
 * 5. Keys expire after 24 hours (TTL)
 * 
 * This prevents:
 * - Duplicate syncs from retries
 * - Infinite loops from circular updates
 * - Race conditions from concurrent workers
 */

export class Deduplicator {
    private redis: Redis;
    private readonly ttlSeconds: number = 86400; // 24 hours

    constructor() {
        this.redis = new Redis(redisConnectionString, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: false,
        });

        this.redis.on('error', (error) => {
            logger.error({ error }, 'Redis deduplicator error');
        });

        this.redis.on('connect', () => {
            logger.debug('Deduplicator Redis connected');
        });
    }

    /**
     * Check if operation has already been processed
     * 
     * @param operationId - Unique operation identifier
     * @returns true if already processed, false otherwise
     */
    async isProcessed(operationId: string): Promise<boolean> {
        const key = this.getKey(operationId);
        const exists = await this.redis.exists(key);
        return exists === 1;
    }

    /**
     * Mark operation as processed
     * 
     * @param operationId - Unique operation identifier
     * @param metadata - Optional metadata to store with the operation
     */
    async markProcessed(operationId: string, metadata?: Record<string, unknown>): Promise<void> {
        const key = this.getKey(operationId);
        const value = metadata ? JSON.stringify(metadata) : 'processed';

        await this.redis.setex(key, this.ttlSeconds, value);

        logger.debug({ operationId, ttl: this.ttlSeconds }, 'Operation marked as processed');
    }

    /**
     * Check and mark in a single atomic operation
     * 
     * @param operationId - Unique operation identifier
     * @returns true if operation was newly marked (not processed before), false if already processed
     */
    async checkAndMark(operationId: string): Promise<boolean> {
        const key = this.getKey(operationId);

        // SET NX (only if not exists) with expiry
        const result = await this.redis.set(key, 'processed', 'EX', this.ttlSeconds, 'NX');

        // result is 'OK' if key was set (not existed before)
        // result is null if key already existed
        return result === 'OK';
    }

    /**
     * Remove operation from processed set (for testing/debugging)
     */
    async remove(operationId: string): Promise<void> {
        const key = this.getKey(operationId);
        await this.redis.del(key);
    }

    /**
     * Get operation metadata if it exists
     */
    async getMetadata(operationId: string): Promise<Record<string, unknown> | null> {
        const key = this.getKey(operationId);
        const value = await this.redis.get(key);

        if (!value) return null;

        try {
            return JSON.parse(value);
        } catch {
            return { value };
        }
    }

    /**
     * Close Redis connection
     */
    async close(): Promise<void> {
        await this.redis.quit();
        logger.info('Deduplicator Redis connection closed');
    }

    /**
     * Get Redis key for operation ID
     */
    private getKey(operationId: string): string {
        return `idempotency:${operationId}`;
    }

    /**
     * Health check
     */
    async healthCheck(): Promise<boolean> {
        try {
            await this.redis.ping();
            return true;
        } catch (error) {
            logger.error({ error }, 'Deduplicator health check failed');
            return false;
        }
    }
}

// Global instance
export const deduplicator = new Deduplicator();
export default deduplicator;
