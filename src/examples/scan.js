// Example: Scan for Neewer lights
import { LightScanner } from '../LightScanner.js';

async function main() {
    const scanner = new LightScanner();

    try {
        // Scan for 10 seconds
        const lights = await scanner.scan(10000);

        await lights[0].connect(); // This might work or might fail

        if (lights.length === 0) {
            console.log('\nNo Neewer lights found. Make sure your lights are powered on and in range.');
            process.exit(0);
        }

        console.log('\n=== Discovered Lights ===');
        lights.forEach((light, index) => {
            console.log(`\n${index + 1}. ${light.name}`);
            console.log(`   Address: ${light.address}`);
            console.log(`   ID: ${light.id}`);
            console.log(`   Signal: ${light.rssi} dBm`);
        });

        console.log('\n=== JSON Output ===');
        console.log(JSON.stringify(lights.map(l => l.toJSON()), null, 2));

    } catch (error) {
        console.error('Error during scan:', error.message);
        process.exit(1);
    }

    process.exit(0);
}

main();