import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import logger from '../utils/logger';

/**
 * WebSocket Server for Real-Time Sync Events
 * 
 * Purpose: Broadcast sync lifecycle events to connected clients
 * 
 * Scope (Phase 5 - Minimal):
 * - Single global channel (no rooms/namespaces)
 * - No authentication
 * - No Redis pub/sub (single server instance)
 * - Basic connect/disconnect handling
 * 
 * Events emitted:
 * - sync:started      { configId, syncId, direction, timestamp }
 * - sync:completed    { configId, syncId, direction, rowsAffected, conflicts, duration }
 * - sync:conflict     { configId, conflictId, rowData }
 * - sync:failed       { configId, syncId, direction, error }
 * - dlq:added         { jobId, error, attemptsMade }
 */

export class WebSocketServer {
    private io: SocketIOServer;

    constructor(httpServer: HttpServer) {
        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: '*', // In production: restrict to specific origins
                methods: ['GET', 'POST'],
            },
        });

        this.setupEventHandlers();
        logger.info('WebSocket server initialized');
    }

    /**
     * Setup Socket.io event handlers
     */
    private setupEventHandlers() {
        this.io.on('connection', (socket) => {
            logger.info({ socketId: socket.id }, 'Client connected');

            // Handle disconnect
            socket.on('disconnect', (reason) => {
                logger.info({ socketId: socket.id, reason }, 'Client disconnected');
            });

            // Handle errors
            socket.on('error', (error) => {
                logger.error({ socketId: socket.id, error }, 'Socket error');
            });

            // Send welcome message
            socket.emit('connected', {
                message: 'Connected to sync platform WebSocket',
                timestamp: new Date().toISOString(),
            });
        });
    }

    /**
     * Broadcast sync started event
     */
    emitSyncStarted(data: {
        configId: string;
        syncId: string;
        direction: 'sheet_to_db' | 'db_to_sheet';
    }) {
        this.io.emit('sync:started', {
            ...data,
            timestamp: new Date().toISOString(),
        });

        logger.debug({ event: 'sync:started', data }, 'WebSocket event emitted');
    }

    /**
     * Broadcast sync completed event
     */
    emitSyncCompleted(data: {
        configId: string;
        syncId: string;
        direction: 'sheet_to_db' | 'db_to_sheet';
        rowsAffected: number;
        conflicts: number;
        duration: number;
    }) {
        this.io.emit('sync:completed', {
            ...data,
            timestamp: new Date().toISOString(),
        });

        logger.debug({ event: 'sync:completed', data }, 'WebSocket event emitted');
    }

    /**
     * Broadcast conflict detected event
     */
    emitConflict(data: {
        configId: string;
        conflictId: string;
        rowIdentifier: string;
        conflictingColumns: string[];
    }) {
        this.io.emit('sync:conflict', {
            ...data,
            timestamp: new Date().toISOString(),
        });

        logger.debug({ event: 'sync:conflict', data }, 'WebSocket event emitted');
    }

    /**
     * Broadcast sync failed event
     */
    emitSyncFailed(data: {
        configId: string;
        syncId: string;
        direction: 'sheet_to_db' | 'db_to_sheet';
        error: string;
    }) {
        this.io.emit('sync:failed', {
            ...data,
            timestamp: new Date().toISOString(),
        });

        logger.debug({ event: 'sync:failed', data }, 'WebSocket event emitted');
    }

    /**
     * Broadcast dead letter queue event
     */
    emitDLQAdded(data: {
        jobId: string;
        error: string;
        attemptsMade: number;
        failureReason: string;
    }) {
        this.io.emit('dlq:added', {
            ...data,
            timestamp: new Date().toISOString(),
        });

        logger.debug({ event: 'dlq:added', data }, 'WebSocket event emitted');
    }

    /**
     * Get connected client count
     */
    getClientCount(): number {
        return this.io.sockets.sockets.size;
    }

    /**
     * Close WebSocket server
     */
    close() {
        this.io.close();
        logger.info('WebSocket server closed');
    }
}

// Global instance (initialized in server.ts)
let wsServer: WebSocketServer | null = null;

export function initializeWebSocket(httpServer: HttpServer): WebSocketServer {
    wsServer = new WebSocketServer(httpServer);
    return wsServer;
}

export function getWebSocketServer(): WebSocketServer | null {
    return wsServer;
}
