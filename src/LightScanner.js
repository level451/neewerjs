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
        const name = peripheral.advertisement?.localName;
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
                if (state === 'poweredOn') resolve();
                else reject(new Error(`Bluetooth adapter is ${state}`));
            });
        });
    }

    /**
     * Scan for Neewer lights with early-stop when all targetMacs are seen.
     * @param {number} duration - Scan duration in ms
     * @param {boolean} allowDuplicates - Whether to report same device multiple times
     * @param {string[]} targetMacs - Optional list of lowercased MACs to stop early when found
     * @returns {Promise<NeewerLight[]>}
     */
    async scan(duration = SCAN_TIMEOUT, allowDuplicates = true, targetMacs = null) {
        console.log('Waiting for Bluetooth adapter...');
        await this.waitForAdapter();

        return new Promise((resolve, reject) => {
            this.discoveredLights.clear();
            this.isScanning = true;

            const wantEarlyStop = Array.isArray(targetMacs) && targetMacs.length > 0;
            const targets = wantEarlyStop ? new Set(targetMacs.map(s => s.toLowerCase())) : null;

            console.log(`Scanning for Neewer lights for ${duration / 1000} seconds...`);

            const maybeFinish = () => {
                if (!wantEarlyStop) return false;
                // Have we seen all target MACs?
                for (const mac of targets) {
                    // noble peripheral.address is lowercase MAC when available
                    const hit = Array.from(this.discoveredLights.values())
                        .some(l => (l.address || '').toLowerCase() === mac);
                    if (!hit) return false;
                }
                return true;
            };

            const stopAndResolve = () => {
                try { noble.removeListener('discover', onDiscover); } catch {}
                try { noble.stopScanning(); } catch {}
                this.isScanning = false;
                const lights = Array.from(this.discoveredLights.values());
                console.log(`\nScan complete. Found ${lights.length} Neewer light(s).`);
                resolve(lights);
            };

            const onDiscover = (peripheral) => {
                // RSSI filter
                if (typeof peripheral.rssi === 'number' && peripheral.rssi < RSSI_THRESHOLD) return;

                // Match by name
                if (!this.isNeewerLight(peripheral)) return;

                // Track
                if (!allowDuplicates && this.discoveredLights.has(peripheral.id)) return;

                const light = new NeewerLight(peripheral);
                this.discoveredLights.set(peripheral.id, light);
                console.log(`Found: ${light.toString()}`);

                // Early stop if all targets are found
                if (maybeFinish()) {
                    stopAndResolve();
                }
            };

            noble.on('discover', onDiscover);

            // Start scanning — allowDuplicates true tends to surface devices faster
            noble.startScanning([], allowDuplicates);

            // Time-based stop as a fallback
            this.scanTimeout = setTimeout(() => {
                stopAndResolve();
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
     * Convenience: scan and connect to the first found light
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
     * Convenience: scan and connect to all found lights
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
