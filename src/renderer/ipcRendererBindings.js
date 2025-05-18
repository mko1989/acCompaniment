// Companion_soundboard/src/renderer/ipcRendererBindings.js
// Sets up renderer-side IPC listeners and sender functions.

let electronAPIInstance;

let audioControllerRef = null;
let dragDropHandlerRef = null;
let cueStoreRef = null;
let uiRef = null;
let appConfigUIRef = null;

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
        console.log('IPC Binding: Received main-process-ready signal.');
        if (uiRef && typeof uiRef.onMainProcessReady === 'function') {
            uiRef.onMainProcessReady();
        } else {
            console.warn('IPC Binding: uiRef.onMainProcessReady not available or uiRef not set yet for main-process-ready.');
        }
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

    electronAPIInstance.on('stop-all-audio', () => {
        console.log("IPC Binding: Received 'stop-all-audio'");
        if (audioControllerRef && typeof audioControllerRef.stopAll === 'function') {
            audioControllerRef.stopAll(true); // fromCompanion = true
        } else {
            console.warn('audioControllerRef.stopAll not available or audioControllerRef not set yet.');
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
}

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
    getOrGenerateWaveformPeaks
}; 