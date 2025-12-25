import logger from './logger';

/**
 * Circuit breaker implementation for fault tolerance
 */
export enum CircuitBreakerState {
    CLOSED = 'closed',
    OPEN = 'open',
    HALF_OPEN = 'half_open',
}

export interface CircuitBreakerOptions {
    failureThreshold: number; // Number of failures before opening
    successThreshold: number; // Number of successes to close from half-open
    timeout: number; // Timeout in ms before attempting half-open
    windowDuration: number; // Sliding window duration in ms
}

export class CircuitBreaker {
    private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
    private failures: number = 0;
    private successes: number = 0;
    private lastFailureTime: number = 0;
    private failureTimestamps: number[] = [];
    private readonly options: CircuitBreakerOptions;
    private readonly name: string;

    constructor(name: string, options?: Partial<CircuitBreakerOptions>) {
        this.name = name;
        this.options = {
            failureThreshold: options?.failureThreshold ?? 5,
            successThreshold: options?.successThreshold ?? 2,
            timeout: options?.timeout ?? 300000, // 5 minutes
            windowDuration: options?.windowDuration ?? 60000, // 1 minute
        };
    }

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (this.state === CircuitBreakerState.OPEN) {
            const now = Date.now();
            if (now - this.lastFailureTime > this.options.timeout) {
                logger.info({ circuitBreaker: this.name }, 'Circuit breaker moving to HALF_OPEN');
                this.state = CircuitBreakerState.HALF_OPEN;
                this.successes = 0;
            } else {
                throw new Error(`Circuit breaker ${this.name} is OPEN`);
            }
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    private onSuccess() {
        this.failureTimestamps = [];

        if (this.state === CircuitBreakerState.HALF_OPEN) {
            this.successes++;
            if (this.successes >= this.options.successThreshold) {
                logger.info({ circuitBreaker: this.name }, 'Circuit breaker moving to CLOSED');
                this.state = CircuitBreakerState.CLOSED;
                this.failures = 0;
            }
        }
    }

    private onFailure() {
        const now = Date.now();
        this.lastFailureTime = now;
        this.failureTimestamps.push(now);

        // Remove failures outside the sliding window
        this.failureTimestamps = this.failureTimestamps.filter(
            (timestamp) => now - timestamp < this.options.windowDuration
        );

        if (this.state === CircuitBreakerState.HALF_OPEN) {
            logger.warn({ circuitBreaker: this.name }, 'Circuit breaker moving to OPEN (failure in HALF_OPEN)');
            this.state = CircuitBreakerState.OPEN;
            return;
        }

        if (this.failureTimestamps.length >= this.options.failureThreshold) {
            logger.warn(
                { circuitBreaker: this.name, failures: this.failureTimestamps.length },
                'Circuit breaker moving to OPEN (threshold exceeded)'
            );
            this.state = CircuitBreakerState.OPEN;
        }
    }

    getState(): CircuitBreakerState {
        return this.state;
    }

    getStateNumeric(): number {
        // For Prometheus metrics: 0=closed, 1=open, 2=half-open
        switch (this.state) {
            case CircuitBreakerState.CLOSED:
                return 0;
            case CircuitBreakerState.OPEN:
                return 1;
            case CircuitBreakerState.HALF_OPEN:
                return 2;
        }
    }

    reset() {
        this.state = CircuitBreakerState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.failureTimestamps = [];
    }
}
