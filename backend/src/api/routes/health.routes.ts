import express, { Request, Response } from 'express';
import { metadataDB } from '../../database/metadata-db';
import { deduplicator } from '../../sync/deduplicator';
import { googleSheetsAdapter } from '../../adapters/google-sheets.adapter';
import logger from '../../utils/logger';

/**
 * Health Check Routes
 * 
 * Provides endpoints for monitoring system health
 * 
 * Endpoints:
 * - GET /health - Overall health status
 * - GET /health/db - Database health
 * - GET /health/redis - Redis health
 * - GET /health/google-sheets - Google Sheets API health
 */

const router = express.Router();

/**
 * Overall health check
 */
router.get('/', async (req: Request, res: Response) => {
    try {
        const [dbHealthy, redisHealthy] = await Promise.all([
            metadataDB.healthCheck(),
            deduplicator.healthCheck(),
        ]);

        const sheetsState = googleSheetsAdapter.getCircuitBreakerState();
        const sheetsHealthy = sheetsState === 'closed' || sheetsState === 'half_open';

        const isHealthy = dbHealthy && redisHealthy && sheetsHealthy;

        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            components: {
                database: dbHealthy ? 'healthy' : 'unhealthy',
                redis: redisHealthy ? 'healthy' : 'unhealthy',
                googleSheets: sheetsHealthy ? 'healthy' : 'unhealthy',
            },
            details: {
                sheetsCircuitBreaker: sheetsState,
                sheetsRateLimitTokens: Math.floor(googleSheetsAdapter.getRateLimitTokens()),
            },
        });
    } catch (error) {
        logger.error({ error }, 'Health check failed');
        res.status(503).json({
            status: 'unhealthy',
            error: 'Health check failed',
        });
    }
});

/**
 * Database health check
 */
router.get('/db', async (req: Request, res: Response) => {
    try {
        const isHealthy = await metadataDB.healthCheck();
        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? 'healthy' : 'unhealthy',
            component: 'database',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        logger.error({ error }, 'Database health check failed');
        res.status(503).json({
            status: 'unhealthy',
            component: 'database',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});

/**
 * Redis health check
 */
router.get('/redis', async (req: Request, res: Response) => {
    try {
        const isHealthy = await deduplicator.healthCheck();
        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? 'healthy' : 'unhealthy',
            component: 'redis',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        logger.error({ error }, 'Redis health check failed');
        res.status(503).json({
            status: 'unhealthy',
            component: 'redis',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});

/**
 * Google Sheets API health
 */
router.get('/google-sheets', async (req: Request, res: Response) => {
    try {
        const circuitState = googleSheetsAdapter.getCircuitBreakerState();
        const tokens = googleSheetsAdapter.getRateLimitTokens();
        const isHealthy = circuitState === 'closed' || circuitState === 'half_open';

        res.status(isHealthy ? 200 : 503).json({
            status: isHealthy ? 'healthy' : 'unhealthy',
            component: 'google-sheets',
            timestamp: new Date().toISOString(),
            details: {
                circuitBreakerState: circuitState,
                rateLimitTokens: Math.floor(tokens),
                rateLimitMax: 100,
            },
        });
    } catch (error) {
        logger.error({ error }, 'Google Sheets health check failed');
        res.status(503).json({
            status: 'unhealthy',
            component: 'google-sheets',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
});

export default router;
