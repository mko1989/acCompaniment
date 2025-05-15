const WebSocket = require('ws');

let wss;
let mainWindowRef; // Reference to the main browser window
let cueManagerRef;   // Reference to cueManager module

const DEFAULT_PORT = 8877;

function startWebSocketServer(port = DEFAULT_PORT) {
    if (wss) {
        console.log('WebSocket server already running.');
        return wss;
    }
    wss = new WebSocket.Server({ port });
    console.log(`WebSocket server started on port ${port}`);

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
    });
    return wss;
}

function handleCompanionMessage(message) {
    if (!mainWindowRef) {
        console.warn('MainWindow reference not set in WebSocket server.');
        return;
    }

    switch (message.action) {
        case 'playCue':
            if (message.payload && message.payload.cueId) {
                mainWindowRef.webContents.send('play-audio-by-id', message.payload.cueId);
            }
            break;
        case 'stopCue':
            if (message.payload && message.payload.cueId) {
                mainWindowRef.webContents.send('stop-audio-by-id', message.payload.cueId);
            }
            break;
        case 'toggleCue':
            if (message.payload && message.payload.cueId) {
                mainWindowRef.webContents.send('toggle-audio-by-id', message.payload.cueId);
            }
            break;
        case 'stopAllCues':
            mainWindowRef.webContents.send('stop-all-audio');
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

function initialize(mainWindow, cueManager) {
    mainWindowRef = mainWindow;
    cueManagerRef = cueManager;
}

module.exports = {
    initialize,
    start: startWebSocketServer, // Renamed to avoid conflict with wss.start if any
    broadcastCuesListUpdate,    // Exposed for cueManager to call
    broadcastCueStatus
}; 