// Command Builder - Creates byte arrays for Neewer lights

import { COMMAND_PREFIX, MODE_CCT } from './constants.js';

export class CommandBuilder {
    /**
     * Calculate checksum for command
     */
    static calculateChecksum(bytes) {
        let sum = 0;
        for (const byte of bytes) {
            sum += byte;
        }
        return sum & 0xFF;
    }

    /**
     * Set CCT (Color Temperature) and Brightness
     * @param {number} brightness - 0-100
     * @param {number} temperature - 3200-8500 (Kelvin)
     * @returns {Buffer}
     */
    static setCCT(brightness, temperature) {
        // Clamp values
        brightness = Math.max(0, Math.min(100, Math.round(brightness)));
        temperature = Math.max(3200, Math.min(8500, Math.round(temperature)));

        // Convert temperature to byte value (32-85 range for 3200K-8500K)
        const tempByte = Math.round(((temperature - 3200) / 6300) * 53 + 32);

        // Build command: [prefix, mode, 0x02, brightness, temp, checksum]
        const command = [
            COMMAND_PREFIX,  // 0x78
            MODE_CCT,        // 0x87
            0x02,
            brightness,
            tempByte,
        ];

        // Add checksum
        const checksum = this.calculateChecksum(command);
        command.push(checksum);

        return Buffer.from(command);
    }

    /**
     * Turn light on (sets to last known state or defaults)
     * @param {number} brightness - 0-100 (default 50)
     * @param {number} temperature - Kelvin (default 5600)
     */
    static turnOn(brightness = 50, temperature = 5600) {
        return this.setCCT(brightness, temperature);
    }

    /**
     * Turn light off (set brightness to 0)
     */
    static turnOff() {
        return this.setCCT(0, 5600);
    }
}