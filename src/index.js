// Main Application Entry Point

import { LightManager } from './LightManager.js';
import { NeewerWebSocketServer } from './WebSocketServer.js';

const manager = new LightManager();
const wsServer = new NeewerWebSocketServer(manager, 8080);

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    wsServer.stop();
    await manager.disconnectAll();
    process.exit(0);
});

// Start everything
(async () => {
    try {
        await manager.initialize();
        wsServer.start();

        console.log('\n✅ System ready!');
        console.log('   - Lights initialized and polling');
        console.log('   - WebSocket server running on ws://localhost:8080');
        console.log('   - Open test-client.html in your browser to control lights');
        console.log('\nPress Ctrl+C to exit\n');

    } catch (error) {
        console.error('Failed to initialize:', error);
        process.exit(1);
    }
})();