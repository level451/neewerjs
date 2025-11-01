// Light Manager - Manages all lights with auto-reconnect

import { EventEmitter } from 'events';
import { LightScanner } from './LightScanner.js';
import { NeewerLight } from './NeewerLight.js';
import { CommandBuilder } from './CommandBuilder.js';
import { LIGHTS } from './lightConfig.js';

// Tunables
const INITIAL_SCAN_MS = 5000;      // initial scan
const RECONNECT_SCAN_MS = 4000;    // rescan for missing lights
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
    }

    /**
     * Run a single scan that everyone can reuse.
     */
    async getSharedScan(durationMs) {
        if (this.activeScanPromise) return this.activeScanPromise;
        this.activeScanPromise = this.scanner.scan(durationMs, false);
        try { return await this.activeScanPromise; }
        finally { this.activeScanPromise = null; }
    }

    /**
     * Acquire connect slot (semaphore)
     */
    async acquireConnectSlot() {
        if (this.activeConnects < CONNECT_CONCURRENCY) {
            this.activeConnects++;
            return;
        }
        await new Promise(res => this.connectQueue.push(res));
        this.activeConnects++;
    }

    /**
     * Release connect slot
     */
    releaseConnectSlot() {
        this.activeConnects = Math.max(0, this.activeConnects - 1);
        const next = this.connectQueue.shift();
        if (next) next();
    }

    /**
     * Initialize - scan and connect to all configured lights
     */
    async initialize() {
        console.log('Initializing Light Manager...');
        console.log(`Looking for ${LIGHTS.length} configured lights...\n`);

        const discoveredLights = await this.getSharedScan(INITIAL_SCAN_MS);

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

        // Await all queued connects (with concurrency limit)
        await Promise.allSettled(tasks);

        console.log('\n=== Initialization Complete ===');
        this.emitStatus();
        this.startPolling();

        // Hourly sweep
        setInterval(() => {
            for (const [mac, l] of this.lights) {
                if (!l.connected && !l.isBusy) this.scheduleReconnect(mac);
            }
        }, HOURLY_SWEEP_MS);
    }

    startPolling() {
        console.log(`\n🔄 Starting status polling every ${this.pollInterval/1000} seconds`);
        let pollCount = 0;
        this.pollTimer = setInterval(async () => {
            pollCount++;
            const results = [];
            for (const [mac, light] of this.lights) {
                if (!light.connected || light.isBusy) continue;
                if (light.peripheral && light.readStatus) {
                    try {
                        await light.readStatus();
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

    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

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

            const t = this.reconnectTimers.get(mac);
            if (t) { clearTimeout(t); this.reconnectTimers.delete(mac); }

            return true;
        } catch (error) {
            console.error(`Failed to connect to ${light.name}: ${error.message}`);
            light.connected = false;
            try { if (light.peripheral) await light.peripheral.disconnectAsync(); } catch (_) {}
            this.emitStatus();
            this.scheduleReconnect(mac);
            return false;
        }
    }

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
                    const discovered = await this.getSharedScan(RECONNECT_SCAN_MS);
                    const found = discovered.find(d => d.address.toLowerCase() === mac.toLowerCase());
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
                        // Use semaphore on reconnect too
                        await this.acquireConnectSlot();
                        try {
                            await this.connectLight(mac);
                        } finally {
                            this.releaseConnectSlot();
                        }
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

        status.lights.forEach((light, i) => {
            status[`light_${i + 1}`] = light.connected;
        });

        return status;
    }

    emitStatus() {
        const status = this.getStatus();
        this.emit('status', status);
        const summary = status.lights.map(l =>
            `${l.name}: ${l.connected ? '🟢' : '🔴'} ${l.brightness}%@${l.temperature}K`
        ).join(' | ');
        console.log(`📊 ${summary}`);
    }

    async shutdown() {
        console.log('\nShutting down Light Manager...');
        this.stopPolling();
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
        for (const light of this.lights.values()) {
            if (light.connected) await light.disconnect();
        }
    }
}
