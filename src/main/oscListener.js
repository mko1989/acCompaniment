const { Server } = require('node-osc');
const mixerIntegrationManager = require('./mixerIntegrationManager'); // May not be needed if all OSC handling moves to mixer modules

let oscServer = null;

// References to main window and cue manager - likely not needed here anymore
// let winRef = null;
// let cmRef = null;

// function setContext(mainWindow, cueManagerInstance) {
//     winRef = mainWindow;
//     cmRef = cueManagerInstance;
//     console.log('OSC Listener: Context set with mainWindow and cueManager.');
// }

// This function is called by appConfig.js when OSC settings change.
// If this listener is only for *mixer feedback that a mixer module ITSELF doesn't handle*,
// then its configuration might be tied to the mixer's config.
// For now, retain the ability to enable/disable it via general OSC settings.
function initializeOscListener(port = 54321, enabled = false) {
    if (!enabled) {
        console.log('OSC Listener: Main OSC listener is disabled in config or by request. Server not started.');
        if (oscServer) {
            stopOscListener();
        }
        return;
    }

    if (oscServer) {
        console.log('OSC Listener: Main OSC Server already running. Shutting down to re-initialize.');
        stopOscListener();
    }

    try {
        oscServer = new Server(port, '0.0.0.0', () => {
            console.log(`OSC Listener: Main OSC Server started and listening on port ${port}. This server is primarily for potential non-specific mixer feedback or other OSC utilities.`);
            console.log('OSC Listener: Note: Behringer WING and WING Compact use their own dedicated OSC servers for subscriptions.');
        });

        oscServer.on('message', (msg) => {
            const address = msg[0];
            const args = msg.slice(1);
            console.log(`OSC Listener: Received generic message - Address: ${address}, Args:`, args);
            // Generic OSC messages received on this main listener are currently only logged.
            // No cue triggering logic is present here anymore.
            // Specific mixer modules (like Behringer WING) handle their own OSC messages on their dedicated servers.

            // Example of how mixerIntegrationManager *could* be used if a mixer module didn't handle its own OSC:
            // if (mixerIntegrationManager && typeof mixerIntegrationManager.handleGenericOscFeedback === 'function') {
            //     mixerIntegrationManager.handleGenericOscFeedback(address, args);
            // }
        });

        oscServer.on('error', (err) => {
            console.error('OSC Listener: Main OSC Server error:', err);
            if (err.code === 'EADDRINUSE') {
                console.error(`OSC Listener: Port ${port} is already in use. Main OSC server could not start.`);
            }
            oscServer = null;
        });

    } catch (error) {
        console.error('OSC Listener: Failed to create Main OSC server:', error);
        oscServer = null;
    }
}

function stopOscListener() {
    if (oscServer) {
        try {
            const serverToClose = oscServer;
            oscServer = null;
            console.log('OSC Listener: Initiated Main OSC server close.');

            serverToClose.close(() => {
                console.log('OSC Listener: Main OSC Server close operation completed successfully.');
            });
        } catch (error) {
            console.error('OSC Listener: Error trying to close Main OSC server:', error);
            oscServer = null;
        }
    } else {
        // console.log('OSC Listener: Main OSC Server not running, no action to stop.');
    }
}

function updateOscSettings(newPort, enabled) {
    // If OSC is being disabled globally, ensure this main listener is stopped.
    if (!enabled) {
        console.log('OSC Listener: Global OSC disabled via updateOscSettings. Stopping main listener.');
        stopOscListener();
        return;
    }
    
    // If settings relevant to this main listener change (e.g. its specific port or enable state if separate from global)
    // For now, assume 'enabled' refers to this listener, and newPort is its port.
    if (!oscServer || (oscServer && oscServer.port !== newPort)) {
        console.log(`OSC Listener: Updating Main OSC settings - New Port: ${newPort}, Enabled: ${enabled}. Re-initializing.`);
        initializeOscListener(newPort, enabled);
    } else if (oscServer && oscServer.port === newPort) {
        console.log('OSC Listener: Main OSC settings (port) already up to date and server running.');
    } else {
        console.log('OSC Listener: Main OSC settings state unclear, re-initializing based on provided config.');
        initializeOscListener(newPort, enabled);
    }
}

// Learn mode and context for direct cue triggering removed.

/**
 * This function is intended to allow other modules (like a specific mixer integration
 * that doesn't manage its own OSC server) to route messages through this listener.
 * However, current WING integrations manage their own servers.
 */
function handleGenericOscMessage(address, args, rinfo, sourceDescription = 'unknown') {
    console.log(`OSC Listener (handleGenericOscMessage from ${sourceDescription}): Address: ${address}, Args: ${JSON.stringify(args)}, From: ${rinfo ? rinfo.address : 'N/A'}:${rinfo ? rinfo.port : 'N/A'}`);
    // This function can be expanded if a central processing point for some OSC messages is needed.
    // For example, routing to mixerIntegrationManager or other services.
}


module.exports = {
    initializeOscListener,
    stopOscListener,
    updateOscSettings,
    handleGenericOscMessage // Exporting this in case any module wants to use this as a central processing point
    // setContext, // Removed as cmRef and winRef are removed
    // enterLearnMode, // Removed
}; 