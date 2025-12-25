import logger from './logger';

/**
 * Retry options
 */
export interface RetryOptions {
    maxAttempts: number;
    baseDelay: number; // Base delay in ms
    maxDelay: number; // Maximum delay in ms
    jitter: boolean; // Add random jitter
    retryableErrors?: (error: unknown) => boolean; // Custom error handler
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
    maxAttempts: 5,
    baseDelay: 1000,
    maxDelay: 60000,
    jitter: true,
};

/**
 * Calculate exponential backoff delay with optional jitter
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
    const exponentialDelay = options.baseDelay * Math.pow(2, attempt);
    const delay = Math.min(exponentialDelay, options.maxDelay);

    if (options.jitter) {
        // Add ±20% jitter
        const jitterAmount = delay * 0.2;
        return delay + (Math.random() * 2 - 1) * jitterAmount;
    }

    return delay;
}

/**
 * Retry a promise-returning function with exponential backoff
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: Partial<RetryOptions> = {},
    context?: Record<string, unknown>
): Promise<T> {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
    let lastError: unknown;

    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Check if error is retryable
            if (opts.retryableErrors && !opts.retryableErrors(error)) {
                logger.warn({ error, attempt, ...context }, 'Non-retryable error encountered');
                throw error;
            }

            // Don't delay on last attempt
            if (attempt < opts.maxAttempts - 1) {
                const delay = calculateDelay(attempt, opts);
                logger.warn(
                    { error, attempt: attempt + 1, maxAttempts: opts.maxAttempts, delay, ...context },
                    'Retry attempt failed, waiting before next retry'
                );
                await sleep(delay);
            }
        }
    }

    logger.error(
        { error: lastError, maxAttempts: opts.maxAttempts, ...context },
        'All retry attempts failed'
    );
    throw lastError;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable (network errors, rate limits, etc.)
 */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();

        // Network errors
        if (
            message.includes('econnrefused') ||
            message.includes('etimedout') ||
            message.includes('enotfound') ||
            message.includes('network')
        ) {
            return true;
        }

        // Rate limiting
        if (message.includes('rate limit') || message.includes('too many requests')) {
            return true;
        }

        // Temporary Google API errors
        if (message.includes('503') || message.includes('429')) {
            return true;
        }
    }

    return false;
}
