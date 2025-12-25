/**
 * Queue Abstraction Interface
 * 
 * This provides a lightweight abstraction over job queuing without
 * committing to a specific implementation (Bull, BullMQ, custom, etc.)
 * 
 * Purpose:
 * - Decouple sync logic from queue implementation
 * - Enable future migration to different queue systems
 * - Demonstrate scale-ready patterns without over-engineering
 */

export interface JobPayload {
    configId: string;
    syncId: string;
    correlationId: string;
    direction: 'sheet_to_db' | 'db_to_sheet';
}

export interface JobOptions {
    priority?: number;
    delay?: number; // milliseconds
    attempts?: number; // max retry attempts
    backoff?: {
        type: 'exponential' | 'fixed';
        delay: number;
    };
}

export interface Job<T = unknown> {
    id: string;
    data: T;
    attemptsMade: number;
    timestamp: Date;
}

export interface QueueAdapter {
    /**
     * Add a job to the queue
     */
    enqueue(payload: JobPayload, options?: JobOptions): Promise<string>;

    /**
     * Process jobs from the queue
     */
    process(handler: (job: Job<JobPayload>) => Promise<void>): void;

    /**
     * Get queue health status
     */
    getHealth(): Promise<{
        isHealthy: boolean;
        depth: number;
        processing: number;
        failed: number;
    }>;

    /**
     * Move failed job to dead letter queue
     */
    moveToDeadLetter(jobId: string, error: Error): Promise<void>;

    /**
     * Close queue connections
     */
    close(): Promise<void>;
}

/**
 * Simple in-memory queue implementation (for Phase 4 demo)
 * 
 * Note: In production, replace with Bull/BullMQ backed by Redis
 */
export class InMemoryQueue implements QueueAdapter {
    private queue: Array<Job<JobPayload>> = [];
    private processing = new Set<string>();
    private deadLetterQueue: Array<{ job: Job<JobPayload>; error: Error }> = [];
    private isProcessing = false;

    async enqueue(payload: JobPayload, options?: JobOptions): Promise<string> {
        const job: Job<JobPayload> = {
            id: `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            data: payload,
            attemptsMade: 0,
            timestamp: new Date(),
        };

        this.queue.push(job);
        return job.id;
    }

    process(handler: (job: Job<JobPayload>) => Promise<void>): void {
        if (this.isProcessing) return;

        this.isProcessing = true;

        // Simple polling loop (in production, use event-driven)
        const processLoop = async () => {
            while (this.isProcessing) {
                if (this.queue.length === 0) {
                    await this.sleep(1000);
                    continue;
                }

                const job = this.queue.shift();
                if (!job) continue;

                this.processing.add(job.id);

                try {
                    await handler(job);
                    this.processing.delete(job.id);
                } catch (error) {
                    this.processing.delete(job.id);
                    await this.moveToDeadLetter(job.id, error as Error);
                }
            }
        };

        processLoop();
    }

    async getHealth(): Promise<{
        isHealthy: boolean;
        depth: number;
        processing: number;
        failed: number;
    }> {
        return {
            isHealthy: this.queue.length < 1000, // Arbitrary threshold
            depth: this.queue.length,
            processing: this.processing.size,
            failed: this.deadLetterQueue.length,
        };
    }

    async moveToDeadLetter(jobId: string, error: Error): Promise<void> {
        const job = this.queue.find((j) => j.id === jobId);
        if (job) {
            this.deadLetterQueue.push({ job, error });
        }
    }

    async close(): Promise<void> {
        this.isProcessing = false;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/**
 * Queue factory - allows swapping implementations
 */
export function createQueue(type: 'memory' | 'bull' = 'memory'): QueueAdapter {
    switch (type) {
        case 'memory':
            return new InMemoryQueue();
        case 'bull':
            // TODO: Implement Bull-backed queue in production
            throw new Error('Bull queue not implemented yet');
        default:
            throw new Error(`Unknown queue type: ${type}`);
    }
}
