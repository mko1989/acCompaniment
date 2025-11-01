// Companion_soundboard/src/renderer/cueStore.js
// Manages the client-side cache of cue data.

let cues = [];
let ipcBindings; // To interact with main process for loading/saving
let sidebarsAPI; // To notify sidebars to refresh
let uiAPI; // To notify UI to refresh grid
let cueGridAPI; // Specifically for refreshing the cue grid
// let uiModule; // Store the ui.js module reference - Replaced by specific API refs

let isInitialized = false; // Flag to indicate if init has completed

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

// DEFAULT_WING_TRIGGER - REMOVED

// This is the actual handler function
function _handleCuesUpdated(updatedCues) {
    console.log('**************** CueStore (_handleCuesUpdated) ENTERED ****************');
    console.log('CueStore (_handleCuesUpdated): Received cues from main. Count:', updatedCues ? updatedCues.length : 'N/A');
    if (Array.isArray(updatedCues)) {
        cues = updatedCues.map(cue => {
            // Log the cue as it comes from main process before any potential re-mapping here
            console.log(`CueStore (_handleCuesUpdated MAP): Processing cue ID ${cue.id}. Main process version:`, JSON.parse(JSON.stringify(cue)));
            const newMappedCue = {
                ...cue, // Spread the incoming cue first
                // wingTrigger: REMOVED
                enableDucking: cue.enableDucking !== undefined ? cue.enableDucking : false,
                isDuckingTrigger: cue.isDuckingTrigger !== undefined ? cue.isDuckingTrigger : false,
                duckingLevel: cue.duckingLevel !== undefined ? cue.duckingLevel : 80,
            };
            // Ensure trim defaults are respected: start defaults to 0, end remains undefined if not set
            if (newMappedCue.trimStartTime === undefined || newMappedCue.trimStartTime === null) {
                newMappedCue.trimStartTime = 0;
            }
            if (newMappedCue.trimEndTime === 0) {
                // Interpret 0 end as unset; use undefined so UI shows "End" and playback calculates correctly
                delete newMappedCue.trimEndTime;
            }
            console.log(`CueStore (_handleCuesUpdated MAP): Mapped cue ID ${cue.id}. Renderer version:`, JSON.parse(JSON.stringify(newMappedCue)));
            return newMappedCue;
        });

        console.log('CueStore (_handleCuesUpdated): Internal cache updated & sanitized.');

        // Refresh properties sidebar if it's open for a playlist that might have changed
        // sidebarsAPI should be uiHandles.propertiesSidebarModule from init
        // CRITICAL: Skip refresh if update is from waveform trim to prevent infinite loops
        if (sidebarsAPI && typeof sidebarsAPI.getActivePropertiesCueId === 'function' && typeof sidebarsAPI.openPropertiesSidebar === 'function') {
            if (window._waveformTrimUpdateInProgress) {
                console.log('CueStore (_handleCuesUpdated): Skipping properties sidebar refresh - waveform trim update in progress');
            } else {
                const activeCueId = sidebarsAPI.getActivePropertiesCueId();
                if (activeCueId) {
                    const activeCue = cues.find(c => c.id === activeCueId);
                    if (activeCue) { // No longer just for playlists, refresh for any active cue
                        console.log(`CueStore (_handleCuesUpdated): Active cue ${activeCueId} found, re-opening/refreshing properties view.`);
                        // Re-open properties sidebar to refresh its content with potentially updated cue data
                        sidebarsAPI.openPropertiesSidebar(activeCue);
                    }
                }
            }
        }

        // Check if UI is fully initialized before refreshing the grid
        // uiAPI should be uiHandles.uiModule or similar from init, cueGridAPI for the grid specifically
        if (cueGridAPI && typeof cueGridAPI.renderCues === 'function') {
            console.log("CueStore (_handleCuesUpdated): Calling cueGridAPI.renderCues().");
            cueGridAPI.renderCues(); // Directly call renderCues on the cueGrid module
        } else {
            console.warn('CueStore (_handleCuesUpdated): cueGridAPI.renderCues is not a function.');
        }
    } else {
        console.error('CueStore (_handleCuesUpdated): Invalid data. Expected array.', updatedCues);
    }
}

// Call this function to initialize the module with dependencies
function init(ipcRendererBindingsInstance, uiHandles) { // Expect uiHandles from renderer.js
    ipcBindings = ipcRendererBindingsInstance;
    // Store specific UI module handles from uiHandles
    if (uiHandles) {
        sidebarsAPI = uiHandles.propertiesSidebarModule; // Assuming this is how propertiesSidebar API is passed
        cueGridAPI = uiHandles.cueGridModule;         // Assuming this is how cueGrid API is passed
        uiAPI = uiHandles.uiModule;                   // General UI module if needed for other things
        console.log('CueStore init: Received uiHandles. sidebarsAPI set:', !!sidebarsAPI, 'cueGridAPI set:', !!cueGridAPI);
    } else {
        console.warn('CueStore init: uiHandles not provided. UI refresh capabilities might be limited.');
    }

    // ---- START DEBUG LOG ----
    console.log('[CueStore Init Debug] typeof ipcBindings:', typeof ipcBindings);
    if (ipcBindings) {
        console.log('[CueStore Init Debug] ipcBindings object DIRECTLY (keys):', Object.keys(ipcBindings).join(', '));
        console.log('[CueStore Init Debug] typeof ipcBindings.registerCueListUpdatedCallback:', typeof ipcBindings.registerCueListUpdatedCallback);
    }
    // ---- END DEBUG LOG ----

    // Register the handler with ipcRendererBindings
    if (ipcBindings && typeof ipcBindings.registerCueListUpdatedCallback === 'function') {
        ipcBindings.registerCueListUpdatedCallback(_handleCuesUpdated);
        console.log('CueStore: Successfully registered _handleCuesUpdated with ipcRendererBindings.');
    } else {
        console.error('CueStore: Failed to register cue list updated callback. ipcBindings or registerCueListUpdatedCallback not available.');
    }
    isInitialized = true; // Set flag after init completes
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
                // wingTrigger: REMOVED
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

// Note: saveCuesToServer function removed as it's obsolete.
// Individual changes go through addOrUpdateCue/deleteCue and full saves
// are handled by main process workspace logic.

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
    if (!cueData) {
        console.error('CueStore: No cue data provided for add/update.');
        return { success: false, error: 'No cue data provided.', cue: null };
    }
    
    // For new cues (no ID), ensure we have either a name, filePath, or valid playlistItems
    if (!cueData.id && !cueData.name && !cueData.filePath && (!cueData.playlistItems || cueData.playlistItems.length === 0)) {
        console.error('CueStore: Invalid or insufficient cue data for add/update.', cueData);
        return { success: false, error: 'Invalid or insufficient cue data provided.', cue: null };
    }

    // Sanitize cueData before sending to main process

    const sanitizedCueData = {
        ...cueData,
        // wingTrigger: REMOVED
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

function isCueStoreReady() {
    return isInitialized;
}

async function reorderCues(newOrder) {
    // newOrder is an array of cue IDs in the desired order
    if (!ipcBindings || typeof ipcBindings.saveReorderedCues !== 'function') {
        console.error('CueStore: IPC bindings or saveReorderedCues function not initialized. Cannot reorder cues.');
        return { success: false, error: 'IPC bindings not available for reordering cues.' };
    }
    
    const allCues = getAllCues();
    const reorderedCues = newOrder.map(cueId => 
        allCues.find(c => c.id === cueId)
    ).filter(c => c !== undefined);
    
    if (reorderedCues.length !== allCues.length) {
        console.warn('CueStore: Reordered cues count does not match total cues. Some cues may be missing.');
    }
    
    console.log(`CueStore: Reordering ${reorderedCues.length} cues to new order.`);
    try {
        const result = await ipcBindings.saveReorderedCues(reorderedCues);
        if (result && result.success) {
            console.log(`CueStore: Cues reordered successfully.`);
        } else {
            console.error('CueStore: Failed to reorder cues.', result ? result.error : 'Unknown error');
        }
        return result;
    } catch (error) {
        console.error('CueStore: Error calling saveReorderedCues IPC binding:', error);
        return { success: false, error: error.message || 'IPC call failed' };
    }
}

async function saveReorderedCues(reorderedCues) {
    // Alias for reorderCues that takes the array directly
    const newOrder = reorderedCues.map(c => c.id);
    return reorderCues(newOrder);
}

export { init, loadCuesFromServer, getCueById, getAllCues, addOrUpdateCue, deleteCue, isCueStoreReady, reorderCues, saveReorderedCues }; 