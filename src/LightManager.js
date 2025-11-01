// Light Manager - Manages all lights with auto-reconnect

import { EventEmitter } from 'events';
import { LightScanner } from './LightScanner.js';
import { NeewerLight } from './NeewerLight.js';
import { CommandBuilder } from './CommandBuilder.js';
import { LIGHTS } from './lightConfig.js';

// Tunables
const INITIAL_SCAN_MS = 3000;      // initial shared scan (fast, early-stop via target MACs)
const RECONNECT_SCAN_MS = 4000;    // shared rescans for missing lights
const HOURLY_SWEEP_MS = 60 * 60 * 1000;
const CONNECT_CONCURRENCY = 2;     // limit concurrent connect/discover
const CONNECT_STAGGER_MS = 150;    // slight jitter to avoid adapter spikes

export class LightManager extends EventEmitter {
    constructor() {
        super();
        this.lights = new Map(); // mac -> NeewerLight
        this.scanner = new LightScanner();
        this.reconnectInterval = 10000;
        this.reconnectTimers = new Map();
        this.pollInterval = 5000;
        this.pollTimer = null;

        // Only one scan at a time for everyone
        this.activeScanPromise = null;

        // Simple semaphore for connecting
        this.activeConnects = 0;
        this.connectQueue = [];

        // NEW: pause the polling loop while scans/connects are in flight
        this.pollPaused = false;

        // Optional: track adaptive reconnect attempts (can be used later)
        this.reconnectAttempts = new Map(); // mac -> count
    }

    /**
     * Run a single shared scan; pass target MACs for early-stop.
     * Polling is paused while scanning.
     */
    async getSharedScan(durationMs, targetMacs = null) {
        if (this.activeScanPromise) return this.activeScanPromise;

        // Pause poll while the adapter is scanning
        this.pollPaused = true;
        this.activeScanPromise = this.scanner.scan(durationMs, true, targetMacs);

        try {
            return await this.activeScanPromise;
        } finally {
            this.activeScanPromise = null;
            // Resume polling only if no connects are in flight
            if (this.activeConnects === 0) this.pollPaused = false;
        }
    }

    /**
     * Acquire a connection slot (limits concurrent connects).
     * Polling is paused while we have active connects.
     */
    async acquireConnectSlot() {
        if (this.activeConnects < CONNECT_CONCURRENCY) {
            this.activeConnects++;
            this.pollPaused = true; // pause while any connects in flight
            return;
        }
        await new Promise(res => this.connectQueue.push(res));
        this.activeConnects++;
        this.pollPaused = true;
    }

    /**
     * Release a connection slot.
     * Resume polling if no connects or scans are active.
     */
    releaseConnectSlot() {
        this.activeConnects = Math.max(0, this.activeConnects - 1);
        if (this.activeConnects === 0 && !this.activeScanPromise) {
            this.pollPaused = false; // safe to resume
        }
        const next = this.connectQueue.shift();
        if (next) next();
    }

    /**
     * Initialize - scan and connect to all configured lights
     */
    async initialize() {
        console.log('Initializing Light Manager...');
        console.log(`Looking for ${LIGHTS.length} configured lights...\n`);

        const targetMacs = LIGHTS.map(l => l.mac.toLowerCase());
        const discoveredLights = await this.getSharedScan(INITIAL_SCAN_MS, targetMacs);

        // Seed map and schedule connects
        const tasks = [];
        for (const config of LIGHTS) {
            const discovered = discoveredLights.find(l =>
                l.address.toLowerCase() === config.mac.toLowerCase()
            );

            if (discovered) {
                const light = new NeewerLight(discovered.peripheral);
                light.name = config.name;
                this.lights.set(config.mac.toLowerCase(), light);

                // Disconnect handler
                light.peripheral.removeAllListeners('disconnect');
                light.peripheral.once('disconnect', () => {
                    console.log(`\n❌ ${light.name} disconnected!`);
                    light.connected = false;
                    light.state.brightness = 0;
                    light.state.cct = 5600;
                    this.emitStatus();
                    console.log(`   Scheduling reconnect for ${light.name}...`);
                    this.scheduleReconnect(config.mac.toLowerCase());
                });

                // State change / soft disconnect
                light.on('stateChanged', () => this.emitStatus());
                light.on('disconnected', () => {
                    console.log(`${light.name} connection lost during operation`);
                    light.connected = false;
                    this.emitStatus();
                    this.scheduleReconnect(config.mac.toLowerCase());
                });

                // Queue connect with semaphore + stagger
                tasks.push((async () => {
                    await new Promise(res => setTimeout(res, CONNECT_STAGGER_MS));
                    await this.acquireConnectSlot();
                    try {
                        await this.connectLight(config.mac.toLowerCase());
                    } finally {
                        this.releaseConnectSlot();
                    }
                })());

            } else {
                console.log(`⚠ ${config.name} (${config.mac}) not found - will keep trying to connect`);
                const placeholderLight = {
                    name: config.name,
                    mac: config.mac.toLowerCase(),
                    connected: false,
                    state: { brightness: 0, cct: 5600 }
                };
                this.lights.set(config.mac.toLowerCase(), {
                    name: config.name,
                    peripheral: null,
                    connected: false,
                    rssi: 0,
                    state: { brightness: 0, cct: 5600 },
                    toJSON: () => placeholderLight
                });
                this.scheduleReconnect(config.mac.toLowerCase());
            }
        }

        await Promise.allSettled(tasks);

        console.log('\n=== Initialization Complete ===');
        this.emitStatus();
        this.startPolling();

        // Hourly sweep to re-attempt any that are still down
        setInterval(() => {
            for (const [mac, l] of this.lights) {
                if (!l.connected && !l.isBusy) this.scheduleReconnect(mac);
            }
        }, HOURLY_SWEEP_MS);
    }

    /**
     * Start polling all lights for status
     * (skips entire cycle when pollPaused is true)
     */
    startPolling() {
        console.log(`\n🔄 Starting status polling every ${this.pollInterval/1000} seconds`);

        let pollCount = 0;
        this.pollTimer = setInterval(async () => {
            if (this.pollPaused) return; // <<< global pause during scans/connects

            pollCount++;
            const results = [];

            for (const [mac, light] of this.lights) {
                // Skip if not connected OR the device is busy connecting/setting up
                if (!light.connected || light.isBusy) continue;

                if (light.peripheral && light.readStatus) {
                    try {
                        await light.readStatus(); // liveness probe (characteristic read)
                        if (light.connected) results.push(`${light.name}:✓`);
                    } catch (_) {
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

        if (light.connected) {
            console.log(`${light.name} is already connected, skipping`);
            return true;
        }

        if (light.peripheral && light.peripheral.state === 'connected') {
            console.log(`${light.name} peripheral already connected, cleaning up...`);
            try {
                await light.peripheral.disconnectAsync();
                await new Promise(res => setTimeout(res, 400));
            } catch (_) {}
        }

        try {
            const connectPromise = light.connect();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection attempt timeout')), 25000)
            );

            await Promise.race([connectPromise, timeoutPromise]);

            console.log(`✓ ${light.name} connected successfully`);
            this.emitStatus();

            // Cancel any reconnect timer
            const t = this.reconnectTimers.get(mac);
            if (t) { clearTimeout(t); this.reconnectTimers.delete(mac); }

            // Reset adaptive attempt counter on success
            this.reconnectAttempts.set(mac, 0);

            return true;
        } catch (error) {
            console.error(`Failed to connect to ${light.name}: ${error.message}`);
            light.connected = false;

            // Force disconnect to clean up
            try { if (light.peripheral) await light.peripheral.disconnectAsync(); } catch (_) {}

            this.emitStatus();
            this.scheduleReconnect(mac);
            return false;
        }
    }

    /**
     * Schedule reconnection attempt (deduped)
     */
    scheduleReconnect(mac) {
        const existing = this.reconnectTimers.get(mac);
        if (existing) { clearTimeout(existing); this.reconnectTimers.delete(mac); }

        const light = this.lights.get(mac);
        console.log(`⏰ Will retry ${light?.name || mac} in ${this.reconnectInterval/1000} seconds`);

        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(mac);
            const l = this.lights.get(mac);
            if (!l) return;
            if (l.connected) return;
            if (l.isBusy) { this.scheduleReconnect(mac); return; }

            console.log(`\n🔄 Reconnecting to ${l.name}...`);

            if (!l.peripheral || !l.peripheral.address) {
                console.log(`  Rescanning for ${l.name} (shared)...`);
                try {
                    const foundList = await this.getSharedScan(RECONNECT_SCAN_MS, [mac.toLowerCase()]);
                    const found = foundList.find(d => d.address.toLowerCase() === mac.toLowerCase());
                    if (found) {
                        const realLight = new NeewerLight(found.peripheral);
                        realLight.name = l.name;
                        this.lights.set(mac, realLight);

                        realLight.peripheral.removeAllListeners('disconnect');
                        realLight.peripheral.once('disconnect', () => {
                            console.log(`${realLight.name} disconnected!`);
                            realLight.connected = false;
                            realLight.state.brightness = 0;
                            realLight.state.cct = 5600;
                            this.emitStatus();
                            this.scheduleReconnect(mac);
                        });
                        realLight.on('stateChanged', () => this.emitStatus());
                        realLight.on('disconnected', () => {
                            realLight.connected = false;
                            this.emitStatus();
                            this.scheduleReconnect(mac);
                        });

                        console.log(`  Found ${realLight.name}, connecting...`);
                        await this.acquireConnectSlot();
                        try { await this.connectLight(mac); }
                        finally { this.releaseConnectSlot(); }
                        return;
                    } else {
                        console.log(`  ${l.name} not found in shared scan`);
                        this.scheduleReconnect(mac);
                        return;
                    }
                } catch (err) {
                    console.log(`  Shared scan failed: ${err.message}`);
                    this.scheduleReconnect(mac);
                    return;
                }
            }

            await this.acquireConnectSlot();
            try { await this.connectLight(mac); }
            finally { this.releaseConnectSlot(); }
        }, this.reconnectInterval);

        this.reconnectTimers.set(mac, timer);
    }

    /**
     * Set CCT for one or all lights
     * @param {string|null} mac - Specific light MAC or null/'all'
     * @param {number} brightness - 0-100
     * @param {number} temperature - Kelvin
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
            if (!light) throw new Error(`Light ${mac} not found`);
            if (!light.connected) throw new Error(`Light ${light.name} is not connected`);

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

        // Set the light_N boolean flags
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
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();

        // Disconnect all lights
        for (const light of this.lights.values()) {
            if (light.connected) {
                await light.disconnect();
            }
        }
    }
}
