// Light Manager - Manages all lights with auto-reconnect

import { EventEmitter } from 'events';
import { LightScanner } from './LightScanner.js';
import { NeewerLight } from './NeewerLight.js';
import { CommandBuilder } from './CommandBuilder.js';
import { LIGHTS } from './lightConfig.js';

export class LightManager extends EventEmitter {
    constructor() {
        super();
        this.lights = new Map(); // mac -> NeewerLight
        this.scanner = new LightScanner();
        this.reconnectInterval = 2000; // Try to reconnect every 2 seconds
        this.reconnectTimers = new Map();
        this.pollInterval = 5000; // Poll lights every 5 seconds
        this.pollTimer = null;
    }

    /**
     * Initialize - scan and connect to all configured lights
     */
    async initialize() {
        console.log('Initializing Light Manager...');
        console.log(`Looking for ${LIGHTS.length} configured lights...\n`);

        // Scan for lights - stop as soon as we find all 4, max 5 seconds
        const discoveredLights = await this.scanner.scan(5000, false, LIGHTS.length);

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
                    console.log(`${light.name} disconnected!`);
                    light.connected = false;
                    // Reset state to unknown when disconnected
                    light.state.brightness = 0;
                    light.state.cct = 5600;
                    this.emitStatus();
                    this.scheduleReconnect(config.mac.toLowerCase());
                });

                // Listen for state changes from the light
                light.on('stateChanged', (state) => {
                    console.log(`📢 ${light.name} changed via physical controls`);
                    this.emitStatus();
                });

                // Listen for disconnection detected during polling
                light.on('disconnected', () => {
                    console.log(`${light.name} connection lost during operation`);
                    light.connected = false;
                    this.emitStatus();
                    this.scheduleReconnect(config.mac.toLowerCase());
                });

                // Try to connect (don't await, do in parallel)
                connectionPromises.push(
                    this.connectLight(config.mac.toLowerCase()).catch(err => {
                        console.error(`${light.name} initial connect failed:`, err.message);
                    })
                );
            } else {
                console.log(`⚠ ${config.name} (${config.mac}) not found`);
            }
        }

        // Wait for all connection attempts to complete (or fail)
        await Promise.allSettled(connectionPromises);

        console.log('\n=== Initialization Complete ===');
        this.emitStatus();

        // Start polling lights
        this.startPolling();
    }

    /**
     * Start polling all lights for status
     */
    startPolling() {
        console.log(`\n🔄 Starting status polling every ${this.pollInterval/1000} seconds`);

        this.pollTimer = setInterval(async () => {
            for (const [mac, light] of this.lights) {
                if (light.connected) {
                    try {
                        await light.readStatus();
                    } catch (error) {
                        console.error(`Failed to read status from ${light.name}:`, error.message);
                    }
                }
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
        if (light.peripheral.state === 'connected') {
            console.log(`${light.name} peripheral already connected, cleaning up...`);
            try {
                await light.peripheral.disconnectAsync();
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                // Ignore
            }
        }

        try {
            // Add overall timeout for connection attempt
            const connectPromise = light.connect();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection attempt timeout')), 20000)
            );

            await Promise.race([connectPromise, timeoutPromise]);

            this.emitStatus();

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
                await light.peripheral.disconnectAsync();
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
        if (this.reconnectTimers.has(mac)) return; // Already scheduled

        const light = this.lights.get(mac);
        console.log(`⏰ Will retry ${light?.name || mac} in ${this.reconnectInterval/1000} seconds`);

        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(mac); // Remove timer reference
            const light = this.lights.get(mac);
            if (light && !light.connected) {
                console.log(`\n🔄 Attempting to reconnect to ${light.name}...`);
                await this.connectLight(mac);
            }
        }, this.reconnectInterval);

        this.reconnectTimers.set(mac, timer);
    }

    /**
     * Set CCT for one or all lights
     * @param {string|null} mac - Specific light MAC or null for all
     * @param {number} brightness - 0-100
     * @param {number} temperature - 3200-8500K
     */
    async setCCT(mac, brightness, temperature) {
        const command = CommandBuilder.setCCT(brightness, temperature);

        if (mac === null || mac === 'all') {
            // Send to all connected lights
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
            // Send to specific light
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
            lights: []
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

        return status;
    }

    /**
     * Emit status update
     */
    emitStatus() {
        const status = this.getStatus();
        this.emit('status', status);

        // Compact one-line summary
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