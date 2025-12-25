import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import logger from './utils/logger';
import { metadataDB } from './database/metadata-db';
import { deduplicator } from './sync/deduplicator';
import { initializeWebSocket } from './websocket/sync-events';
import healthRoutes from './api/routes/health.routes';
import metricsRoutes from './api/routes/metrics.routes';
import configRoutes from './api/routes/config.routes';

/**
 * Main Express server with WebSocket support
 */

const app = express();

// Middleware
app.use(helmet()); // Security headers
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info({
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration,
        }, 'HTTP Request');
    });
    next();
});

// Routes
app.use('/health', healthRoutes);
app.use('/metrics', metricsRoutes);
app.use('/api/configs', configRoutes);

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Google Sheets ↔ MySQL Sync Platform',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: '/health',
            metrics: '/metrics',
            websocket: 'ws://localhost:3001',
        },
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        path: req.path,
    });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error({ error: err, path: req.path }, 'Unhandled error');
    res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
    });
});

// Create HTTP server (needed for WebSocket)
const httpServer = createServer(app);

// Initialize WebSocket
const wsServer = initializeWebSocket(httpServer);
logger.info('WebSocket server attached');

// Start server
const PORT = config.PORT;
httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server started with WebSocket support');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, starting graceful shutdown');

    httpServer.close(() => {
        logger.info('HTTP server closed');
    });

    // Close WebSocket
    wsServer.close();

    // Close database connections
    await metadataDB.close();
    await deduplicator.close();

    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, starting graceful shutdown');

    httpServer.close(() => {
        logger.info('HTTP server closed');
    });

    // Close WebSocket
    wsServer.close();

    process.exit(0);
});

export default app;
