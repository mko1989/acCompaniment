// Companion_soundboard/src/renderer/ui.js
// Manages core UI logic, initializes sub-modules, and handles interactions not covered by sub-modules.

// Import UI sub-modules
import * as cueGrid from './ui/cueGrid.js';
import * as utils from './ui/utils.js';
import * as sidebars from './ui/sidebars.js';
import * as modals from './ui/modals.js';
import * as appConfigUI from './ui/appConfigUI.js'; // Import new module
import * as waveformControls from './ui/waveformControls.js'; // Ensure this is imported if used by init

// Module references that will be initialized
let cueStoreModule; // Renamed for clarity, will hold the passed cueStore module
let audioControllerModule; // Renamed for clarity
let ipcRendererBindingsModule; // This will be electronAPI
let dragDropHandlerModule; // Renamed for clarity
let appConfigUIModuleInternal; // To hold the passed appConfigUI module
let modalsModule; // To be initialized
let waveformControlsModule;
let appConfigUIModule; // Reference to the appConfigUI module

// Core DOM Elements (not managed by sub-modules yet)
let appContainer;
let addCueButton; // The one in the top bar
let modeToggleBtn;
let stopAllButton;

// --- Modals (MOVED to modals.js) ---
/*
let cueConfigModal;
let closeCueConfigModalBtn;
let multipleFilesDropModal;
let closeMultipleFilesDropModalBtn;
let modalAddAsSeparateCuesBtn;
let modalAddAsPlaylistCueBtn;
let modalCancelMultipleFilesDropBtn;
*/

// --- App Config Sidebar Inputs (MOVED to appConfigUI.js) ---
/*
let audioOutputSelect, defaultFadeInInput, defaultFadeOutInput, defaultLoopCheckbox,
    defaultVolumeInput, defaultVolumeValueDisplay, retriggerBehaviorSelect, defaultStopAllBehaviorSelect;
*/

// --- Cue Config Modal Inputs (MOVED to modals.js) ---
/*
let modalCueIdInput, modalCueNameInput, modalCueTypeSelect, modalSingleFileConfigDiv,
    modalFilePathInput, modalPlaylistConfigDiv, modalPlaylistItemsUl,
    modalPlaylistFilePathDisplay, modalFadeInTimeInput, modalFadeOutTimeInput,
    modalLoopCheckbox, modalTrimStartTimeInput, modalTrimEndTimeInput,
    modalVolumeRangeInput, modalVolumeValueSpan, modalSaveCueButton;
*/

// Core UI State
let currentMode = 'edit'; // 'edit' or 'show'
let shiftKeyPressed = false;

// App Configuration State (MOVED to appConfigUI.js)
// let currentAppConfig = {}; // Local cache of app config in ui.js - REMOVE, use appConfigUI.getCurrentAppConfig()

// MOVED to modals.js: droppedFilesList

// Corrected init signature to match renderer.js
async function init(rcvdCueStore, rcvdAudioController, rcvdElectronAPI, rcvdDragDropHandler, rcvdAppConfigUI, rcvdWaveformControls) {
    console.log('UI Core: init function started.');
    console.log('UI Core: Received rcvdElectronAPI. Type:', typeof rcvdElectronAPI, 'Keys:', rcvdElectronAPI ? Object.keys(rcvdElectronAPI) : 'undefined');
    if (rcvdElectronAPI && typeof rcvdElectronAPI.whenMainReady === 'function') {
        console.log('UI Core: rcvdElectronAPI.whenMainReady IS a function. Waiting for main process...');
        await rcvdElectronAPI.whenMainReady();
        console.log('UI Core: Main process is ready. Proceeding with UI initialization.');
    } else {
        console.error('UI Core: FATAL - rcvdElectronAPI.whenMainReady is NOT a function or rcvdElectronAPI is invalid. Halting UI init.', rcvdElectronAPI);
        // Display error to user or throw
        document.body.innerHTML = '<div style="color: red; padding: 20px;"><h1>Critical Error</h1><p>UI cannot initialize because of an internal problem (electronAPI not ready). Please restart.</p></div>';
        return; // Stop further execution
    }

    // Assign passed modules to scoped variables
    ipcRendererBindingsModule = rcvdElectronAPI;
    cueStoreModule = rcvdCueStore;
    audioControllerModule = rcvdAudioController;
    dragDropHandlerModule = rcvdDragDropHandler; // Store if ui.js needs to interact with it later
    appConfigUIModuleInternal = rcvdAppConfigUI;
    waveformControlsModule = rcvdWaveformControls;

    let uiModules = {}; // Declare uiModules as an object

    // Populate uiModules for sub-module initialization
    modalsModule = modals;
    uiModules.cueGrid = cueGrid; // These are the imported modules
    uiModules.sidebars = sidebars;
    uiModules.waveformControls = waveformControlsModule; // Use the imported waveformControls
    uiModules.appConfigUI = appConfigUIModuleInternal; // Use the imported appConfigUI for its functions

    // Initialize App Config UI first as other modules might depend on config values
    // Use the *imported* appConfigUI module for initialization, not the one passed as a parameter
    // if we intend to call appConfigUI.init() which is part of the imported module.
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.init === 'function') {
        appConfigUIModuleInternal.init(ipcRendererBindingsModule); // Initialize the imported appConfigUI
    } else {
        console.error('UI Init: Imported appConfigUI module or its init function is not available.');
    }

    // Pass the *assigned* cueStoreModule to utils
    utils.initUtils(cueStoreModule); 
    
    cacheCoreDOMElements();
    bindCoreEventListeners();

    const uiCoreInterface = {
        isEditMode,
        openPropertiesSidebar: sidebars.openPropertiesSidebar,
        getCurrentAppConfig: appConfigUIModuleInternal.getCurrentAppConfig, // Use imported appConfigUI
        openNewCueModal: modalsModule.openNewCueModal, 
        showMultipleFilesDropModal: modalsModule.showMultipleFilesDropModal
    };

    // Pass the *assigned* modules to sub-module initializers
    cueGrid.initCueGrid(cueStoreModule, audioControllerModule, dragDropHandlerModule, uiCoreInterface);
    sidebars.initSidebars(cueStoreModule, audioControllerModule, ipcRendererBindingsModule, uiCoreInterface);
    modalsModule.initModals(cueStoreModule, ipcRendererBindingsModule, uiCoreInterface);
    
    // updateModeUI(); // Defer this call until after initial cues are loaded
    console.log('UI Core Module Initialized (after main process ready). Mode UI update deferred until cues loaded.');

    // Return the actual module references (or specific functions if preferred)
    return {
        cueGridModule: cueGrid,
        sidebarsModule: sidebars
        // We can also expose specific functions directly here if that's cleaner for audioController
        // e.g., updateButtonPlayingState: cueGrid.updateButtonPlayingState,
        //       updateCueButtonTime: cueGrid.updateCueButtonTime,
        //       highlightPlayingPlaylistItem: sidebars.highlightPlayingPlaylistItem 
    };
}

function cacheCoreDOMElements() {
    appContainer = document.getElementById('appContainer');
    addCueButton = document.getElementById('addCueButton');
    modeToggleBtn = document.getElementById('modeToggleBtn');
    stopAllButton = document.getElementById('stopAllButton');

    // MOVED to modals.js: Caching for cueConfigModal, multipleFilesDropModal and their child elements
    // MOVED to modals.js: Caching for modalCueIdInput, modalCueNameInput etc.

    // App Config Sidebar Inputs caching MOVED to appConfigUI.js
}

function bindCoreEventListeners() {
    if (modeToggleBtn) modeToggleBtn.addEventListener('click', toggleMode);
    if (addCueButton) addCueButton.addEventListener('click', modalsModule.openNewCueModal); 

    if (stopAllButton) {
        stopAllButton.addEventListener('click', () => {
            if (audioControllerModule && typeof audioControllerModule.stopAll === 'function') {
                const config = appConfigUIModuleInternal.getCurrentAppConfig(); // Get from appConfigUI
                const behavior = config.defaultStopAllBehavior || 'stop';
                audioControllerModule.stopAll({ behavior: behavior });
            }
        });
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') {
            shiftKeyPressed = true;
            updateModeUI();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') {
            shiftKeyPressed = false;
            updateModeUI();
        }
    });

    // MOVED to modals.js: Event listeners for closeCueConfigModalBtn, modalSaveCueButton, cueConfigModal (outside click)
    // MOVED to modals.js: Event listeners for modalCueTypeSelect, modalVolumeRangeInput
    // MOVED to modals.js: Event listeners for closeMultipleFilesDropModalBtn, modalAddAsSeparateCuesBtn, etc.

    // App Config Listeners MOVED to appConfigUI.js
}

function getCurrentAppMode() {
    return shiftKeyPressed ? 'show' : currentMode;
}

function toggleMode() {
    currentMode = (currentMode === 'edit') ? 'show' : 'edit';
    shiftKeyPressed = false; // Reset shift key on manual toggle
    updateModeUI();
    if (currentMode === 'show') {
        sidebars.hidePropertiesSidebar(); 
    }
}

function updateModeUI() {
    const actualMode = getCurrentAppMode();
    if (actualMode === 'show') {
        appContainer.classList.remove('edit-mode');
        appContainer.classList.add('show-mode');
        modeToggleBtn.textContent = 'Enter Edit Mode';
        modeToggleBtn.classList.add('show-mode-active');
    } else { // edit mode
        appContainer.classList.remove('show-mode');
        appContainer.classList.add('edit-mode');
        modeToggleBtn.textContent = 'Enter Show Mode';
        modeToggleBtn.classList.remove('show-mode-active');
    }
    cueGrid.renderCues(); 
}

async function loadAndRenderCues() {
    console.log('UI Core: Attempting to load cues...');
    if (!cueStoreModule) {
        console.error('UI Core (loadAndRenderCues): cueStoreModule is not initialized!');
        return;
    }
    await cueStoreModule.loadCuesFromServer();
    console.log('UI Core: Cues loaded, attempting to render grid via cueGrid module.');
    
    if (cueStoreModule && typeof cueStoreModule.getAllCues === 'function') {
        const cuesForGrid = cueStoreModule.getAllCues();
        console.log('UI Core (loadAndRenderCues): Cues retrieved from cueStoreModule just before calling cueGrid.renderCues():', cuesForGrid);
    } else {
        console.error('UI Core (loadAndRenderCues): cueStoreModule or cueStoreModule.getAllCues is not available!');
    }

    updateModeUI(); // Call updateModeUI here after cues are loaded, which will call cueGrid.renderCues()
    // cueGrid.renderCues(); // No longer directly call this, let updateModeUI handle it.
}

function isEditMode() {
    return getCurrentAppMode() === 'edit';
}

// Function to apply a new app configuration received from the main process
function applyAppConfiguration(newConfig) {
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.populateConfigSidebar === 'function') {
        console.log('UI Core: Applying new app configuration received from main:', newConfig);
        appConfigUIModuleInternal.populateConfigSidebar(newConfig);
        // After applying, other UI components might need to be notified or refresh if they depend on app config.
        // For example, sidebars.js (for cue properties) gets current config when opening, so that should be fine.
        // If any part of cueGrid depends directly on appConfig that is not passed through cue data, it might need a refresh call.
    } else {
        console.error('UI Core: appConfigUIModuleInternal.populateConfigSidebar is not available to apply new config.');
    }
}

// getCurrentAppConfig MOVED (accessed via appConfigUI.getCurrentAppConfig through uiCoreInterface)

// --- App Configuration Functions (MOVED to appConfigUI.js) ---
/* Commenting out the moved functions as they are now in appConfigUI.js
async function loadAndApplyAppConfiguration() { ... }
function populateConfigSidebar() { ... }
async function handleAppConfigChange() { ... }
async function populateAudioOutputDevicesDropdown() { ... }
*/

// --- Workspace Change Handling ---
async function handleWorkspaceChange() {
    console.log('UI Core: Workspace did change. Reloading cues and app config.');
    // Stop all audio before changing workspace context to prevent issues
    if (audioControllerModule && typeof audioControllerModule.stopAll === 'function') {
        // Get current stop behavior from the config that's *about to be replaced*
        const currentEffectiveConfig = appConfigUIModuleInternal.getCurrentAppConfig(); 
        audioControllerModule.stopAll({ 
            behavior: currentEffectiveConfig.defaultStopAllBehavior || 'stop',
            forceNoFade: true // Ensure immediate stop before context switch
        });
    }
    sidebars.hidePropertiesSidebar(); // Close properties sidebar as cue context is changing

    // Reload application configuration from the new workspace via appConfigUI module
    await appConfigUIModuleInternal.forceLoadAndApplyAppConfiguration(); 
    
    // Reload and render cues for the new workspace
    await loadAndRenderCues(); 

    // No need to explicitly update audioController with appConfig here,
    // as forceLoadAndApplyAppConfiguration in appConfigUI should handle notifying audioController.
    
    console.log('UI Core: Workspace change handling complete.');
}

// Exposed for dragDropHandler to add files to a specific cue if properties sidebar is open
async function handleSingleFileDrop(filePath, dropTargetElement) {
    const mainDropArea = document.getElementById('cueGridContainer'); // Main grid
    const propertiesSidebarDOM = document.getElementById('propertiesSidebar');
    const cueConfigModalDOM = document.getElementById('cueConfigModal');
    const multipleFilesDropModalDOM = document.getElementById('multipleFilesDropModal');

    // 1. Try to delegate to properties sidebar if it's the target
    if (propertiesSidebarDOM && !propertiesSidebarDOM.classList.contains('hidden') && propertiesSidebarDOM.contains(dropTargetElement)) {
        if (await sidebars.setFilePathInProperties(filePath)) {
            console.log("UI Core (SingleDrop): Handled by open Properties Sidebar.");
            return;
        }
    }

    // 2. If not properties sidebar, check for general drop area to create a new cue
    if (dropTargetElement === mainDropArea ||
        (document.body.contains(dropTargetElement) &&
         (!propertiesSidebarDOM || !propertiesSidebarDOM.contains(dropTargetElement)) &&
         (!cueConfigModalDOM || !cueConfigModalDOM.contains(dropTargetElement)) &&
         (!multipleFilesDropModalDOM || !multipleFilesDropModalDOM.contains(dropTargetElement)))) {
        console.log("UI Core (SingleDrop): Matched general drop area. Attempting to create cue..."); // New Log
        try {
            const activeAppConfig = appConfigUIModuleInternal.getCurrentAppConfig(); // Correctly get app config
            if (!activeAppConfig) {
                console.error("UI Core (SingleDrop): App config not available!");
                alert('Error: App configuration is not loaded. Cannot create cue.');
                return;
            }
            console.log("UI Core (SingleDrop): App config loaded:", activeAppConfig); // New Log

            const cueId = await ipcRendererBindingsModule.generateUUID();
            console.log("UI Core (SingleDrop): Generated UUID:", cueId); // New Log

            const fileName = filePath.split(/[\\\/]/).pop();
            const cueName = fileName.split('.').slice(0, -1).join('.') || 'New Cue';
            const newCueData = {
                id: cueId, name: cueName, type: 'single_file', filePath: filePath,
                volume: activeAppConfig.defaultVolume,
                fadeInTime: activeAppConfig.defaultFadeInTime,
                fadeOutTime: activeAppConfig.defaultFadeOutTime,
                loop: activeAppConfig.defaultLoop,
                retriggerBehavior: activeAppConfig.defaultRetriggerBehavior,
                shuffle: false, repeatOne: false, trimStartTime: null, trimEndTime: null,
            };
            console.log("UI Core (SingleDrop): Prepared new cue data:", newCueData); // New Log

            if (!cueStoreModule) {
                console.error('UI Core (handleSingleFileDrop): cueStoreModule is not initialized!');
                alert('Error: Cue store not available. Cannot create cue.');
                return;
            }
            await cueStoreModule.addOrUpdateCue(newCueData);
            console.log("UI Core (SingleDrop): Successfully called cueStoreModule.addOrUpdateCue. Cue should be created/updated.");
        } catch (error) {
            console.error('UI Core (SingleDrop): Error creating cue from drop:', error); // More detailed log
            alert('Error creating cue from drop: ' + error.message);
        }
    } else {
        console.log("UI Core (SingleDrop): Drop target not general area or open properties sidebar. Ignored by this handler.", dropTargetElement);
    }
}

async function handleMultipleFileDrop(files, dropTargetElement) {
    const mainDropArea = document.getElementById('cueGridContainer');
    const propertiesSidebarDOM = document.getElementById('propertiesSidebar');
    const cueConfigModalDOM = document.getElementById('cueConfigModal');
    const multipleFilesDropModalDOM = document.getElementById('multipleFilesDropModal');

    // 1. Try to delegate to properties sidebar if it's the target
    if (propertiesSidebarDOM && !propertiesSidebarDOM.classList.contains('hidden') && propertiesSidebarDOM.contains(dropTargetElement)) {
        // Convert FileList to array of objects for sidebars.addFilesToStagedPlaylist
        const fileArray = Array.from(files).map(file => ({ path: file.path, name: file.name }));
        // Assuming addFilesToStagedPlaylist handles playlist cues. 
        // If it needs to open properties sidebar for a single file cue, that logic would be in sidebars.js
        if (await sidebars.addFilesToStagedPlaylist(fileArray)) { // This was from your previous suggestion, ensure it's correct for multi-file to playlist
            console.log("UI Core (MultiDrop): Handled by open Properties Sidebar (playlist).");
            return;
        } else {
            // Fallback or alternative handling if not a playlist drop on sidebar, 
            // or if addFilesToStagedPlaylist returns false for other reasons.
            // For now, let's assume if it's on sidebar, it tried to handle it.
            // If it failed, maybe let assignFilesToRelevantTarget try a more generic assignment.
            // assignFilesToRelevantTarget(Array.from(files).map(f => f.path), dropTargetElement); // assignFilesToRelevantTarget is not defined here
            console.warn("UI Core (MultiDrop): Properties sidebar did not handle multi-file drop. No fallback implemented yet for this specific case.");
            return;
        }
    }

    // 2. If not properties sidebar, check for general drop area to show modal
    if (dropTargetElement === mainDropArea ||
        (document.body.contains(dropTargetElement) &&
         (!propertiesSidebarDOM || !propertiesSidebarDOM.contains(dropTargetElement)) &&
         (!cueConfigModalDOM || !cueConfigModalDOM.contains(dropTargetElement)) &&
         (!multipleFilesDropModalDOM || !multipleFilesDropModalDOM.contains(dropTargetElement)))) {
        modalsModule.showMultipleFilesDropModal(files); // Show modal for multiple files
        console.log("UI Core (MultiDrop): Showed multiple files modal for general drop.");
    } else {
         // If not a general area, and not properties sidebar, try assignFilesToRelevantTarget
         // This might be a drop on a cue button or the new cue modal itself.
         // assignFilesToRelevantTarget(Array.from(files).map(f => f.path), dropTargetElement); // assignFilesToRelevantTarget is not defined here
         console.warn("UI Core (MultiDrop): Drop target not general area. No fallback implemented yet for this specific case.", dropTargetElement);
    }
}

// New function to specifically refresh the cue grid display
function refreshCueGrid() {
    if (cueGrid && typeof cueGrid.renderCues === 'function') {
        console.log('UI Core: Refreshing cue grid display.');
        cueGrid.renderCues();
    }
}

export {
    init,
    loadAndRenderCues, // Called by renderer.js on init and workspace changes
    handleWorkspaceChange, // Called by IPC via renderer.js

    // Core UI utility functions passed to sub-modules as part of uiCoreInterface
    isEditMode,
    // getCurrentAppConfig, // Removed, use uiCoreInterface.getCurrentAppConfig
    updateModeUI, // If called by renderer.js (e.g. after shift key for testing)

    // New global drop handlers (called by dragDropHandler.js)
    handleSingleFileDrop,
    handleMultipleFileDrop,
    refreshCueGrid, // Export the new function
    applyAppConfiguration // Export the new function
};
