const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const { formatTimeMMSS, calculateEffectiveTrimmedDurationSec } = require('./utils/timeUtils'); // Import utilities

let cueManagerRef;
let mainWindowRef; // To send messages to the renderer if needed

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const recentlyTriggeredCuesByRemote = new Map(); // cueId -> timestamp
const REMOTE_TRIGGER_DEBOUNCE_MS = 400; // Ignore duplicate remote triggers for the same cue within this time
let ipcSentForThisRemoteTrigger = {}; // cueId -> boolean : Blocks IPC send if true for this specific trigger event

// Cleanup function to prevent memory leaks in ipcSentForThisRemoteTrigger
function cleanupIpcTriggerLocks() {
    const now = Date.now();
    const keysToDelete = [];
    
    for (const [cueId, timestamp] of Object.entries(ipcSentForThisRemoteTrigger)) {
        // Remove entries older than 5 seconds (safety margin)
        if (now - timestamp > 5000) {
            keysToDelete.push(cueId);
        }
    }
    
    keysToDelete.forEach(key => delete ipcSentForThisRemoteTrigger[key]);
    
    if (keysToDelete.length > 0) {
        console.log(`HTTP_SERVER: Cleaned up ${keysToDelete.length} stale IPC trigger locks`);
    }
}

// Run cleanup every 30 seconds
setInterval(cleanupIpcTriggerLocks, 30000);

let configuredPort = 3000; // Default port
let appConfigRef = null; // Reference to app config

function initialize(cueMgr, mainWin, appConfig = null) {
    cueManagerRef = cueMgr;
    mainWindowRef = mainWin;
    appConfigRef = appConfig;
    
    // Use configured port if available
    if (appConfig && appConfig.httpRemotePort) {
        configuredPort = appConfig.httpRemotePort;
    }

    // Serve static files (like remote.html, and later CSS/JS for it)
    // Assuming remote.html will be in src/renderer/remote_control/
    app.use(express.static(path.join(__dirname, '..', 'renderer', 'remote_control')));
    // Add static serving for the top-level assets directory
    app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'renderer', 'remote_control', 'remote.html'));
    });

    wss.on('connection', (ws) => {
        console.log('HTTP_SERVER: Remote client connected via WebSocket.');

        // Send current cues on connection
        if (cueManagerRef) {
            const rawCues = cueManagerRef.getCues();
            const processedCues = rawCues.map(cue => {
                let initialTrimmedDurationValueS = 0;
                let originalKnownDurationS = 0;
                
                if (cue.type === 'single_file') {
                    initialTrimmedDurationValueS = calculateEffectiveTrimmedDurationSec(cue);
                    originalKnownDurationS = cue.knownDuration || 0;
                } else if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                    // For playlists, use the effective duration of the first item for initial display
                    // Playlist items have knownDuration, trimStartTime, trimEndTime
                    const firstItem = cue.playlistItems[0];
                    initialTrimmedDurationValueS = calculateEffectiveTrimmedDurationSec(firstItem);
                    originalKnownDurationS = firstItem.knownDuration || 0;
                } else {
                    // Fallback for other types or empty playlists
                    initialTrimmedDurationValueS = cue.knownDuration || 0;
                    originalKnownDurationS = cue.knownDuration || 0;
                }
                
                console.log(`HTTP_SERVER: Initial cue data for ${cue.id} (${cue.type}): trimmed=${initialTrimmedDurationValueS}s, original=${originalKnownDurationS}s`);
                
                // Ensure all necessary fields expected by remote are present
                return {
                    id: cue.id,
                    name: cue.name,
                    type: cue.type,
                    status: 'stopped', // Initial status, will be updated by remote_cue_update
                    currentTimeS: 0,
                    currentItemDurationS: initialTrimmedDurationValueS, // Use this for initial total time display
                    initialTrimmedDurationS: initialTrimmedDurationValueS, // Explicitly for remote's logic
                    knownDurationS: originalKnownDurationS, // Original untrimmed duration of main file/first item
                    playlistItemName: (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) ? cue.playlistItems[0].name : null,
                    nextPlaylistItemName: null, // This will come from live updates
                };
            });
            ws.send(JSON.stringify({ type: 'all_cues', payload: processedCues }));
        }

        ws.on('message', (message) => {
            // Reduced verbose logging
            try {
                const parsedMessage = JSON.parse(message.toString());

                if (parsedMessage.action === 'trigger_cue' && parsedMessage.cueId) {
                    const cueId = parsedMessage.cueId;
                    const now = Date.now();
                    

                    const lastTriggerTime = recentlyTriggeredCuesByRemote.get(cueId);
                    
                    if (lastTriggerTime && (now - lastTriggerTime < REMOTE_TRIGGER_DEBOUNCE_MS)) {
                        console.log(`HTTP_SERVER: Ignoring duplicate trigger for cue ${cueId} (debounced)`);
                        return; 
                    }
                    
                    recentlyTriggeredCuesByRemote.set(cueId, now);
                    
                    // New Guard: Ensure IPC for this specific trigger event is sent only once
                    if (ipcSentForThisRemoteTrigger[cueId]) {
                        console.log(`HTTP_SERVER: Ignoring duplicate IPC trigger for cue ${cueId} (already sent)`);
                        // We still want the recentlyTriggeredCuesByRemote timeout to clear normally for the *next* distinct message.
                        // So, we just return from this execution path for THIS message.
                        return; 
                    }
                    ipcSentForThisRemoteTrigger[cueId] = now;
                    

                    // Clear the per-trigger IPC lock after a safe interval
                    setTimeout(() => {
                        delete ipcSentForThisRemoteTrigger[cueId]; 
                    }, 1000); // 1 second, well after any potential duplicate processing of the same event
                    
                    // Original timeout for inter-message debounce
                    setTimeout(() => {
                        recentlyTriggeredCuesByRemote.delete(cueId);
                    }, REMOTE_TRIGGER_DEBOUNCE_MS);

                    if (mainWindowRef && mainWindowRef.webContents) {
                        const payload = { 
                            cueId: parsedMessage.cueId,
                            source: 'remote_http' 
                        };
                        mainWindowRef.webContents.send('trigger-cue-by-id-from-main', payload);
                        
                    } else {
                        console.warn('HTTP_SERVER: Cannot send trigger message - mainWindowRef or webContents not available');
                    }
                } else if (parsedMessage.action === 'stop_all_cues') {
                    if (mainWindowRef && mainWindowRef.webContents) {
                        mainWindowRef.webContents.send('stop-all-audio');
                        console.log('HTTP_SERVER: Stop all cues command sent to main window');
                    } else {
                        console.warn('HTTP_SERVER: Cannot send stop all command - mainWindowRef or webContents not available');
                    }
                } else if (parsedMessage.action === 'playlist_jump_to_item' && parsedMessage.cueId !== undefined && parsedMessage.targetIndex !== undefined) {
                    if (mainWindowRef && mainWindowRef.webContents) {
                        mainWindowRef.webContents.send('playlist-jump-to-item-from-main', { cueId: parsedMessage.cueId, targetIndex: parsedMessage.targetIndex });
                        console.log(`HTTP_SERVER: Playlist jump to item command sent for cue ${parsedMessage.cueId}, index ${parsedMessage.targetIndex}`);
                    } else {
                        console.warn('HTTP_SERVER: Cannot send playlist jump to item command - mainWindowRef or webContents not available');
                    }
                }
            } catch (error) {
                console.error('HTTP_SERVER_LOG: Error in ws.on("message") handler:', error);
            }
        });

        ws.on('close', () => {
            console.log('HTTP_SERVER: Remote client disconnected.');
        });

        ws.on('error', (error) => {
            console.error('HTTP_SERVER: WebSocket error:', error);
        });
    });

    // Function to try starting server on a port, with automatic retry on different ports
    function tryStartServer(port, maxRetries = 10) {
        server.listen(port, () => {
            configuredPort = port; // Update the configured port to the actual port used
            console.log(`HTTP_SERVER: HTTP and WebSocket server started on port ${port}. Access remote at http://localhost:${port}`);
        }).on('error', (error) => {
            console.error(`HTTP_SERVER: Failed to start server on port ${port}:`, error);
            if (error.code === 'EADDRINUSE') {
                const nextPort = port + 1;
                if (nextPort <= configuredPort + maxRetries) {
                    console.log(`HTTP_SERVER: Port ${port} is already in use. Trying port ${nextPort}...`);
                    tryStartServer(nextPort, maxRetries);
                } else {
                    console.error(`HTTP_SERVER: Could not find an available port after trying ${maxRetries} ports starting from ${configuredPort}. Please check your system.`);
                }
            } else {
                console.error(`HTTP_SERVER: Server startup failed with error: ${error.message}`);
            }
        });
    }
    
    tryStartServer(configuredPort);
}

// Function to broadcast updates to all connected remote clients
function broadcastToRemotes(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('HTTP_SERVER: Error sending message to remote client:', error);
            }
        }
    });
}

// Function to get all network interface IP addresses
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
                    address: info.address,
                    url: `http://${info.address}:${configuredPort}`
                });
            }
        }
    }
    
    return addresses;
}

// Function to get HTTP remote info for app config
function getRemoteInfo() {
    return {
        enabled: appConfigRef ? appConfigRef.httpRemoteEnabled !== false : true,
        port: configuredPort,
        interfaces: getNetworkInterfaces()
    };
}

// Function to update configuration (for port changes, etc.)
function updateConfig(newConfig) {
    appConfigRef = newConfig;
    
    // If port changed, log a warning that restart is needed
    if (newConfig.httpRemotePort && newConfig.httpRemotePort !== configuredPort) {
        console.log(`HTTP_SERVER: Port change detected (${configuredPort} -> ${newConfig.httpRemotePort}). Server restart required for changes to take effect.`);
        // Note: We don't restart the server automatically to avoid disrupting connections
        // The port change will take effect on next app restart
    }
}

module.exports = { initialize, broadcastToRemotes, getRemoteInfo, updateConfig }; 