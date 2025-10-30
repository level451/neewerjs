// Neewer Light Controller Constants

// Bluetooth GATT Characteristic UUIDs
export const GATT_CHARACTERISTIC_UUID = '69400002b5a3f393e0a9e50e24dcca99';
export const GATT_SERVICE_UUID = '69400001b5a3f393e0a9e50e24dcca99';

// Command prefixes
export const COMMAND_PREFIX = 0x78;
export const MODE_HSI = 0x86;  // RGB/HSI mode
export const MODE_CCT = 0x87;  // Color temperature mode
export const MODE_SCENE = 0x88; // Animation/Scene mode

// Neewer light name patterns for discovery
export const NEEWER_NAME_PATTERNS = [
    'NEEWER',
    'NW',
    'SL-',
    'RGB',
    'SNL',
    'GL1',
    'BH30S',
    'CB60',
    'CL124',
    'SRP',
    'WRP',
    'ZRP'
];

// Light capabilities
export const LIGHT_TYPES = {
    CCT_ONLY: 'cct_only',
    RGB_ONLY: 'rgb_only',
    CCT_RGB: 'cct_rgb',
    SCENE_CAPABLE: 'scene_capable'
};

// CCT Temperature range (in Kelvin)
export const CCT_MIN = 2700;
export const CCT_MAX = 6500;
export const CCT_DEFAULT = 5600;

// RGB/HSI ranges
export const HUE_MIN = 0;
export const HUE_MAX = 360;
export const SATURATION_MIN = 0;
export const SATURATION_MAX = 100;
export const BRIGHTNESS_MIN = 0;
export const BRIGHTNESS_MAX = 100;

// Scene IDs
export const SCENES = {
    SQUAD_CAR: 1,
    AMBULANCE: 2,
    FIRE_ENGINE: 3,
    FIREWORKS: 4,
    PARTY: 5,
    CANDLE_LIGHT: 6,
    LIGHTNING: 7,
    PAPARAZZI: 8,
    SCREEN: 9
};

// Scan settings
export const SCAN_TIMEOUT = 10000; // 10 seconds default scan time
export const RSSI_THRESHOLD = -90; // Minimum signal strength