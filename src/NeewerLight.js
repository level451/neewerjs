// NeewerLight.js - Individual light control with disconnect detection

import { EventEmitter } from 'events';
import { NEEWER_SERVICE_UUID, NEEWER_CHARACTERISTIC_UUID, NEEWER_NOTIFY_UUID } from './constants.js';

export class NeewerLight extends EventEmitter {
    constructor(peripheral) {
        super();
        this.peripheral = peripheral;
        this.name = peripheral.advertisement.localName || 'Unknown';
        this.mac = peripheral.address;
        this.connected = false;
        this.characteristic = null;
        this.notifyCharacteristic = null;
        this.rssi = peripheral.rssi;

        // Current state
        this.state = {
            brightness: 0,
            cct: 5600
        };
    }

    /**
     * Connect to the light and set up characteristics
     */
    async connect() {
        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 30000);

            try {
                // Connect to peripheral
                await this.peripheral.connectAsync();
                console.log('Connected! Setting up characteristics...');

                // Discover services and characteristics
                const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
                    [NEEWER_SERVICE_UUID],
                    [NEEWER_CHARACTERISTIC_UUID, NEEWER_NOTIFY_UUID]
                );

                // Find write characteristic
                this.characteristic = characteristics.find(
                    c => c.uuid === NEEWER_CHARACTERISTIC_UUID
                );

                // Find notify characteristic
                this.notifyCharacteristic = characteristics.find(
                    c => c.uuid === NEEWER_NOTIFY_UUID
                );

                if (!this.characteristic) {
                    throw new Error('Control characteristic not found');
                }

                // Subscribe to notifications if available
                if (this.notifyCharacteristic) {
                    await this.notifyCharacteristic.subscribeAsync();
                    this.notifyCharacteristic.on('data', (data) => {
                        this.parseNotification(data);
                    });
                }

                this.connected = true;
                console.log('  ✓ Ready to control');
                clearTimeout(timeout);
                resolve();

            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    /**
     * Parse notification data from the light
     */
    parseNotification(data) {
        if (data.length < 6) return;

        // Check if this is a state update (0x78 0x86 response)
        if (data[0] === 0x78 && data[1] === 0x86) {
            const brightness = data[3];
            const cctHigh = data[4];
            const cctLow = data[5];
            const cct = (cctHigh << 8) | cctLow;

            // Only emit if state actually changed
            if (this.state.brightness !== brightness || this.state.cct !== cct) {
                this.state.brightness = brightness;
                this.state.cct = cct;
                this.emit('stateChanged', this.state);
            }
        }
    }

    /**
     * Send a command to the light
     */
    async sendCommand(commandBuffer) {
        if (!this.connected || !this.characteristic) {
            throw new Error('Not connected');
        }

        try {
            await this.characteristic.writeAsync(commandBuffer, false);
        } catch (error) {
            console.log(`⚠ ${this.name} write failed: ${error.message}`);
            this.connected = false;
            this.emit('disconnected');
            throw error;
        }
    }

    /**
     * Read current status from the light
     */
    async readStatus() {
        if (!this.connected || !this.characteristic) {
            return;
        }

        try {
            // Just verify connection is alive by reading a characteristic
            if (this.notifyCharacteristic) {
                await this.notifyCharacteristic.readAsync();
            }
            // Connection is alive if we got here

        } catch (error) {
            // ANY error means connection is dead - emit disconnected event
            console.log(`⚠ ${this.name} connection dead during poll: ${error.message}`);
            this.connected = false;
            this.emit('disconnected');
        }
    }

    /**
     * Disconnect from the light
     */
    async disconnect() {
        if (this.peripheral && this.connected) {
            try {
                await this.peripheral.disconnectAsync();
            } catch (error) {
                // Ignore disconnect errors
            }
            this.connected = false;
        }
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            name: this.name,
            mac: this.mac,
            connected: this.connected,
            brightness: this.state.brightness,
            temperature: this.state.cct,
            rssi: this.rssi
        };
    }
}