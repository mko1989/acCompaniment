// acCompaniment/src/renderer/ipcRendererBindings.js
// Sets up renderer-side IPC listeners and sender functions.

let electronAPIInstance;

let audioControllerRef = null;
let dragDropHandlerRef = null;
let cueStoreRef = null;
let uiRef = null;
let appConfigUIRef = null;
let sidebarsRef = null;

let _cueListUpdatedCallback = null; // To store the callback from cueStore
let queuedCuesUpdate = null; // To queue cues if callback isn't ready
let cuesUpdatedListenerRegistered = false; // Flag to ensure listener is only set once

const setAudioOutputDevice = (deviceId) => electronAPIInstance.invoke('set-audio-output-device', deviceId);
const showMultipleFilesDropModalComplete = (result) => electronAPIInstance.send('multiple-files-drop-modal-complete', result);
const showOpenDialog = (options) => electronAPIInstance.invoke('show-open-dialog', options);
const showSaveDialog = (options) => electronAPIInstance.invoke('show-save-dialog', options);
const sendStartOscLearn = (cueId) => electronAPIInstance.send('start-osc-learn', cueId);
const sendStopOscLearn = () => electronAPIInstance.send('stop-osc-learn');
const sendSaveOscConfig = (config) => electronAPIInstance.invoke('save-osc-config', config);
const sendRequestOscConfig = () => electronAPIInstance.invoke('request-osc-config');
const sendOscMessageToMixer = (message) => electronAPIInstance.invoke('send-osc-message-to-mixer', message);


function initialize(electronAPI) {
    console.log('IPC Binding: initialize() CALLED');
    electronAPIInstance = electronAPI;

    if (electronAPIInstance && typeof electronAPIInstance.on === 'function') {
        // DO NOT set up 'cues-updated-from-main' listener here anymore.
        // It will be set up by registerCueListUpdatedCallback.
        setupOtherListeners(); // Assuming other listeners can be set up here
    } else {
        console.error('electronAPI not found or `on` is not a function. IPC listeners will not work.');
    }
}

function setModuleRefs(modules) {
    console.log('IPC Binding: setModuleRefs CALLED with:', modules);
    // Ensure we are getting the .default export if modules are imported with import *
    // audioCtrl is expected to be the audioController namespace import
    audioControllerRef = modules.audioCtrl && modules.audioCtrl.default ? modules.audioCtrl.default : modules.audioCtrl;
    dragDropHandlerRef = modules.dragDropCtrl && modules.dragDropCtrl.default ? modules.dragDropCtrl.default : modules.dragDropCtrl;
    cueStoreRef = modules.cueStoreMod && modules.cueStoreMod.default ? modules.cueStoreMod.default : modules.cueStoreMod;
    uiRef = modules.uiMod && modules.uiMod.default ? modules.uiMod.default : modules.uiMod;
    appConfigUIRef = modules.appConfigUIMod && modules.appConfigUIMod.default ? modules.appConfigUIMod.default : modules.appConfigUIMod;
    sidebarsRef = modules.sidebarsAPI; // This is expected to be the direct module/API, not a namespace

    console.log('IPC Binding: audioControllerRef after setModuleRefs:', audioControllerRef);
    console.log('IPC Binding: dragDropHandlerRef after setModuleRefs:', dragDropHandlerRef);
    console.log('IPC Binding: cueStoreRef after setModuleRefs:', cueStoreRef);
    console.log('IPC Binding: uiRef after setModuleRefs:', uiRef);
    console.log('IPC Binding: appConfigUIRef after setModuleRefs:', appConfigUIRef);
    console.log('IPC Binding: sidebarsRef after setModuleRefs:', sidebarsRef);

    // Validate that essential refs are now actual objects with expected functions
    if (audioControllerRef && typeof audioControllerRef.playCueByIdFromMain === 'function') {
        console.log('IPC Binding: audioControllerRef.playCueByIdFromMain is now available.');
    } else {
        console.warn('IPC Binding: audioControllerRef.playCueByIdFromMain is STILL NOT available after setModuleRefs. Check imports and module structure.', audioControllerRef);
    }
    if (audioControllerRef && typeof audioControllerRef.toggle === 'function') {
        console.log('IPC Binding: audioControllerRef.toggle is now available.');
    } else {
        console.warn('IPC Binding: audioControllerRef.toggle is STILL NOT available after setModuleRefs.');
    }

    // Note: showModal functionality is handled by the modals module, not directly by uiRef
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

async function saveReorderedCues(reorderedCues) {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for save-reordered-cues");
    return electronAPIInstance.invoke('save-reordered-cues', reorderedCues);
}

async function generateUUID() {
    if (!electronAPIInstance) {
        console.error("electronAPIInstance not available for UUID generation, falling back.");
        // More robust fallback UUID generation using crypto if available
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback to timestamp + better random component
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
        return `cue_fallback_${timestamp}_${randomPart}`;
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

// New function to get HTTP remote info
async function getHttpRemoteInfo() {
    if (!electronAPIInstance) throw new Error("electronAPIInstance not available for get-http-remote-info");
    return electronAPIInstance.invoke('get-http-remote-info');
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
function setupOtherListeners() {
    console.log('IPC Binding: setupOtherListeners() CALLED');
    // Example: electronAPIInstance.on('some-other-event', handler);
    // The original setupListeners had more, so those would be refactored here or initialized directly
    // For instance, 'app-config-updated-from-main', 'play-audio-by-id', etc.
    // This refactoring requires careful checking of the original setupListeners content.

    // Re-adding other listeners from the original setupListeners function explicitly here
    // to ensure they are still active. The 'cues-updated-from-main' is the one being moved.

    electronAPIInstance.on('main-process-ready', () => {
        console.log('IPC Binding: Received main-process-ready signal.');
    });

    electronAPIInstance.on('app-config-updated-from-main', (newConfig) => { 
        console.log('IPC Binding: SUCCESS - Received app-config-updated-from-main with new config:', newConfig);
        if (uiRef && typeof uiRef.applyAppConfiguration === 'function') {
            uiRef.applyAppConfiguration(newConfig);
        }
    });

    electronAPIInstance.on('play-audio-by-id', (cueId) => {
        console.log(`IPC Binding: Received 'play-audio-by-id' for cueId: ${cueId}`);
        if (cueStoreRef && audioControllerRef && audioControllerRef.play) {
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) audioControllerRef.play(cue);
        }
    });

    electronAPIInstance.on('stop-audio-by-id', (cueId) => {
        console.log(`IPC Binding: Received 'stop-audio-by-id' for cueId: ${cueId}`);
        if (audioControllerRef && audioControllerRef.stop) {
            audioControllerRef.stop(cueId, true, true);
        }
    });

    electronAPIInstance.on('toggle-audio-by-id', (cueId) => {
        console.log(`IPC Binding: Received 'toggle-audio-by-id' for cueId: ${cueId}`);
        if (cueStoreRef && audioControllerRef && audioControllerRef.toggle) {
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) audioControllerRef.toggle(cue, true);
        }
    });

    electronAPIInstance.on('workspace-did-change', async () => {
        console.log('IPC Binding: Received workspace-did-change signal.');
        if (uiRef && typeof uiRef.handleWorkspaceChange === 'function') {
            await uiRef.handleWorkspaceChange(); 
        }
    });
    
    let triggerCueByIdFromMainInProgress = false;
    electronAPIInstance.on('trigger-cue-by-id-from-main', ({ cueId, source }) => {
        console.log(`IPC Binding: Received 'trigger-cue-by-id-from-main' for cue: ${cueId}, source: ${source}`);
        
        if (triggerCueByIdFromMainInProgress) {
            console.log(`IPC Binding: Ignoring duplicate 'trigger-cue-by-id-from-main' for cue: ${cueId} (already in progress)`);
            return;
        }
        
        triggerCueByIdFromMainInProgress = true;
        console.log(`IPC Binding: Processing 'trigger-cue-by-id-from-main' for cue: ${cueId}, source: ${source}`);
        
        try {
            if (!audioControllerRef) {
                console.error(`IPC Binding: audioControllerRef is not available for cue: ${cueId}`);
                return;
            }
            
            if (typeof audioControllerRef.playCueByIdFromMain !== 'function') {
                console.error(`IPC Binding: audioControllerRef.playCueByIdFromMain is not a function for cue: ${cueId}`);
                return;
            }
            
            console.log(`IPC Binding: Calling audioControllerRef.playCueByIdFromMain for cue: ${cueId}`);
            audioControllerRef.playCueByIdFromMain(cueId, source);
            console.log(`IPC Binding: Successfully called audioControllerRef.playCueByIdFromMain for cue: ${cueId}`);
        } catch (error) {
            console.error(`IPC Binding: Error processing 'trigger-cue-by-id-from-main' for cue: ${cueId}:`, error);
        } finally {
            setTimeout(() => { 
                triggerCueByIdFromMainInProgress = false;
                console.log(`IPC Binding: Reset triggerCueByIdFromMainInProgress flag for cue: ${cueId}`);
            }, 50);
        }
    });

    electronAPIInstance.on('mixer-subscription-feedback', (feedbackData) => {
        if (sidebarsRef && typeof sidebarsRef.updateMixerSubFeedbackDisplay === 'function') {
            sidebarsRef.updateMixerSubFeedbackDisplay(feedbackData.buttonId, feedbackData.value);
        }
    });

    electronAPIInstance.on('playback-time-update-from-main', (data) => {
        if (uiRef && typeof uiRef.updateCueButtonTimeDisplay === 'function') {
            uiRef.updateCueButtonTimeDisplay(data);
        }
    });

    electronAPIInstance.on('highlight-playing-item', (data) => {
        if (uiRef && typeof uiRef.highlightPlayingItem === 'function') {
            uiRef.highlightPlayingItem(data);
        }
    });

    // Playlist navigation listeners for external sources (Companion/HTTP remote)
    // These are ONLY for messages from main process (external sources), not UI clicks
    electronAPIInstance.on('playlist-navigate-next-from-main', (cueId) => {
        console.log(`IPC Binding: Received 'playlist-navigate-next-from-main' from EXTERNAL source for cueId: ${cueId}`);
        console.log(`IPC Binding: audioControllerRef exists: ${!!audioControllerRef}, playlistNavigateNext function exists: ${!!(audioControllerRef && audioControllerRef.playlistNavigateNext)}`);
        if (audioControllerRef && typeof audioControllerRef.playlistNavigateNext === 'function') {
            const result = audioControllerRef.playlistNavigateNext(cueId, true); // true = from external source
            console.log(`IPC Binding: playlistNavigateNext result for ${cueId}: ${result}`);
        } else {
            console.error('IPC Binding: audioControllerRef.playlistNavigateNext not available for external navigation');
        }
    });

    electronAPIInstance.on('playlist-navigate-previous-from-main', (cueId) => {
        console.log(`IPC Binding: Received 'playlist-navigate-previous-from-main' from EXTERNAL source for cueId: ${cueId}`);
        if (audioControllerRef && typeof audioControllerRef.playlistNavigatePrevious === 'function') {
            const result = audioControllerRef.playlistNavigatePrevious(cueId, true); // true = from external source
            console.log(`IPC Binding: playlistNavigatePrevious result for ${cueId}: ${result}`);
        } else {
            console.error('IPC Binding: audioControllerRef.playlistNavigatePrevious not available for external navigation');
        }
    });

    electronAPIInstance.on('playlist-jump-to-item-from-main', (data) => {
        console.log(`IPC Binding: Received 'playlist-jump-to-item-from-main' from EXTERNAL source for cueId: ${data.cueId}, index: ${data.targetIndex}`);
        if (audioControllerRef && typeof audioControllerRef.playlistJumpToItem === 'function') {
            const result = audioControllerRef.playlistJumpToItem(data.cueId, data.targetIndex, true); // true = from external source
            console.log(`IPC Binding: playlistJumpToItem result for ${data.cueId}: ${result}`);
        } else {
            console.error('IPC Binding: audioControllerRef.playlistJumpToItem not available for external navigation');
        }
    });
}

// Note: ipcRendererBindings itself no longer directly calls audioController methods like playCueById, stopCue, etc.
// It receives events from main and calls the new methods (play, stop, toggle) on audioControllerRef.

function registerCueListUpdatedCallback(callback) {
    console.log('IPC Binding: registerCueListUpdatedCallback CALLED. Registering callback:', typeof callback === 'function' ? 'Function received' : 'NOT a function');
    if (typeof callback === 'function') {
        _cueListUpdatedCallback = callback; // Store the callback
        console.log('IPC Binding: _cueListUpdatedCallback has been SET.');

        // Set up the listener only if it hasn't been done already
        if (!cuesUpdatedListenerRegistered && electronAPIInstance && typeof electronAPIInstance.on === 'function') {
            console.log(`IPC Binding: Setting up 'cues-updated-from-main' listener NOW.`);
            electronAPIInstance.on('cues-updated-from-main', (cues) => {
                console.log(`IPC Binding: Event 'cues-updated-from-main' received. Number of cues: ${cues ? cues.length : 'N/A'}`);
                // Now _cueListUpdatedCallback should be the one just set
                if (typeof _cueListUpdatedCallback === 'function') {
                    console.log('IPC Binding: Invoking _cueListUpdatedCallback from newly registered listener.');
                    _cueListUpdatedCallback(cues);
                } else {
                    // This case should ideally not happen if registration logic is correct
                    console.error('IPC Binding: cues-updated-from-main event, but _cueListUpdatedCallback is still not a function!');
                }
            });
            cuesUpdatedListenerRegistered = true;
            console.log('IPC Binding: cues-updated-from-main listener has been registered.');
        } else if (cuesUpdatedListenerRegistered) {
            console.log('IPC Binding: cues-updated-from-main listener was already registered.');
        } else {
            console.error('IPC Binding: Cannot register cues-updated-from-main listener - electronAPIInstance not available.');
        }

        // Process any queued update immediately with the now registered callback and listener
        if (queuedCuesUpdate) {
            console.log('IPC Binding: Found queued cues update. Processing it now with the new callback.');
            if (typeof _cueListUpdatedCallback === 'function') {
                 _cueListUpdatedCallback(queuedCuesUpdate);
            } else {
                // Should not happen if we just set it
                console.error('IPC Binding: Queued update exists, but _cueListUpdatedCallback is not callable even after assignment!');
            }
            queuedCuesUpdate = null; // Clear the queue
        }
    } else {
        console.error('IPC Binding: Attempted to register a non-function as cue list updated callback.');
    }
}

export {
    initialize,
    setModuleRefs,
    getCuesFromMain,
    saveCuesToMain,
    saveReorderedCues,
    generateUUID,
    sendCueStatusUpdate,
    getAppConfig,
    saveAppConfig,
    getAudioOutputDevices,
    getHttpRemoteInfo,
    addOrUpdateCue,
    deleteCue,
    sendCueDurationUpdate,
    getAudioFileBuffer,
    getOrGenerateWaveformPeaks,
    getMediaDuration,
    setAudioOutputDevice,
    showMultipleFilesDropModalComplete,
    showOpenDialog,
    showSaveDialog,
    sendStartOscLearn,
    sendStopOscLearn,
    sendSaveOscConfig,
    sendRequestOscConfig,
    sendOscMessageToMixer,
    registerCueListUpdatedCallback
};