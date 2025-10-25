// Manual discovery approach - sometimes works better on Windows
import noble from '@stoprocent/noble';
import { NEEWER_NAME_PATTERNS, GATT_CHARACTERISTIC_UUID } from '../constants.js';

async function waitForBluetooth() {
    return new Promise((resolve) => {
        if (noble.state === 'poweredOn') {
            resolve();
        } else {
            noble.once('stateChange', (state) => {
                if (state === 'poweredOn') resolve();
            });
        }
    });
}

function isNeewerLight(peripheral) {
    const name = peripheral.advertisement.localName;
    if (!name) return false;
    const upperName = name.toUpperCase();
    return NEEWER_NAME_PATTERNS.some(pattern =>
        upperName.includes(pattern.toUpperCase())
    );
}

async function main() {
    console.log('Waiting for Bluetooth...');
    await waitForBluetooth();

    console.log('Scanning for Neewer lights...\n');

    let targetPeripheral = null;

    noble.on('discover', async (peripheral) => {
        if (!isNeewerLight(peripheral)) return;
        if (targetPeripheral) return; // Already found one

        targetPeripheral = peripheral;
        noble.stopScanning();

        console.log(`Found: ${peripheral.advertisement.localName}`);
        console.log(`Address: ${peripheral.address}`);
        console.log(`RSSI: ${peripheral.rssi} dBm\n`);

        try {
            console.log('Connecting...');
            await peripheral.connectAsync();
            console.log('✓ Connected!\n');

            console.log('Discovering services (method 1)...');
            const services = await peripheral.discoverServicesAsync([]);
            console.log(`Found ${services.length} services:`);
            services.forEach(s => console.log(`  ${s.uuid}`));

            if (services.length === 0) {
                console.log('\nNo services found with method 1, trying alternative...');

                // Sometimes we need to discover services one by one
                console.log('Trying to discover specific service...');
                const specificServices = await peripheral.discoverServicesAsync(['69400001b5a3f393e0a9e50e24dcca99']);
                console.log(`Found ${specificServices.length} services with specific UUID`);
            }

            console.log('\nDiscovering characteristics...');
            for (const service of services) {
                console.log(`\nService ${service.uuid}:`);
                try {
                    const characteristics = await service.discoverCharacteristicsAsync([]);
                    console.log(`  Found ${characteristics.length} characteristics:`);

                    characteristics.forEach(char => {
                        console.log(`    - ${char.uuid}`);
                        console.log(`      Properties: ${char.properties.join(', ')}`);

                        // Check if this is the one we want
                        if (char.uuid === GATT_CHARACTERISTIC_UUID) {
                            console.log(`      ★ This is the Neewer control characteristic!`);
                        }
                    });
                } catch (error) {
                    console.log(`  Error discovering characteristics: ${error.message}`);
                }
            }

            console.log('\n=== Connection successful! ===');
            console.log('Press Ctrl+C to disconnect and exit.');

            process.on('SIGINT', async () => {
                console.log('\n\nDisconnecting...');
                await peripheral.disconnectAsync();
                process.exit(0);
            });

        } catch (error) {
            console.error('\nError:', error.message);
            console.error('Stack:', error.stack);
            process.exit(1);
        }
    });

    noble.startScanning([], false);

    // Timeout after 15 seconds
    setTimeout(() => {
        if (!targetPeripheral) {
            console.log('No Neewer lights found after 15 seconds.');
            process.exit(0);
        }
    }, 15000);
}

main();