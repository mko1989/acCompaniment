// Behringer WING specific mixer integration logic
const nodeOsc = require('node-osc');

let wingClient = null; // For sending commands to WING
let wingSubscriptionServer = null; // For receiving subscription data from WING
let wingSubscriptionKeepAliveInterval = null;

const WING_DEFAULT_REMOTE_PORT = 2223; // WING's listening port for commands
const WING_SUBSCRIPTION_LOCAL_LISTEN_PORT = 23456; // Port our app listens on for WING subscriptions
const WING_SUBSCRIPTION_KEEP_ALIVE_MS = 8000;

let currentWingConfig = {};
let mainWindowRef = null;
let cueManagerRef = null;
let localOscListenerRef = null;
let appConfigManagerInstanceRef = null; // To store appConfigManager


function init(config, mainWindow, cueManager, oscListener, appConfigManager) {
    currentWingConfig = config;
    mainWindowRef = mainWindow;
    cueManagerRef = cueManager;
    localOscListenerRef = oscListener; // Store the main oscListener reference
    appConfigManagerInstanceRef = appConfigManager; // Store appConfigManager reference

    if (!currentWingConfig.wingIpAddress) {
        console.warn('BehringerWing: WING selected, but no IP address configured.');
        return;
    }
    console.log(`BehringerWing: Initializing. IP: ${currentWingConfig.wingIpAddress}`);
    try {
        if (typeof nodeOsc.Client !== 'function') {
            console.error('BehringerWing: nodeOsc.Client is not a constructor!');
            throw new Error('nodeOsc.Client is not available');
        }
        wingClient = new nodeOsc.Client(currentWingConfig.wingIpAddress, WING_DEFAULT_REMOTE_PORT);
        console.log(`BehringerWing: WING OSC Client created for ${currentWingConfig.wingIpAddress}:${WING_DEFAULT_REMOTE_PORT}.`);

        if (typeof nodeOsc.Server !== 'function') {
            console.error('BehringerWing: nodeOsc.Server is not a constructor!');
            throw new Error('nodeOsc.Server is not available');
        }
        // Ensure the port is not already in use
        if (wingSubscriptionServer) {
            console.warn("BehringerWing: wingSubscriptionServer already exists. Closing existing one before creating new.");
            wingSubscriptionServer.close();
            wingSubscriptionServer = null;
        }

        wingSubscriptionServer = new nodeOsc.Server(WING_SUBSCRIPTION_LOCAL_LISTEN_PORT, '0.0.0.0', () => {
            console.log(`BehringerWing: WING Subscription OSC Server listening on port ${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT}.`);
            establishWingSubscription();
        });

        wingSubscriptionServer.on('message', (msg, rinfo) => {
            // console.log(">>>>>>>>>> WING SUB RECV (in behringerWing.js):", JSON.stringify(msg), "FROM:", rinfo ? `${rinfo.address}:${rinfo.port}` : "N/A");
            const address = msg && msg.length > 0 ? msg[0] : '[no address in msg array]';
            const rawArgs = msg && msg.length > 1 ? msg.slice(1) : [];
            // console.log(`BehringerWing: WING Sub Server Parsed: ${address} Args: ${JSON.stringify(rawArgs)} From: ${rinfo ? rinfo.address : 'N/A'}:${rinfo ? rinfo.port : 'N/A'}`);

            // Route to the main oscListener's handler if it's not a specific WING subscription handled here
            if (localOscListenerRef && typeof localOscListenerRef.handleGenericOscMessage === 'function') {
                 if (!address.startsWith('/$ctl/user/')) { // Don't re-process WING specific ctl messages if main oscListener handles them broadly
                    localOscListenerRef.handleGenericOscMessage(address, rawArgs, rinfo, 'behringer_wing_subscription');
                 }
            }

            // WING specific button press handling (for subscribed user buttons)
            const wingButtonPressRegex = /^\/\$ctl\/user\/(\d+)\/(\d+)\/bu\/val$/; // Only bu/val for press (bd/val is release)
            const wingButtonPressMatch = address.match(wingButtonPressRegex);

            if (wingButtonPressMatch && rawArgs.length > 0 && parseInt(String(rawArgs[0]), 10) === 127) {
                const [, wingLayerStr, wingIndexStr] = wingButtonPressMatch;
                 // console.log(`BehringerWing: Raw match from WING button press. LayerStr: ${wingLayerStr}, IndexStr: ${wingIndexStr}. About to call handleSubscribedWingButtonPress.`);
                handleSubscribedWingButtonPress(wingLayerStr, wingIndexStr, 'bu'); // 'bu' signifies a button press
                return;
            }
             // More specific handling for other WING user control messages if needed
            if (address.includes('/$ctl/user/') && address.endsWith('/name')) {
                // console.log(`BehringerWing: Detected WING User Button Name/Label update: ${address} -> ${rawArgs[0]}`);
            }
        });

        wingSubscriptionServer.on('error', (err) => {
            console.error(`BehringerWing: WING Subscription OSC Server error:`, err);
            if (err.code === 'EADDRINUSE') {
                console.error(`BehringerWing: Port ${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT} is already in use for WING subscriptions.`);
            }
            stop(); // Call local stop
        });

    } catch (error) {
        console.error(`BehringerWing: Error setting up WING Client/Server:`, error);
        stop(); // Call local stop
    }
}

function stop() {
    console.log('BehringerWing: Stopping and cleaning up WING connections.');
    if (wingSubscriptionKeepAliveInterval) {
        clearInterval(wingSubscriptionKeepAliveInterval);
        wingSubscriptionKeepAliveInterval = null;
    }
    if (wingSubscriptionServer) {
        try {
            wingSubscriptionServer.close();
            console.log('BehringerWing: WING Subscription Server closed.');
        } catch (e) {
            console.error('BehringerWing: Error closing WING Subscription Server:', e);
        }
        wingSubscriptionServer = null;
    }
    if (wingClient) {
        try {
            wingClient.close(); // node-osc client doesn't have a close method, this is conceptual.
            console.log('BehringerWing: WING Client resources released (conceptual close).');
        } catch (e) {
            console.error('BehringerWing: Error closing WING Client (conceptual):', e);
        }
        wingClient = null;
    }
}


function sendOsc(address, ...oscArgs) {
    if (!wingClient) {
        console.warn('BehringerWing: WING client not initialized. Cannot send OSC message.');
        return;
    }
    if (!currentWingConfig.wingIpAddress) {
        console.warn('BehringerWing: WING IP address not configured. Cannot send OSC.');
        return;
    }
    try {
        // console.log(`BehringerWing: Sending OSC to WING: ${address}`, oscArgs);
        wingClient.send(address, ...oscArgs);
    } catch (error) {
        console.error(`BehringerWing: Error sending OSC message to WING (${address} ${oscArgs.join(' ')}):`, error);
    }
}

function establishWingSubscription() {
    if (!wingClient || !currentWingConfig.wingIpAddress) {
        console.warn('BehringerWing: Cannot establish WING subscription, client or WING IP not configured.');
        return;
    }

    let selectedLocalIp = null;
    if (appConfigManagerInstanceRef && typeof appConfigManagerInstanceRef.getLocalIpAddresses === 'function') {
        const localIps = appConfigManagerInstanceRef.getLocalIpAddresses();
        if (localIps.length > 0) {
            selectedLocalIp = localIps[0].address;
            console.log(`BehringerWing: Auto-detected local IP for subscriptions: ${selectedLocalIp} (Interface: ${localIps[0].name}) - Note: This IP is not used in the WING /%port/*s~ subscription message.`);
        } else {
            console.error('BehringerWing: CRITICAL - No local IP addresses found. This might affect other functionalities but not the subscription message format itself.');
            // Depending on WING behavior, not having a specific IP to advertise might not be an issue for /%port/*s~
            // as it might use the source IP of the packet.
        }
    }

    console.log(`BehringerWing: Attempting to establish subscription with WING at ${currentWingConfig.wingIpAddress} for listening port ${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT}.`);

    const sendSubscriptionCommand = () => {
        // Correct WING subscription message: /%<PORT>/*s~
        // <PORT> is WING_SUBSCRIPTION_LOCAL_LISTEN_PORT
        // The '*' tells WING to send (s)tream all events. The '~' might signify a toggle or start.
        // The documentation shows both /%12345/*s~ and /%12345/*S~
        // We'll use /*s~ as it's listed first.

        const subscriptionPath = `/%${WING_SUBSCRIPTION_LOCAL_LISTEN_PORT}/*s~`;
        sendOsc(subscriptionPath); // No additional arguments needed for this specific WING command

        console.log(`BehringerWing: Sent WING subscription command: ${subscriptionPath}. Will renew in ${WING_SUBSCRIPTION_KEEP_ALIVE_MS / 1000}s.`);
    };

    sendSubscriptionCommand(); // Initial subscription

    if (wingSubscriptionKeepAliveInterval) {
        clearInterval(wingSubscriptionKeepAliveInterval);
    }
    wingSubscriptionKeepAliveInterval = setInterval(sendSubscriptionCommand, WING_SUBSCRIPTION_KEEP_ALIVE_MS);
}


function appButtonIdToWingPhysicalId(appButtonId) {
    if (!appButtonId || typeof appButtonId !== 'string') {
        console.warn(`BehringerWing: appButtonIdToWingPhysicalId - Invalid appButtonId (null or not a string): ${appButtonId}`);
        return null;
    }

    // Expected format for Full WING: "layer<N>_button<M>_<row_bu_or_bd>"
    // e.g., "layer1_button2_bu"
    const parts = appButtonId.split('_'); 
    if (parts.length !== 3) {
        console.warn(`BehringerWing: Invalid appButtonId format for Full WING. Expected 3 parts (layerX_buttonY_row), got: ${appButtonId}`);
        return null;
    }

    const layerStr = parts[0].replace('layer', '');
    const buttonStr = parts[1].replace('button', '');
    const rowStr = parts[2]; // Should be 'bu' or 'bd'

    const layerNum = parseInt(layerStr, 10);
    const buttonNum = parseInt(buttonStr, 10);

    if (isNaN(layerNum) || isNaN(buttonNum) || layerNum < 1 || layerNum > 16 || buttonNum < 1 || buttonNum > 4) {
        console.warn(`BehringerWing: Invalid layer/button number in appButtonId for Full WING: ${appButtonId}. Parsed L:${layerNum}, B:${buttonNum}`);
        return null;
    }

    if (rowStr !== 'bu' && rowStr !== 'bd') {
        console.warn(`BehringerWing: Invalid row string in appButtonId for Full WING. Expected 'bu' or 'bd', got: ${rowStr} in ${appButtonId}`);
        return null;
    }

    // WING OSC path for user controls: /$ctl/user/<layer_0_15>/<index_0_3>/<property>
    const wingLayer = layerNum - 1; // Convert 1-based from UI to 0-based for OSC
    const wingIndex = buttonNum - 1;  // Convert 1-based from UI to 0-based for OSC

    // For Full WING, rowStr directly tells us 'bu' or 'bd'
    const oscPropertyBase = rowStr; // 'bu' or 'bd'

    // Construct paths based on the row property
    // Note: WING sends /val on press, e.g., /$ctl/user/0/0/bu/val
    // For configuring, we target /name, /col, /bl (brightness/LED for buttons)
    const oscTriggerPathRoot = `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}`;
    const oscNamePath = `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/name`; // Name is per button (bu/bd share display if physically one button)
    const oscColorPath = `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/col`; // Color is per button
    const oscLedStatePath = `/$ctl/user/${wingLayer}/${wingIndex}/${oscPropertyBase}/bl`; // LED state is per button

    return {
        layer: wingLayer,
        index: wingIndex,
        row: oscPropertyBase, // 'bu' or 'bd'
        // oscTriggerPath: oscTriggerPathRoot, // Path that WING sends on press (e.g., /$ctl/user/0/2/bu/val) - WING adds /val
        oscNamePath: oscNamePath,         // Path for the control's name/label
        oscColorPath: oscColorPath,       // Path for the control's color
        oscLedStatePath: oscLedStatePath, // Path for LED state/brightness (e.g., /bl)
        appButtonId: appButtonId          // Store original ID for reference
    };
}


function wingPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStrOrType) {
    // wingLayerStr: "0"-"15" (from WING OSC path, for specific button element like /bu or /bd)
    // wingIndexStr: "0"-"3" (from WING OSC path)
    // wingRowStrOrType: "bu" or "bd" (or potentially "bl", "name", "col" if we adapt for those specific feedbacks)

    const wingLayer = parseInt(wingLayerStr, 10);
    const wingIndex = parseInt(wingIndexStr, 10);

    if (isNaN(wingLayer) || isNaN(wingIndex) || wingLayer < 0 || wingLayer > 15 || wingIndex < 0 || wingIndex > 3) {
        console.warn(`BehringerWing: Invalid WING physical ID parts: Layer=${wingLayerStr}, Index=${wingIndexStr}`);
        return null;
    }

    // Convert 0-indexed from WING to 1-indexed for app
    const appLayer = wingLayer + 1;
    const appButtonNum = wingIndex + 1;

    // We need to ensure wingRowStrOrType is 'bu' or 'bd' for constructing the appButtonId correctly.
    // If the incoming OSC is, for example, /.../bl/val, we still map it to the base button (bu or bd)
    // The `handleSubscribedWingButtonPress` should only be called for /bu/val or /bd/val for actual triggers.
    let appRowStr = wingRowStrOrType;
    if (wingRowStrOrType !== 'bu' && wingRowStrOrType !== 'bd') {
        // If we get feedback for /bl, /col, /name, we might need to infer if it was for a bu or bd button.
        // This part might need more context if we listen to more than just /bu/val and /bd/val for triggers.
        // For now, assume if it's not bu/bd, it's an error for ID generation, or needs default.
        // However, since WING sends /$ctl/user/.../bu/val or /$ctl/user/.../bd/val, this should be fine.
        console.warn(`BehringerWing: wingPhysicalToAppButtonId received unexpected wingRowStrOrType '${wingRowStrOrType}'. Assuming 'bu' for ID generation if it was for a generic property.`);
        // Defaulting to 'bu' might be problematic if we are trying to map feedback from /name or /col for a /bd button.
        // For now, this function is primarily used by `handleSubscribedWingButtonPress` which gets 'bu' or 'bd'.
        if (!['bu', 'bd'].includes(wingRowStrOrType)) {
             console.warn(`BehringerWing: wingPhysicalToAppButtonId wingRowStrOrType is '${wingRowStrOrType}', which is not 'bu' or 'bd'. This might lead to incorrect appButtonId generation if the source wasn\'t a button press.`);
             // Cannot reliably form an ID without knowing if it corresponds to 'bu' or 'bd' part of a physical button.
             // This case should ideally not happen if this function is called only from button press handlers.
             return null; 
        }
    }

    return `layer${appLayer}_button${appButtonNum}_${appRowStr}`;
}

function handleSubscribedWingButtonPress(wingLayerStr, wingIndexStr, wingRowStr) {
    // wingLayerStr, wingIndexStr are 0-indexed strings from WING's OSC path.
    // wingRowStr is 'bu' (upper button press) or 'bd' (lower button press)

    // We only process actual button down/press events (/bu/val or /bd/val with arg 127)
    // The check for arg === 127 is done in the 'message' handler before calling this.

    const appButtonId = wingPhysicalToAppButtonId(wingLayerStr, wingIndexStr, wingRowStr);
    if (!appButtonId) {
        console.warn(`BehringerWing: Could not map WING physical button (L:${wingLayerStr} I:${wingIndexStr} Row:${wingRowStr}) to appButtonId.`);
        return;
    }

    console.log(`BehringerWing: Mapped WING press (L:${wingLayerStr} I:${wingIndexStr} Row:${wingRowStr}) to appButtonId: ${appButtonId}`);

    if (cueManagerRef && typeof cueManagerRef.triggerCueByMixerButtonId === 'function') {
        cueManagerRef.triggerCueByMixerButtonId(appButtonId, 'behringer_wing');
    } else {
        console.error('BehringerWing: cueManagerRef or triggerCueByMixerButtonId is not available.');
    }
}

function configureButton(appButtonId, label, colorName, cueId, isActive) {
    if (!wingClient) {
        console.warn('BehringerWing: WING client not initialized. Cannot configure button.');
        return;
    }
    const physicalId = appButtonIdToWingPhysicalId(appButtonId);
    if (!physicalId) {
        console.warn(`BehringerWing: Could not get physical ID for appButtonId: ${appButtonId} during configureButton.`);
        return;
    }

    console.log(`BehringerWing: Configuring Full WING button ${appButtonId} (L:${physicalId.layer} I:${physicalId.index} Row:${physicalId.row}). Label: '${label}', Color: '${colorName}', Active: ${isActive}`);

    // Set Name/Label
    // WING buttons (bu/bd) might share a physical display or have separate ones.
    // The path physicalId.oscNamePath now includes /bu/name or /bd/name.
    if (label && physicalId.oscNamePath) {
        sendOsc(physicalId.oscNamePath, String(label).slice(0, 11)); // WING labels are often short
    }

    // Set Color (using physicalId.oscColorPath which is e.g. .../bu/col)
    const colorMap = {
        'off': 0, // Or a dim color if preferred over pure black
        'black': 0,
        'red': 1,
        'green': 2,
        'yellow': 3,
        'blue': 4,
        'magenta': 5,
        'cyan': 6,
        'white': 7,
        // Add more if WING supports them and they are used in appConfig
        'default': 0 // Default to black/off
    };
    const wingColorIndex = colorMap.hasOwnProperty(colorName) ? colorMap[colorName] : colorMap['default'];

    if (physicalId.oscColorPath) {
        sendOsc(physicalId.oscColorPath, wingColorIndex);
    }

    // Set LED State (using physicalId.oscLedStatePath which is e.g. .../bu/bl)
    if (physicalId.oscLedStatePath) { 
        if (colorName === 'off' || !isActive) {
            sendOsc(physicalId.oscLedStatePath, 0); // Turn LED off
        } else {
            sendOsc(physicalId.oscLedStatePath, 127); // Turn LED on (bright)
        }
    }
     console.log(`BehringerWing: Sent config to Full WING for ${appButtonId}: Label='${label}', ColorIndex=${wingColorIndex}, ActiveState=${isActive ? 127 : 0}`);
}


module.exports = {
    init,
    stop,
    sendOsc, // Primarily for internal use or specific WING commands
    configureButton, // For setting up button appearance based on cue linking
    handleSubscribedWingButtonPress, // Called by the subscription server's message handler
    // No need to export appButtonIdToWingPhysicalId or wingPhysicalToAppButtonId unless other modules need them directly
}; 