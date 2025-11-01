// Light Manager - Manages all lights with auto-reconnect

import { EventEmitter } from 'events';
import { LightScanner } from './LightScanner.js';
import { NeewerLight } from './NeewerLight.js';
import { CommandBuilder } from './CommandBuilder.js';
import { LIGHTS } from './lightConfig.js';

// Tunables
const INITIAL_SCAN_MS = 5000;   // first scan on startup (was 10000)
const RECONNECT_SCAN_MS = 4000; // rescans for missing lights
const HOURLY_SWEEP_MS = 60 * 60 * 1000;

export class LightManager extends EventEmitter {
    constructor() {
        super();
        this.lights = new Map(); // mac -> NeewerLight
        this.scanner = new LightScanner();
        this.reconnectInterval = 10000; // Try to reconnect every 10 seconds
        this.reconnectTimers = new Map();
        this.pollInterval = 5000; // Poll lights every 5 seconds
        this.pollTimer = null;

        // NEW: we only ever want ONE BLE scan at a time
        this.activeScanPromise = null;
    }

    /**
     * Run a single scan that everyone can reuse.
     */
    async getSharedScan(durationMs) {
        if (this.activeScanPromise) {
            // someone is already scanning, just reuse their result
            return this.activeScanPromise;
        }
        this.activeScanPromise = this.scanner.scan(durationMs, false);
        try {
            const result = await this.activeScanPromise;
            return result;
        } finally {
            this.activeScanPromise = null;
        }
    }

    /**
     * Initialize - scan and connect to all configured lights
     */
    async initialize() {
        console.log('Initializing Light Manager...');
        console.log(`Looking for ${LIGHTS.length} configured lights...\n`);

        // Scan for lights BUT only 5 seconds now, and make it shared
        const discoveredLights = await this.getSharedScan(INITIAL_SCAN_MS); // shared scan

        // Find and connect to our configured lights
        const connectionPromises = [];

        for (const config of LIGHTS) {
            const discovered = discoveredLights.find(l =>
                l.address.toLowerCase() === config.mac.toLowerCase()
            );

            if (discovered) {
                const light = new NeewerLight(discovered.peripheral);
                light.name = config.name;
                this.lights.set(config.mac.toLowerCase(), light);

                // Set up disconnect handler (only once!)
                light.peripheral.removeAllListeners('disconnect');
                light.peripheral.once('disconnect', () => {
                    console.log(`\n❌ ${light.name} disconnected!`);
                    light.connected = false;
                    // Reset state to unknown when disconnected
                    light.state.brightness = 0;
                    light.state.cct = 5600;
                    this.emitStatus(); // Send status on disconnect

                    // Important: Schedule reconnect
                    console.log(`   Scheduling reconnect for ${light.name}...`);
                    this.scheduleReconnect(config.mac.toLowerCase());
                });

                // Listen for state changes from the light
                light.on('stateChanged', () => {
                    console.log(`📢 ${light.name} changed via physical controls`);
                    this.emitStatus();
                });

                // Listen for disconnection detected during polling
                light.on('disconnected', () => {
                    console.log(`${light.name} connection lost during operation`);
                    light.connected = false;
                    this.emitStatus(); // Send status on disconnect
                    this.scheduleReconnect(config.mac.toLowerCase());
                });

                // Try to connect (don't await, do in parallel)
                connectionPromises.push(
                    this.connectLight(config.mac.toLowerCase()).catch(err => {
                        console.error(`${light.name} initial connect failed:`, err.message);
                        // Schedule reconnect even if initial connection fails
                        this.scheduleReconnect(config.mac.toLowerCase());
                    })
                );
            } else {
                console.log(`⚠ ${config.name} (${config.mac}) not found - will keep trying to connect`);

                // Placeholder
                const placeholderLight = {
                    name: config.name,
                    mac: config.mac.toLowerCase(),
                    connected: false,
                    state: {
                        brightness: 0,
                        cct: 5600
                    }
                };

                this.lights.set(config.mac.toLowerCase(), {
                    name: config.name,
                    peripheral: null,
                    connected: false,
                    rssi: 0,
                    state: {
                        brightness: 0,
                        cct: 5600
                    },
                    toJSON: () => placeholderLight
                });

                // Schedule reconnect attempts for missing lights
                this.scheduleReconnect(config.mac.toLowerCase());
            }
        }

        // Wait for all connection attempts to complete (or fail)
        await Promise.allSettled(connectionPromises);

        console.log('\n=== Initialization Complete ===');
        this.emitStatus();

        // Start polling lights
        this.startPolling();

        // Hourly sweep for anything still down
        setInterval(() => {
            for (const [mac, l] of this.lights) {
                if (!l.connected && !l.isBusy) {
                    this.scheduleReconnect(mac);
                }
            }
        }, HOURLY_SWEEP_MS);
    }

    /**
     * Start polling all lights for status
     */
    startPolling() {
        console.log(`\n🔄 Starting status polling every ${this.pollInterval/1000} seconds`);

        let pollCount = 0;
        this.pollTimer = setInterval(async () => {
            pollCount++;
            const results = [];

            for (const [mac, light] of this.lights) {
                // Skip if not connected OR the device is busy connecting/setting up
                if (!light.connected || light.isBusy) {
                    continue;
                }

                if (light.peripheral && light.readStatus) {
                    try {
                        await light.readStatus();
                        if (light.connected) {
                            results.push(`${light.name}:✓`);
                        }
                    } catch (error) {
                        results.push(`${light.name}:✗`);
                    }
                }
            }

            if (results.length > 0) {
                console.log(`💓 Poll #${pollCount}: ${results.join(' | ')}`);
            }
        }, this.pollInterval);
    }

    /**
     * Stop polling
     */
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * Connect to a specific light
     */
    async connectLight(mac) {
        const light = this.lights.get(mac.toLowerCase());
        if (!light) return false;

        // Don't try to connect if already connected
        if (light.connected) {
            console.log(`${light.name} is already connected, skipping`);
            return true;
        }

        // Don't try to connect if peripheral says it's connected
        if (light.peripheral && light.peripheral.state === 'connected') {
            console.log(`${light.name} peripheral already connected, cleaning up...`);
            try {
                await light.peripheral.disconnectAsync();
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                // Ignore
            }
        }

        try {
            // Add overall timeout for connection attempt (25 seconds)
            const connectPromise = light.connect();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection attempt timeout')), 25000)
            );

            await Promise.race([connectPromise, timeoutPromise]);

            console.log(`✓ ${light.name} connected successfully`);
            this.emitStatus(); // Send status on successful connect

            // Cancel any reconnect timer
            if (this.reconnectTimers.has(mac)) {
                clearTimeout(this.reconnectTimers.get(mac));
                this.reconnectTimers.delete(mac);
            }

            return true;
        } catch (error) {
            console.error(`Failed to connect to ${light.name}:`, error.message);
            light.connected = false;

            // Force disconnect to clean up
            try {
                if (light.peripheral) {
                    await light.peripheral.disconnectAsync();
                }
            } catch (e) {
                // Ignore
            }

            this.emitStatus();
            this.scheduleReconnect(mac);
            return false;
        }
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect(mac) {
        // Always de-dup: clear any existing timer before scheduling a new one
        const existing = this.reconnectTimers.get(mac);
        if (existing) {
            clearTimeout(existing);
            this.reconnectTimers.delete(mac);
        }

        const light = this.lights.get(mac);
        console.log(`⏰ Will retry ${light?.name || mac} in ${this.reconnectInterval/1000} seconds`);

        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(mac);
            const l = this.lights.get(mac);
            if (!l) {
                console.log(`   ${mac} missing, skipping`);
                return;
            }
            if (l.connected) {
                console.log(`   ${l.name} already connected, skipping`);
                return;
            }
            if (l.isBusy) {
                console.log(`   ${l.name} busy, rescheduling`);
                this.scheduleReconnect(mac);
                return;
            }

            console.log(`\n🔄 Reconnecting to ${l.name}...`);

            // If we don't have a peripheral, run a SHARED rescan
            if (!l.peripheral || !l.peripheral.address) {
                console.log(`  Rescanning for ${l.name} (shared)...`);
                try {
                    const discovered = await this.getSharedScan(RECONNECT_SCAN_MS);
                    const found = discovered.find(d =>
                        d.address.toLowerCase() === mac.toLowerCase()
                    );
                    if (found) {
                        // Replace placeholder with real NeewerLight
                        const realLight = new NeewerLight(found.peripheral);
                        realLight.name = l.name;
                        this.lights.set(mac, realLight);

                        // Set up handlers
                        realLight.peripheral.removeAllListeners('disconnect');
                        realLight.peripheral.once('disconnect', () => {
                            console.log(`${realLight.name} disconnected!`);
                            realLight.connected = false;
                            realLight.state.brightness = 0;
                            realLight.state.cct = 5600;
                            this.emitStatus();
                            this.scheduleReconnect(mac);
                        });

                        realLight.on('stateChanged', () => {
                            this.emitStatus();
                        });

                        realLight.on('disconnected', () => {
                            realLight.connected = false;
                            this.emitStatus();
                            this.scheduleReconnect(mac);
                        });

                        console.log(`  Found ${realLight.name}, connecting...`);
                    } else {
                        console.log(`  ${l.name} not found in shared scan`);
                        this.scheduleReconnect(mac); // Try again later
                        return;
                    }
                } catch (err) {
                    console.log(`  Shared scan failed: ${err.message}`);
                    this.scheduleReconnect(mac); // Try again
                    return;
                }
            }

            await this.connectLight(mac);
        }, this.reconnectInterval);

        this.reconnectTimers.set(mac, timer);
    }

    /**
     * Set CCT for one or all lights
     */
    async setCCT(mac, brightness, temperature) {
        const command = CommandBuilder.setCCT(brightness, temperature);

        if (mac === null || mac === 'all') {
            const results = [];
            for (const [lightMac, light] of this.lights) {
                if (light.connected) {
                    try {
                        await light.sendCommand(command);
                        light.state.brightness = brightness;
                        light.state.cct = temperature;
                        results.push({ mac: lightMac, success: true });
                    } catch (error) {
                        results.push({ mac: lightMac, success: false, error: error.message });
                    }
                } else {
                    results.push({ mac: lightMac, success: false, error: 'Not connected' });
                }
            }
            this.emitStatus();
            return results;
        } else {
            const light = this.lights.get(mac.toLowerCase());
            if (!light) {
                throw new Error(`Light ${mac} not found`);
            }
            if (!light.connected) {
                throw new Error(`Light ${light.name} is not connected`);
            }

            await light.sendCommand(command);
            light.state.brightness = brightness;
            light.state.cct = temperature;
            this.emitStatus();
            return { mac, success: true };
        }
    }

    /**
     * Get status of all lights
     */
    getStatus() {
        const status = {
            timestamp: new Date().toISOString(),
            lights: [],
            light_1: false,
            light_2: false,
            light_3: false,
            light_4: false
        };

        for (const config of LIGHTS) {
            const light = this.lights.get(config.mac.toLowerCase());

            if (light) {
                status.lights.push({
                    name: light.name,
                    mac: config.mac,
                    connected: light.connected,
                    brightness: light.state.brightness,
                    temperature: light.state.cct,
                    rssi: light.rssi
                });
            } else {
                status.lights.push({
                    name: config.name,
                    mac: config.mac,
                    connected: false,
                    brightness: 0,
                    temperature: 0,
                    rssi: null
                });
            }
        }

        status.lights.forEach((light, index) => {
            status[`light_${index + 1}`] = light.connected;
        });

        return status;
    }

    /**
     * Emit status update
     */
    emitStatus() {
        const status = this.getStatus();
        this.emit('status', status);

        const summary = status.lights.map(l =>
            `${l.name}: ${l.connected ? '🟢' : '🔴'} ${l.brightness}%@${l.temperature}K`
        ).join(' | ');
        console.log(`📊 ${summary}`);
    }

    /**
     * Shutdown - disconnect all lights
     */
    async shutdown() {
        console.log('\nShutting down Light Manager...');

        // Stop polling
        this.stopPolling();

        // Clear all reconnect timers
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();

        // Disconnect all lights
        for (const light of this.lights.values()) {
            if (light.connected) {
                await light.disconnect();
            }
        }
    }
}
