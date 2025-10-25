// NeewerLight class - represents a single Neewer light
import { GATT_CHARACTERISTIC_UUID, LIGHT_TYPES } from './constants.js';

export class NeewerLight {
    constructor(peripheral) {
        this.peripheral = peripheral;
        this.id = peripheral.id;
        this.address = peripheral.address;
        this.name = peripheral.advertisement.localName || 'Unknown Neewer Light';
        this.rssi = peripheral.rssi;
        this.connected = false;
        this.characteristic = null;

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
    async connect(timeout = 15000) {
        if (this.connected) {
            console.log(`Light ${this.name} is already connected`);
            return;
        }

        try {
            console.log(`Connecting to ${this.name}...`);

            // Add timeout to connection
            const connectPromise = this.peripheral.connectAsync();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timeout')), timeout)
            );

            await Promise.race([connectPromise, timeoutPromise]);
            console.log(`Connected! Discovering services...`);

            // Discover ALL services and characteristics for debugging
            const { services, characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();

            console.log(`Found ${services.length} service(s) and ${characteristics.length} characteristic(s)`);

            // Log all discovered UUIDs for debugging
            console.log('Services found:');
            services.forEach(s => console.log(`  - ${s.uuid}`));

            console.log('Characteristics found:');
            characteristics.forEach(c => console.log(`  - ${c.uuid} (properties: ${c.properties.join(', ')})`));

            // Try to find our characteristic
            this.characteristic = characteristics.find(
                c => c.uuid === GATT_CHARACTERISTIC_UUID
            );

            if (!this.characteristic) {
                console.warn(`Could not find expected characteristic ${GATT_CHARACTERISTIC_UUID}`);
                console.warn('Trying alternate characteristic search...');

                // Try finding any writable characteristic
                this.characteristic = characteristics.find(
                    c => c.properties.includes('write') || c.properties.includes('writeWithoutResponse')
                );

                if (this.characteristic) {
                    console.log(`Using alternate characteristic: ${this.characteristic.uuid}`);
                } else {
                    throw new Error('Could not find any writable characteristic');
                }
            }

            this.connected = true;
            console.log(`✓ Successfully connected to ${this.name}`);
            console.log(`  Using characteristic: ${this.characteristic.uuid}`);
        } catch (error) {
            console.error(`Failed to connect to ${this.name}:`, error.message);

            // Try to disconnect if partially connected
            try {
                await this.peripheral.disconnectAsync();
            } catch (e) {
                // Ignore disconnect errors
            }

            throw error;
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