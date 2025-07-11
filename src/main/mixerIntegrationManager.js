// Companion_soundboard/src/main/mixerIntegrationManager.js
// Manages integration with various audio mixers like Behringer WING, Yamaha DM3, etc.

const behringerWing = require('./mixerIntegrations/behringerWing'); // This will become effectively orphaned
const behringerWingCompact = require('./mixerIntegrations/behringerWingCompact');
const behringerWingFull = require('./mixerIntegrations/behringerWingFull'); 
// const behringerX32 = require('./mixerIntegrations/behringerX32');
// const yamahaDm3 = require('./mixerIntegrations/yamahaDm3');
const appConfig = require('./appConfig');

let currentConfig = {};
let mainWindowRef = null;
let cueManagerRef = null;
let oscListenerRef = null;

let activeMixerModule = null;
let wingAssignedCCs = new Set(); // For managing assigned MIDI CCs for WING triggers


/**
 * Initializes the Mixer Integration Manager.
 * @param {object} initialConfig - The initial application configuration.
 * @param {BrowserWindow} mainWindow - Reference to the main browser window.
 * @param {object} cueManager - Reference to the CueManager instance.
 * @param {object} oscListener - Reference to the main OscListener instance.
 */
function initialize(initialConfig, mainWindow, cueManager, oscListener) {
    // ALPHA BUILD: Skip mixer integration initialization entirely
    if (!initialConfig.mixerIntegrationEnabled) {
        console.log('MixerIntegrationManager: Mixer integration disabled, skipping initialization.');
        return;
    }
    
    mainWindowRef = mainWindow;
    cueManagerRef = cueManager;
    oscListenerRef = oscListener; 
    updateSettings(initialConfig);
    console.log('MixerIntegrationManager: Initialized with new structure.');
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

    if (activeMixerModule && typeof activeMixerModule.stop === 'function') {
        activeMixerModule.stop();
    }
    activeMixerModule = null;

    if (!currentConfig.mixerIntegrationEnabled) {
        console.log('MixerIntegrationManager: Mixer integration disabled.');
        return;
    }

    // Determine which module to load
    if (currentConfig.mixerType === 'behringer_wing_compact') {
        activeMixerModule = behringerWingCompact;
        console.log('MixerIntegrationManager: Behringer WING Compact selected, loading behringerWingCompact module.');
    } else if (currentConfig.mixerType === 'behringer_wing_full') { 
        activeMixerModule = behringerWingFull;
        console.log('MixerIntegrationManager: Behringer WING Full selected, loading behringerWingFull module.');
    } else {
        console.warn(`MixerIntegrationManager: Unknown or unsupported mixerType: ${currentConfig.mixerType}`);
        return;
    }

    // Initialize the selected module
    if (activeMixerModule && typeof activeMixerModule.initialize === 'function') { 
        if (activeMixerModule === behringerWingCompact || activeMixerModule === behringerWingFull) {
            activeMixerModule.initialize(currentConfig, mainWindowRef, cueManagerRef);
            console.log(`MixerIntegrationManager: Initialized module for ${currentConfig.mixerType || 'Behringer WING type ' + currentConfig.wingModelType} using new init signature.`);
        } else {
            // This path should ideally not be taken for WING mixers anymore.
            // If behringerWing.js (old) were still in use, it would need oscListenerRef and appConfig.
            activeMixerModule.initialize(currentConfig, mainWindowRef, cueManagerRef, oscListenerRef, appConfig);
            console.log(`MixerIntegrationManager: Initialized module for ${currentConfig.mixerType} using original init signature (potentially old module).`);
        }
    } else if (activeMixerModule && typeof activeMixerModule.init === 'function') {
        // Fallback for very old modules with .init() - this path should also ideally not be taken for WING.
        console.warn(`MixerIntegrationManager: Module for ${currentConfig.mixerType} uses .init instead of .initialize. Attempting to call .init.`);
        activeMixerModule.init(currentConfig, mainWindowRef, cueManagerRef, oscListenerRef, appConfig);
        console.log(`MixerIntegrationManager: Initialized module for ${currentConfig.mixerType} using .init.`);
    } else {
        console.error(`MixerIntegrationManager: Module for ${currentConfig.mixerType} does not have an init or initialize function or was not loaded properly.`);
    }
}


function stopAndCleanupMixerConnections() {
    if (activeMixerModule && typeof activeMixerModule.stop === 'function') {
        activeMixerModule.stop();
    }
    activeMixerModule = null;
    console.log('MixerIntegrationManager: All mixer connections stopped and cleaned up.');
}


function triggerInitialCueMixerTriggers() {
    if (!cueManagerRef || !currentConfig.mixerIntegrationEnabled || !activeMixerModule) {
        return;
    }
    if (activeMixerModule && typeof activeMixerModule.triggerInitialCueMixerTriggers === 'function') {
        console.log('MixerIntegrationManager: Requesting active module to trigger initial cue mixer triggers.');
        activeMixerModule.triggerInitialCueMixerTriggers();
    } else if (activeMixerModule && typeof activeMixerModule.updateCueMixerTrigger === 'function') {
        console.log('MixerIntegrationManager: Active module does not have triggerInitialCueMixerTriggers, calling updateCueMixerTrigger for all cues.');
        const cues = cueManagerRef.getCues ? cueManagerRef.getCues() : (cueManagerRef.getAllCues ? cueManagerRef.getAllCues() : []);
        cues.forEach(cue => {
            if (cue.mixerTrigger && cue.mixerTrigger.buttonId) {
                let cueMixerType = cue.mixerTrigger.mixerType || currentConfig.mixerType;
                let currentActiveType = currentConfig.mixerType;
                if(currentConfig.mixerType === 'behringer_wing'){
                    currentActiveType = currentConfig.wingModelType === 'compact' ? 'behringer_wing_compact' : (currentConfig.wingModelType === 'full' ? 'behringer_wing_full' : 'behringer_wing_full'); // Default to full
                }

                if (cueMixerType === currentActiveType || 
                    (cueMixerType === 'behringer_wing' && currentActiveType.startsWith('behringer_wing_')) || 
                    (cueMixerType === 'behringer_wing_full' && currentActiveType === 'behringer_wing_full') ||
                    (cueMixerType === 'behringer_wing_compact' && currentActiveType === 'behringer_wing_compact')
                    ) {
                    updateCueMixerTrigger(cue); 
                }
            }
        });
    } else {
        console.log('MixerIntegrationManager: No compatible function on active module to trigger/update cue mixer buttons.');
    }
}

function sendOsc(address, ...oscArgs) {
    if (activeMixerModule && typeof activeMixerModule.sendOsc === 'function') {
        activeMixerModule.sendOsc(address, ...oscArgs);
    } else {
        console.warn('MixerIntegrationManager: No active mixer module or sendOsc function not available.');
    }
}


function updateCueMixerTrigger(cue) {
    if (!currentConfig.mixerIntegrationEnabled || !activeMixerModule || typeof activeMixerModule.configureButton !== 'function') {
        return;
    }

    let cueMixerType = null;
    if (cue.mixerTrigger && cue.mixerTrigger.mixerType) { // Legacy
        cueMixerType = cue.mixerTrigger.mixerType;
    } else if (cue.mixerButtonAssignment && cue.mixerButtonAssignment.mixerType) { // New structure
        cueMixerType = cue.mixerButtonAssignment.mixerType;
    }
    
    let currentActiveFullType = currentConfig.mixerType;

    let shouldConfigure = false;
    if (cueMixerType === currentActiveFullType) {
        shouldConfigure = true;
    }

    if (!shouldConfigure) {
        return;
    }

    let buttonId, label, color, enabled, cueIdToPass;
    cueIdToPass = cue.id; // Always pass cue.id

    if (cue.mixerTrigger && cue.mixerTrigger.buttonId) { // Legacy structure
        ({ buttonId, label, color, enabled } = cue.mixerTrigger);
    } else if (cue.mixerButtonAssignment && cue.mixerButtonAssignment.buttonId) { // New structure
        ({ buttonId } = cue.mixerButtonAssignment);
        label = cue.name;
        color = cue.color;
        enabled = true; 
    }

    if (buttonId) {
        const isActive = enabled !== false;
        let actualLabel = label || cue.name;
        actualLabel = String(actualLabel).trim();

        let actualColor = color || (isActive ? currentConfig.mixerTriggerDefaults?.activeColor : currentConfig.mixerTriggerDefaults?.inactiveColor);
        actualColor = actualColor || (isActive ? 'green' : 'red');

        activeMixerModule.configureButton(buttonId, actualLabel, actualColor, cueIdToPass, isActive);
    } 
}

function handleMixerSpecificFeedback(oscAddress, oscArgs, mixerType) {
    console.log(`MixerIntegrationManager: Received mixer-specific feedback for ${mixerType}. Address: ${oscAddress}, Args: ${JSON.stringify(oscArgs)}`);

    if (activeMixerModule && typeof activeMixerModule.handleFeedback === 'function') {
        activeMixerModule.handleFeedback(oscAddress, oscArgs, cueManagerRef);
    } else {
        console.warn(`MixerIntegrationManager: No active module or handleFeedback function for ${mixerType} to process: ${oscAddress}`);
    }
}

// --- WING Button Configuration --- 
async function setupWingButton(cueId, wingTriggerData) {
    if (!activeMixerModule || typeof activeMixerModule.configurePhysicalWingButton !== 'function') {
        console.error('MixerIntegrationManager: Active module cannot configure WING button.', activeMixerModule);
        return { success: false, error: 'Active module cannot configure WING button.' };
    }

    let assignedCC = null;
    for (let i = 0; i < 128; i++) {
        if (!wingAssignedCCs.has(i)) {
            assignedCC = i;
            break;
        }
    }

    if (assignedCC === null) {
        console.error('MixerIntegrationManager: No available MIDI CCs for WING trigger.');
        return { success: false, error: 'No available MIDI CCs.' };
    }

    try {
        const result = await activeMixerModule.configurePhysicalWingButton(wingTriggerData, assignedCC);
        if (result && result.success) {
            wingAssignedCCs.add(assignedCC);
            console.log(`MixerIntegrationManager: Assigned MIDI CC ${assignedCC} to WING button. Current CCs:`, Array.from(wingAssignedCCs));
            return { success: true, assignedMidiCC: assignedCC };
        }
        return result; // Forward error from module
    } catch (error) {
        console.error('MixerIntegrationManager: Error calling configurePhysicalWingButton on module:', error);
        return { success: false, error: error.message };
    }
}

async function clearWingButton(wingTriggerData) {
    if (!activeMixerModule || typeof activeMixerModule.clearPhysicalWingButton !== 'function') {
        console.error('MixerIntegrationManager: Active module cannot clear WING button.');
        return { success: false, error: 'Active module cannot clear WING button.' };
    }

    try {
        const result = await activeMixerModule.clearPhysicalWingButton(wingTriggerData);
        if (result && result.success) {
            if (wingTriggerData.assignedMidiCC !== null && wingTriggerData.assignedMidiCC !== undefined) {
                wingAssignedCCs.delete(wingTriggerData.assignedMidiCC);
                console.log(`MixerIntegrationManager: Cleared MIDI CC ${wingTriggerData.assignedMidiCC} for WING button. Current CCs:`, Array.from(wingAssignedCCs));
            }
            return { success: true };
        }
        return result; // Forward error from module
    } catch (error) {
        console.error('MixerIntegrationManager: Error calling clearPhysicalWingButton on module:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initialize,
    updateSettings,
    sendOsc, 
    setupWingButton,
    clearWingButton,
    updateCueMixerTrigger,
    stopAndCleanupMixerConnections, 
    handleMixerSpecificFeedback, 
}; 