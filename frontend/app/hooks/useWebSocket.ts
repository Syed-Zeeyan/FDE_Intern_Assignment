'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface SyncEvent {
    type: string;
    data: any;
}

interface HealthStatus {
    database: string;
    redis: string;
    googleSheets: string;
}

export function useWebSocket() {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [events, setEvents] = useState<SyncEvent[]>([]);
    const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);

    useEffect(() => {
        // Connect to WebSocket
        const socketInstance = io('http://localhost:3001');

        socketInstance.on('connect', () => {
            console.log('WebSocket connected');
            setIsConnected(true);
        });

        socketInstance.on('disconnect', () => {
            console.log('WebSocket disconnected');
            setIsConnected(false);
        });

        // Listen for sync events
        socketInstance.on('sync:started', (data) => {
            addEvent('sync:started', data);
        });

        socketInstance.on('sync:completed', (data) => {
            addEvent('sync:completed', data);
        });

        socketInstance.on('sync:failed', (data) => {
            addEvent('sync:failed', data);
        });

        socketInstance.on('sync:conflict', (data) => {
            addEvent('sync:conflict', data);
        });

        socketInstance.on('dlq:added', (data) => {
            addEvent('dlq:added', data);
        });

        setSocket(socketInstance);

        // Fetch health status periodically
        const healthInterval = setInterval(async () => {
            try {
                const res = await fetch('http://localhost:3001/health');
                if (res.ok) {
                    const data = await res.json();
                    setHealthStatus(data.components);
                }
            } catch (error) {
                console.error('Failed to fetch health:', error);
            }
        }, 5000);

        // Cleanup
        return () => {
            socketInstance.disconnect();
            clearInterval(healthInterval);
        };
    }, []);

    const addEvent = (type: string, data: any) => {
        setEvents((prev) => [{ type, data }, ...prev].slice(0, 50));
    };

    return {
        socket,
        isConnected,
        events,
        healthStatus,
    };
}
