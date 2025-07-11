const nodeOsc = require('node-osc');

let wingClient = null; // For sending commands to WING
let wingSubscriptionServer = null; // For receiving subscription data from WING
let wingFullSubscriptionKeepAliveInterval = null;

// Constants from original behringerWing.js, potentially more accurate for Full WING
const WING_FULL_DEFAULT_REMOTE_PORT = 2223;
const WING_FULL_SUBSCRIPTION_LOCAL_LISTEN_PORT = 23458;
const WING_FULL_SUBSCRIPTION_KEEP_ALIVE_MS = 8000; // 8 seconds

let currentWingFullConfig = {};
let mainWindowRef = null;
let cueManagerRef = null;

/**
* Initializes the Mixer Integration Manager for WING Full.
* @param {object} initialConfig - The initial application configuration.
* @param {BrowserWindow} mainWindow - Reference to the main browser window.
* @param {object} cueManager - Reference to the CueManager instance.
*/
function initialize(initialConfig, mainWindow, cueManager) {
   mainWindowRef = mainWindow;
   cueManagerRef = cueManager;
   updateSettings(initialConfig);
   console.log('MixerIntegrationManager (WING Full): Initialized using Client/Server model.');
}

/**
 * Updates the settings for the WING Full integration.
 * This function is called when the app configuration changes or on initial load.
 * @param {object} newConfig - The new application configuration.
 */
function updateSettings(newConfig) {
    currentWingFullConfig = newConfig;
    console.log('BehringerWingFull: Settings updated', currentWingFullConfig);

    stop(); // Clean up existing connections before applying new settings

    if (!currentWingFullConfig.mixerIntegrationEnabled) {
        console.log('BehringerWingFull: WING Full integration disabled in current config (mixerIntegrationEnabled is false).');
        return;
    }

    if (!currentWingFullConfig.wingIpAddress) {
        console.warn('BehringerWingFull: WING Full selected, but no IP address configured.');
        return;
    }

    console.log(`BehringerWingFull: Initializing for WING Full. Target IP: ${currentWingFullConfig.wingIpAddress}.`);

    if (!nodeOsc || typeof nodeOsc.Client !== 'function' || typeof nodeOsc.Server !== 'function' || typeof nodeOsc.Message !== 'function') {
        console.error('[INIT ERROR] BehringerWingFull: node-osc or required components (Client, Server, Message) are not correctly initialized.');
        return;
    }

    try {
        wingClient = new nodeOsc.Client(currentWingFullConfig.wingIpAddress, WING_FULL_DEFAULT_REMOTE_PORT);
        console.log(`BehringerWingFull: WING OSC Client created for ${currentWingFullConfig.wingIpAddress}:${WING_FULL_DEFAULT_REMOTE_PORT}.`);

        wingSubscriptionServer = new nodeOsc.Server(WING_FULL_SUBSCRIPTION_LOCAL_LISTEN_PORT, '0.0.0.0', () => {
            console.log(`BehringerWingFull: WING Subscription OSC Server listening on port ${WING_FULL_SUBSCRIPTION_LOCAL_LISTEN_PORT}.`);
            establishWingFullSubscription();
        });

        wingSubscriptionServer.on('message', (msg, rinfo) => {
            console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
            console.log(`BehringerWingFull: RAW OSC MESSAGE RECEIVED ON PORT ${WING_FULL_SUBSCRIPTION_LOCAL_LISTEN_PORT}`);
            console.log(`  FROM: ${rinfo ? rinfo.address : 'N/A'}:${rinfo ? rinfo.port : 'N/A'}`);
            console.log(`  RAW MSG ARRAY:`, JSON.stringify(msg));
            console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);

            const address = msg && msg.length > 0 ? msg[0] : '[no address in msg array]';
            const rawArgs = msg && msg.length > 1 ? msg.slice(1) : [];
            
            // Updated Regex and logic from original behringerWing.js for user button presses
            // WING Full user button presses (numerical layer/index)
            // Format: /$ctl/user/<layer_0_15>/<index_0_3>/<bu_or_bd>/val
            // Value for press appears to be 127 (from original behringerWing.js observation)
            // Value for release might be 0 or different.
            const wingButtonPressRegex = /^\/\$ctl\/user\/(\d+)\/(\d+)\/(bu|bd)\/val$/;
            const wingButtonPressMatch = address.match(wingButtonPressRegex);

            // Original behringerWing.js checked for rawArgs[0] === 127 (as integer)
            // The compact version checked for !== 0 (as float 1.0)
            // Let's use the 127 check, assuming it's more specific to the full WING's user buttons.
            if (wingButtonPressMatch && rawArgs.length > 0 && parseInt(String(rawArgs[0]), 10) === 127) {
                let pressed = true; 
                // if (typeof rawArgs[0] === 'number' && rawArgs[0] === 127) { // Original used parseInt(String(rawArgs[0]), 10)
                //     pressed = true;
                // }
                if (pressed) {
                    const [, wingLayerStr, wingIndexStr, wingRowStr] = wingButtonPressMatch;
                    handleSubscribedWingFullButtonPress(wingLayerStr, wingIndexStr, wingRowStr); 
                    return; 
                }
            }
            // TODO: Add handling for other WING Full specific messages if necessary (e.g., channel mutes, fader movements if needed by app)
        });

        wingSubscriptionServer.on('error', (err) => {
            console.error(`BehringerWingFull: WING Subscription OSC Server error:`, err);
            if (err.code === 'EADDRINUSE') {
                console.error(`BehringerWingFull: Port ${WING_FULL_SUBSCRIPTION_LOCAL_LISTEN_PORT} is already in use for WING subscriptions.`);
            }
            stop();
        });
        
        triggerInitialCueMixerTriggers();

    } catch (error) {
        console.error(`BehringerWingFull: Error setting up WING Full OSC Client/Server:`, error);
        stop();
    }
}

function stop() {
    console.log('BehringerWingFull: Stopping and cleaning up WING Full connections.');
    if (wingFullSubscriptionKeepAliveInterval) {
        clearInterval(wingFullSubscriptionKeepAliveInterval);
        wingFullSubscriptionKeepAliveInterval = null;
        console.log('BehringerWingFull: WING subscription keep-alive cleared.');
    }
    if (wingSubscriptionServer) {
        console.log('BehringerWingFull: Closing WING Subscription OSC Server.');
        try {
            const serverToClose = wingSubscriptionServer;
            wingSubscriptionServer = null; 
            serverToClose.close(() => {
                console.log('BehringerWingFull: WING Subscription OSC Server closed successfully.');
            });
        } catch (e) {
            console.error('BehringerWingFull: Error closing WING Subscription OSC Server:', e);
            wingSubscriptionServer = null; 
        }
    }
    if (wingClient) {
        // node-osc client doesn't have a .close() method. Setting to null is sufficient for cleanup.
        console.log('BehringerWingFull: Releasing WING OSC Client.');
        wingClient = null; 
    }
}

function sendOsc(address, ...oscArgs) {
    if (!wingClient) {
        console.warn('BehringerWingFull: WING Full OSC Client not initialized. Cannot send OSC.');
        return;
    }
    if (typeof nodeOsc.Message !== 'function') {
        console.error('BehringerWingFull: nodeOsc.Message is not a constructor! Cannot send OSC.');
        return;
    }
    
    try {
        const message = new nodeOsc.Message(address);
        oscArgs.forEach(arg => message.append(arg));
        
        wingClient.send(message, (err) => {
            if (err) {
                console.error(`BehringerWingFull: Error reported by node-osc client.send for ${address}:`, err);
            }
        });
    } catch (error) {
        console.error(`BehringerWingFull: Error sending OSC message (${address} ${oscArgs.join(' ')}):`, error);
    }
}

function establishWingFullSubscription() {
    if (!wingClient) { 
        console.warn('BehringerWingFull: Cannot establish WING Full subscription, OSC client not ready.');
        return;
    }

    const sendSubscriptionCommand = () => {
        if (wingClient) { 
            // Aligning with WING Compact: /%<PORT>/*S and user-provided WING doc: /%<PORT>/*S~
            const subscriptionPath = `/%${WING_FULL_SUBSCRIPTION_LOCAL_LISTEN_PORT}/*S~`; 
            sendOsc(subscriptionPath); 
            console.log(`BehringerWingFull: Sent WING Full subscription command: ${subscriptionPath}. Will renew in ${WING_FULL_SUBSCRIPTION_KEEP_ALIVE_MS / 1000}s.`);
        } else {
            console.warn('BehringerWingFull: WING client gone. Stopping subscription keep-alive.');
            if (wingFullSubscriptionKeepAliveInterval) {
                clearInterval(wingFullSubscriptionKeepAliveInterval);
                wingFullSubscriptionKeepAliveInterval = null;
            }
        }
    };

    if (wingFullSubscriptionKeepAliveInterval) {
        clearInterval(wingFullSubscriptionKeepAliveInterval);
    }
    sendSubscriptionCommand(); 
    wingFullSubscriptionKeepAliveInterval = setInterval(sendSubscriptionCommand, WING_FULL_SUBSCRIPTION_KEEP_ALIVE_MS);
}

// Button mapping functions adapted from original behringerWing.js, seemed more specific to Full WING.
/**
 * Maps an application button ID to WING Full physical OSC paths.
 * Expected appButtonId format for Full WING: "layer<N>_button<M>_<row_bu_or_bd>" (e.g., "layer1_button2_bu")
 * @param {string} appButtonId - The application's internal button identifier.
 * @returns {object|null} An object with OSC paths or null if mapping fails.
 */
function appButtonIdToWingFullPhysicalId(appButtonId) {
    if (!appButtonId || typeof appButtonId !== 'string') {
        console.warn(`BehringerWingFull: appButtonIdToWingFullPhysicalId - Invalid appButtonId: ${appButtonId}`);
        return null;
    }
    
    const parts = appButtonId.split('_');
    if (parts.length !== 3) { // Expecting layer<N>_button<M>_row (e.g. bu/bd)
        console.warn(`BehringerWingFull: Invalid appButtonId format. Expected 3 parts (layerX_buttonY_row), got: ${appButtonId}`);
        return null;
    }
    const layerStr = parts[0].replace('layer', '');
    const buttonStr = parts[1].replace('button', '');
    const rowStr = parts[2]; // Should be 'bu' or 'bd' for user buttons

    const layerNum = parseInt(layerStr, 10);
    const buttonNum = parseInt(buttonStr, 10);

    // WING Full User Assignable Buttons:
    // Layers: Typically 1-16 (OSC 0-15)
    // Buttons per layer: Typically 1-4 (OSC 0-3)
    // Rows: 'bu' (top/button) and 'bd' (bottom/display scribble strip action)
    if (isNaN(layerNum) || isNaN(buttonNum) || layerNum < 1 || layerNum > 16 || buttonNum < 1 || buttonNum > 4) {
        console.warn(`BehringerWingFull: Invalid layer/button number in appButtonId: ${appButtonId}. Parsed App L:${layerNum}, B:${buttonNum}`);
        return null;
    }
    if (rowStr !== 'bu' && rowStr !== 'bd') {
        console.warn(`BehringerWingFull: Invalid row string in appButtonId. Expected 'bu' or 'bd', got: ${rowStr} in ${appButtonId}`);
        return null;
    }

    const wingLayer = layerNum - 1; // Convert app 1-based to WING 0-based
    const wingIndex = buttonNum - 1; // Convert app 1-based to WING 0-based
    const oscPropertyBase = rowStr; // 'bu' or 'bd'
    
    return {
        layer: wingLayer, 
        index: wingIndex,
        row: oscPropertyBase, 
        oscNamePath: `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/name`,
        oscColorPath: `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/col`,
        // For LED state, WING uses /bl for brightness/LED on buttons like 'bu'
        // For 'bd' (display area), it might not have a direct /bl equivalent for simple on/off LED,
        // but color changes serve as visual feedback. We will use /bl for 'bu' and potentially ignore for 'bd' or use color.
        oscLedStatePath: (oscPropertyBase === 'bu') ? `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/bl` : null,
        appButtonId: appButtonId
    };
}

/**
 * Maps a physical WING Full button (from OSC message) to an application button ID.
 * @param {string} wingLayerStr - Layer identifier ("0"-"15") from WING OSC message.
 * @param {string} wingIndexStr - Index/Button identifier ("0"-"3") from WING OSC message.
 * @param {string} wingRowStr - Row identifier ("bu" or "bd") from WING OSC message.
 * @returns {string|null} The application's internal button ID or null.
 */
function wingFullPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStr) {
    const wingLayer = parseInt(wingLayerStr, 10);
    const wingIndex = parseInt(wingIndexStr, 10);

    if (isNaN(wingLayer) || isNaN(wingIndex) || wingLayer < 0 || wingLayer > 15 || wingIndex < 0 || wingIndex > 3) {
        console.warn(`BehringerWingFull: Invalid WING Full physical ID parts: Layer=${wingLayerStr}, Index=${wingIndexStr}, Row=${wingRowStr}`);
        return null;
    }
    if (wingRowStr !== 'bu' && wingRowStr !== 'bd') {
         console.warn(`BehringerWingFull: Invalid WING Full physical row: ${wingRowStr}. Expected 'bu' or 'bd'.`);
        return null;
    }
    
    const appLayer = wingLayer + 1; // Convert WING 0-based to app 1-based
    const appButtonNum = wingIndex + 1; // Convert WING 0-based to app 1-based
    return `layer${appLayer}_button${appButtonNum}_${wingRowStr}`;
}

/**
 * Handles a button press event received from the WING Full mixer via subscription.
 * @param {string} wingLayerStr - The layer identifier from the OSC message.
 * @param {string} wingIndexStr - The index/button identifier from the OSC message.
 * @param {string} wingRowStr - The row ('bu' or 'bd') from the OSC message.
 */
function handleSubscribedWingFullButtonPress(wingLayerStr, wingIndexStr, wingRowStr) {
    const appButtonId = wingFullPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStr);
    if (appButtonId && cueManagerRef) {
        console.log(`BehringerWingFull: Mapped physical button (Layer: ${wingLayerStr}, Index: ${wingIndexStr}, Row: ${wingRowStr}) to App ID: ${appButtonId}. Triggering cue.`);
        // Pass 'behringer_wing_full' as the mixerType for routing in cueManager
        cueManagerRef.triggerCueByMixerButtonId(appButtonId, 'behringer_wing_full');
    } else if (!appButtonId) {
        console.warn(`BehringerWingFull: Could not map WING Full button press (Layer: ${wingLayerStr}, Index: ${wingIndexStr}, Row: ${wingRowStr}) to an app button ID.`);
    } else {
        console.warn(`BehringerWingFull: CueManager reference not available, cannot trigger cue for button ${appButtonId}.`);
    }
}

/**
 * Configures a button on the WING Full mixer (e.g., sets its label, color, LED state).
 * @param {string} appButtonId - The application's internal button ID.
 * @param {string} label - The text label for the button.
 * @param {string} colorName - The name of the color for the button (e.g., "red", "blue").
 * @param {boolean} isActive - Whether the button should be shown as active/lit.
 */
function configureButton(appButtonId, label, colorName, cueId, isActive) { // Added cueId to match original behringerWing
    console.log(`BehringerWingFull: configureButton called for AppID: ${appButtonId}, Label: ${label}, Color: ${colorName}, CueID: ${cueId}, Active: ${isActive}`);
    const physicalIds = appButtonIdToWingFullPhysicalId(appButtonId);

    if (!physicalIds) {
        console.warn(`BehringerWingFull: Could not get physical WING Full IDs for appButtonId: ${appButtonId}. Cannot configure button.`);
        return;
    }

    if (physicalIds.oscNamePath) {
        sendOsc(physicalIds.oscNamePath, label || '');
    }

    // Color mapping - WING expects integer color codes. This is a basic mapping.
    // Source: WING OSC documentation / WING App observation.
    // This might need to be more extensive or configurable.
    let wingColorValue = 0; // Default/Off
    // Basic colors (actual WING values may vary, these are common OSC color int representations)
    // Black: 0 (Often off)
    // Red: 1 / Pink: 2 / Purple: 3 / Deep Blue: 4
    // Blue: 5 / Cyan: 6 / Teal: 7 / Green: 8
    // Light Green: 9 / Lime: 10 / Yellow: 11 / Amber: 12
    // Orange: 13 / Warm White: 14 / White: 15
    // These are examples; exact values for WING might need to be looked up from its OSC spec or testing.
    // Using a simplified set for now, similar to original behringerWing.js had placeholders.
    const colorMap = {
        black: 0, off: 0,
        red: 1,
        green: 8,
        blue: 5,
        yellow: 11,
        cyan: 6,
        magenta: 3, // or purple
        white: 15,
        amber: 12,
        orange: 13
        // Add more standard color names if needed
    };
    if (colorName && colorMap.hasOwnProperty(colorName.toLowerCase())) {
        wingColorValue = colorMap[colorName.toLowerCase()];
    } else if (colorName) {
        console.warn(`BehringerWingFull: Unknown color name "${colorName}". Defaulting color for ${appButtonId}.`);
        wingColorValue = isActive ? colorMap.green : colorMap.red; // Default to green if active, red if not, if color unknown
    } else {
        wingColorValue = isActive ? colorMap.green : 0; // Default if no color specified
    }

    if (physicalIds.oscColorPath) {
        sendOsc(physicalIds.oscColorPath, wingColorValue);
    }

    // LED state for 'bu' buttons (top row, physical buttons)
    // WING expects a float value for /bl (brightness), 0.0 (off) to 1.0 (full).
    if (physicalIds.oscLedStatePath && physicalIds.row === 'bu') {
        sendOsc(physicalIds.oscLedStatePath, isActive ? 1.0 : 0.0);
    }
    // For 'bd' (scribble strip area), color change is the primary feedback. No separate /bl for simple on/off LED.

    console.log(`BehringerWingFull: Sent configuration OSC for AppID: ${appButtonId} (CueID: ${cueId}) to physical WING Full paths (Name: ${physicalIds.oscNamePath}, Color: ${physicalIds.oscColorPath} val ${wingColorValue}, LED: ${physicalIds.oscLedStatePath} val ${isActive ? 1.0 : 0.0})`);
}

/**
 * Iterates through all cues and configures their assigned mixer buttons on the WING Full.
 * Called on initial setup and potentially when cue assignments change.
 */
function triggerInitialCueMixerTriggers() {
    if (!cueManagerRef || !currentWingFullConfig.mixerIntegrationEnabled) {
        console.log('BehringerWingFull: Skipping initial cue mixer triggers (CueManager not ready or integration disabled).');
        return;
    }
    const cues = cueManagerRef.getAllCues ? cueManagerRef.getAllCues() : [];
    console.log(`BehringerWingFull: Triggering initial cue mixer triggers for ${cues.length} cues.`);

    cues.forEach(cue => {
        // Check the new mixerButtonAssignment structure
        if (cue.mixerButtonAssignment && 
            (cue.mixerButtonAssignment.mixerType === 'behringer_wing_full' || cue.mixerButtonAssignment.mixerType === 'behringer_wing') && // Accept generic 'behringer_wing' for full too
            cue.mixerButtonAssignment.buttonId) {
            
            console.log(`BehringerWingFull: Configuring button for cue "${cue.name}" (ID: ${cue.id}) on WING Full (AppID: ${cue.mixerButtonAssignment.buttonId})`);
            
            // Determine active state (e.g., cue is playing, or simply assigned)
            // For initial setup, we usually light up assigned buttons. Actual "is playing" state is dynamic.
            // We can pass cue.id to configureButton if that function needs it.
            // The `isActive` here could represent "is this trigger slot active/configured" rather than "is cue playing".
            // For simplicity, let's assume `true` means the button should be configured with the cue's details.
            let isActiveForButtonConfig = true; 
            
            configureButton(cue.mixerButtonAssignment.buttonId, cue.name, cue.color, cue.id, isActiveForButtonConfig);
        }
    });
}

// NEW Function to configure a physical button via OSC
async function configurePhysicalWingButton(triggerData, assignedCC) {
    console.log(`BehringerWingFull: Configuring physical button for cue. TriggerData:`, triggerData, `AssignedCC: ${assignedCC}`);
    if (!wingClient) {
        console.error('BehringerWingFull: WING client not available to configure button.');
        return { success: false, error: 'WING client not available.' }; // Return object for async
    }

    const layerMatch = triggerData.wingLayer ? String(triggerData.wingLayer).match(/layer(\d+)/i) : null;
    const buttonMatch = triggerData.wingButton ? String(triggerData.wingButton).match(/button(\d+)/i) : null;
    
    if (!layerMatch || !buttonMatch) {
        console.error('BehringerWingFull: Could not parse layer/button from triggerData:', triggerData);
        return { success: false, error: 'Invalid layer/button format in triggerData.' }; // Return object for async
    }

    const layerNum = parseInt(layerMatch[1], 10); // Use 1-based index directly
    const buttonNum = parseInt(buttonMatch[1], 10); // Use 1-based index directly
    const rowId = triggerData.wingRow; // Should be 'bu' or 'bd' for user assignable buttons

    // Validate parsed numbers against expected WING ranges (1-16 for layer, 1-4 for button)
    if (isNaN(layerNum) || layerNum < 1 || layerNum > 16 || 
        isNaN(buttonNum) || buttonNum < 1 || buttonNum > 4 || 
        (rowId !== 'bu' && rowId !== 'bd')) {
        console.error('BehringerWingFull: Invalid parsed layer/button/row numbers for OSC:', { layerNum, buttonNum, rowId });
        return { success: false, error: 'Invalid parsed layer/button/row numbers for OSC.' }; // Return object for async
    }

    const basePath = `/$ctl/user/${layerNum}/${buttonNum}/${rowId}`; // Path uses 1-based indexing

    try {
        sendOsc(`${basePath}/mode`, "MIDICCP");
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        sendOsc(`${basePath}/$fname`, `CC 1:${assignedCC}`); // Assuming MIDI Ch1 (0-indexed in WING $fname means Ch1)
        sendOsc(`${basePath}/ch`, 1); // MIDI Channel 1 (for CH1 for the WING)
        sendOsc(`${basePath}/cc`, assignedCC);
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms

        sendOsc(`${basePath}/name`, String(triggerData.label || '').substring(0, 16)); // Ensure label is string and trimmed to 16 chars

        console.log(`BehringerWingFull: Sent OSC commands to configure button ${basePath} for CC ${assignedCC}, Label: ${triggerData.label}`);
        return { success: true }; // Return object for async
    } catch (error) {
        console.error(`BehringerWingFull: Error sending OSC for button configuration:`, error);
        return { success: false, error: `OSC send error: ${error.message}` }; // Return object for async
    }
}

// NEW Function to clear/reset a physical button via OSC
async function clearPhysicalWingButton(triggerData) {
    console.log(`BehringerWingFull: Clearing physical button. TriggerData:`, triggerData);
    if (!wingClient) {
        console.error('BehringerWingFull: WING client not available to clear button.');
        return { success: false, error: 'WING client not available.' }; // Return object for async
    }

    const layerMatch = triggerData.wingLayer ? String(triggerData.wingLayer).match(/layer(\d+)/i) : null;
    const buttonMatch = triggerData.wingButton ? String(triggerData.wingButton).match(/button(\d+)/i) : null;
    
    if (!layerMatch || !buttonMatch) {
        console.error('BehringerWingFull: Could not parse layer/button from triggerData for clear:', triggerData);
        return { success: false, error: 'Invalid layer/button format for clear.' }; // Return object for async
    }

    const layerNum = parseInt(layerMatch[1], 10) - 1;
    const buttonNum = parseInt(buttonMatch[1], 10) - 1;
    const rowId = triggerData.wingRow;

    if (isNaN(layerNum) || layerNum < 0 || isNaN(buttonNum) || buttonNum < 0 || (rowId !== 'bu' && rowId !== 'bd')) {
        console.error('BehringerWingFull: Invalid parsed layer/button/row for clear OSC:', { layerNum, buttonNum, rowId });
        return { success: false, error: 'Invalid parsed layer/button/row for OSC clear.' }; // Return object for async
    }
    
    const basePath = `/$ctl/user/${layerNum}/${buttonNum}/${rowId}`;

    try {
        // Set Mode to default (e.g., "OFF" - this needs verification for WING's 'unassigned' state)
        sendOsc(`${basePath}/mode`, "OFF"); // Use "OFF" as per documentation snippet
        await new Promise(resolve => setTimeout(resolve, 20)); // Delay 20ms
        sendOsc(`${basePath}/name`, ""); // Clear name
        // Optionally clear MIDI CC fields if mode "OFF" doesn't do it.
        // sendOsc(`${basePath}/$fname`, ""); 
        // sendOsc(`${basePath}/ch`, 0); 
        // sendOsc(`${basePath}/cc`, 0); 

        console.log(`BehringerWingFull: Sent OSC commands to clear/reset button ${basePath}.`);
        return { success: true }; // Return object for async
    } catch (error) {
        console.error(`BehringerWingFull: Error sending OSC for button clear/reset:`, error);
        return { success: false, error: `OSC send error during clear: ${error.message}` }; // Return object for async
    }
}

module.exports = {
    initialize,
    updateSettings,
    stop,
    configureButton, 
    triggerInitialCueMixerTriggers,
    // Expose sendOsc if mixerIntegrationManager or other parts need to send raw OSC via this module
    sendOsc,
    handleSubscribedWingFullButtonPress,
    appButtonIdToWingFullPhysicalId,
    wingFullPhysicalToAppButtonId,
    configurePhysicalWingButton,
    clearPhysicalWingButton
}; 