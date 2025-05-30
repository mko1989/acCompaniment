// Companion_soundboard/src/renderer/cueStore.js
// Manages the client-side cache of cue data.

let cues = [];
let ipcBindings; // To interact with main process for loading/saving
let sidebarsAPI; // To notify sidebars to refresh
let uiAPI; // To notify UI to refresh grid
let uiModule; // Store the ui.js module reference

// DEFAULT_MIDI_TRIGGER REMOVED
// const DEFAULT_MIDI_TRIGGER = {
//     enabled: false,
//     type: null,
//     channel: null,
//     note: null,
//     velocity: null,
//     controller: null,
//     value: null
// };

const DEFAULT_WING_TRIGGER = { // Added for consistency with main process
    enabled: false,
    userButton: null,
    mixerType: 'behringer_wing' // Default mixerType for WING trigger
};

// Call this function to initialize the module with dependencies
function init(ipcRendererBindings, sbAPI, mainUIApi) {
    ipcBindings = ipcRendererBindings;
    sidebarsAPI = sbAPI; // Store reference to sidebars module API
    uiAPI = mainUIApi; // Store reference to UI module API (or specific functions)
    uiModule = mainUIApi; // Store the ui.js module reference

    if (ipcBindings && typeof ipcBindings.onCueListUpdated === 'function') {
        ipcBindings.onCueListUpdated((updatedCues) => {
            // This is the renamed handleCuesUpdated function, now inline or called directly by the listener
            console.log('CueStore (onCueListUpdated): Received cues from main. Count:', updatedCues.length);
            if (Array.isArray(updatedCues)) {
                cues = updatedCues.map(cue => ({
                    ...cue,
                    wingTrigger: cue.wingTrigger ? { ...DEFAULT_WING_TRIGGER, mixerType: cue.wingTrigger.mixerType || 'behringer_wing', ...cue.wingTrigger } : { ...DEFAULT_WING_TRIGGER },
                }));

                console.log('CueStore (onCueListUpdated): Internal cache updated & sanitized.');

                if (sidebarsAPI && typeof sidebarsAPI.refreshPlaylistPropertiesView === 'function') {
                    cues.forEach(cue => {
                        if (cue.type === 'playlist') {
                            sidebarsAPI.refreshPlaylistPropertiesView(cue.id);
                        }
                    });
                }

                // Check if UI is fully initialized before refreshing the grid
                if (uiModule && typeof uiModule.isUIFullyInitialized === 'function' && uiModule.isUIFullyInitialized()) {
                    if (uiModule && typeof uiModule.refreshCueGrid === 'function') {
                        console.log("CueStore (onCueListUpdated): UI is ready. Calling uiModule.refreshCueGrid().");
                        uiModule.refreshCueGrid();
                    } else {
                        console.warn('CueStore (onCueListUpdated): uiModule.refreshCueGrid is not a function, though UI was reported ready.');
                    }
                } else {
                    console.log('CueStore (onCueListUpdated): UI not fully initialized yet. Grid refresh deferred.');
                }
            } else {
                console.error('CueStore (onCueListUpdated): Invalid data. Expected array.', updatedCues);
            }
        });
    }
}

async function loadCuesFromServer() {
    if (!ipcBindings) {
        console.error('CueStore: IPC bindings not initialized. Cannot load cues.');
        return false;
    }
    try {
        console.log('CueStore: Requesting cues from main process...');
        const loadedCues = await ipcBindings.getCuesFromMain();
        if (Array.isArray(loadedCues)) {
            // Ensure all cues from server have default trigger structures
            cues = loadedCues.map(cue => ({
                ...cue,
                // midiTrigger: cue.midiTrigger ? { ...DEFAULT_MIDI_TRIGGER, ...cue.midiTrigger } : { ...DEFAULT_MIDI_TRIGGER }, // REMOVED
                wingTrigger: cue.wingTrigger ? { ...DEFAULT_WING_TRIGGER, mixerType: cue.wingTrigger.mixerType || 'behringer_wing', ...cue.wingTrigger } : { ...DEFAULT_WING_TRIGGER },
                // oscTrigger: cue.oscTrigger || { enabled: false, path: '' } // REMOVED
            }));
            // Clean up any lingering properties that might have been missed or from very old files

            console.log('CueStore: Cues loaded from server and sanitized:', cues);
            return true;
        } else {
            console.error('CueStore: Received invalid cue data from server:', loadedCues);
            cues = []; // Fallback to empty
            return false;
        }
    } catch (error) {
        console.error('CueStore: Error loading cues from server:', error);
        cues = []; // Fallback to empty on error
        return false;
    }
}

// saveCuesToServer is likely obsolete if individual changes go through addOrUpdateCue / deleteCue
// and full saves are handled by main process workspace logic.
/*
async function saveCuesToServer() {
    if (!ipcBindings) {
        console.error('CueStore: IPC bindings not initialized. Cannot save cues.');
        return false;
    }
    try {
        console.log('CueStore: Saving cues to main process...', cues);
        await ipcBindings.saveCuesToMain(cues); // saveCuesToMain sends the ENTIRE cues array
        console.log('CueStore: Cues successfully saved to server.');
        return true;
    } catch (error) {
        console.error('CueStore: Error saving cues to server:', error);
        return false;
    }
}
*/

function getCueById(id) {
    return cues.find(cue => cue.id === id);
}

function getAllCues() {
    return [...cues]; // Return a copy to prevent direct modification
}

// Adds a new cue or updates an existing one by sending it to the main process
async function addOrUpdateCue(cueData) {
    if (!ipcBindings || typeof ipcBindings.addOrUpdateCue !== 'function') {
        console.error('CueStore: IPC bindings or addOrUpdateCue function not initialized. Cannot save cue.');
        // Consider throwing an error or returning a promise that rejects
        return { success: false, error: 'IPC bindings not available for saving cue.', cue: null };
    }
    // Basic check for cueData validity, especially if it's a new cue (no ID yet)
    if (!cueData || (!cueData.id && (!cueData.name && !cueData.filePath && (!cueData.playlistItems || cueData.playlistItems.length === 0)))) {
        console.error('CueStore: Invalid or insufficient cue data for add/update.', cueData);
        return { success: false, error: 'Invalid or insufficient cue data provided.', cue: null };
    }

    // Sanitize cueData before sending to main process

    const sanitizedCueData = {
        ...cueData,
        wingTrigger: cueData.wingTrigger ? { ...DEFAULT_WING_TRIGGER, mixerType: cueData.wingTrigger.mixerType || 'behringer_wing', ...cueData.wingTrigger } : { ...DEFAULT_WING_TRIGGER },
    };

    console.log(`CueStore: Sending cue (ID: ${sanitizedCueData.id || 'new'}) to main process for add/update.`);
    try {
        // The main process will handle adding/updating, fetch durations, save, and then broadcast 'cues-updated-from-main'.
        // This store will then be updated by setCuesFromMain when that event is received.
        const result = await ipcBindings.addOrUpdateCue(sanitizedCueData); 
        if (result && result.success) {
            console.log(`CueStore: Cue (ID: ${result.cue.id}) processed successfully by main process.`);
            // No direct modification of 'this.cues' here. It will be updated via 'cues-updated-from-main' event.
        } else {
            console.error('CueStore: Main process failed to add/update cue.', result ? result.error : 'Unknown error');
        }
        return result; // Return the result from main { success, cue, error }
    } catch (error) {
        console.error('CueStore: Error calling addOrUpdateCue IPC binding:', error);
        return { success: false, error: error.message || 'IPC call failed', cue: null };
    }
}

async function deleteCue(id) {
    if (!ipcBindings || typeof ipcBindings.deleteCue !== 'function') { 
        console.error('CueStore: IPC bindings or deleteCue function not initialized. Cannot delete cue.');
        return { success: false, error: 'IPC bindings not available for deleting cue.' };
    }
    if (!id) {
        console.error('CueStore: Invalid cue ID for deletion.');
        return { success: false, error: 'Invalid cue ID for deletion.' };
    }

    console.log(`CueStore: Sending delete request for cue ID: ${id} to main process.`);
    try {
        // Main process handles deletion, saving, and broadcasting 'cues-updated-from-main'.
        const result = await ipcBindings.deleteCue(id);
        if (result && result.success) {
            console.log(`CueStore: Cue (ID: ${id}) delete request sent successfully to main process.`);
            // No direct modification of 'this.cues' here. It will be updated via 'cues-updated-from-main' event.
        } else {
            console.error('CueStore: Main process failed to delete cue.', result ? result.error : 'Unknown error');
        }
        return result; // Return { success, error }
    } catch (error) {
        console.error('CueStore: Error calling deleteCue IPC binding:', error);
        return { success: false, error: error.message || 'IPC call failed' };
    }
}

// New function to update the local cues cache from an authoritative main process update
// RENAMED from setCuesFromMain
// THIS FUNCTION IS NOW EFFECTIVELY INLINED/HANDLED BY ipcBindings.onCueListUpdated above.
// We keep it separate for clarity if we want to call it from elsewhere, but it duplicates logic now.
// For now, let's assume the ipcBindings.onCueListUpdated is the primary handler.

export { init, loadCuesFromServer, getCueById, getAllCues, addOrUpdateCue, deleteCue }; 