Neewer Light Controller
Simple Node.js controller for Neewer LED lights with WebSocket API and web interface.

Quick Start
bash
# Install dependencies
npm install

# Start the server
npm start
What It Does
Scans and connects to your 4 configured lights on startup
Auto-reconnects if lights disconnect (tries every 5 seconds)
WebSocket server on port 8080 for JSON commands
Status broadcasts whenever lights connect/disconnect
Web Interface
Open test-client.html in your browser to control lights.

JSON Commands
Set all lights:

json
{"action":"setCCT","brightness":75,"temperature":5600}
Set specific light:

json
{"action":"setCCT","mac":"fc:e6:97:7d:d7:18","brightness":50,"temperature":3200}
Get status:

json
{"action":"getStatus"}
Status Format
json
{
"timestamp": "2025-10-25T...",
"lights": [
{
"name": "Light 1",
"mac": "fc:e6:97:7d:d7:18",
"connected": true,
"brightness": 50,
"temperature": 5600,
"rssi": -75
}
]
}
Configuration
Edit src/lightConfig.js to change light names or MAC addresses.

Files
src/index.js - Main application
src/lightConfig.js - Your 4 light configurations
src/LightManager.js - Light management & auto-reconnect
src/CommandBuilder.js - Neewer protocol commands
src/WebSocketServer.js - WebSocket API server
test-client.html - Web control interface
