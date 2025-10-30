// Main Application Entry Point

import { LightManager } from './LightManager.js';
import { WebSocketServer } from './WebSocketServer.js';

const WEBSOCKET_PORT = 8080;

async function main() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Neewer Light Controller Starting    ║');
    console.log('╚════════════════════════════════════════╝\n');

    // Create light manager
    const lightManager = new LightManager();

    // Create WebSocket server
    const wsServer = new WebSocketServer(lightManager, WEBSOCKET_PORT);

    try {
        // Start WebSocket server first (don't wait for lights)
        wsServer.start();

        // Initialize and connect to all lights (in background)
        lightManager.initialize().catch(err => {
            console.error('Warning: Light initialization had errors:', err.message);
        });

        console.log('\n╔════════════════════════════════════════╗');
        console.log('║        System Ready!                   ║');
        console.log('╚════════════════════════════════════════╝');
        console.log(`\nWebSocket: ws://localhost:${WEBSOCKET_PORT}`);
        console.log('\nExample commands:');
        console.log('  Set all lights to 50% @ 5600K:');
        console.log('    {"action":"setCCT","brightness":50,"temperature":5600}');
        console.log('  Set specific light:');
        console.log('    {"action":"setCCT","mac":"fc:e6:97:7d:d7:18","brightness":75,"temperature":3200}');
        console.log('  Get status:');
        console.log('    {"action":"getStatus"}');
        console.log('\nPress Ctrl+C to exit\n');

    } catch (error) {
        console.error('\n❌ Initialization failed:', error.message);
        process.exit(1);
    }

    // Handle shutdown
    const shutdown = async () => {
        console.log('\n\n🛑 Shutting down...');
        wsServer.stop();
        await lightManager.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();