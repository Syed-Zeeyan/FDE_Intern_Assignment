import pino from 'pino';
import { config } from '../config';

/**
 * Structured logger factory with correlation ID support
 */
export const logger = pino({
    level: config.LOG_LEVEL,
    ...(config.LOG_PRETTY && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },
    }),
});

/**
 * Create a child logger with context
 */
export function createChildLogger(context: Record<string, unknown>) {
    return logger.child(context);
}

/**
 * Generate correlation ID for request tracking
 */
export function generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export default logger;
