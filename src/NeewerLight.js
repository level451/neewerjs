// NeewerLight class - represents a single Neewer light
import { EventEmitter } from 'events';
import { GATT_CHARACTERISTIC_UUID, LIGHT_TYPES } from './constants.js';

export class NeewerLight extends EventEmitter {
    constructor(peripheral) {
        super();
        this.peripheral = peripheral;
        this.peripheral.setMaxListeners(20); // Prevent memory leak warning
        this.id = peripheral.id;
        this.id = peripheral.id;
        this.address = peripheral.address;
        this.name = peripheral.advertisement.localName || 'Unknown Neewer Light';
        this.rssi = peripheral.rssi;
        this.connected = false;
        this.characteristic = null;
        this.notifyCharacteristic = null; // Store for polling

        // Busy flag so polling/pings don't collide with connect/discover
        this.isBusy = false;

        // Light capabilities (will be determined on connection)
        this.capabilities = {
            supportsCCT: true,
            supportsRGB: false,
            supportsScenes: false,
            cctRange: { min: 3200, max: 5600 }
        };

        // Current state
        this.state = {
            isOn: false,
            mode: null,
            brightness: 0,
            cct: 5600,
            hue: 0,
            saturation: 100,
            scene: null
        };
    }

    /**
     * Connect to the light
     */
    async connect(timeout = 15000, retries = 2) {
        if (this.connected) {
            console.log(`Light ${this.name} is already connected`);
            return;
        }
        if (this.isBusy) {
            console.log(`Light ${this.name} is busy; skipping connect attempt`);
            return;
        }

        this.isBusy = true;
        let lastError = null;

        // Known UUIDs (use one-step discovery)
        const serviceUuid = '69400001b5a3f393e0a9e50e24dcca99';
        const writeCharUuid = '69400002b5a3f393e0a9e50e24dcca99';
        const notifyCharUuid = '69400003b5a3f393e0a9e50e24dcca99';

        const DISCOVERY_TIMEOUT_MS = 8000; // more forgiving than 5s

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                if (attempt > 1) {
                    console.log(`Retry attempt ${attempt}/${retries}...`);
                    await new Promise(res => setTimeout(res, 400 + (attempt - 1) * 200));
                }

                console.log(`Connecting to ${this.name}...`);

                // Add timeout to connection
                const connectPromise = this.peripheral.connectAsync();
                const connTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Connection timeout')), timeout)
                );
                await Promise.race([connectPromise, connTimeout]);
                console.log(`Connected! Discovering handles...`);

                // 📌 One-step discovery: services + characteristics in one call
                const discoverPromise = this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
                    [serviceUuid],
                    [writeCharUuid, notifyCharUuid]
                );
                const discTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Characteristic discovery timeout')), DISCOVERY_TIMEOUT_MS)
                );
                const { characteristics } = await Promise.race([discoverPromise, discTimeout]);

                this.characteristic = characteristics.find(c => c.uuid === writeCharUuid);
                this.notifyCharacteristic = characteristics.find(c => c.uuid === notifyCharUuid);

                if (!this.characteristic) {
                    throw new Error('Write characteristic not found');
                }

                // Optional: subscribe to notifications
                if (this.notifyCharacteristic) {
                    try {
                        await this.notifyCharacteristic.subscribeAsync();
                        this.notifyCharacteristic.on('data', (data) => {
                            if (data.length < 5) return;
                            this.parseNotification(data);
                        });
                    } catch (_) {
                        // Notifications are optional
                    }
                }

                this.connected = true;
                this.isBusy = false;
                console.log(`✓ ${this.name} ready`);
                return; // Success!

            } catch (error) {
                lastError = error;
                console.error(`Attempt ${attempt} failed: ${error.message}`);

                // Clean up partial connects
                try { await this.peripheral.disconnectAsync(); } catch (_) {}

                // Continue loop for next retry
            }
        }

        this.isBusy = false;
        throw new Error(`Failed to connect after ${retries} attempts: ${lastError?.message || 'unknown error'}`);
    }

    /**
     * Read current status from the light
     */
    async readStatus() {
        if (!this.connected || !this.characteristic || !this.notifyCharacteristic) {
            return;
        }

        try {
            await this.notifyCharacteristic.readAsync(); // liveness probe
        } catch (error) {
            if (this.connected) {
                console.log(`⚠ ${this.name} connection dead during poll: ${error.message}`);
                this.connected = false;
                this.emit('disconnected'); // ensure LightManager schedules reconnect
            }
            throw error;
        }
    }

    /**
     * Parse notification data from light (when values change)
     */
    parseNotification(data) {
        if (data.length < 5) return;

        // Neewer CCT: [0x78, 0x87, 0x02, brightness, tempByte, checksum]
        if (data[0] === 0x78 && data[1] === 0x87) {
            const brightness = data[3];
            const tempByte = data[4];
            const temperature = Math.round((tempByte - 32) / 53 * 6300 + 3200);

            const changed = (this.state.brightness !== brightness || this.state.cct !== temperature);
            this.state.brightness = brightness;
            this.state.cct = temperature;

            if (changed) {
                console.log(`📢 ${this.name} state changed: ${brightness}% @ ${temperature}K`);
                this.emit('stateChanged', { brightness, temperature });
            }
        }
    }

    /**
     * Disconnect from the light
     */
    async disconnect() {
        if (!this.connected) return;

        try {
            await this.peripheral.disconnectAsync();
            this.connected = false;
            this.characteristic = null;
            console.log(`Disconnected from ${this.name}`);
        } catch (error) {
            console.error(`Failed to disconnect from ${this.name}: ${error.message}`);
        }
    }

    /**
     * Send a command to the light
     */
    async sendCommand(commandBytes) {
        if (!this.connected || !this.characteristic) {
            throw new Error('Light is not connected');
        }
        try {
            const buffer = Buffer.from(commandBytes);
            await this.characteristic.writeAsync(buffer, false);
        } catch (error) {
            console.error(`Failed to send command to ${this.name}: ${error.message}`);
            throw error;
        }
    }

    toString() {
        return `${this.name} (${this.address}) - RSSI: ${this.rssi} dBm - ${this.connected ? 'Connected' : 'Disconnected'}`;
    }

    toJSON() {
        return {
            id: this.id,
            address: this.address,
            name: this.name,
            rssi: this.rssi,
            connected: this.connected,
            capabilities: this.capabilities,
            state: this.state
        };
    }
}
