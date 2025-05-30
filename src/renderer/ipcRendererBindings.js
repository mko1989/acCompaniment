// Companion_soundboard/src/renderer/ipcRendererBindings.js
// Sets up renderer-side IPC listeners and sender functions.

let electronAPIInstance;

let audioControllerRef = null;
let dragDropHandlerRef = null;
let cueStoreRef = null;
let uiRef = null;
let appConfigUIRef = null;
let sidebarsRef = null;
const configureWingButtonForCue = (cueId, wingTriggerData) => electronAPIInstance.invoke('configure-wing-button-for-cue', cueId, wingTriggerData);
const clearWingButtonForCue = (cueId, oldWingTriggerData) => electronAPIInstance.invoke('clear-wing-button-for-cue', cueId, oldWingTriggerData);
const setAudioOutputDevice = (deviceId) => electronAPIInstance.invoke('set-audio-output-device', deviceId);
const showMultipleFilesDropModalComplete = (result) => electronAPIInstance.send('multiple-files-drop-modal-complete', result);
const showOpenDialog = (options) => electronAPIInstance.invoke('show-open-dialog', options);
const showSaveDialog = (options) => electronAPIInstance.invoke('show-save-dialog', options);


function initialize(electronAPI) {
    console.log('IPC Binding: initialize() CALLED');
    electronAPIInstance = electronAPI;

    if (electronAPIInstance && typeof electronAPIInstance.on === 'function') {
        setupListeners();
    } else {
        console.error('electronAPI not found or `on` is not a function. IPC listeners will not work.');
    }
}

function setModuleRefs(modules) {
    console.log('IPC Binding: setModuleRefs() CALLED with:', modules);
    audioControllerRef = modules.audioCtrl;
    dragDropHandlerRef = modules.dragDropCtrl;
    cueStoreRef = modules.cueStoreMod;
    uiRef = modules.uiMod;
    appConfigUIRef = modules.appConfigUIMod;
    sidebarsRef = modules.sidebarsMod;
}

// --- Senders to Main Process ---
async function getCuesFromMain() {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for get-cues");
    return electronAPIInstance.invoke('get-cues');
}

async function saveCuesToMain(cues) {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for save-cues");
    return electronAPIInstance.invoke('save-cues', cues);
}

async function generateUUID() {
    if (!electronAPIInstance) {
        console.error("electronAPIInstance not available for UUID generation, falling back.");
        return 'cue_fallback_' + Date.now().toString(36) + Math.random().toString(36).substring(2);
    }
    return electronAPIInstance.invoke('generate-uuid');
}

// This function is now primarily called by audioController itself after init.
// If other modules need to send status, they should go via audioController or a new shared service.
function sendCueStatusUpdate(cueId, status, details = null) {
    if (!electronAPIInstance) {
        console.error('electronAPIInstance not available for cue-status-update-for-companion');
        return;
    }
    const payload = { cueId, status };
    if (details) payload.details = details; 
    electronAPIInstance.send('cue-status-update-for-companion', payload);
}

// New functions for App Configuration
async function getAppConfig() {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for get-initial-config");
    return electronAPIInstance.invoke('get-initial-config');
}

async function saveAppConfig(configData) {
    if (!electronAPIInstance) {
        console.error("electronAPIInstance not available for save-app-config");
        throw new Error("electronAPIInstance not available for save-app-config");
    }
    return electronAPIInstance.invoke('save-app-config', configData);
}

// New function to get audio output devices
async function getAudioOutputDevices() {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for get-audio-output-devices");
    return electronAPIInstance.invoke('get-audio-output-devices');
}

async function addOrUpdateCue(cueData) {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for add-or-update-cue");
    console.log(`IPC Binding: Sending add-or-update-cue for cue ID: ${cueData.id || 'new cue'}`);
    return electronAPIInstance.invoke('add-or-update-cue', cueData);
}

async function deleteCue(cueId) {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for delete-cue");
    console.log(`IPC Binding: Sending delete-cue for cue ID: ${cueId}`);
    return electronAPIInstance.invoke('delete-cue', cueId);
}

// New function to send discovered duration to the main process
function sendCueDurationUpdate(cueId, duration, playlistItemId = null) {
    if (!electronAPIInstance) {
        console.error("electronAPIInstance not available for cue-duration-update");
        return;
    }
    console.log(`IPC Binding: Sending cue-duration-update for cue: ${cueId}, item: ${playlistItemId || 'N/A'}, duration: ${duration}`);
    electronAPIInstance.send('cue-duration-update', { cueId, duration, playlistItemId });
}

// New function to get audio file buffer
async function getAudioFileBuffer(filePath) {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for get-audio-file-buffer");
    console.log(`>>> IPC Binding: ENTERING getAudioFileBuffer with path: ${filePath}`);
    return electronAPIInstance.invoke('get-audio-file-buffer', filePath);
}

// New function to get or generate waveform peaks
async function getOrGenerateWaveformPeaks(filePath) {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for get-or-generate-waveform-peaks");
    console.log(`IPC Binding: Requesting waveform peaks for path: ${filePath}`);
    return electronAPIInstance.invoke('get-or-generate-waveform-peaks', filePath);
}

async function getMediaDuration(filePath) {
    if (!electronAPIInstance) {
        console.error("electronAPIInstance not available for get-media-duration");
        throw new Error("electronAPIInstance not available for get-media-duration");
    }
    console.log(`IPC Binding: Requesting media duration for path: ${filePath}`);
    return electronAPIInstance.invoke('get-media-duration', filePath);
}

// --- Listeners for Main Process Events ---
function setupListeners() {
    console.log('IPC Binding: setupListeners() CALLED');
    // Listen for files dropped (forwarded from main process)
    /*
    electronAPIInstance.on('files-dropped-on-app', (filePaths) => {
        console.log('IPC Binding: Renderer received files-dropped-on-app:', filePaths);
        // The dragDropHandler module is now expected to set up its own global listeners 
        // or be called by ui.js when a general drop occurs.
        // For now, ui.js has assignFilesToRelevantTarget that can be used.
        if (uiRef && typeof uiRef.assignFilesToRelevantTarget === 'function') {
            uiRef.assignFilesToRelevantTarget(filePaths, document.body); // Indicate general drop
        } else {
            console.warn('uiRef or assignFilesToRelevantTarget not available for general file drop.');
        }
    });
    */

    // Listener for when the main process signals it's ready
    electronAPIInstance.on('main-process-ready', () => {
        console.log('IPC Binding: Received main-process-ready signal. UI module handles its own readiness now.');
    });

    console.log(`IPC Binding: Attempting to set up listener for 'app-config-updated-from-main'.`);
    electronAPIInstance.on('app-config-updated-from-main', (newConfig) => { 
        console.log('IPC Binding: SUCCESS - Received app-config-updated-from-main with new config:', newConfig);
        if (uiRef && typeof uiRef.applyAppConfiguration === 'function') {
            console.log('IPC Binding: Calling uiRef.applyAppConfiguration for app-config-updated-from-main.');
            uiRef.applyAppConfiguration(newConfig);
        } else {
            console.warn('IPC Binding: uiRef.applyAppConfiguration not available or uiRef not set yet for app-config-updated-from-main.');
        }
    });

    console.log(`IPC Binding: Attempting to set up listener for 'cues-updated-from-main'.`);
    electronAPIInstance.on('cues-updated-from-main', (cues) => {
        console.log('IPC Binding: SUCCESS - Received cues-updated-from-main. Number of cues:', cues ? cues.length : 'N/A');
        if (cueStoreRef && typeof cueStoreRef.handleCuesUpdated === 'function') {
            console.log('IPC Binding: Calling cueStoreRef.handleCuesUpdated.');
            cueStoreRef.handleCuesUpdated(cues);
        } else {
            console.warn('IPC Binding: cueStoreRef.handleCuesUpdated not available or cueStoreRef not set yet.');
        }
    });

    electronAPIInstance.on('play-audio-by-id', (cueId) => {
        console.log(`IPC Binding: Received 'play-audio-by-id' for cueId: ${cueId}`);
        if (!cueStoreRef || !audioControllerRef) {
            console.warn('IPC Binding: cueStoreRef or audioControllerRef not set for play-audio-by-id');
            return;
        }
        const cue = cueStoreRef.getCueById(cueId);
        console.log(`IPC Binding (play-audio-by-id): Cue found by ID ${cueId}?`, cue ? 'Yes' : 'No', cue);
        if (cue && typeof audioControllerRef.play === 'function') {
            // Play typically implies a fresh play or resume if paused.
            // If it's playing, retrigger logic is usually in toggle. 
            // For a direct 'play' command from Companion, it might mean force play/restart.
            // The audioController.play will handle resume if paused, or restart if already playing.
            // If specific retrigger is needed, Companion should send 'toggle' with behavior.
            console.log(`IPC: play-audio-by-id received for ${cueId}. Calling audioController.play.`);
            audioControllerRef.play(cue); 
        } else {
            console.warn(`Cue ${cueId} not found or audioControllerRef.play not available.`);
        }
    });

    electronAPIInstance.on('stop-audio-by-id', (cueId) => {
        console.log(`IPC Binding: Received 'stop-audio-by-id' for cueId: ${cueId}`);
        if (!cueStoreRef || !audioControllerRef) {
            console.warn('IPC Binding: cueStoreRef or audioControllerRef not set for stop-audio-by-id');
            return;
        }
        const cue = cueStoreRef.getCueById(cueId);
        console.log(`IPC Binding (stop-audio-by-id): Cue found by ID ${cueId}?`, cue ? 'Yes' : 'No', cue);
        if (cue && typeof audioControllerRef.stop === 'function') {
            console.log(`IPC: stop-audio-by-id received for ${cueId}. Calling audioController.stop.`);
            audioControllerRef.stop(cueId, true, true); // fromCompanion = true, useFade = true
        } else {
             console.warn(`Cue ${cueId} not found or audioControllerRef.stop not available.`);
        }
    });

    electronAPIInstance.on('toggle-audio-by-id', (cueId) => {
        console.log(`IPC Binding: Received 'toggle-audio-by-id' for cueId: ${cueId}`);
        if (!cueStoreRef || !audioControllerRef) {
            console.warn('IPC Binding: cueStoreRef or audioControllerRef not set for toggle-audio-by-id');
            return;
        }
        const cue = cueStoreRef.getCueById(cueId);
        console.log(`IPC Binding (toggle-audio-by-id): Cue found by ID ${cueId}?`, cue ? 'Yes' : 'No', cue);
        if (cue && typeof audioControllerRef.toggle === 'function') {
            // Companion toggle will use the default retrigger behavior in audioController.toggle (which is 'restart')
            // unless Companion starts sending a specific behavior.
            console.log(`IPC: toggle-audio-by-id received for ${cueId}. Calling audioController.toggle.`);
            audioControllerRef.toggle(cue, true);
        } else {
            console.warn(`Cue ${cueId} not found or audioControllerRef.toggle not available.`);
        }
    });

    // Listener for workspace changes from the main process
    electronAPIInstance.on('workspace-did-change', async () => {
        console.log('IPC Binding: Received workspace-did-change signal.');
        try {
            if (uiRef && typeof uiRef.handleWorkspaceChange === 'function') {
                await uiRef.handleWorkspaceChange(); 
            } else {
                console.warn('uiRef.handleWorkspaceChange not available or uiRef not set yet. Attempting fallbacks.');
                if (cueStoreRef && typeof cueStoreRef.loadCuesFromServer === 'function') {
                    await cueStoreRef.loadCuesFromServer();
                    console.log('IPC Binding: Fallback: Requested cueStore to reload cues.');
                }
                if (uiRef && typeof uiRef.loadAndApplyAppConfiguration === 'function') { // Assuming uiRef could still have other useful methods
                    await uiRef.loadAndApplyAppConfiguration();
                    console.log('IPC Binding: Fallback: Requested ui to reload app configuration.');
                }
            }
        } catch (error) {
            console.error('IPC Binding: Error handling workspace-did-change:', error);
        }
    });

    // --- Listener for triggering cues from main process (e.g., via HTTP remote or Companion) ---
    // Ensure any previous listeners are removed before adding a new one, to prevent duplication if setupListeners were ever called multiple times.
    if (electronAPIInstance && typeof electronAPIInstance.removeAllListeners === 'function') {
        console.log("IPC Binding: Removing existing listeners for 'trigger-cue-by-id-from-main' before re-adding.");
        electronAPIInstance.removeAllListeners('trigger-cue-by-id-from-main');
    }
    let triggerCueByIdFromMainInProgress = false; // Flag to prevent re-entrancy
    electronAPIInstance.on('trigger-cue-by-id-from-main', ({ cueId, source }) => {
        if (triggerCueByIdFromMainInProgress) {
            console.warn(`IPC Binding: 'trigger-cue-by-id-from-main' for ${cueId} (source: ${source}) IGNORED, flag indicates another trigger is already processing.`);
            return;
        }
        triggerCueByIdFromMainInProgress = true;
        console.log(`IPC Binding: Received 'trigger-cue-by-id-from-main' for cue: ${cueId}, source: ${source}. Processing.`);
        
        try {
            if (audioControllerRef && typeof audioControllerRef.playCueByIdFromMain === 'function') {
                audioControllerRef.playCueByIdFromMain(cueId, source);
            } else {
                console.warn(`IPC Binding: audioControllerRef.playCueByIdFromMain not available for cue ${cueId} from source ${source}. audioControllerRef:`, audioControllerRef);
            }
        } finally {
            // Reset the flag after a short delay to allow the call stack to unwind and prevent immediate re-trigger
            // by a potentially duplicated event, but allow subsequent legitimate events.
            setTimeout(() => {
                triggerCueByIdFromMainInProgress = false;
                console.log(`IPC Binding: 'trigger-cue-by-id-from-main' flag reset for ${cueId}.`);
            }, 50); // 50ms should be enough for most duplicated events if they are near-simultaneous
        }
    });

    electronAPIInstance.on('mixer-subscription-feedback', (feedbackData) => {
        console.log('IPC Binding: Received mixer-subscription-feedback', feedbackData);
        if (sidebarsRef && typeof sidebarsRef.updateMixerSubFeedbackDisplay === 'function') {
            sidebarsRef.updateMixerSubFeedbackDisplay(feedbackData.buttonId, feedbackData.value);
        } else {
            console.warn('sidebarsRef or updateMixerSubFeedbackDisplay not available.');
        }
    });

    // Listener for continuous playback time updates
    electronAPIInstance.on('playback-time-update-from-main', (data) => {
        // console.log('[IPC_BINDING_DEBUG] Received playback-time-update-from-main:', data);
        if (uiRef && typeof uiRef.updateCueButtonTimeDisplay === 'function') {
            uiRef.updateCueButtonTimeDisplay(data);
        } else {
            // console.warn('[IPC_BINDING_DEBUG] uiRef or uiRef.updateCueButtonTimeDisplay not available for playback-time-update-from-main.');
        }
    });

    // Listener for highlighting playing playlist item in sidebar
    electronAPIInstance.on('highlight-playing-item', (data) => {
        console.log('IPC Binding: Received highlight-playing-item', data);
        if (uiRef && typeof uiRef.highlightPlayingItem === 'function') {
            uiRef.highlightPlayingItem(data);
        } else {
            console.warn('uiRef or highlightPlayingItem not available for highlight-playing-item.');
        }
    });
};

// Note: ipcRendererBindings itself no longer directly calls audioController methods like playCueById, stopCue, etc.
// It receives events from main and calls the new methods (play, stop, toggle) on audioControllerRef.

export {
    initialize,
    setModuleRefs,
    getCuesFromMain,
    saveCuesToMain,
    generateUUID,
    sendCueStatusUpdate,
    getAppConfig,
    saveAppConfig,
    getAudioOutputDevices,
    addOrUpdateCue,
    deleteCue,
    sendCueDurationUpdate,
    getAudioFileBuffer,
    getOrGenerateWaveformPeaks,
    getMediaDuration,
    configureWingButtonForCue,
    clearWingButtonForCue,
    setAudioOutputDevice,
    showMultipleFilesDropModalComplete,
    showOpenDialog,
    showSaveDialog
};