import logger from '../utils/logger';

/**
 * Token bucket rate limiter
 */
export class RateLimiter {
    private tokens: number;
    private readonly maxTokens: number;
    private readonly refillRate: number; // tokens per second
    private lastRefill: number;
    private readonly name: string;

    constructor(name: string, maxTokens: number, refillRate: number) {
        this.name = name;
        this.maxTokens = maxTokens;
        this.refillRate = refillRate;
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }

    /**
     * Acquire tokens (async with backpressure)
     */
    async acquire(tokensNeeded: number = 1): Promise<void> {
        while (true) {
            this.refill();

            if (this.tokens >= tokensNeeded) {
                this.tokens -= tokensNeeded;
                logger.debug(
                    { rateLimiter: this.name, tokensNeeded, tokensRemaining: this.tokens },
                    'Tokens acquired'
                );
                return;
            }

            // Calculate wait time
            const tokensShort = tokensNeeded - this.tokens;
            const waitMs = (tokensShort / this.refillRate) * 1000;

            logger.warn(
                { rateLimiter: this.name, tokensNeeded, tokensAvailable: this.tokens, waitMs },
                'Rate limit reached, waiting for tokens'
            );

            await this.sleep(waitMs);
        }
    }

    /**
     * Try to acquire tokens (non-blocking)
     */
    tryAcquire(tokensNeeded: number = 1): boolean {
        this.refill();

        if (this.tokens >= tokensNeeded) {
            this.tokens -= tokensNeeded;
            return true;
        }

        return false;
    }

    /**
     * Refill tokens based on elapsed time
     */
    private refill() {
        const now = Date.now();
        const elapsedMs = now - this.lastRefill;
        const elapsedSeconds = elapsedMs / 1000;
        const tokensToAdd = elapsedSeconds * this.refillRate;

        if (tokensToAdd > 0) {
            this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }

    /**
     * Get current token count
     */
    getTokens(): number {
        this.refill();
        return this.tokens;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
