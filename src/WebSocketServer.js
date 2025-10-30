// WebSocket Server - API for controlling lights

import { WebSocketServer } from 'ws';

export class NeewerWebSocketServer {
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
        this.wss = new WebSocketServer({ port: this.port });

        console.log(`\n🌐 WebSocket server started on port ${this.port}`);

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
                    console.log(`📥 Received:`, message);

                    await this.handleCommand(message, ws);
                } catch (error) {
                    console.error('Error handling message:', error);
                    ws.send(JSON.stringify({
                        error: error.message
                    }));
                }
            });

            ws.on('close', () => {
                console.log(`\n🔌 WebSocket client disconnected (Remaining: ${this.wss.clients.size - 1})`);
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
        });

        // Listen for status updates from LightManager
        this.lightManager.on('status', (status) => {
            this.broadcast(status);
        });
    }

    /**
     * Handle incoming commands
     */
    async handleCommand(message, ws) {
        switch (message.action) {
            case 'setCCT':
                await this.lightManager.setCCT(
                    message.brightness,
                    message.temperature,
                    message.mac
                );
                break;

            case 'getStatus':
                const status = this.lightManager.getStatus();
                ws.send(JSON.stringify(status));
                break;

            default:
                ws.send(JSON.stringify({
                    error: 'Unknown action: ' + message.action
                }));
        }
    }

    /**
     * Broadcast message to all connected clients
     */
    broadcast(data) {
        const message = JSON.stringify(data);

        for (const client of this.clients) {
            if (client.readyState === client.OPEN) {
                client.send(message);
            }
        }
    }

    /**
     * Stop the WebSocket server
     */
    stop() {
        if (this.wss) {
            this.wss.close();
            console.log('WebSocket server stopped');
        }
    }
}