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

        let lastError = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                if (attempt > 1) {
                    console.log(`Retry attempt ${attempt}/${retries}...`);
                    // Wait a bit between retries
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                console.log(`Connecting to ${this.name}...`);

                // Add timeout to connection
                const connectPromise = this.peripheral.connectAsync();
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Connection timeout')), timeout)
                );

                await Promise.race([connectPromise, timeoutPromise]);
                console.log(`Connected! Setting up characteristics...`);

                // We already know the UUIDs - just get the service and characteristics directly
                const serviceUuid = '69400001b5a3f393e0a9e50e24dcca99';
                const writeCharUuid = '69400002b5a3f393e0a9e50e24dcca99';
                const notifyCharUuid = '69400003b5a3f393e0a9e50e24dcca99';

                try {
                    // Get the service (quick)
                    const servicePromise = this.peripheral.discoverServicesAsync([serviceUuid]);
                    const serviceTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Service discovery timeout')), 5000)
                    );

                    const services = await Promise.race([servicePromise, serviceTimeout]);

                    if (services.length === 0) {
                        throw new Error('Neewer service not found');
                    }

                    const service = services[0];

                    // Get only the two characteristics we need (quick)
                    const charPromise = service.discoverCharacteristicsAsync([writeCharUuid, notifyCharUuid]);
                    const charTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Characteristic discovery timeout')), 5000)
                    );

                    const chars = await Promise.race([charPromise, charTimeout]);

                    this.characteristic = chars.find(c => c.uuid === writeCharUuid);
                    this.notifyCharacteristic = chars.find(c => c.uuid === notifyCharUuid);

                    if (!this.characteristic) {
                        throw new Error('Write characteristic not found');
                    }

                    console.log(`  ✓ Ready to control`);

                    // Optional: Subscribe to notifications (don't fail if this doesn't work)
                    if (this.notifyCharacteristic) {
                        try {
                            await this.notifyCharacteristic.subscribeAsync();
                            this.notifyCharacteristic.on('data', (data) => {
                                if (data.length < 5) return;
                                this.parseNotification(data);
                            });
                        } catch (err) {
                            // Notifications not critical - just skip
                        }
                    }

                    this.connected = true;
                    console.log(`✓ ${this.name} ready`);
                    return; // Success!

                } catch (error) {
                    throw new Error(`Setup failed: ${error.message}`);
                }

            } catch (error) {
                lastError = error;
                console.error(`Attempt ${attempt} failed:`, error.message);

                // Try to disconnect if partially connected
                try {
                    await this.peripheral.disconnectAsync();
                } catch (e) {
                    // Ignore disconnect errors
                }

                // If this wasn't the last attempt, continue to retry
                if (attempt < retries) {
                    continue;
                }
            }
        }

        // All retries failed
        throw new Error(`Failed to connect after ${retries} attempts: ${lastError.message}`);
    }

    /**
     * Read current status from the light
     */
    async readStatus() {
        if (!this.connected || !this.characteristic || !this.notifyCharacteristic) {
            return;
        }

        try {
            // Just verify connection is alive by reading a characteristic
            await this.notifyCharacteristic.readAsync();
            // Connection is alive if we got here

        } catch (error) {
            // Only log once and mark as dead
            if (this.connected) {
                console.log(`⚠ ${this.name} connection dead during poll`);
                this.connected = false;
                this.emit('disconnected');
            }
            // Don't log subsequent failures - already marked as dead
        }
    }

    /**
     * Parse notification data from light (when values change)
     */
    parseNotification(data) {
        // Ignore short messages
        if (data.length < 5) {
            return;
        }

        console.log(`🔍 Parsing notification from ${this.name}, length: ${data.length}`);

        // Neewer lights send status updates as notifications
        // Format: [0x78, 0x87, 0x02, brightness, temp, checksum] for CCT mode

        if (data[0] === 0x78 && data[1] === 0x87) {
            console.log(`  CCT mode notification detected`);
            const brightness = data[3];
            const tempByte = data[4];

            // Convert temp byte back to Kelvin
            const temperature = Math.round((tempByte - 32) / 53 * 6300 + 3200);

            console.log(`  Parsed: brightness=${brightness}%, temp=${temperature}K`);
            console.log(`  Current state: brightness=${this.state.brightness}%, temp=${this.state.cct}K`);

            const changed = (this.state.brightness !== brightness || this.state.cct !== temperature);

            this.state.brightness = brightness;
            this.state.cct = temperature;

            if (changed) {
                console.log(`📢 ${this.name} state changed: ${brightness}% @ ${temperature}K`);
                this.emit('stateChanged', { brightness, temperature });
            } else {
                console.log(`  No change detected`);
            }
        } else {
            console.log(`  Unknown notification format (0x${data[0].toString(16)} 0x${data[1].toString(16)})`);
        }
    }

    /**
     * Disconnect from the light
     */
    async disconnect() {
        if (!this.connected) {
            return;
        }

        try {
            await this.peripheral.disconnectAsync();
            this.connected = false;
            this.characteristic = null;
            console.log(`Disconnected from ${this.name}`);
        } catch (error) {
            console.error(`Failed to disconnect from ${this.name}:`, error.message);
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
            console.error(`Failed to send command to ${this.name}:`, error.message);
            throw error;
        }
    }

    /**
     * Get light info as a formatted string
     */
    toString() {
        return `${this.name} (${this.address}) - RSSI: ${this.rssi} dBm - ${
            this.connected ? 'Connected' : 'Disconnected'
        }`;
    }

    /**
     * Get light info as object
     */
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