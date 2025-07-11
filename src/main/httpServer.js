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
            console.log('HTTP_SERVER_LOG: ws.on("message") START. Message:', message.toString()); // LOG A
            try {
                const parsedMessage = JSON.parse(message.toString());
                console.log('HTTP_SERVER_LOG: Parsed message:', parsedMessage); // LOG B

                if (parsedMessage.action === 'trigger_cue' && parsedMessage.cueId) {
                    const cueId = parsedMessage.cueId;
                    const now = Date.now();
                    console.log(`HTTP_SERVER_LOG: 'trigger_cue' action for ${cueId} at ${now}.`); // LOG C

                    const lastTriggerTime = recentlyTriggeredCuesByRemote.get(cueId);
                    console.log(`HTTP_SERVER_LOG: Debounce check - cueId: ${cueId}, now: ${now}, lastTriggerTime: ${lastTriggerTime}, REMOTE_TRIGGER_DEBOUNCE_MS: ${REMOTE_TRIGGER_DEBOUNCE_MS}`); // LOG D

                    if (lastTriggerTime && (now - lastTriggerTime < REMOTE_TRIGGER_DEBOUNCE_MS)) {
                        console.log(`HTTP_SERVER_LOG: DEBOUNCED duplicate remote trigger_cue for ${cueId}. Difference: ${now - lastTriggerTime}ms. IGNORING.`); // LOG E
                        return; 
                    }
                    console.log(`HTTP_SERVER_LOG: Debounce PASSED for ${cueId}.`); // LOG F
                    recentlyTriggeredCuesByRemote.set(cueId, now);
                    
                    // New Guard: Ensure IPC for this specific trigger event is sent only once
                    if (ipcSentForThisRemoteTrigger[cueId]) {
                        console.log(`HTTP_SERVER_LOG: BLOCKING IPC send for ${cueId} - ipcSentForThisRemoteTrigger[${cueId}] is true. This message instance was already processed for IPC send.`);
                        // We still want the recentlyTriggeredCuesByRemote timeout to clear normally for the *next* distinct message.
                        // So, we just return from this execution path for THIS message.
                        return; 
                    }
                    ipcSentForThisRemoteTrigger[cueId] = true;
                    console.log(`HTTP_SERVER_LOG: Set ipcSentForThisRemoteTrigger[${cueId}] = true.`);

                    // Clear the per-trigger IPC lock after a safe interval
                    setTimeout(() => {
                        delete ipcSentForThisRemoteTrigger[cueId]; 
                        console.log(`HTTP_SERVER_LOG: Cleared ipcSentForThisRemoteTrigger flag for ${cueId} after 1000ms.`);
                    }, 1000); // 1 second, well after any potential duplicate processing of the same event
                    
                    // Original timeout for inter-message debounce
                    setTimeout(() => {
                        const deleted = recentlyTriggeredCuesByRemote.delete(cueId);
                        console.log(`HTTP_SERVER_LOG: Debounce map key ${cueId} (recentlyTriggeredCuesByRemote) deleted after timeout. Success: ${deleted}`); // LOG G
                    }, REMOTE_TRIGGER_DEBOUNCE_MS);

                    if (mainWindowRef && mainWindowRef.webContents) {
                        const payload = { 
                            cueId: parsedMessage.cueId,
                            source: 'remote_http' 
                        };
                        console.log(`HTTP_SERVER_LOG: PRE-SEND IPC 'trigger-cue-by-id-from-main' for ${payload.cueId}. Payload:`, payload); // LOG H
                        mainWindowRef.webContents.send('trigger-cue-by-id-from-main', payload);
                        console.log(`HTTP_SERVER_LOG: POST-SEND IPC 'trigger-cue-by-id-from-main' for ${payload.cueId}.`); // LOG I
                    } else {
                        console.log(`HTTP_SERVER_LOG: mainWindowRef or webContents NOT AVAILABLE for IPC send. cueId: ${cueId}`); // LOG J
                    }
                } else if (parsedMessage.action === 'stop_all_cues') {
                    console.log('HTTP_SERVER_LOG: \'stop_all_cues\' action received.'); // LOG K
                    if (mainWindowRef && mainWindowRef.webContents) {
                        console.log("HTTP_SERVER_LOG: PRE-SEND IPC 'stop-all-audio'."); // LOG L
                        mainWindowRef.webContents.send('stop-all-audio');
                        console.log("HTTP_SERVER_LOG: POST-SEND IPC 'stop-all-audio'."); // LOG M
                    }
                }
            } catch (error) {
                console.error('HTTP_SERVER_LOG: Error in ws.on("message") handler:', error);
            }
            console.log('HTTP_SERVER_LOG: ws.on("message") END.'); // LOG N
        });

        ws.on('close', () => {
            console.log('HTTP_SERVER: Remote client disconnected.');
        });

        ws.on('error', (error) => {
            console.error('HTTP_SERVER: WebSocket error:', error);
        });
    });

    server.listen(configuredPort, () => {
        console.log(`HTTP_SERVER: HTTP and WebSocket server started on port ${configuredPort}. Access remote at http://localhost:${configuredPort}`);
    });
}

// Function to broadcast updates to all connected remote clients
function broadcastToRemotes(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
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