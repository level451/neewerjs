// LightScanner - handles scanning for Neewer lights
import noble from '@stoprocent/noble';
import { NeewerLight } from './NeewerLight.js';
import { NEEWER_NAME_PATTERNS, SCAN_TIMEOUT, RSSI_THRESHOLD } from './constants.js';

export class LightScanner {
    constructor() {
        this.discoveredLights = new Map(); // Map of peripheral.id -> NeewerLight
        this.isScanning = false;
        this.scanTimeout = null;
    }

    /**
     * Check if a peripheral is a Neewer light based on its name
     */
    isNeewerLight(peripheral) {
        const name = peripheral.advertisement.localName;
        if (!name) return false;

        const upperName = name.toUpperCase();
        return NEEWER_NAME_PATTERNS.some(pattern =>
            upperName.includes(pattern.toUpperCase())
        );
    }

    /**
     * Wait for Bluetooth adapter to be ready
     */
    async waitForAdapter() {
        return new Promise((resolve, reject) => {
            if (noble.state === 'poweredOn') {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Bluetooth adapter did not power on in time'));
            }, 5000);

            noble.once('stateChange', (state) => {
                clearTimeout(timeout);
                if (state === 'poweredOn') {
                    resolve();
                } else {
                    reject(new Error(`Bluetooth adapter is ${state}`));
                }
            });
        });
    }

    /**
     * Scan for Neewer lights
     * @param {number} duration - Scan duration in milliseconds
     * @param {boolean} allowDuplicates - Whether to report same device multiple times
     * @returns {Promise<NeewerLight[]>} Array of discovered lights
     */
    async scan(duration = SCAN_TIMEOUT, allowDuplicates = false) {
        console.log('Waiting for Bluetooth adapter...');
        await this.waitForAdapter();

        return new Promise((resolve, reject) => {
            this.discoveredLights.clear();
            this.isScanning = true;

            console.log(`Scanning for Neewer lights for ${duration / 1000} seconds...`);

            const onDiscover = (peripheral) => {
                // Filter by RSSI
                if (peripheral.rssi < RSSI_THRESHOLD) {
                    return;
                }

                // Check if it's a Neewer light
                if (!this.isNeewerLight(peripheral)) {
                    return;
                }

                // Skip duplicates unless requested
                if (!allowDuplicates && this.discoveredLights.has(peripheral.id)) {
                    return;
                }

                const light = new NeewerLight(peripheral);
                this.discoveredLights.set(peripheral.id, light);

                console.log(`Found: ${light.toString()}`);
            };

            noble.on('discover', onDiscover);

            // Start scanning
            noble.startScanning([], allowDuplicates);

            // Stop scanning after timeout
            this.scanTimeout = setTimeout(() => {
                noble.stopScanning();
                noble.removeListener('discover', onDiscover);
                this.isScanning = false;

                const lights = Array.from(this.discoveredLights.values());
                console.log(`\nScan complete. Found ${lights.length} Neewer light(s).`);
                resolve(lights);
            }, duration);
        });
    }

    /**
     * Stop scanning immediately
     */
    stopScanning() {
        if (this.scanTimeout) {
            clearTimeout(this.scanTimeout);
            this.scanTimeout = null;
        }

        if (this.isScanning) {
            noble.stopScanning();
            this.isScanning = false;
            console.log('Scanning stopped.');
        }
    }

    /**
     * Scan and connect to the first found light
     * @param {number} duration - Scan duration in milliseconds
     * @returns {Promise<NeewerLight|null>} The connected light or null
     */
    async scanAndConnectFirst(duration = SCAN_TIMEOUT) {
        const lights = await this.scan(duration);

        if (lights.length === 0) {
            console.log('No Neewer lights found.');
            return null;
        }

        const light = lights[0];
        await light.connect();
        return light;
    }

    /**
     * Scan and connect to all found lights
     * @param {number} duration - Scan duration in milliseconds
     * @returns {Promise<NeewerLight[]>} Array of connected lights
     */
    async scanAndConnectAll(duration = SCAN_TIMEOUT) {
        const lights = await this.scan(duration);

        if (lights.length === 0) {
            console.log('No Neewer lights found.');
            return [];
        }

        console.log(`\nConnecting to ${lights.length} light(s)...`);

        const connectionPromises = lights.map(light =>
            light.connect().catch(err => {
                console.error(`Failed to connect to ${light.name}: ${err.message}`);
                return null;
            })
        );

        await Promise.all(connectionPromises);

        const connectedLights = lights.filter(light => light.connected);
        console.log(`Successfully connected to ${connectedLights.length} light(s).`);

        return connectedLights;
    }
}