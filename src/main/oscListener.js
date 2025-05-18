const { Server } = require('node-osc');
const mixerIntegrationManager = require('./mixerIntegrationManager');

let oscServer = null;
let learnModeActive = false;
let learnModeTimeout = null;
let learnSuccessCallback = null;
let learnFailCallback = null;
const LEARN_MODE_TIMEOUT_MS = 10000; // 10 seconds for learn mode

// References to main window and cue manager
let winRef = null;
let cmRef = null;

function setContext(mainWindow, cueManagerInstance) {
    winRef = mainWindow;
    cmRef = cueManagerInstance;
    console.log('OSC Listener: Context set with mainWindow and cueManager.');
}

function initializeOscListener(port = 54321, enabled = false) {
    if (!enabled) {
        console.log('OSC Listener: OSC is disabled in config. Server not started.');
        if (oscServer) {
            stopOscListener(); // Ensure any existing server is stopped if disabled
        }
        return;
    }

    if (oscServer) {
        console.log('OSC Listener: Server already running. Shutting down to re-initialize.');
        stopOscListener();
    }

    try {
        oscServer = new Server(port, '0.0.0.0', () => {
            console.log(`OSC Listener: Server started and listening on port ${port}`);
        });

        oscServer.on('message', (msg) => {
            const address = msg[0];
            const args = msg.slice(1);
            // console.log(`OSC Listener: Received message - Address: ${address}, Args:`, args); // Keep for debugging if needed

            if (learnModeActive && learnSuccessCallback) {
                console.log(`OSC Listener: Message captured in learn mode: ${address}`);
                clearTimeout(learnModeTimeout);
                learnModeActive = false;
                const cb = learnSuccessCallback;
                learnSuccessCallback = null;
                learnFailCallback = null;
                cb(address); // Send back the address
                return; 
            }

            // If not in learn mode, try to trigger cues
            if (!learnModeActive) {
                // First, check if it's a WING-specific trigger message
                if (address.startsWith('/ac/trigger/wing/')) {
                    if (mixerIntegrationManager && typeof mixerIntegrationManager.handleIncomingWingTrigger === 'function') {
                        mixerIntegrationManager.handleIncomingWingTrigger(address, args);
                    } else {
                        console.warn('OSC Listener: Received WING trigger, but mixerIntegrationManager or handleIncomingWingTrigger is not available.');
                    }
                    return; // WING triggers are handled exclusively by the manager
                }
                
                // If not a WING trigger, proceed with standard cue OSC trigger matching
                if (!winRef || !cmRef) {
                    console.warn('OSC Listener: Cannot trigger cues, winRef or cmRef not set. Call setContext first.');
                    return;
                }

                const cues = cmRef.getCues();
                if (cues && cues.length > 0) {
                    // console.log(`OSC Listener: Checking ${cues.length} cues for OSC triggers for address: ${address}`);
                    for (const cue of cues) {
                        if (cue.oscTrigger && cue.oscTrigger.enabled && cue.oscTrigger.path === address) {
                            console.log(`OSC Listener: Triggering cue "${cue.name}" (ID: ${cue.id}) via toggle-audio-by-id for OSC path: ${address}`);
                            if (winRef && winRef.webContents && !winRef.webContents.isDestroyed()) {
                                winRef.webContents.send('toggle-audio-by-id', cue.id);
                            } else {
                                console.warn(`OSC Listener: Cannot send IPC message to trigger cue ${cue.id}, mainWindow is not available or destroyed.`);
                            }
                            // Should we allow multiple cues to be triggered by the same OSC message?
                            // For now, let's assume only one cue per unique address, or trigger all matches.
                            // Current logic will trigger all matches. If only first match is desired, add a 'break;' here.
                        }
                    }
                }
            }
        });

        oscServer.on('error', (err) => {
            console.error('OSC Listener: Server error:', err);
            // Handle specific errors like EADDRINUSE if needed
            if (err.code === 'EADDRINUSE') {
                console.error(`OSC Listener: Port ${port} is already in use. OSC server could not start.`);
                // Optionally, notify the UI or try another port if that's a desired feature
            }
            oscServer = null; // Ensure server instance is cleared on error
        });

        // Note: 'listening' event is handled by the callback in new Server(...)
        // 'close' event could be handled if explicit server.close() is called and needs cleanup.

    } catch (error) {
        console.error('OSC Listener: Failed to create OSC server:', error);
        oscServer = null;
    }
}

function stopOscListener() {
    if (oscServer) {
        try {
            const serverToClose = oscServer; // Capture instance before nulling
            oscServer = null; // Set to null immediately
            console.log('OSC Listener: Initiated server close. oscServer is now null.');

            serverToClose.close(() => {
                console.log('OSC Listener: Server close operation completed successfully.');
                // oscServer = null; // Already nulled
            });
        } catch (error) {
            console.error('OSC Listener: Error trying to close OSC server:', error);
            oscServer = null; // Ensure it's cleared even if close throws initially
        }
    } else {
        console.log('OSC Listener: Server not running, no action to stop.');
    }
}

// Function to update the listener, e.g., if port changes in config
function updateOscSettings(newPort, enabled) {
    if (!enabled) {
        stopOscListener();
        return;
    }
    // If port is different or server not running, re-initialize
    if (!oscServer || (oscServer && oscServer.port !== newPort) || (oscServer && !oscServer._sock)) {
        console.log(`OSC Listener: Updating settings - New Port: ${newPort}, Enabled: ${enabled}`);
        initializeOscListener(newPort, enabled);
    } else if (oscServer && oscServer.port === newPort && oscServer._sock) {
        console.log('OSC Listener: Settings (port and enabled status) already up to date. OSC server should be running if enabled.');
    } else {
        // This case should ideally not be hit if logic is correct, but as a fallback:
        console.log('OSC Listener: Settings appear to be different but not covered by main conditions, re-initializing.');
        initializeOscListener(newPort, enabled);
    }
}

function enterLearnMode(onSuccess, onFail) {
    console.log('OSC Listener (enterLearnMode): Checking server status.');
    console.log('OSC Listener (enterLearnMode): oscServer object:', oscServer);
    if (oscServer) {
        console.log('OSC Listener (enterLearnMode): oscServer._slskit_server object:', oscServer._slskit_server);
        if (oscServer._slskit_server) {
            console.log('OSC Listener (enterLearnMode): oscServer._slskit_server.address():', oscServer._slskit_server.address());
        }
    }

    if (learnModeActive) {
        console.warn('OSC Listener: Learn mode already active. New request ignored or previous one cancelled.');
        if (learnFailCallback) {
            learnFailCallback('Learn mode re-initiated before completion.');
        }
        clearTimeout(learnModeTimeout);
    }

    if (!oscServer || (oscServer && !oscServer._sock)) {
        console.warn('OSC Listener: Cannot enter learn mode, server is not running or not enabled (detailed check failed - no _sock).');
        if (onFail) onFail('OSC server not running.');
        return;
    }

    console.log(`OSC Listener: Entering learn mode for ${LEARN_MODE_TIMEOUT_MS / 1000} seconds.`);
    learnModeActive = true;
    learnSuccessCallback = onSuccess;
    learnFailCallback = onFail;

    learnModeTimeout = setTimeout(() => {
        if (learnModeActive) {
            console.warn('OSC Listener: Learn mode timed out.');
            learnModeActive = false;
            if (learnFailCallback) {
                learnFailCallback('Learn mode timed out. No OSC message received.');
            }
            learnSuccessCallback = null;
            learnFailCallback = null;
        }
    }, LEARN_MODE_TIMEOUT_MS);
}

module.exports = {
    initializeOscListener,
    stopOscListener,
    updateOscSettings,
    enterLearnMode,
    setContext
    // We might export the server instance itself if other modules need direct access,
    // but for now, encapsulating it is cleaner.
}; 