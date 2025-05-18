// Companion_soundboard/src/main/mixerIntegrationManager.js
// Manages integration with various audio mixers like Behringer WING, Yamaha DM3, etc.

const nodeOsc = require('node-osc');
// TOP LEVEL logs confirmed nodeOsc.Client and nodeOsc.Server (via nodeOsc.Message) are functions.
// nodeOsc.UDPPort was undefined.

let currentConfig = {};
let mainWindowRef = null;
let cueManagerRef = null;

let wingClient = null; // For sending commands to WING
let wingSubscriptionServer = null; // For receiving subscription data from WING
let wingSubscriptionKeepAliveInterval = null;

const WING_DEFAULT_REMOTE_PORT = 2223; // WING's listening port for commands
const WING_SUBSCRIPTION_LOCAL_LISTEN_PORT = 23456; // Port our app listens on for WING subscriptions
const WING_SUBSCRIPTION_KEEP_ALIVE_MS = 8000;

/**
 * Initializes the Mixer Integration Manager.
 * @param {object} initialConfig - The initial application configuration.
 * @param {BrowserWindow} mainWindow - Reference to the main browser window.
 * @param {object} cueManager - Reference to the CueManager instance.
 */
function initialize(initialConfig, mainWindow, cueManager) {
    mainWindowRef = mainWindow;
    cueManagerRef = cueManager;
    updateSettings(initialConfig);
    console.log('MixerIntegrationManager: Initialized using Client/Server model.');
}

/**
 * Updates the settings for the mixer integration.
 * This function is called when the app configuration changes.
 * @param {object} newConfig - The new application configuration.
 */
function updateSettings(newConfig) {
    const oldConfig = { ...currentConfig };
    currentConfig = newConfig;
    console.log('MixerIntegrationManager: Settings updated', currentConfig);

    stopAndCleanupWingConnections();

    if (!currentConfig.mixerIntegrationEnabled || currentConfig.mixerType !== 'behringer_wing') {
        console.log('MixerIntegrationManager: WING integration disabled or not selected.');
        return;
    }

    if (!currentConfig.wingIpAddress) {
        console.warn('MixerIntegrationManager: WING selected, but no IP address configured.');
        return;
    }

    console.log(`MixerIntegrationManager: Behringer WING selected. IP: ${currentConfig.wingIpAddress}.`);

    try {
        // Setup Client for sending
        if (typeof nodeOsc.Client !== 'function') {
            console.error('MixerIntegrationManager: nodeOsc.Client is not a constructor!');
            throw new Error('nodeOsc.Client is not available');
        }
        wingClient = new nodeOsc.Client(currentConfig.wingIpAddress, WING_DEFAULT_REMOTE_PORT);
        console.log(`MixerIntegrationManager: WING OSC Client created for ${currentConfig.wingIpAddress}:${WING_DEFAULT_REMOTE_PORT}.`);

        // Setup Server for listening to subscriptions
        if (typeof nodeOsc.Server !== 'function') {
            console.error('MixerIntegrationManager: nodeOsc.Server is not a constructor!');
            throw new Error('nodeOsc.Server is not available');
        }
        wingSubscriptionServer = new nodeOsc.Server(WING_SUBSCRIPTION_LOCAL_LISTEN_PORT, '0.0.0.0', () => {
            console.log(`MixerIntegrationManager: WING Subscription OSC Server listening on port ${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT}.`);
            establishWingSubscription(); // Now that server is listening, tell WING to send here
        });

        wingSubscriptionServer.on('message', (msg, rinfo) => {
            // DIAGNOSTIC: Log all raw incoming subscription messages prominently
            console.log(">>>>>>>>>> MIM WING SUB RECV:", JSON.stringify(msg), "FROM:", rinfo ? `${rinfo.address}:${rinfo.port}` : "N/A");

            const address = msg && msg.length > 0 ? msg[0] : '[no address in msg array]';
            const rawArgs = msg && msg.length > 1 ? msg.slice(1) : [];

            console.log(`MixerIntegrationManager: WING Sub Server Parsed: ${address} Args: ${JSON.stringify(rawArgs)} From: ${rinfo ? rinfo.address : 'N/A'}:${rinfo ? rinfo.port : 'N/A'}`);
            
            if (address && address.startsWith('/ac/trigger/wing/')) {
                console.log("MixerIntegrationManager: Processing as direct /ac/trigger/wing/ message.");
                handleIncomingWingTrigger(address, rawArgs);
                return; 
            }

            const wingButtonPressRegex = new RegExp(/^\/\$ctl\/user\/U(\d+)\/(\d+)\/(bu|bd)\/val$/);            
            const wingButtonPressMatch = address.match(wingButtonPressRegex);
            if (wingButtonPressMatch && rawArgs.length > 0 && parseInt(String(rawArgs[0]), 10) === 127) { 
                const [, wingLayerStr, wingIndexStr, wingRowStr] = wingButtonPressMatch;
                // DIAGNOSTIC: Log parameters before calling handleSubscribedWingButtonPress
                console.log(`MIM DIAGNOSTIC: Raw match from WING button press. LayerStr: ${wingLayerStr}, IndexStr: ${wingIndexStr}, RowStr: ${wingRowStr}. About to call handleSubscribedWingButtonPress.`);
                handleSubscribedWingButtonPress(wingLayerStr, wingIndexStr, wingRowStr);
                return; 
            }

            if (address.includes('/$ctl/user/') && address.endsWith('/name')) {
                 console.log(`MixerIntegrationManager: Detected WING User Button Name/Label update: ${address} -> ${rawArgs[0]}`);
            }
        });

        wingSubscriptionServer.on('error', (err) => {
            console.error(`MixerIntegrationManager: WING Subscription OSC Server error:`, err);
            if (err.code === 'EADDRINUSE') {
                console.error(`MixerIntegrationManager: Port ${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT} is already in use for WING subscriptions.`);
            }
            stopAndCleanupWingConnections();
        });
        
        // Initial WING button setup now client is ready (server might not be ready yet)
        triggerInitialCueMixerTriggers();

    } catch (error) {
        console.error(`MixerIntegrationManager: Error setting up WING Client/Server:`, error);
        stopAndCleanupWingConnections();
    }
}

function triggerInitialCueMixerTriggers() {
    if (!wingClient) return; // Need client to send
    if (cueManagerRef) {
        const allCues = cueManagerRef.getCues ? cueManagerRef.getCues() : [];
        console.log(`MixerIntegrationManager: Processing ${allCues.length} cues for initial WING button setup.`);
        allCues.forEach(cue => {
            if (cue.wingTrigger && cue.wingTrigger.enabled && cue.wingTrigger.userButton) {
                updateCueMixerTrigger(cue);
            }
        });
    } else {
        console.warn('MixerIntegrationManager: cueManagerRef not available for initial WING button setup.');
    }
}

function sendWingOsc(address, ...oscArgs) {
    if (wingClient) {
        if (typeof nodeOsc.Message !== 'function') {
            console.error('MixerIntegrationManager: nodeOsc.Message is not a constructor!');
            throw new Error('nodeOsc.Message not available');
        }
        const message = new nodeOsc.Message(address);
        // Let node-osc infer types from the arguments themselves
        oscArgs.forEach(arg => message.append(arg));

        try {
            console.log(`MixerIntegrationManager: Attempting to send OSC to WING: Addr=${address} Args=${JSON.stringify(oscArgs)}`);
            wingClient.send(message, (err) => { 
                if (err) {
                    console.error(`MixerIntegrationManager: Error reported by node-osc client.send for ${address}:`, err);
                } 
            });
        } catch (error) {
            console.error(`MixerIntegrationManager: Exception during wingClient.send for ${address}:`, error);
        }
    } else {
        console.warn(`MixerIntegrationManager: WING client not available. Cannot send OSC: ${address}`, oscArgs);
    }
}

function updateCueMixerTrigger(cue) {
    if (!currentConfig.mixerIntegrationEnabled || currentConfig.mixerType !== 'behringer_wing' || !wingClient || !cue || !cue.id) {
        return;
    }
    const appButtonId = cue.wingTrigger ? parseInt(String(cue.wingTrigger.userButton), 10) : null;

    if (appButtonId && appButtonId >= 1 && appButtonId <= 16) {
        const physicalId = appButtonIdToWingPhysicalId(appButtonId);
        if (!physicalId) {
            console.warn(`MIM: updateCueMixerTrigger - Could not get physical ID for App Button ${appButtonId}`);
            return;
        }

        const basePath = `/$ctl/user/${physicalId.layer}/${physicalId.index}/${physicalId.row}`;

        if (cue.wingTrigger && cue.wingTrigger.enabled) {
            const uniqueButtonName = `ACue${appButtonId}`.substring(0, 15);
            
            console.log(`MIM: updateCueMixerTrigger - Setting WING User Button (${physicalId.layer}, Index ${physicalId.index}, Row ${physicalId.row} - App ID: ${appButtonId}) for Cue '${cue.name}'. Name: '${uniqueButtonName}', Mode: MIDICCP.`);
            
            sendWingOsc(`${basePath}/mode`, 'MIDICCP');
            sendWingOsc(`${basePath}/ch`, appButtonId); 
            sendWingOsc(`${basePath}/cc`, appButtonId); 
            sendWingOsc(`${basePath}/val`, 127);
            sendWingOsc(`${basePath}/name`, uniqueButtonName);
        } else {
            console.log(`MIM: updateCueMixerTrigger - Clearing WING User Button (${physicalId.layer}, Index ${physicalId.index}, Row ${physicalId.row} - App ID: ${appButtonId}, previously for Cue '${cue.name}')`);
            sendWingOsc(`${basePath}/name`, ''); 
            sendWingOsc(`${basePath}/ch`, 0); 
            sendWingOsc(`${basePath}/cc`, 0); 
            sendWingOsc(`${basePath}/val`, 0);
        }
    }
}

function handleIncomingWingTrigger(address, args) {
    if (!currentConfig.mixerIntegrationEnabled || currentConfig.mixerType !== 'behringer_wing' || !mainWindowRef || !cueManagerRef) {
        return;
    }
    console.log(`MixerIntegrationManager: handleIncomingWingTrigger checking: ${address}`, args);
    const match = address.match(/^\/ac\/trigger\/wing\/(\d+)$/);
    if (!match || !match[1]) return;
    const buttonId = parseInt(match[1], 10);
    if (isNaN(buttonId)) return;

    const cues = cueManagerRef.getAllCues ? cueManagerRef.getAllCues() : (cueManagerRef.getCues ? cueManagerRef.getCues() : []);
    const matchedCue = cues.find(cue => 
        cue.wingTrigger && 
        cue.wingTrigger.enabled && 
        parseInt(String(cue.wingTrigger.userButton), 10) === buttonId
    );
    if (matchedCue) {
        console.log(`MixerIntegrationManager: WING User Button ${buttonId} triggered Cue ID: ${matchedCue.id} ('${matchedCue.name}').`);
        if (mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.webContents) {
            mainWindowRef.webContents.send('toggle-audio-by-id', matchedCue.id);
        }
    }
}

function establishWingSubscription() {
    if (!wingClient) {
        console.warn('MixerIntegrationManager: WING client not available for subscription.');
        return;
    }
    if (!wingSubscriptionServer || !wingSubscriptionServer.sockets || Object.keys(wingSubscriptionServer.sockets).length === 0) {
        console.warn('MixerIntegrationManager: WING subscription server not ready for subscription.');
        // This might be called before server is fully 'listening' if not careful with callbacks.
        // The call is now from server's listening callback, so this should be fine.
    }

    const sendSubscriptionCommand = () => {
        if (wingClient) {
            const subscribeAddress = `/%${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT}/*S`; // Tell WING to send to our server port, use *S
            console.log(`MixerIntegrationManager: Sending WING subscription/keep-alive: ${subscribeAddress}`);
            sendWingOsc(subscribeAddress); 
        } else {
            console.warn('MixerIntegrationManager: WING client gone. Stopping subscription keep-alive.');
            if (wingSubscriptionKeepAliveInterval) {
                clearInterval(wingSubscriptionKeepAliveInterval);
                wingSubscriptionKeepAliveInterval = null;
            }
        }
    };

    sendSubscriptionCommand(); // Initial
    if (wingSubscriptionKeepAliveInterval) clearInterval(wingSubscriptionKeepAliveInterval);
    wingSubscriptionKeepAliveInterval = setInterval(sendSubscriptionCommand, WING_SUBSCRIPTION_KEEP_ALIVE_MS);
    console.log(`MixerIntegrationManager: WING subscription keep-alive to port ${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT} initiated.`);
}

function stopAndCleanupWingConnections() {
    if (wingSubscriptionKeepAliveInterval) {
        clearInterval(wingSubscriptionKeepAliveInterval);
        wingSubscriptionKeepAliveInterval = null;
        console.log('MixerIntegrationManager: WING subscription keep-alive cleared.');
    }
    if (wingSubscriptionServer) {
        console.log('MixerIntegrationManager: Closing WING Subscription OSC Server.');
        try { wingSubscriptionServer.close(); } catch (e) { console.error('Error closing WING Sub Server:', e); }
        wingSubscriptionServer = null;
    }
    if (wingClient) {
        console.log('MixerIntegrationManager: Closing WING OSC Client.');
        // node-osc Client doesn't have a close method in the same way Server/UDPPort do.
        // Nullifying it should be sufficient to stop further sends and let it be GC'd.
        wingClient = null;
    }
}

// ===== START NEW/CORRECTED MAPPING FUNCTIONS =====
function appButtonIdToWingPhysicalId(appButtonId) {
    // console.log("ATTEMPTING 4-LAYER MAPPING - appButtonIdToWingPhysicalId - App ID:", appButtonId); // Keep this or similar
    console.log("MIM: appButtonIdToWingPhysicalId - CALLED WITH App ID:", appButtonId); // Ensure this log is active and clear
    if (appButtonId < 1 || appButtonId > 16) {
        console.warn("MIM: appButtonIdToWingPhysicalId - appButtonId out of range:", appButtonId);
        return null;
    }

    const wingLayerNumber = Math.ceil(appButtonId / 4);         // e.g., AppID 1-4 -> L1; 5-8 -> L2; 9-12 -> L3; 13-16 -> L4
    const wingIndexInLayer = ((appButtonId - 1) % 4) + 1;    // e.g., AppID 1,5,9,13 -> Idx1; 2,6,10,14 -> Idx2; etc.
    const wingRow = 'bu'; // Always 'bu' for WING Compact based on new logs

    const physicalId = {
        layer: `U${wingLayerNumber}`,
        index: wingIndexInLayer.toString(),
        row: wingRow
    };
    console.log("MIM: appButtonIdToWingPhysicalId - Calculated:", physicalId);
    return physicalId;
}

function wingPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStr) {
    // DIAGNOSTIC: Log parameters at the start of wingPhysicalToAppButtonId
    console.log(`MIM DIAGNOSTIC: wingPhysicalToAppButtonId CALLED - LayerStr: '${wingLayerStr}', IndexStr: '${wingIndexStr}', RowStr: '${wingRowStr}'`);

    // const wingLayerNum = parseInt(wingLayerStr.replace('U', ''), 10); // Original, might be okay
    const wingLayerNum = parseInt(String(wingLayerStr).replace('U', ''), 10); // Safer conversion
    const wingButtonIndexInLayer = parseInt(wingIndexStr, 10);

    if (isNaN(wingLayerNum) || isNaN(wingButtonIndexInLayer) || wingLayerNum < 1 || wingLayerNum > 4 || wingButtonIndexInLayer < 1 || wingButtonIndexInLayer > 4) {
        console.warn(`MIM: wingPhysicalToAppButtonId: Invalid layer/index: L${wingLayerNum}, I${wingButtonIndexInLayer}`);
        return null;
    }

    if (wingRowStr !== 'bu') {
        console.warn(`MIM: wingPhysicalToAppButtonId: Expected row 'bu', but got '${wingRowStr}' for L${wingLayerNum}, I${wingButtonIndexInLayer}. Processing as if 'bu'.`);
    }

    const appButtonId = ((wingLayerNum - 1) * 4) + wingButtonIndexInLayer;

    if (appButtonId < 1 || appButtonId > 16) {
        console.warn(`MIM: wingPhysicalToAppButtonId: Calculated appButtonId ${appButtonId} is out of range (1-16).`);
        return null;
    }
    console.log("MIM: wingPhysicalToAppButtonId - Mapped to App Button ID:", appButtonId);
    return appButtonId;
}
// ===== END NEW/CORRECTED MAPPING FUNCTIONS =====

// New handler for presses coming from the subscription stream
function handleSubscribedWingButtonPress(wingLayerStr, wingIndexStr, wingRowStr) {
    // DIAGNOSTIC: Log parameters at the start of handleSubscribedWingButtonPress
    console.log(`MIM DIAGNOSTIC: handleSubscribedWingButtonPress CALLED - LayerStr: '${wingLayerStr}', IndexStr: '${wingIndexStr}', RowStr: '${wingRowStr}'`);

    const appButtonId = wingPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStr);

    if (appButtonId !== null && appButtonId >= 1 && appButtonId <= 16) {
        console.log(`MixerIntegrationManager: WING physical button (L${wingLayerStr}, I${wingIndexStr}, R${wingRowStr}) mapped to App Button ID: ${appButtonId}`);

        const cues = cueManagerRef.getAllCues ? cueManagerRef.getAllCues() : (cueManagerRef.getCues ? cueManagerRef.getCues() : []);
        const matchedCue = cues.find(cue => 
            cue.wingTrigger && 
            cue.wingTrigger.enabled && 
            parseInt(String(cue.wingTrigger.userButton), 10) === appButtonId
        );

        if (matchedCue) {
            console.log(`MixerIntegrationManager: WING User Button press (App ID: ${appButtonId}) triggered Cue ID: ${matchedCue.id} ('${matchedCue.name}').`);
            if (mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.webContents) {
                mainWindowRef.webContents.send('toggle-audio-by-id', matchedCue.id);
            }
        } else {
            console.log(`MixerIntegrationManager: No active cue found for WING User Button press (App ID: ${appButtonId}).`);
        }
    }
}

module.exports = {
    initialize,
    updateSettings,
    sendWingOsc,
    updateCueMixerTrigger,
    handleIncomingWingTrigger,
    establishWingSubscription,
    stopAndCleanupWingConnections,
    appButtonIdToWingPhysicalId,
    wingPhysicalToAppButtonId,
    handleSubscribedWingButtonPress,
    triggerInitialCueMixerTriggers
}; 