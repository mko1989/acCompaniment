const WebSocket = require('ws');

let wss = null; // Initialize wss to null
let mainWindowRef; // Reference to the main browser window
let cueManagerRef;   // Reference to cueManager module
let isServerStartingOrStopping = false; // Flag to prevent re-entrant calls

const DEFAULT_PORT = 8877;

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
        await stopServer(); // stopServer will also set isServerStartingOrStopping to false when done if it was called from here
        // No explicit delay here anymore, rely on stopServer completion
    }

    if (!mainWindowRef || !cueManagerRef) {
        console.error('WebSocket Server: Cannot start. mainWindowRef or cueManagerRef not set. Call setContext first.');
        isServerStartingOrStopping = false;
        return null;
    }

    try {
        console.log(`WebSocket server attempting to start on port ${port}`);
        wss = new WebSocket.Server({ port });

        wss.on('listening', () => {
            console.log(`WebSocket server successfully started and listening on port ${port}`);
            isServerStartingOrStopping = false;
        });

        wss.on('connection', wsClient => {
            console.log('Companion module client connected');

            if (cueManagerRef) {
                wsClient.send(JSON.stringify({ event: 'cuesListUpdate', payload: { cues: cueManagerRef.getCues() } }));
            }

            wsClient.on('message', messageBuffer => {
                const message = messageBuffer.toString();
                console.log('Received from Companion:', message);
                try {
                    const parsedMessage = JSON.parse(message);
                    handleCompanionMessage(parsedMessage);
                } catch (e) {
                    console.error('Failed to parse message from Companion or handle it:', e);
                }
            });

            wsClient.on('close', () => {
                console.log('Companion module client disconnected');
            });

            wsClient.on('error', (error) => {
                console.error('WebSocket error with client:', error);
            });
        });

        wss.on('error', (error) => {
            console.error('WebSocket Server Error:', error);
            // If server fails to start (e.g. EADDRINUSE), wss might not be the new instance or might be null.
            // We should ensure the flag is reset to allow another attempt if needed, e.g. after user changes port.
            if (error.code === 'EADDRINUSE') {
                // wss might be the old one if new one failed, or null. Ensure it is null if start failed.
                if (wss && wss.options.port === port) { // Check if this is the instance that failed
                    // It failed to listen, so it's not really active.
                    // No need to call currentWssInstance.close() as it never opened.
                }
                wss = null; // Ensure wss is null if it failed to start
            }
            isServerStartingOrStopping = false; // Reset flag on error
        });
        return wss;
    } catch (e) {
        console.error('Error starting WebSocket server (catch block):', e);
        isServerStartingOrStopping = false;
        return null;
    }
}

function handleCompanionMessage(message) {
    if (!mainWindowRef) {
        console.warn('MainWindow reference not set in WebSocket server.');
        return;
    }

    // All Companion actions that trigger a cue should go through the generic trigger mechanism
    // which respects the cue's configured retrigger behavior.
    const source = 'companion'; 

    switch (message.action) {
        case 'playCue':
        case 'toggleCue': // Treat play and toggle from Companion the same way initially
            if (message.payload && message.payload.cueId) {
                console.log(`WebSocketServer: Routing Companion action '${message.action}' for cue ${message.payload.cueId} to 'trigger-cue-by-id-from-main'`);
                mainWindowRef.webContents.send('trigger-cue-by-id-from-main', { cueId: message.payload.cueId, source });
            }
            break;
        case 'stopCue':
            if (message.payload && message.payload.cueId) {
                // stop-audio-by-id directly calls audioPlaybackManager.stop with fade, which is fine.
                mainWindowRef.webContents.send('stop-audio-by-id', message.payload.cueId);
            }
            break;
        case 'stopAllCues':
            // Pass behavior parameter if provided in the payload
            if (message.payload && message.payload.behavior) {
                console.log(`WebSocketServer: Routing 'stopAllCues' with behavior '${message.payload.behavior}' to 'stop-all-audio'`);
                mainWindowRef.webContents.send('stop-all-audio', { behavior: message.payload.behavior });
            } else {
                console.log(`WebSocketServer: Routing 'stopAllCues' with no behavior to 'stop-all-audio'`);
                mainWindowRef.webContents.send('stop-all-audio');
            }
            break;
        default:
            console.log('Unknown action from Companion:', message.action);
    }
}

function broadcastToAllClients(messageObject) {
    if (!wss) return;
    const messageString = JSON.stringify(messageObject);
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
    // console.log('Broadcasting playback time update to Companion clients:', updatePayload);
    broadcastToAllClients({ type: 'playbackTimeUpdate', data: updatePayload });
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
                    // Even if close fails, we attempted. Reset flag only if this stop was the end of a cycle.
                    // isServerStartingOrStopping = false; // Potentially reset here or rely on caller
                    reject(err);
                } else {
                    console.log('WebSocket server currentWssInstance.close() successful.');
                    // isServerStartingOrStopping = false; // Potentially reset here or rely on caller
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
            // isServerStartingOrStopping = false; // Reset if this was part of a cycle that expected a server.
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