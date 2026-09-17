const WebSocket = require('ws');
const os = require('os');

let wss = null; // Initialize wss to null
let mainWindowRef; // Reference to the main browser window
let cueManagerRef;   // Reference to cueManager module
let isServerStartingOrStopping = false; // Flag to prevent re-entrant calls

const DEFAULT_PORT = 8877;

// Helper function to get network interface information
function getNetworkInterfaces() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const interfaceName in interfaces) {
        const interfaceInfo = interfaces[interfaceName];
        for (const info of interfaceInfo) {
            // Skip internal (loopback) and non-IPv4 addresses
            if (!info.internal && info.family === 'IPv4') {
                addresses.push({
                    interface: interfaceName,
                    address: info.address
                });
            }
        }
    }
    
    return addresses;
}

// Call this first to set the required context for other functions
function setContext(mainWindow, cueManager) {
    mainWindowRef = mainWindow;
    cueManagerRef = cueManager;
    console.log('WebSocket Server: Context set with mainWindow and cueManager.');
}

async function startServer(port = DEFAULT_PORT, enabled = true) {
    if (isServerStartingOrStopping) {
        console.log('WebSocket server start/stop already in progress. Aborting duplicate start attempt.');
        return null;
    }
    isServerStartingOrStopping = true;

    if (!enabled) {
        console.log('WebSocket server is disabled in config. Not starting.');
        if (wss) {
            await stopServer(); // Ensure any existing server is stopped
        }
        isServerStartingOrStopping = false;
        return null;
    }

    if (wss) {
        console.log('WebSocket server (old instance) was found. Attempting to stop it for restart.');
        await stopServer(); // stopServer will reset isServerStartingOrStopping to false when done
        // No explicit delay here anymore, rely on stopServer completion
    }

    if (!mainWindowRef || !cueManagerRef) {
        console.error('WebSocket Server: Cannot start. mainWindowRef or cueManagerRef not set. Call setContext first.');
        isServerStartingOrStopping = false;
        return null;
    }

    try {
        console.log(`WebSocket server attempting to start on port ${port}`);
        
        // Log network interface information to help with Windows networking troubleshooting
        const networkInterfaces = getNetworkInterfaces();
        console.log('WebSocket Server: Available network interfaces:');
        networkInterfaces.forEach(iface => {
            console.log(`  - ${iface.interface}: ${iface.address}`);
        });
        
        wss = new WebSocket.Server({ 
            port,
            host: '0.0.0.0' // Explicitly bind to all interfaces 
        });

        wss.on('listening', () => {
            console.log(`WebSocket server successfully started and listening on port ${port}`);
            console.log(`WebSocket Server: Accessible at:`);
            console.log(`  - localhost:${port}`);
            console.log(`  - 127.0.0.1:${port}`);
            networkInterfaces.forEach(iface => {
                console.log(`  - ${iface.address}:${port}`);
            });
            console.log(`WebSocket Server: Companion should connect to one of these addresses.`);
            isServerStartingOrStopping = false;
        });

        wss.on('connection', wsClient => {
            console.log('WebSocket Server: Companion module client connected');
            console.log(`WebSocket Server: Client remote address: ${wsClient._socket?.remoteAddress || 'unknown'}`);
            console.log(`WebSocket Server: Client remote port: ${wsClient._socket?.remotePort || 'unknown'}`);

            if (cueManagerRef) {
                try {
                    const cues = cueManagerRef.getCues();
                    const message = JSON.stringify({ event: 'cuesListUpdate', payload: { cues } });
                    wsClient.send(message);
                    console.log(`WebSocket Server: Sent initial cues list with ${cues.length} cues to client`);
                } catch (error) {
                    console.error('WebSocket Server: Error sending initial cues list:', error);
                }
            }

            wsClient.on('message', messageBuffer => {
                const message = messageBuffer.toString();
                console.log('WebSocket Server: Received message from Companion:', message);
                try {
                    const parsedMessage = JSON.parse(message);
                    console.log('WebSocket Server: Successfully parsed message:', parsedMessage);
                    handleCompanionMessage(parsedMessage);
                } catch (e) {
                    console.error('WebSocket Server: Failed to parse message from Companion:', e);
                    console.error('WebSocket Server: Raw message was:', message);
                }
            });

            wsClient.on('close', (code, reason) => {
                console.log('WebSocket Server: Companion module client disconnected');
                console.log(`WebSocket Server: Close code: ${code}, reason: ${reason || 'no reason provided'}`);
            });

            wsClient.on('error', (error) => {
                console.error('WebSocket Server: WebSocket error with client:', error);
                console.error('WebSocket Server: Error code:', error.code);
                console.error('WebSocket Server: Error message:', error.message);
            });
        });

        wss.on('error', (error) => {
            console.error('WebSocket Server: Server error:', error);
            console.error('WebSocket Server: Error code:', error.code);
            console.error('WebSocket Server: Error message:', error.message);
            
            // If server fails to start (e.g. EADDRINUSE), wss might not be the new instance or might be null.
            // We should ensure the flag is reset to allow another attempt if needed, e.g. after user changes port.
            if (error.code === 'EADDRINUSE') {
                console.error(`WebSocket Server: Port ${port} is already in use. This could be a Windows firewall issue or another application using the port.`);
                console.error('WebSocket Server: Try changing the WebSocket port in app settings or check Windows firewall settings.');
                // wss might be the old one if new one failed, or null. Ensure it is null if start failed.
                if (wss && wss.options && wss.options.port === port) { // Check if this is the instance that failed
                    // It failed to listen, so it's not really active.
                    // No need to call currentWssInstance.close() as it never opened.
                }
                wss = null; // Ensure wss is null if it failed to start
            } else if (error.code === 'EACCES') {
                console.error(`WebSocket Server: Permission denied for port ${port}. Try running as administrator or use a different port.`);
            } else if (error.code === 'ENOTFOUND') {
                console.error(`WebSocket Server: Network interface not found. Check network configuration.`);
            }
            isServerStartingOrStopping = false; // Reset flag on error
        });
        return wss;
    } catch (e) {
        console.error('WebSocket Server: Error starting server (catch block):', e);
        console.error('WebSocket Server: This could be a Windows-specific networking issue.');
        isServerStartingOrStopping = false;
        return null;
    }
}

function handleCompanionMessage(message) {
    console.log(`WebSocket Server: handleCompanionMessage called with:`, message);
    
    if (!mainWindowRef) {
        console.warn('WebSocket Server: MainWindow reference not set - cannot process companion message.');
        return;
    }

    if (!mainWindowRef.webContents) {
        console.warn('WebSocket Server: MainWindow webContents not available - cannot process companion message.');
        return;
    }

    if (mainWindowRef.webContents.isDestroyed()) {
        console.warn('WebSocket Server: MainWindow webContents is destroyed - cannot process companion message.');
        return;
    }

    // All Companion actions that trigger a cue should go through the generic trigger mechanism
    // which respects the cue's configured retrigger behavior.
    const source = 'companion'; 

    console.log(`WebSocket Server: Processing companion message action: ${message.action}`);

    switch (message.action) {
        case 'playCue':
        case 'toggleCue': // Treat play and toggle from Companion the same way initially
            if (message.payload && message.payload.cueId) {
                console.log(`WebSocket Server: Routing Companion action '${message.action}' for cue ${message.payload.cueId} to 'trigger-cue-by-id-from-main'`);
                try {
                    const payload = { cueId: message.payload.cueId, source };
                    console.log(`WebSocket Server: Sending IPC message 'trigger-cue-by-id-from-main' with payload:`, payload);
                    mainWindowRef.webContents.send('trigger-cue-by-id-from-main', payload);
                    console.log(`WebSocket Server: Successfully sent IPC message for cue ${message.payload.cueId}`);
                } catch (error) {
                    console.error(`WebSocket Server: Error sending IPC message for cue ${message.payload.cueId}:`, error);
                }
            } else {
                console.warn(`WebSocket Server: Invalid payload for action '${message.action}' - missing cueId`);
            }
            break;
        case 'stopCue':
            if (message.payload && message.payload.cueId) {
                console.log(`WebSocket Server: Processing stop cue action for ${message.payload.cueId}`);
                try {
                    console.log(`WebSocket Server: Sending IPC message 'stop-audio-by-id' for cue ${message.payload.cueId}`);
                    // stop-audio-by-id directly calls audioPlaybackManager.stop with fade, which is fine.
                    mainWindowRef.webContents.send('stop-audio-by-id', message.payload.cueId);
                    console.log(`WebSocket Server: Successfully sent stop IPC message for cue ${message.payload.cueId}`);
                } catch (error) {
                    console.error(`WebSocket Server: Error sending stop IPC message for cue ${message.payload.cueId}:`, error);
                }
            } else {
                console.warn(`WebSocket Server: Invalid payload for stopCue action - missing cueId`);
            }
            break;
        case 'stopAllCues':
            console.log(`WebSocket Server: Processing stop all cues action`);
            try {
                // Pass behavior parameter if provided in the payload
                if (message.payload && message.payload.behavior) {
                    console.log(`WebSocket Server: Routing 'stopAllCues' with behavior '${message.payload.behavior}' to 'stop-all-audio'`);
                    mainWindowRef.webContents.send('stop-all-audio', { behavior: message.payload.behavior });
                } else {
                    console.log(`WebSocket Server: Routing 'stopAllCues' with no behavior to 'stop-all-audio'`);
                    mainWindowRef.webContents.send('stop-all-audio');
                }
                console.log(`WebSocket Server: Successfully sent stop all IPC message`);
            } catch (error) {
                console.error(`WebSocket Server: Error sending stop all IPC message:`, error);
            }
            break;
        case 'playlistNavigateNext':
            if (message.payload && message.payload.cueId) {
                console.log(`WebSocket Server: Processing playlist navigate next for ${message.payload.cueId}`);
                try {
                    mainWindowRef.webContents.send('playlist-navigate-next-from-main', message.payload.cueId);
                    console.log(`WebSocket Server: Successfully sent playlist navigate next IPC message for cue ${message.payload.cueId}`);
                } catch (error) {
                    console.error(`WebSocket Server: Error sending playlist navigate next IPC message for cue ${message.payload.cueId}:`, error);
                }
            } else {
                console.warn(`WebSocket Server: Invalid payload for playlistNavigateNext action - missing cueId`);
            }
            break;
        case 'playlistNavigatePrevious':
            if (message.payload && message.payload.cueId) {
                console.log(`WebSocket Server: Processing playlist navigate previous for ${message.payload.cueId}`);
                try {
                    mainWindowRef.webContents.send('playlist-navigate-previous-from-main', message.payload.cueId);
                    console.log(`WebSocket Server: Successfully sent playlist navigate previous IPC message for cue ${message.payload.cueId}`);
                } catch (error) {
                    console.error(`WebSocket Server: Error sending playlist navigate previous IPC message for cue ${message.payload.cueId}:`, error);
                }
            } else {
                console.warn(`WebSocket Server: Invalid payload for playlistNavigatePrevious action - missing cueId`);
            }
            break;
        default:
            console.warn('WebSocket Server: Unknown action from Companion:', message.action);
    }
}

function broadcastToAllClients(messageObject) {
    if (!wss) {
        console.log('WebSocket Server: Cannot broadcast - no server instance (wss is null)');
        return;
    }
    const messageString = JSON.stringify(messageObject);
    const openClients = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);
    
    if (openClients.length === 0 && messageObject.event === 'playbackTimeUpdate') {
        // Only log once per cue to avoid spam
        if (!broadcastToAllClients._loggedNoClients) {
            console.log('WebSocket Server: No Companion clients connected to receive playback updates');
            broadcastToAllClients._loggedNoClients = true;
        }
    } else if (openClients.length > 0) {
        broadcastToAllClients._loggedNoClients = false;
    }
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
}

function broadcastCuesListUpdate(currentCues) {
    console.log('Broadcasting cues list update to Companion clients.');
    broadcastToAllClients({ event: 'cuesListUpdate', payload: { cues: currentCues } });
}

function broadcastCueStatus(cueId, status, error = null) {
    console.log(`Broadcasting cue status for ${cueId}: ${status}`);
    const payload = { cueId, status };
    if (error) payload.error = error;
    broadcastToAllClients({ event: 'cueStatus', payload });
}

// New function to broadcast playback time updates
function broadcastPlaybackTimeUpdate(updatePayload) {
    console.log('Broadcasting playback time update to Companion clients:', {
        cueId: updatePayload.cueId,
        status: updatePayload.status,
        currentTime: updatePayload.currentTimeFormatted,
        isCurrentCue: updatePayload.isCurrentCue
    });
    broadcastToAllClients({ event: 'playbackTimeUpdate', payload: updatePayload });
}

function stopServer() {
    return new Promise((resolve, reject) => {
        // If stopServer is called, it implies a stop or restart sequence is in progress or starting.
        // However, startServer is the main gatekeeper for isServerStartingOrStopping flag for starting.
        // stopServer itself doesn't need to set it true, but should reset it if it was the final step of a startServer-initiated stop.

        if (wss) {
            console.log('Stopping WebSocket server...');
            const currentWssInstance = wss;
            wss = null;

            const clientsToTerminate = Array.from(currentWssInstance.clients);

            currentWssInstance.close(err => {
                if (err) {
                    console.error('Error during WebSocket server currentWssInstance.close():', err);
                    // Even if close fails, we attempted. Reset flag to allow future operations.
                    isServerStartingOrStopping = false;
                    reject(err);
                } else {
                    console.log('WebSocket server currentWssInstance.close() successful.');
                    // Reset flag to allow future operations.
                    isServerStartingOrStopping = false;
                    resolve();
                }
            });

            clientsToTerminate.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    console.log('Terminating a client connection forcefully after initiating close.');
                    client.terminate();
                }
            });
        } else {
            console.log('WebSocket server not running (wss is null), no action to stop.');
            // Reset flag to allow future operations.
            isServerStartingOrStopping = false;
            resolve();
        }
    });
}

module.exports = {
    setContext,         // New: To set references
    startServer,        // New: To start the server
    stopServer,         // New: To stop the server
    broadcastCuesListUpdate,
    broadcastCueStatus,
    broadcastPlaybackTimeUpdate // Export the new function
}; 