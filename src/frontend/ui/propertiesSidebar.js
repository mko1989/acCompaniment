import * as waveformControls from './waveformControls.js';
import { debounce } from './utils.js';

// Import the new modular components
import { 
    cachePropertiesSidebarDOMElements, 
    getDOMElement, 
    showPropertiesSidebar, 
    hidePropertiesSidebar as hideSidebar,
    updateDuckingControlsVisibility 
} from './propertiesSidebarDOM.js';
import {
    initPlaylistManager,
    setStagedPlaylistItems,
    getStagedPlaylistItems,
    renderPlaylistInProperties,
    addFilesToStagedPlaylist,
    highlightPlayingPlaylistItemInSidebar
} from './propertiesSidebarPlaylist.js';
import { 
    initFormManager, 
    setCurrentWaveformTrim, 
    getCurrentWaveformTrim,
    saveCueProperties,
    deleteCueProperties,
    populateFormWithCueData
} from './propertiesSidebarForm.js';
import { 
    initEventHandlers, 
    bindPropertiesSidebarEventListeners,
    updateActivePropertiesCueId
} from './propertiesSidebarEvents.js';

let cueStore;
let audioController;
let websocketBindingsModule; // Changed from ipcRendererBindingsModule
let uiCore; // For isEditMode, getCurrentAppConfig

// --- State for Properties Sidebar ---
let activePropertiesCueId = null;
let debouncedSaveCueProperties;

// --- Helper Functions (Specific to Properties or shared & simple enough to keep) ---


// --- Initialization ---
function initPropertiesSidebar(csModule, acModule, websocketAPI, uiCoreInterfaceRef) {
    cueStore = csModule;
    audioController = acModule;
    websocketBindingsModule = websocketAPI; // Changed from ipcRendererBindingsModule
    uiCore = uiCoreInterfaceRef;

    // Initialize DOM elements
    cachePropertiesSidebarDOMElements();
    
    // Log cached elements to verify they are found
    console.log('[PropertiesSidebarInit] Cached DOM elements after cachePropertiesSidebarDOMElements:');
    console.log('  propCueNameInput:', getDOMElement('propCueNameInput') ? 'Found' : 'NOT FOUND');
    console.log('  propLoopCheckbox:', getDOMElement('propLoopCheckbox') ? 'Found' : 'NOT FOUND');

    // Initialize debounced save function
    debouncedSaveCueProperties = debounce(handleSaveCueProperties, 500);
    console.log('[PropertiesSidebarInit] debouncedSaveCueProperties initialized:', typeof debouncedSaveCueProperties);

    // Initialize all modules
    initFormManager(cueStore, audioController, uiCore);
    initPlaylistManager(debouncedSaveCueProperties, websocketBindingsModule);
    
    // Get DOM elements for event handlers
    const domElements = {
        closePropertiesSidebarBtn: getDOMElement('closePropertiesSidebarBtn'),
        saveCuePropertiesButton: getDOMElement('saveCuePropertiesButton'),
        previewCueButton: getDOMElement('previewCueButton'),
        deleteCuePropertiesButton: getDOMElement('deleteCuePropertiesButton'),
        propCueTypeSelect: getDOMElement('propCueTypeSelect'),
        propPlaylistConfigDiv: getDOMElement('propPlaylistConfigDiv'),
        propSingleFileConfigDiv: getDOMElement('propSingleFileConfigDiv'),
        propFilePathInput: getDOMElement('propFilePathInput'),
        propVolumeRangeInput: getDOMElement('propVolumeRangeInput'),
        propVolumeValueSpan: getDOMElement('propVolumeValueSpan'),
        propDuckingLevelInput: getDOMElement('propDuckingLevelInput'),
        propDuckingLevelValueSpan: getDOMElement('propDuckingLevelValueSpan'),
        propCueNameInput: getDOMElement('propCueNameInput'),
        propFadeInTimeInput: getDOMElement('propFadeInTimeInput'),
        propFadeOutTimeInput: getDOMElement('propFadeOutTimeInput'),
        propVolumeRangeInput: getDOMElement('propVolumeRangeInput'),
        propRetriggerBehaviorSelect: getDOMElement('propRetriggerBehaviorSelect'),
        propPlaylistPlayModeSelect: getDOMElement('propPlaylistPlayModeSelect'),
        propLoopCheckbox: getDOMElement('propLoopCheckbox'),
        propShufflePlaylistCheckbox: getDOMElement('propShufflePlaylistCheckbox'),
        propRepeatOnePlaylistItemCheckbox: getDOMElement('propRepeatOnePlaylistItemCheckbox'),
        propIsDuckingTriggerCheckbox: getDOMElement('propIsDuckingTriggerCheckbox'),
        propEnableDuckingCheckbox: getDOMElement('propEnableDuckingCheckbox'),
        propPlaylistItemsUl: getDOMElement('propPlaylistItemsUl'),
        propPlaylistFilePathDisplay: getDOMElement('propPlaylistFilePathDisplay'),
        previewCueButton: getDOMElement('previewCueButton'),
        propOutputPatchGroup: getDOMElement('propOutputPatchGroup'),
        propOutputPatchLeft: getDOMElement('propOutputPatchLeft'),
        propOutputPatchRight: getDOMElement('propOutputPatchRight'),
    };
    
    initEventHandlers(debouncedSaveCueProperties, (cueId) => { activePropertiesCueId = cueId; }, cueStore, domElements, websocketBindingsModule);
    bindReplaceFile();
    bindPropertiesSidebarEventListeners(hidePropertiesSidebar, handleDeleteCueProperties, renderPlaylistInPropertiesWrapper, setStagedPlaylistItems);
    
    console.log('Properties Sidebar Module Initialized');
}



// --- Properties Sidebar Specific Functions ---
function openPropertiesSidebar(cue) {
    const propertiesSidebar = getDOMElement('propertiesSidebar');
    if (!cue || !propertiesSidebar || !uiCore) {
        console.warn('[PropertiesSidebar] openPropertiesSidebar called with invalid parameters:', { cue: !!cue, propertiesSidebar: !!propertiesSidebar, uiCore: !!uiCore });
        return;
    }
    
    activePropertiesCueId = cue.id;
    updateActivePropertiesCueId(cue.id);
    
    // Get DOM elements
    const domElements = {
        propCueIdInput: getDOMElement('propCueIdInput'),
        propCueNameInput: getDOMElement('propCueNameInput'),
        propCueTypeSelect: getDOMElement('propCueTypeSelect'),
        propPlaylistConfigDiv: getDOMElement('propPlaylistConfigDiv'),
        propSingleFileConfigDiv: getDOMElement('propSingleFileConfigDiv'),
        propFilePathInput: getDOMElement('propFilePathInput'),
        propPlaylistItemsUl: getDOMElement('propPlaylistItemsUl'),
        propPlaylistFilePathDisplay: getDOMElement('propPlaylistFilePathDisplay'),
        propFadeInTimeInput: getDOMElement('propFadeInTimeInput'),
        propFadeOutTimeInput: getDOMElement('propFadeOutTimeInput'),
        propLoopCheckbox: getDOMElement('propLoopCheckbox'),
        propTrimStartTimeInput: getDOMElement('propTrimStartTimeInput'),
        propTrimEndTimeInput: getDOMElement('propTrimEndTimeInput'),
        propTrimConfig: getDOMElement('propTrimConfig'),
        propVolumeRangeInput: getDOMElement('propVolumeRangeInput'),
        propVolumeValueSpan: getDOMElement('propVolumeValueSpan'),
        propVolumeSlider: getDOMElement('propVolumeSlider'),
        propVolumeValueDisplay: getDOMElement('propVolumeValueDisplay'),
        propRetriggerBehaviorSelect: getDOMElement('propRetriggerBehaviorSelect'),
        propShufflePlaylistCheckbox: getDOMElement('propShufflePlaylistCheckbox'),
        propRepeatOnePlaylistItemCheckbox: getDOMElement('propRepeatOnePlaylistItemCheckbox'),
        propPlaylistPlayModeSelect: getDOMElement('propPlaylistPlayModeSelect'),
        propEnableDuckingCheckbox: getDOMElement('propEnableDuckingCheckbox'),
        propDuckingLevelInput: getDOMElement('propDuckingLevelInput'),
        propDuckingLevelValueSpan: getDOMElement('propDuckingLevelValueSpan'),
        propIsDuckingTriggerCheckbox: getDOMElement('propIsDuckingTriggerCheckbox'),
        propOutputPatchGroup: getDOMElement('propOutputPatchGroup'),
        propOutputPatchLeft: getDOMElement('propOutputPatchLeft'),
        propOutputPatchRight: getDOMElement('propOutputPatchRight'),
    };

    // Populate form with cue data using the form manager
    updateReplaceFileButton(cue);
    populateFormWithCueData(
        cue, 
        domElements, 
        setStagedPlaylistItems, 
        renderPlaylistInPropertiesWrapper, 
        waveformControls.showWaveformForCue, 
        waveformControls.hideAndDestroyWaveform, 
        updateDuckingControlsVisibility
    );

    // Show the sidebar
    showPropertiesSidebar();
}

// --- Replace File ------------------------------------------------------------
// Swaps the cue's library file for a new version, in place on the server:
// every cue in every project using that file then plays the new version.

function updateReplaceFileButton(cue) {
    const button = document.getElementById('replaceCueFileButton');
    const status = document.getElementById('replaceCueFileStatus');
    if (status) status.textContent = '';
    if (button) {
        const hasFile = cue && cue.type !== 'playlist' && Boolean(cue.audioFileId);
        button.style.display = hasFile ? '' : 'none';
    }
}

function bindReplaceFile() {
    const button = document.getElementById('replaceCueFileButton');
    const input = document.getElementById('replaceCueFileInput');
    if (!button || !input) return;

    button.addEventListener('click', () => {
        const cue = activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null;
        if (!cue?.audioFileId) return;
        const fileName = cue.relativePath || 'this file';
        if (!confirm(`Replace "${fileName}" with a new version?\n\nEvery cue using this file, in every project, will play the new version.`)) {
            return;
        }
        input.value = '';
        input.click();
    });

    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        const cue = activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null;
        const status = document.getElementById('replaceCueFileStatus');
        if (!file || !cue?.audioFileId) return;
        if (status) status.textContent = `Replacing with ${file.name}...`;
        try {
            const form = new FormData();
            form.append('audioFile', file);
            const response = await fetch(`/api/audio/${cue.audioFileId}/replace`, { method: 'POST', body: form });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Replace failed');
            }
            const where = result.projectsUpdated > 1 ? ` (in ${result.projectsUpdated} projects)` : '';
            if (status) status.textContent = `Replaced with ${file.name}${where}.`;
            // The waveform URL doesn't change - reload it explicitly so it
            // shows the new audio even if nothing else about the cue did.
            const latest = cueStore.getCueById(cue.id) || cue;
            waveformControls.showWaveformForCue({ ...latest, relativePath: result.audioFile.relativePath });
        } catch (error) {
            console.error('PropertiesSidebar: Replace file failed:', error);
            if (status) status.textContent = `Replace failed: ${error.message}`;
        } finally {
            input.value = '';
        }
    });
}

function hidePropertiesSidebar() {
    hideSidebar();
    activePropertiesCueId = null;
    setStagedPlaylistItems([]);
    waveformControls.hideAndDestroyWaveform();
}

// Wrapper function for playlist rendering
function renderPlaylistInPropertiesWrapper() {
    const propPlaylistItemsUl = getDOMElement('propPlaylistItemsUl');
    const propPlaylistFilePathDisplay = getDOMElement('propPlaylistFilePathDisplay');
    renderPlaylistInProperties(propPlaylistItemsUl, propPlaylistFilePathDisplay);
}

/**
 * Upload and append files to the currently open playlist cue's staged
 * playlist. Returns false if there is no open playlist cue to add to (the
 * caller - ui.js's handleMultipleFileDrop - falls back to the general
 * new-cue drop flow in that case).
 */
async function addFilesToStagedPlaylistWrapper(files) {
    if (!activePropertiesCueId) {
        return false;
    }
    const activeCue = cueStore ? cueStore.getCueById(activePropertiesCueId) : null;
    if (!activeCue || activeCue.type !== 'playlist') {
        return false;
    }
    const propPlaylistItemsUl = getDOMElement('propPlaylistItemsUl');
    const propPlaylistFilePathDisplay = getDOMElement('propPlaylistFilePathDisplay');
    await addFilesToStagedPlaylist(files, propPlaylistItemsUl, propPlaylistFilePathDisplay);
    return true;
}


async function handleSaveCueProperties() {
    console.log('[PropertiesSidebar] handleSaveCueProperties CALLED. Active Cue ID:', activePropertiesCueId);
    if (!activePropertiesCueId) {
        console.warn('[PropertiesSidebar] handleSaveCueProperties: No active cue ID');
        return;
    }

    // Get DOM elements
    const domElements = {
        propCueNameInput: getDOMElement('propCueNameInput'),
        propCueTypeSelect: getDOMElement('propCueTypeSelect'),
        propFilePathInput: getDOMElement('propFilePathInput'),
        propFadeInTimeInput: getDOMElement('propFadeInTimeInput'),
        propFadeOutTimeInput: getDOMElement('propFadeOutTimeInput'),
        propLoopCheckbox: getDOMElement('propLoopCheckbox'),
        propVolumeSlider: getDOMElement('propVolumeSlider'),
        propRetriggerBehaviorSelect: getDOMElement('propRetriggerBehaviorSelect'),
        propShufflePlaylistCheckbox: getDOMElement('propShufflePlaylistCheckbox'),
        propRepeatOnePlaylistItemCheckbox: getDOMElement('propRepeatOnePlaylistItemCheckbox'),
        propPlaylistPlayModeSelect: getDOMElement('propPlaylistPlayModeSelect'),
        propEnableDuckingCheckbox: getDOMElement('propEnableDuckingCheckbox'),
        propDuckingLevelInput: getDOMElement('propDuckingLevelInput'),
        propIsDuckingTriggerCheckbox: getDOMElement('propIsDuckingTriggerCheckbox')
    };

    // Use the form manager to save
    await saveCueProperties(activePropertiesCueId, domElements, getStagedPlaylistItems());
}

async function handleDeleteCueProperties() {
    const success = await deleteCueProperties(activePropertiesCueId);
    if (success) {
        hidePropertiesSidebar();
    }
}

function getActivePropertiesCueId() {
    return activePropertiesCueId;
}

// Replaces the audio of the open single-file cue with a newly uploaded file
// (dropped onto the sidebar). Playback uses the file's id and relative
// path, so those are what gets saved - this used to only change the text in
// the (read-only) file field, and the cue kept playing its old audio.
async function setFilePathInProperties(audioFile) {
    if (!activePropertiesCueId) return false;
    const activeCue = cueStore.getCueById(activePropertiesCueId);
    if (!activeCue || (activeCue.type !== 'single_file' && activeCue.type !== 'single')) return false;
    if (!audioFile || typeof audioFile !== 'object' || !audioFile.id) return false;

    const propFilePathInput = getDOMElement('propFilePathInput');
    if (propFilePathInput) {
        propFilePathInput.value = audioFile.relativePath || '';
    }

    const result = await cueStore.addOrUpdateCue({
        id: activeCue.id,
        audioFileId: audioFile.id,
        relativePath: audioFile.relativePath,
        filePath: `/api/audio/serve/${audioFile.id}`,
        knownDuration: audioFile.duration || 0,
        // Trim points belonged to the old file.
        trimStartTime: 0,
        trimEndTime: null,
    });
    if (result?.success) {
        setCurrentWaveformTrim(0, undefined);
        waveformControls.showWaveformForCue({ ...activeCue, filePath: `/api/audio/serve/${audioFile.id}`, trimStartTime: 0, trimEndTime: undefined });
    }
    return Boolean(result?.success);
}

function handleCuePropertyChangeFromWaveform(trimStart, trimEnd) {
    if (!activePropertiesCueId) return;
    
    // Apply trim to local cue immediately so playback uses it before server round-trip
    if (cueStore && typeof cueStore.applyLocalCueUpdates === 'function') {
        cueStore.applyLocalCueUpdates(activePropertiesCueId, {
            trimStartTime: typeof trimStart === 'number' ? trimStart : 0,
            trimEndTime: (typeof trimEnd === 'number' && trimEnd > 0) ? trimEnd : undefined
        });
    }
    // Update trim values in form manager
    setCurrentWaveformTrim(trimStart, trimEnd);
    
    // Set flag to prevent properties sidebar refresh loop
    window._waveformTrimUpdateInProgress = true;
    
    // CRITICAL: Save immediately so playback uses fresh trim values
    // (bypass debounce to avoid race when user hits play right after trimming)
    handleSaveCueProperties();
    
    // Also schedule a debounced save as a safety net for any subsequent UI updates
    debouncedSaveCueProperties();
    
    // Clear flag after giving enough time for the save and cue update cycle to complete
    setTimeout(() => {
        window._waveformTrimUpdateInProgress = false;
        console.log('PropertiesSidebar: Cleared waveform trim update flag');
    }, 1000); // Give enough time for the debounced save + IPC + cue update cycle
}

function highlightPlayingPlaylistItemInSidebarWrapper(cueId, playlistItemId) {
    const propPlaylistItemsUl = getDOMElement('propPlaylistItemsUl');
    highlightPlayingPlaylistItemInSidebar(cueId, playlistItemId, activePropertiesCueId, propPlaylistItemsUl);
}

// New function to refresh the playlist view if it's the active cue
function refreshPlaylistPropertiesView(cueIdToRefresh) {
    const propertiesSidebar = getDOMElement('propertiesSidebar');
    if (!propertiesSidebar || propertiesSidebar.classList.contains('hidden')) {
        console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Sidebar not visible, no refresh needed for', cueIdToRefresh);
        return;
    }
    if (activePropertiesCueId && activePropertiesCueId === cueIdToRefresh) {
        console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Active cue matches cueIdToRefresh:', cueIdToRefresh, '. Re-fetching and re-rendering.');
        const latestCueData = cueStore.getCueById(activePropertiesCueId);
        if (latestCueData && latestCueData.type === 'playlist') {
            // Ensure playlistItems is an array, default to empty if not.
            // Deep copy to avoid modifying cueStore's copy directly if renderPlaylistInProperties modifies stagedPlaylistItems in the future (it shouldn't, but good practice).
            setStagedPlaylistItems(latestCueData.playlistItems ? JSON.parse(JSON.stringify(latestCueData.playlistItems)) : []);
            renderPlaylistInPropertiesWrapper();
            console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Playlist items refreshed and re-rendered.');
        } else if (latestCueData) {
            console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Active cue is not a playlist, no playlist items to refresh.');
        } else {
            console.warn('[PropertiesSidebar refreshPlaylistPropertiesView] Could not find active cue data in store for ID:', activePropertiesCueId);
        }
    } else {
        console.log('[PropertiesSidebar refreshPlaylistPropertiesView] Cue to refresh (', cueIdToRefresh, ') does not match active cue ( ', activePropertiesCueId, '). No action.');
    }
}

export {
    initPropertiesSidebar,
    openPropertiesSidebar,
    hidePropertiesSidebar,
    getActivePropertiesCueId,
    refreshPlaylistPropertiesView,
    setFilePathInProperties,
    handleCuePropertyChangeFromWaveform,
    highlightPlayingPlaylistItemInSidebarWrapper as highlightPlayingPlaylistItemInSidebar,
    handleSaveCueProperties,
    addFilesToStagedPlaylistWrapper as addFilesToStagedPlaylist
};