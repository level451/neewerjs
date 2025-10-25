// Debug script - scan and attempt to connect with verbose output
import { LightScanner } from '../LightScanner.js';

async function main() {
    const scanner = new LightScanner();

    try {
        console.log('=== STEP 1: Scanning for lights ===\n');
        const lights = await scanner.scan(10000);

        if (lights.length === 0) {
            console.log('\nNo Neewer lights found.');
            process.exit(0);
        }

        console.log(`\nFound ${lights.length} light(s):`);
        lights.forEach((light, index) => {
            console.log(`  ${index + 1}. ${light.name} (${light.address}) - ${light.rssi} dBm`);
        });

        // Try to connect to the first light
        const light = lights[0];
        console.log(`\n=== STEP 2: Connecting to ${light.name} ===\n`);

        try {
            await light.connect();

            console.log('\n=== SUCCESS ===');
            console.log('Connection established successfully!');
            console.log(`Light: ${light.name}`);
            console.log(`Characteristic: ${light.characteristic.uuid}`);

            // Keep connection alive for testing
            console.log('\nConnection is active. Press Ctrl+C to exit.');

            // Disconnect on exit
            process.on('SIGINT', async () => {
                console.log('\n\nDisconnecting...');
                await light.disconnect();
                process.exit(0);
            });

        } catch (error) {
            console.error('\n=== CONNECTION FAILED ===');
            console.error('Error:', error.message);
            console.error('\nTroubleshooting tips:');
            console.error('  1. Close the official Neewer app if it\'s running');
            console.error('  2. Turn the light off and on again');
            console.error('  3. Make sure Bluetooth is enabled in Windows Settings');
            console.error('  4. Try running as Administrator');
            console.error('  5. Check if the light is paired in Windows - if so, unpair it');
            process.exit(1);
        }

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

main();