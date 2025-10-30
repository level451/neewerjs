// WebSocket Server - Accepts JSON commands and broadcasts status

import { WebSocketServer as WSServer } from 'ws';

export class WebSocketServer {
    constructor(lightManager, port = 8080) {
        this.lightManager = lightManager;
        this.port = port;
        this.wss = null;
        this.clients = new Set();
    }

    /**
     * Start the WebSocket server
     */
    start() {
        this.wss = new WSServer({ port: this.port });

        this.wss.on('connection', (ws) => {
            console.log(`\n🔌 WebSocket client connected (Total: ${this.wss.clients.size})`);
            this.clients.add(ws);

            // Send current status immediately on connection
            const status = this.lightManager.getStatus();
            ws.send(JSON.stringify(status));
            console.log(`📤 Sent initial status to new client`);

            // Handle incoming messages
            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    await this.handleCommand(message, ws);
                } catch (error) {
                    this.sendError(ws, error.message);
                }
            });

            ws.on('close', () => {
                console.log(`\n🔌 WebSocket client disconnected (Total: ${this.wss.clients.size - 1})`);
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error.message);
                this.clients.delete(ws);
            });
        });

        // Listen for status updates from LightManager
        this.lightManager.on('status', (status) => {
            this.broadcast(status);
        });

        console.log(`\n🚀 WebSocket server running on ws://localhost:${this.port}`);
    }

    /**
     * Handle incoming command
     */
    async handleCommand(message, ws) {
        console.log('\n📨 Received command:', JSON.stringify(message));

        const { action, mac, brightness, temperature } = message;

        switch (action) {
            case 'setCCT':
                if (brightness === undefined || temperature === undefined) {
                    throw new Error('setCCT requires brightness and temperature');
                }
                await this.lightManager.setCCT(mac || null, brightness, temperature);
                break;

            case 'getStatus':
                const status = this.lightManager.getStatus();
                ws.send(JSON.stringify(status));
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    /**
     * Broadcast message to all connected clients
     */
    broadcast(message) {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            if (client.readyState === 1) { // OPEN
                client.send(data);
            }
        }
    }

    /**
     * Send error to specific client
     */
    sendError(ws, errorMessage) {
        const error = {
            error: true,
            message: errorMessage,
            timestamp: new Date().toISOString()
        };
        ws.send(JSON.stringify(error));
    }

    /**
     * Stop the server
     */
    stop() {
        if (this.wss) {
            console.log('\n🛑 Stopping WebSocket server...');
            this.wss.close();
        }
    }
}