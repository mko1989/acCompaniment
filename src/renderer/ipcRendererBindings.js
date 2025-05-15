// Companion_soundboard/src/renderer/ipcRendererBindings.js
// Sets up renderer-side IPC listeners and sender functions.

let audioControllerRef;
let dragDropHandlerRef;
let cueStoreRef; // Added cueStore reference
let uiRef; // For getting retrigger behavior for Companion toggle - or decide on a default

function initialize(audioCtrl, dragDropCtrl, cueStore, uiModule) {
    audioControllerRef = audioCtrl;
    dragDropHandlerRef = dragDropCtrl;
    cueStoreRef = cueStore; 
    uiRef = uiModule; // To potentially get default retrigger or pass it through

    if (window.electronAPI && typeof window.electronAPI.on === 'function') {
        setupListeners();
    } else {
        console.error('electronAPI not found or `on` is not a function. IPC listeners will not work.');
    }
}

// --- Senders to Main Process ---
async function getCuesFromMain() {
    if (!window.electronAPI) throw new Error("electronAPI not available for get-cues");
    return window.electronAPI.invoke('get-cues');
}

async function saveCuesToMain(cues) {
    if (!window.electronAPI) throw new Error("electronAPI not available for save-cues");
    return window.electronAPI.invoke('save-cues', cues);
}

async function generateUUID() {
    if (!window.electronAPI) {
        console.error("electronAPI not available for UUID generation, falling back.");
        return 'cue_fallback_' + Date.now().toString(36) + Math.random().toString(36).substring(2);
    }
    return window.electronAPI.invoke('generate-uuid');
}

// This function is now primarily called by audioController itself after init.
// If other modules need to send status, they should go via audioController or a new shared service.
function sendCueStatusUpdate(cueId, status, details = null) {
    if (!window.electronAPI) {
        console.error('electronAPI not available for cue-status-update-for-companion');
        return;
    }
    const payload = { cueId, status };
    if (details) payload.details = details; 
    window.electronAPI.send('cue-status-update-for-companion', payload);
}

// New functions for App Configuration
async function getAppConfig() {
    if (!window.electronAPI) throw new Error("electronAPI not available for get-app-config");
    return window.electronAPI.invoke('get-app-config');
}

function saveAppConfig(configData) {
    if (!window.electronAPI) {
        console.error("electronAPI not available for save-app-config");
        return;
    }
    window.electronAPI.send('save-app-config', configData);
}

// New function to get audio output devices
async function getAudioOutputDevices() {
    if (!window.electronAPI) throw new Error("electronAPI not available for get-audio-output-devices");
    return window.electronAPI.invoke('get-audio-output-devices');
}

async function addOrUpdateCue(cueData) {
    if (!window.electronAPI) throw new Error("electronAPI not available for add-or-update-cue");
    console.log(`IPC Binding: Sending add-or-update-cue for cue ID: ${cueData.id || 'new cue'}`);
    return window.electronAPI.invoke('add-or-update-cue', cueData);
}

async function deleteCue(cueId) {
    if (!window.electronAPI) throw new Error("electronAPI not available for delete-cue");
    console.log(`IPC Binding: Sending delete-cue for cue ID: ${cueId}`);
    return window.electronAPI.invoke('delete-cue', cueId);
}

// New function to send discovered duration to the main process
function sendCueDurationUpdate(cueId, duration, playlistItemId = null) {
    if (!window.electronAPI) {
        console.error("electronAPI not available for cue-duration-update");
        return;
    }
    console.log(`IPC Binding: Sending cue-duration-update for cue: ${cueId}, item: ${playlistItemId || 'N/A'}, duration: ${duration}`);
    window.electronAPI.send('cue-duration-update', { cueId, duration, playlistItemId });
}

// --- Listeners for Main Process Events ---
function setupListeners() {
    // Listen for files dropped (forwarded from main process)
    /*
    window.electronAPI.on('files-dropped-on-app', (filePaths) => {
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

    // Listener for when the main process sends updated cues (e.g., after a duration update)
    window.electronAPI.on('cues-updated-from-main', (updatedCuesList) => {
        console.log('IPC Binding: Received cues-updated-from-main.', updatedCuesList);
        if (cueStoreRef && typeof cueStoreRef.setCuesFromMain === 'function') {
            cueStoreRef.setCuesFromMain(updatedCuesList);
            // After cueStore is updated, tell UI to re-render.
            if (uiRef && typeof uiRef.renderCues === 'function') {
                uiRef.renderCues();
            }
        } else {
            console.warn('cueStoreRef or setCuesFromMain not available for cues-updated-from-main.');
        }
    });

    window.electronAPI.on('play-audio-by-id', (cueId) => {
        if (!cueStoreRef || !audioControllerRef) {
            console.warn('cueStore or audioController not initialized for play-audio-by-id');
            return;
        }
        const cue = cueStoreRef.getCueById(cueId);
        if (cue && typeof audioControllerRef.play === 'function') {
            // Play typically implies a fresh play or resume if paused.
            // If it's playing, retrigger logic is usually in toggle. 
            // For a direct 'play' command from Companion, it might mean force play/restart.
            // The audioController.play will handle resume if paused, or restart if already playing.
            // If specific retrigger is needed, Companion should send 'toggle' with behavior.
            console.log(`IPC: play-audio-by-id received for ${cueId}. Calling audioController.play.`);
            audioControllerRef.play(cue); 
        } else {
            console.warn(`Cue ${cueId} not found or audioController.play not available.`);
        }
    });

    window.electronAPI.on('stop-audio-by-id', (cueId) => {
        if (!cueStoreRef || !audioControllerRef) {
            console.warn('cueStore or audioController not initialized for stop-audio-by-id');
            return;
        }
        const cue = cueStoreRef.getCueById(cueId);
        if (cue && typeof audioControllerRef.stop === 'function') {
            console.log(`IPC: stop-audio-by-id received for ${cueId}. Calling audioController.stop.`);
            audioControllerRef.stop(cueId, true, true); // fromCompanion = true, useFade = true
        } else {
             console.warn(`Cue ${cueId} not found or audioController.stop not available.`);
        }
    });

    window.electronAPI.on('stop-all-audio', () => {
        if (audioControllerRef && typeof audioControllerRef.stopAll === 'function') {
            audioControllerRef.stopAll(true); // fromCompanion = true
        } else {
            console.warn('audioControllerRef or stopAll not available for stop-all-audio.');
        }
    });

    window.electronAPI.on('toggle-audio-by-id', (cueId) => {
        if (!cueStoreRef || !audioControllerRef) {
            console.warn('cueStore or audioController not initialized for toggle-audio-by-id');
            return;
        }
        const cue = cueStoreRef.getCueById(cueId);
        if (cue && typeof audioControllerRef.toggle === 'function') {
            // Companion toggle will use the default retrigger behavior in audioController.toggle (which is 'restart')
            // unless Companion starts sending a specific behavior.
            console.log(`IPC: toggle-audio-by-id received for ${cueId}. Calling audioController.toggle.`);
            audioControllerRef.toggle(cue, true);
        } else {
            console.warn(`Cue ${cueId} not found or audioController.toggle not available.`);
        }
    });

    // Listener for workspace changes from the main process
    window.electronAPI.on('workspace-did-change', async () => {
        console.log('IPC Binding: Received workspace-did-change signal.');
        try {
            if (uiRef && typeof uiRef.handleWorkspaceChange === 'function') {
                // It might be better for ui.js to coordinate this
                await uiRef.handleWorkspaceChange(); 
            } else {
                // Fallback to direct calls if ui.handleWorkspaceChange is not implemented
                console.warn('uiRef.handleWorkspaceChange not available, attempting direct reloads.');
                if (cueStoreRef && typeof cueStoreRef.loadCuesFromServer === 'function') {
                    await cueStoreRef.loadCuesFromServer(); // This should internally trigger UI update for cues
                    console.log('IPC Binding: Requested cueStore to reload cues.');
                }
                if (uiRef && typeof uiRef.loadAndApplyAppConfiguration === 'function') {
                    await uiRef.loadAndApplyAppConfiguration(); // This reloads app config and updates UI
                    console.log('IPC Binding: Requested ui to reload app configuration.');
                }
            }
        } catch (error) {
            console.error('IPC Binding: Error handling workspace-did-change:', error);
            // Optionally, inform the user that the workspace refresh failed.
        }
    });
}

// Note: ipcRendererBindings itself no longer directly calls audioController methods like playCueById, stopCue, etc.
// It receives events from main and calls the new methods (play, stop, toggle) on audioControllerRef.

export {
    initialize,
    getCuesFromMain,
    saveCuesToMain,
    generateUUID,
    sendCueStatusUpdate, // Still exported if any other module *really* needs direct IPC send capability for this.
    addOrUpdateCue,      // Export new function
    deleteCue,           // Export new function
    getAppConfig,      // Export new function
    saveAppConfig,      // Export new function
    getAudioOutputDevices, // Export new function
    sendCueDurationUpdate, // Export new function
}; 