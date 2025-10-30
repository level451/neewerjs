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
        this.reconnectInterval = 10000; // Try to reconnect every 10 seconds
        this.reconnectTimers = new Map();
        this.pollInterval = 5000; // Poll every 5 seconds
        this.pollTimer = null;
        this.pollCounter = 0;
    }

    /**
     * Initialize - scan and connect to all configured lights
     */
    async initialize() {
        console.log('Initializing Light Manager...');
        console.log(`Looking for ${LIGHTS.length} configured lights...\n`);

        // Scan for lights
        const discoveredLights = await this.scanner.scan(10000);

        // Find and connect to our configured lights
        for (const config of LIGHTS) {
            const discovered = discoveredLights.find(l =>
                l.address.toLowerCase() === config.mac.toLowerCase()
            );

            if (discovered) {
                const light = new NeewerLight(discovered.peripheral);
                light.name = config.name;
                this.lights.set(config.mac.toLowerCase(), light);

                // Set up event handlers BEFORE connecting
                this.setupLightEventHandlers(light, config.mac.toLowerCase());

                // Connect
                await this.connectLight(config.mac.toLowerCase());
            } else {
                console.log(`⚠ ${config.name} not found during scan`);
                // Create a placeholder and schedule reconnect
                this.lights.set(config.mac.toLowerCase(), {
                    name: config.name,
                    mac: config.mac,
                    connected: false,
                    peripheral: null,
                    state: { brightness: 0, cct: 5600 }
                });
                this.scheduleReconnect(config.mac.toLowerCase());
            }
        }

        console.log('\n=== Initialization Complete ===');
        this.emitStatus();

        // Start polling for connection health
        this.startPolling();
    }

    /**
     * Set up event handlers for a light
     */
    setupLightEventHandlers(light, mac) {
        // Handle peripheral disconnect
        light.peripheral.removeAllListeners('disconnect');
        light.peripheral.once('disconnect', () => {
            console.log(`\n❌ ${light.name} disconnected!`);
            light.connected = false;
            light.state.brightness = 0;
            light.state.cct = 5600;
            this.emitStatus();
            console.log(`   Scheduling reconnect for ${light.name}...`);
            this.scheduleReconnect(mac);
        });

        // Handle state changes (from physical controls)
        light.removeAllListeners('stateChanged');
        light.on('stateChanged', (state) => {
            console.log(`📢 ${light.name} changed via physical controls`);
            this.emitStatus();
        });

        // Handle disconnection detected during operations
        light.removeAllListeners('disconnected');
        light.on('disconnected', () => {
            console.log(`\n❌ ${light.name} connection lost during operation`);
            light.connected = false;
            light.state.brightness = 0;
            light.state.cct = 5600;
            this.emitStatus();
            console.log(`   Scheduling reconnect for ${light.name}...`);
            this.scheduleReconnect(mac);
        });
    }

    /**
     * Connect to a specific light
     */
    async connectLight(mac) {
        const light = this.lights.get(mac);
        if (!light) {
            console.log(`Light ${mac} not configured`);
            return false;
        }

        // If it's a placeholder (no peripheral), need to scan first
        if (!light.peripheral) {
            console.log(`  Rescanning for ${light.name}...`);
            try {
                const discoveredLights = await this.scanner.scan(10000);
                const found = discoveredLights.find(l =>
                    l.address.toLowerCase() === mac
                );

                if (found) {
                    // Replace placeholder with real light
                    const realLight = new NeewerLight(found.peripheral);
                    realLight.name = light.name;
                    this.lights.set(mac, realLight);

                    // Set up event handlers
                    this.setupLightEventHandlers(realLight, mac);

                    console.log(`  Found ${realLight.name}, connecting...`);
                } else {
                    console.log(`  ${light.name} not found in scan`);
                    return false;
                }
            } catch (err) {
                console.log(`  Scan failed: ${err.message}`);
                return false;
            }
        }

        // Now try to connect
        const realLight = this.lights.get(mac);
        if (!realLight.peripheral) {
            return false;
        }

        console.log(`Connecting to ${realLight.name}...`);

        const maxAttempts = 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await realLight.connect();
                console.log(`✓ ${realLight.name} ready`);
                console.log(`✓ ${realLight.name} connected successfully`);
                this.emitStatus();
                return true;
            } catch (error) {
                console.log(`Attempt ${attempt} failed: ${error.message}`);

                if (realLight.peripheral) {
                    try {
                        await realLight.peripheral.disconnectAsync();
                    } catch (e) {
                        // Ignore
                    }
                }

                if (attempt < maxAttempts) {
                    console.log(`Retry attempt ${attempt + 1}/${maxAttempts}...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        console.log(`Failed to connect to ${realLight.name}: Failed to connect after ${maxAttempts} attempts`);
        return false;
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect(mac) {
        if (this.reconnectTimers.has(mac)) {
            console.log(`   Reconnect already scheduled for ${mac}`);
            return; // Already scheduled
        }

        const light = this.lights.get(mac);
        console.log(`⏰ Will retry ${light?.name || mac} in ${this.reconnectInterval/1000} seconds`);

        const timer = setTimeout(async () => {
            console.log(`\n🔄 Reconnecting to ${light?.name || mac}...`);
            this.reconnectTimers.delete(mac); // Remove timer reference

            const success = await this.connectLight(mac);

            // If failed, schedule another attempt
            if (!success) {
                const currentLight = this.lights.get(mac);
                if (currentLight && !currentLight.connected) {
                    this.scheduleReconnect(mac);
                }
            }
        }, this.reconnectInterval);

        this.reconnectTimers.set(mac, timer);
    }

    /**
     * Start polling all connected lights for health
     */
    startPolling() {
        console.log(`\n🔄 Starting status polling every ${this.pollInterval/1000} seconds`);

        this.pollTimer = setInterval(async () => {
            this.pollCounter++;
            const connectedLights = [];

            for (const [mac, light] of this.lights) {
                if (light.connected && light.readStatus) {
                    await light.readStatus();
                    connectedLights.push(`${light.name}:✓`);
                }
            }

            if (connectedLights.length > 0) {
                console.log(`💓 Poll #${this.pollCounter}: ${connectedLights.join(' | ')}`);
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
     * Set CCT for one or all lights
     */
    async setCCT(brightness, temperature, mac = null) {
        const command = CommandBuilder.setCCT(brightness, temperature);

        if (mac) {
            // Set specific light
            const light = this.lights.get(mac.toLowerCase());
            if (light && light.connected) {
                await light.sendCommand(command);
                light.state.brightness = brightness;
                light.state.cct = temperature;
                this.emitStatus();
            }
        } else {
            // Set all lights
            for (const light of this.lights.values()) {
                if (light.connected && light.sendCommand) {
                    try {
                        await light.sendCommand(command);
                        light.state.brightness = brightness;
                        light.state.cct = temperature;
                    } catch (error) {
                        console.log(`Failed to set ${light.name}: ${error.message}`);
                    }
                }
            }
            this.emitStatus();
        }
    }

    /**
     * Get status of all lights
     */
    getStatus() {
        const lightsArray = [];
        for (const light of this.lights.values()) {
            if (light.getStatus) {
                lightsArray.push(light.getStatus());
            } else {
                // Placeholder light
                lightsArray.push({
                    name: light.name,
                    mac: light.mac,
                    connected: false,
                    brightness: 0,
                    temperature: 5600,
                    rssi: 0
                });
            }
        }

        return {
            timestamp: new Date().toISOString(),
            lights: lightsArray
        };
    }

    /**
     * Emit status to WebSocket clients
     */
    emitStatus() {
        const status = this.getStatus();
        this.emit('status', status);

        // Also print a quick status line
        const statusLine = status.lights.map(l =>
            `${l.name}: ${l.connected ? '🟢' : '🔴'} ${l.brightness}%@${l.temperature}K`
        ).join(' | ');
        console.log(`📊 ${statusLine}`);
    }

    /**
     * Disconnect all lights
     */
    async disconnectAll() {
        console.log('\nDisconnecting all lights...');
        this.stopPolling();

        // Clear all reconnect timers
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();

        // Disconnect all lights
        for (const light of this.lights.values()) {
            if (light.disconnect) {
                try {
                    await light.disconnect();
                } catch (error) {
                    // Ignore errors
                }
            }
        }
    }
}