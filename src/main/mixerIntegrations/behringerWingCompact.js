const nodeOsc = require('node-osc');

let wingClient = null; // For sending commands to WING
let wingSubscriptionServer = null; // For receiving subscription data from WING
let wingCompactSubscriptionKeepAliveInterval = null;

const WING_COMPACT_DEFAULT_REMOTE_PORT = 2223; // WING's listening port for commands
const WING_COMPACT_SUBSCRIPTION_LOCAL_LISTEN_PORT = 23457; // Port our app listens on for WING Compact subscriptions
const WING_COMPACT_SUBSCRIPTION_KEEP_ALIVE_MS = 8000;

let currentWingCompactConfig = {};
let mainWindowRef = null;
let cueManagerRef = null;

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
 * This function is called when the app configuration changes or on initial load.
 * @param {object} newConfig - The new application configuration.
 */
function updateSettings(newConfig) {
    const oldConfig = { ...currentWingCompactConfig };
    currentWingCompactConfig = newConfig; // This should be the app-wide config object
    console.log('BehringerWingCompact: Settings updated', currentWingCompactConfig);

    stop(); // Clean up existing connections before applying new settings

    // Simplified check: The main mixerIntegrationManager is responsible for ensuring this module is loaded for the correct type.
    // We just need to ensure integration is enabled and IP is present.
    if (!currentWingCompactConfig.mixerIntegrationEnabled) {
        console.log('BehringerWingCompact: WING Compact integration disabled in current config (mixerIntegrationEnabled is false).');
        return;
    }

    if (!currentWingCompactConfig.wingIpAddress) {
        console.warn('BehringerWingCompact: WING Compact selected, but no IP address configured.');
        return;
    }

    console.log(`BehringerWingCompact: Initializing for WING Compact. Target IP: ${currentWingCompactConfig.wingIpAddress}.`);

    // Check if node-osc and its necessary components (Client, Server, Message) are available
    if (!nodeOsc || typeof nodeOsc.Client !== 'function' || typeof nodeOsc.Server !== 'function' || typeof nodeOsc.Message !== 'function') {
        console.error('[INIT ERROR] BehringerWingCompact: node-osc or required components (Client, Server, Message) are not correctly initialized.');
        // (Further diagnostic logs could be added here if needed)
        return; // Stop further execution
    }

    try {
        // Setup Client for sending
        wingClient = new nodeOsc.Client(currentWingCompactConfig.wingIpAddress, WING_COMPACT_DEFAULT_REMOTE_PORT);
        console.log(`BehringerWingCompact: WING OSC Client created for ${currentWingCompactConfig.wingIpAddress}:${WING_COMPACT_DEFAULT_REMOTE_PORT}.`);

        // Setup Server for listening to subscriptions
        wingSubscriptionServer = new nodeOsc.Server(WING_COMPACT_SUBSCRIPTION_LOCAL_LISTEN_PORT, '0.0.0.0', () => {
            console.log(`BehringerWingCompact: WING Subscription OSC Server listening on port ${WING_COMPACT_SUBSCRIPTION_LOCAL_LISTEN_PORT}.`);
            establishWingCompactSubscription(); // Now that server is listening, tell WING to send here
        });

        wingSubscriptionServer.on('message', (msg, rinfo) => {
            // VERY VERBOSE LOG: Dump all incoming messages to see if anything arrives from WING
            console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
            console.log(`BehringerWingCompact: RAW OSC MESSAGE RECEIVED ON PORT ${WING_COMPACT_SUBSCRIPTION_LOCAL_LISTEN_PORT}`);
            console.log(`  FROM: ${rinfo ? rinfo.address : 'N/A'}:${rinfo ? rinfo.port : 'N/A'}`);
            console.log(`  RAW MSG ARRAY:`, JSON.stringify(msg));
            console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);

            const address = msg && msg.length > 0 ? msg[0] : '[no address in msg array]';
            const rawArgs = msg && msg.length > 1 ? msg.slice(1) : [];
            
            // console.log(`BehringerWingCompact: OSC Message Received via Subscription Server from ${rinfo.address}:${rinfo.port} - Path: ${address}, Args: ${JSON.stringify(rawArgs)}`);

            // Regex for WING Compact user button presses (numerical layer/index)
            const wingButtonPressRegex = new RegExp("^/\$ctl/user/(\d+)/(\d+)/bu/val$");
            const wingButtonPressMatch = address.match(wingButtonPressRegex);

            if (wingButtonPressMatch && rawArgs.length > 0) {
                let pressed = false;
                // WING Compact sends float 1.0 for press, 0.0 for release for /bu/val
                if (typeof rawArgs[0] === 'number' && rawArgs[0] !== 0) { 
                    pressed = true;
                }
                if (pressed) {
                    const [, wingLayerStr, wingIndexStr] = wingButtonPressMatch;
                    // Pass 'bu' as type, as our regex is specific to /bu/val
                    handleSubscribedWingCompactButtonPress(wingLayerStr, wingIndexStr, 'bu');
                    return; 
                }
            }
            // Add other specific WING Compact message handling here if needed (e.g., /name updates, /col updates)
        });

        wingSubscriptionServer.on('error', (err) => {
            console.error(`BehringerWingCompact: WING Subscription OSC Server error:`, err);
            if (err.code === 'EADDRINUSE') {
                console.error(`BehringerWingCompact: Port ${WING_COMPACT_SUBSCRIPTION_LOCAL_LISTEN_PORT} is already in use for WING subscriptions.`);
            }
            stop(); // Clean up on server error
        });
        
        // Initial WING button setup now client/server are being set up
        triggerInitialCueMixerTriggers();

    } catch (error) {
        console.error(`BehringerWingCompact: Error setting up WING Compact OSC Client/Server:`, error);
        stop(); // Cleanup if init fails badly
    }
}

function stop() {
    console.log('BehringerWingCompact: Stopping and cleaning up WING Compact connections.');
    if (wingCompactSubscriptionKeepAliveInterval) {
        clearInterval(wingCompactSubscriptionKeepAliveInterval);
        wingCompactSubscriptionKeepAliveInterval = null;
        console.log('BehringerWingCompact: WING subscription keep-alive cleared.');
    }
    if (wingSubscriptionServer) {
        console.log('BehringerWingCompact: Closing WING Subscription OSC Server.');
        try {
            const serverToClose = wingSubscriptionServer;
            wingSubscriptionServer = null; 
            serverToClose.close(() => {
                console.log('BehringerWingCompact: WING Subscription OSC Server closed successfully.');
            });
        } catch (e) {
            console.error('BehringerWingCompact: Error closing WING Subscription OSC Server:', e);
            wingSubscriptionServer = null; 
        }
    }
    if (wingClient) {
        console.log('BehringerWingCompact: Closing WING OSC Client.');
        wingClient = null; 
    }
}

function sendOsc(address, ...oscArgs) {
    if (!wingClient) {
        console.warn('BehringerWingCompact: WING Compact OSC Client not initialized. Cannot send OSC.');
        return;
    }
    if (typeof nodeOsc.Message !== 'function') {
        console.error('BehringerWingCompact: nodeOsc.Message is not a constructor! Cannot send OSC.');
        return;
    }
    
    // console.log(`BehringerWingCompact: Sending OSC via Client - Address: ${address}, Args: ${JSON.stringify(oscArgs)}`);
    try {
        const message = new nodeOsc.Message(address);
        oscArgs.forEach(arg => message.append(arg));
        
        wingClient.send(message, (err) => {
            if (err) {
                console.error(`BehringerWingCompact: Error reported by node-osc client.send for ${address}:`, err);
            }
        });
    } catch (error) {
        console.error(`BehringerWingCompact: Error sending OSC message (${address} ${oscArgs.join(' ')}):`, error);
    }
}

function establishWingCompactSubscription() {
    if (!wingClient) { 
        console.warn('BehringerWingCompact: Cannot establish WING Compact subscription, OSC client not ready.');
        return;
    }
    // Server readiness is implied by this function being called from its 'listening' callback or by triggerInitial.

    const sendSubscriptionCommand = () => {
        if (wingClient) { 
            // Aligning with WING Compact: /%<PORT>/*S and user-provided WING doc: /%<PORT>/*S~
            const subscriptionPath = `/%${WING_COMPACT_SUBSCRIPTION_LOCAL_LISTEN_PORT}/*S~`; 
            sendOsc(subscriptionPath); 
            console.log(`BehringerWingCompact: Sent WING Compact subscription command: ${subscriptionPath}. Will renew in ${WING_COMPACT_SUBSCRIPTION_KEEP_ALIVE_MS / 1000}s.`);
        } else {
            console.warn('BehringerWingCompact: WING client gone. Stopping subscription keep-alive.');
            if (wingCompactSubscriptionKeepAliveInterval) {
                clearInterval(wingCompactSubscriptionKeepAliveInterval);
                wingCompactSubscriptionKeepAliveInterval = null;
            }
        }
    };

    if (wingCompactSubscriptionKeepAliveInterval) {
        clearInterval(wingCompactSubscriptionKeepAliveInterval);
    }
    sendSubscriptionCommand(); 
    wingCompactSubscriptionKeepAliveInterval = setInterval(sendSubscriptionCommand, WING_COMPACT_SUBSCRIPTION_KEEP_ALIVE_MS);
}

function appButtonIdToWingCompactPhysicalId(appButtonId) {
    if (!appButtonId || typeof appButtonId !== 'string') {
        console.warn(`BehringerWingCompact: appButtonIdToWingCompactPhysicalId - Invalid appButtonId: ${appButtonId}`);
        return null;
    }
    const parts = appButtonId.split('_');
    if (parts.length !== 2) {
        console.warn(`BehringerWingCompact: Invalid appButtonId format. Expected 2 parts (layerX_buttonY), got: ${appButtonId}`);
        return null;
    }
    const layerStr = parts[0].replace('layer', '');
    const buttonStr = parts[1].replace('button', '');
    const layerNum = parseInt(layerStr, 10);
    const buttonNum = parseInt(buttonStr, 10);

    // WING Compact user layers 0-3, buttons 0-3 (for OSC paths)
    // App model seems to be layer 1-4, button 1-4
    if (isNaN(layerNum) || isNaN(buttonNum) || layerNum < 1 || layerNum > 4 || buttonNum < 1 || buttonNum > 4) {
        console.warn(`BehringerWingCompact: Invalid layer/button number in appButtonId: ${appButtonId}. Parsed App L:${layerNum}, B:${buttonNum}`);
        return null;
    }
    const wingLayer = layerNum - 1; // Convert app 1-4 to WING 0-3
    const wingIndex = buttonNum - 1; // Convert app 1-4 to WING 0-3
    
    const oscPropertyBase = 'bu'; // For WING Compact, user buttons are typically under /bu/
    return {
        layer: wingLayer, // numerical layer 0-3
        index: wingIndex, // numerical index 0-3
        oscNamePath: `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/name`,
        oscColorPath: `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/col`,
        oscLedStatePath: `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/bl`,
        appButtonId: appButtonId // Keep original for reference
    };
}

function wingCompactPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStrOrType) {
    const wingLayer = parseInt(wingLayerStr, 10); // Expecting numerical string "0"-"3"
    const wingIndex = parseInt(wingIndexStr, 10); // Expecting numerical string "0"-"3"

    if (isNaN(wingLayer) || isNaN(wingIndex) || wingLayer < 0 || wingLayer > 3 || wingIndex < 0 || wingIndex > 3) {
        console.warn(`BehringerWingCompact: Invalid WING Compact physical ID parts: Layer=${wingLayerStr}, Index=${wingIndexStr}`);
        return null;
    }
    // wingRowStrOrType is 'bu' from our regex, can be ignored or validated if more types are handled
    
    const appLayer = wingLayer + 1; // Convert WING 0-3 to app 1-4
    const appButtonNum = wingIndex + 1; // Convert WING 0-3 to app 1-4
    return `layer${appLayer}_button${appButtonNum}`;
}

function handleSubscribedWingCompactButtonPress(wingLayerStr, wingIndexStr, wingTypeStr) {
    const appButtonId = wingCompactPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingTypeStr);
    if (!appButtonId) {
        console.warn(`BehringerWingCompact: Could not map WING Compact physical button (L:${wingLayerStr} I:${wingIndexStr} Type:${wingTypeStr}) to appButtonId.`);
        return;
    }
    console.log(`BehringerWingCompact: Mapped WING Compact press (L:${wingLayerStr} I:${wingIndexStr} Type:${wingTypeStr}) to appButtonId: ${appButtonId}. Triggering cue.`);
    if (cueManagerRef && typeof cueManagerRef.triggerCueByMixerButtonId === 'function') {
        // 'behringer_wing_compact' should match the mixerType key used in cueManager or appConfig
        cueManagerRef.triggerCueByMixerButtonId(appButtonId, 'behringer_wing_compact');
    } else {
        console.error('BehringerWingCompact: cueManagerRef or triggerCueByMixerButtonId is not available.');
    }
}

function configureButton(appButtonId, label, colorName, isActive) {
    // cueId parameter removed as it's not directly used for OSC messages here, label is used.
    if (!wingClient) { 
        console.warn('BehringerWingCompact: WING Compact OSC Client not initialized. Cannot configure button.');
        return;
    }
    const physicalId = appButtonIdToWingCompactPhysicalId(appButtonId);
    if (!physicalId) {
        console.warn(`BehringerWingCompact: Could not get physical ID for appButtonId: ${appButtonId} during configureButton.`);
        return;
    }
    console.log(`BehringerWingCompact: Configuring Compact button ${appButtonId} (WING L:${physicalId.layer} I:${physicalId.index}). Label: '${label}', Color: '${colorName}', Active: ${isActive}`);
    
    if (label && physicalId.oscNamePath) {
        // WING Compact button labels are typically short, ensure it fits. Max 11 chars observed.
        sendOsc(physicalId.oscNamePath, String(label).slice(0, 11));
    }
    
    const colorMap = { // Standard WING color map indices
        'off': 0, 'black': 0, 'red': 1, 'green': 2, 'yellow': 3, 'blue': 4,
        'magenta': 5, 'cyan': 6, 'white': 7, 'default': 0 
    };
    const wingColorIndex = colorMap.hasOwnProperty(colorName) ? colorMap[colorName.toLowerCase()] : colorMap['default'];
    
    if (physicalId.oscColorPath) {
        sendOsc(physicalId.oscColorPath, wingColorIndex);
    }

    if (physicalId.oscLedStatePath) {
        // LED state: 0 for off, 1-127 for on (often 127 for full brightness)
        // If button is not active or color is 'off', turn LED off. Otherwise, on.
        if (colorName.toLowerCase() === 'off' || !isActive) {
            sendOsc(physicalId.oscLedStatePath, 0); // LED Off
        } else {
            sendOsc(physicalId.oscLedStatePath, 127); // LED On (bright)
        }
    }
    // console.log(`BehringerWingCompact: Sent config to Compact for ${appButtonId}: Label='${label}', ColorIndex=${wingColorIndex}, ActiveState=${isActive ? 127 : 0}`);
}

// This function, adapted from the old mixerIntegrationManager, will iterate through cues
// and set up their corresponding WING Compact buttons.
function triggerInitialCueMixerTriggers() {
    if (!wingClient) { // Need client to send configuration
        console.warn('BehringerWingCompact: Wing client not ready, cannot trigger initial cue mixer triggers.');
        return;
    }
    if (!cueManagerRef || typeof cueManagerRef.getCues !== 'function') {
        console.warn('BehringerWingCompact: cueManagerRef or getCues is not available for initial button setup.');
        return;
    }

    const allCues = cueManagerRef.getCues();
    console.log(`BehringerWingCompact: Processing ${allCues.length} cues for initial WING Compact button setup.`);
    
    allCues.forEach(cue => {
        // IMPORTANT: This assumes a cue structure like:
        // cue.mixerButtonAssignment = { 
        //    mixerType: 'behringer_wing_compact', 
        //    buttonId: 'layer1_button1', // This is the appButtonId
        //    enabled: true 
        // }
        // And cue.name, cue.color for label and color.
        if (cue.mixerButtonAssignment && 
            cue.mixerButtonAssignment.mixerType === 'behringer_wing_compact' && 
            cue.mixerButtonAssignment.enabled && 
            cue.mixerButtonAssignment.buttonId) {
            
            const appButtonId = cue.mixerButtonAssignment.buttonId;
            const label = cue.name || ''; // Use cue name for label
            const color = cue.color || 'default'; // Use cue color, or a default
            const isActive = true; // If it has an enabled assignment, consider it active for setup

            console.log(`BehringerWingCompact: Initial setup for cue "${label}" on button ${appButtonId}`);
            configureButton(appButtonId, label, color, isActive);
        }
    });
}

// NEW Function to configure a physical button via OSC (Adapted from BehringerWingFull)
async function configurePhysicalWingButton(triggerData, assignedCC) {
    console.log(`BehringerWingCompact: Configuring physical button. TriggerData:`, triggerData, `AssignedCC: ${assignedCC}`);
    if (!wingClient) {
        console.error('BehringerWingCompact: WING client not available to configure button.');
        return { success: false, error: 'WING Compact client not available.' };
    }

    const layerMatch = triggerData.wingLayer ? String(triggerData.wingLayer).match(/layer(\d+)/i) : null;
    const buttonMatch = triggerData.wingButton ? String(triggerData.wingButton).match(/button(\d+)/i) : null;
    
    if (!layerMatch || !buttonMatch) {
        console.error('BehringerWingCompact: Could not parse layer/button from triggerData:', triggerData);
        return { success: false, error: 'Invalid layer/button format in triggerData for Compact.' };
    }

    // WING Compact app model layer 1-4, button 1-4. OSC expects 0-3.
    const appLayerNum = parseInt(layerMatch[1], 10);
    const appButtonNum = parseInt(buttonMatch[1], 10);

    if (isNaN(appLayerNum) || isNaN(appButtonNum) || appLayerNum < 1 || appLayerNum > 4 || appButtonNum < 1 || appButtonNum > 4) {
        console.error('BehringerWingCompact: Invalid app layer/button number after parsing:', { appLayerNum, appButtonNum }, 'Original triggerData:', triggerData);
        return { success: false, error: 'App layer/button number out of range for Compact (1-4).' };
    }

    const oscLayerNum = appLayerNum - 1; // Convert to 0-indexed for OSC
    const oscButtonNum = appButtonNum - 1; // Convert to 0-indexed for OSC
    const rowId = 'bu'; // WING Compact only has 'bu' row for user buttons of this type

    const basePath = `/$ctl/user/${oscLayerNum}/${oscButtonNum}/${rowId}`;
    const label = triggerData.label ? triggerData.label.substring(0, 16) : 'Cue'; // Max 16 chars for WING name

    try {
        // Set Mode to MIDI CC Push
        sendOsc(`${basePath}/mode`, "MIDICCP");
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        // Set MIDI CC Parameters for MIDICCP mode
        // $fname format for CC on WING is "CC <channel>:<cc_number>"
        // Assuming MIDI Channel 1 for simplicity here (matches Wing Full version's assumption)
        // MIDI channels on Wing UI are 1-16. OSC for $fname seems to use 1-based channel index directly.
        sendOsc(`${basePath}/$fname`, `CC 1:${assignedCC}`); 
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        sendOsc(`${basePath}/ch`, 1); // MIDI Channel 1 (for CH1 for the WING /midiccp/ch)
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        sendOsc(`${basePath}/val`, 127); // MIDI Value (typically 0-127, 127 for push on)
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        // Set Label (Name)
        sendOsc(`${basePath}/name`, label);
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        // Set Color (Example: Green)
        sendOsc(`${basePath}/col`, 6); // Assuming 6 is a green-like color, similar to Wing Full.
        // For Wing Compact, color indices might differ or be more limited. Refer to WING Compact OSC docs if specific colors are needed.
        
        console.log(`BehringerWingCompact: Successfully configured button ${appLayerNum}/${appButtonNum}/${rowId} for CC ${assignedCC} with label '${label}'.`);
        return { success: true, assignedCC: assignedCC, wingButtonId: `${triggerData.wingLayer}_${triggerData.wingButton}_${rowId}` };
    } catch (error) {
        console.error(`BehringerWingCompact: Error configuring physical WING Compact button:`, error);
        return { success: false, error: error.message };
    }
}

// NEW Function to clear a physical button configuration (Adapted from BehringerWingFull)
async function clearPhysicalWingButton(triggerData) {
    console.log('BehringerWingCompact: Clearing physical button configuration. TriggerData:', triggerData);
    if (!wingClient) {
        console.error('BehringerWingCompact: WING client not available to clear button.');
        return { success: false, error: 'WING Compact client not available.' };
    }

    const layerMatch = triggerData.wingLayer ? String(triggerData.wingLayer).match(/layer(\d+)/i) : null;
    const buttonMatch = triggerData.wingButton ? String(triggerData.wingButton).match(/button(\d+)/i) : null;

    if (!layerMatch || !buttonMatch) {
        console.error('BehringerWingCompact: Could not parse layer/button from triggerData for clearing:', triggerData);
        return { success: false, error: 'Invalid layer/button format in triggerData for Compact clearing.' };
    }

    const appLayerNum = parseInt(layerMatch[1], 10);
    const appButtonNum = parseInt(buttonMatch[1], 10);

    if (isNaN(appLayerNum) || isNaN(appButtonNum) || appLayerNum < 1 || appLayerNum > 4 || appButtonNum < 1 || appButtonNum > 4) {
        console.error('BehringerWingCompact: Invalid app layer/button number for clearing:', { appLayerNum, appButtonNum }, 'Original triggerData:', triggerData);
        return { success: false, error: 'App layer/button number out of range for Compact clearing (1-4).' };
    }

    const oscLayerNum = appLayerNum - 1;
    const oscButtonNum = appButtonNum - 1;
    const rowId = 'bu';

    const basePath = `/$ctl/user/${oscLayerNum}/${oscButtonNum}/${rowId}`;

    try {
        sendOsc(`${basePath}/mode`, "OFF"); // Set mode to OFF
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms
        sendOsc(`${basePath}/name`, "");    // Clear label
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms
        sendOsc(`${basePath}/col`, 0);     // Set color to default/off (usually 0 is black or default)
        
        console.log(`BehringerWingCompact: Successfully cleared button ${appLayerNum}/${appButtonNum}/${rowId}.`);
        return { success: true };
    } catch (error) {
        console.error(`BehringerWingCompact: Error clearing physical WING Compact button:`, error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initialize,
    updateSettings,
    stop,
    configureButton,
    triggerInitialCueMixerTriggers,
    sendOsc,
    configurePhysicalWingButton,
    clearPhysicalWingButton
};