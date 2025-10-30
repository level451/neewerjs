// Light Scanner - Discovers Neewer lights via Bluetooth

import noble from '@abandonware/noble';
import { NEEWER_NAME_PREFIXES } from './constants.js';

export class LightScanner {
    constructor() {
        this.scanning = false;
        this.discovered = [];
    }

    /**
     * Scan for Neewer lights
     * @param {number} duration - Scan duration in milliseconds
     * @returns {Promise<Array>} Array of discovered lights
     */
    async scan(duration = 10000) {
        return new Promise((resolve, reject) => {
            this.discovered = [];

            // Wait for adapter to be ready
            const startScan = () => {
                console.log(`Scanning for Neewer lights for ${duration/1000} seconds...`);

                noble.on('discover', (peripheral) => {
                    const name = peripheral.advertisement.localName;

                    if (name && this.isNeewerDevice(name)) {
                        // Check if we already found this device
                        if (!this.discovered.find(d => d.address === peripheral.address)) {
                            console.log(`Found: ${name} (${peripheral.address}) - RSSI: ${peripheral.rssi} dBm - ${peripheral.state}`);
                            this.discovered.push({
                                name,
                                address: peripheral.address,
                                rssi: peripheral.rssi,
                                peripheral
                            });
                        }
                    }
                });

                noble.startScanningAsync([], false).then(() => {
                    this.scanning = true;

                    // Stop after duration
                    setTimeout(async () => {
                        await noble.stopScanningAsync();
                        this.scanning = false;
                        console.log(`\nScan complete. Found ${this.discovered.length} Neewer light(s).`);
                        resolve(this.discovered);
                    }, duration);
                }).catch(reject);
            };

            // Wait for Bluetooth adapter
            if (noble.state === 'poweredOn') {
                startScan();
            } else {
                console.log('Waiting for Bluetooth adapter...');
                noble.once('stateChange', (state) => {
                    if (state === 'poweredOn') {
                        startScan();
                    } else {
                        reject(new Error(`Bluetooth adapter not ready: ${state}`));
                    }
                });
            }
        });
    }

    /**
     * Check if device name matches Neewer patterns
     */
    isNeewerDevice(name) {
        return NEEWER_NAME_PREFIXES.some(prefix =>
            name.toUpperCase().startsWith(prefix.toUpperCase())
        );
    }

    /**
     * Stop scanning
     */
    async stopScanning() {
        if (this.scanning) {
            await noble.stopScanningAsync();
            this.scanning = false;
        }
    }
}