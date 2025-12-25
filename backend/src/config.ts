import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment schema with validation
const envSchema = z.object({
    // Server
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().transform(Number).pipe(z.number().min(1).max(65535)).default('3001'),

    // PostgreSQL (Metadata DB)
    POSTGRES_HOST: z.string().default('localhost'),
    POSTGRES_PORT: z.string().transform(Number).pipe(z.number()).default('5432'),
    POSTGRES_DB: z.string().default('sheets_sync_metadata'),
    POSTGRES_USER: z.string(),
    POSTGRES_PASSWORD: z.string(),

    // Redis
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.string().transform(Number).pipe(z.number()).default('6379'),
    REDIS_PASSWORD: z.string().optional().default(''),

    // Google Sheets API
    GOOGLE_SHEETS_CREDENTIALS: z.string().optional(),
    GOOGLE_SHEETS_CREDENTIALS_PATH: z.string().optional(),

    // Sync Configuration
    DEFAULT_SYNC_INTERVAL_SECONDS: z.string().transform(Number).pipe(z.number()).default('30'),
    MAX_RETRY_ATTEMPTS: z.string().transform(Number).pipe(z.number()).default('5'),
    CIRCUIT_BREAKER_THRESHOLD: z.string().transform(Number).pipe(z.number()).default('5'),
    CIRCUIT_BREAKER_TIMEOUT_MS: z.string().transform(Number).pipe(z.number()).default('300000'),

    // Rate Limiting
    GOOGLE_SHEETS_RATE_LIMIT: z.string().transform(Number).pipe(z.number()).default('100'),
    GOOGLE_SHEETS_RATE_WINDOW_SECONDS: z.string().transform(Number).pipe(z.number()).default('100'),

    // Queue Configuration
    WORKER_CONCURRENCY: z.string().transform(Number).pipe(z.number()).default('5'),
    JOB_TIMEOUT_MS: z.string().transform(Number).pipe(z.number()).default('300000'),

    // Logging
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_PRETTY: z.string().transform((v) => v === 'true').default('true'),

    // Security
    JWT_SECRET: z.string().optional(),
    ENCRYPTION_KEY: z.string().min(32).optional(),

    // CORS
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
});

// Validate and export config
const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(parseResult.error.format());
    process.exit(1);
}

export const config = parseResult.data;

// Derived configuration
export const isDevelopment = config.NODE_ENV === 'development';
export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

// Database connection strings
export const postgresConnectionString = `postgresql://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@${config.POSTGRES_HOST}:${config.POSTGRES_PORT}/${config.POSTGRES_DB}`;

export const redisConnectionString = config.REDIS_PASSWORD
    ? `redis://:${config.REDIS_PASSWORD}@${config.REDIS_HOST}:${config.REDIS_PORT}`
    : `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`;

// Google Sheets credentials
export function getGoogleSheetsCredentials() {
    if (config.GOOGLE_SHEETS_CREDENTIALS) {
        // Base64-encoded credentials
        try {
            return JSON.parse(Buffer.from(config.GOOGLE_SHEETS_CREDENTIALS, 'base64').toString('utf-8'));
        } catch (error) {
            throw new Error('Failed to parse GOOGLE_SHEETS_CREDENTIALS');
        }
    }

    if (config.GOOGLE_SHEETS_CREDENTIALS_PATH) {
        // File path to credentials
        try {
            const path = require('path');
            const fs = require('fs');
            const credPath = path.resolve(process.cwd(), config.GOOGLE_SHEETS_CREDENTIALS_PATH);
            return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        } catch (error) {
            throw new Error(`Failed to load credentials from ${config.GOOGLE_SHEETS_CREDENTIALS_PATH}: ${(error as Error).message}`);
        }
    }

    throw new Error('Google Sheets credentials not configured');
}

export default config;
