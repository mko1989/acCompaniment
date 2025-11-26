// Companion_soundboard/src/renderer/ui.js
// Manages core UI logic, initializes sub-modules, and handles interactions not covered by sub-modules.

// Import UI sub-modules
import * as cueGrid from './ui/cueGrid.js';
import * as utils from './ui/utils.js';
import * as configSidebar from './ui/configSidebar.js';
import * as sidebars from './ui/sidebars.js'; // Import sidebars module for config sidebar toggle
import * as propertiesSidebar from './ui/propertiesSidebar.js';
import * as modals from './ui/modals.js';
import * as appConfigUI from './ui/appConfigUI.js'; // Import new module
import * as waveformControls from './ui/waveformControls.js'; // Ensure this is imported if used by init

// Module references that will be initialized
let cueStoreModule; // Renamed for clarity, will hold the passed cueStore module
let audioControllerModule; // Renamed for clarity
let electronAPIForPreload; // Renamed to be specific: this is the electronAPI from preload
let actualIpcBindingsModule; // To store the actual ipcRendererBindings.js module
let dragDropHandlerModule; // Renamed for clarity
let appConfigUIModuleInternal; // To hold the passed appConfigUI module
let modalsModule; // To be initialized
let waveformControlsModule;
let isUIModuleFullyInitialized = false; // NEW FLAG

// Core DOM Elements (not managed by sub-modules yet)
let appContainer;
let modeToggleBtn;
let stopAllButton;
let crossfadeToggleBtn;

// Crossfade state
let crossfadeEnabled = false;

// --- Modals (MOVED to modals.js) ---
// Modal elements are now managed by modals.js module

// --- App Config Sidebar Inputs (MOVED to appConfigUI.js) ---
// App config elements are now managed by appConfigUI.js module

// --- Cue Config Modal Inputs (MOVED to modals.js) ---
// Cue config modal elements are now managed by modals.js module

// Core UI State
let currentMode = 'edit'; // 'edit' or 'show'
let shiftKeyPressed = false;

// App Configuration State (MOVED to appConfigUI.js)
// App config state is now managed by appConfigUI.js module

// MOVED to modals.js: droppedFilesList

// Corrected init signature to match renderer.js
async function init(rcvdCueStore, rcvdAudioController, rcvdElectronAPI, rcvdDragDropHandler, rcvdAppConfigUI, rcvdWaveformControls, rcvdActualIpcBindings) {
    console.log('UI Core: init function started.');
    console.log('UI Core: Received rcvdElectronAPI. Type:', typeof rcvdElectronAPI, 'Keys:', rcvdElectronAPI ? Object.keys(rcvdElectronAPI) : 'undefined');
    console.log('UI Core: Received rcvdActualIpcBindings. Type:', typeof rcvdActualIpcBindings, 'Keys:', rcvdActualIpcBindings ? Object.keys(rcvdActualIpcBindings) : 'undefined');

    // Directly await electronAPI.whenMainReady()
    if (rcvdElectronAPI && typeof rcvdElectronAPI.whenMainReady === 'function') {
        console.log('UI Core: rcvdElectronAPI.whenMainReady IS a function. Waiting for main process...');
        await rcvdElectronAPI.whenMainReady();
        console.log('UI Core: Main process is ready. Proceeding with UI initialization.');
    } else {
        console.error('UI Core: FATAL - rcvdElectronAPI.whenMainReady is NOT a function or rcvdElectronAPI is invalid. Halting UI init.', rcvdElectronAPI);
        document.body.innerHTML = '<div style="color: red; padding: 20px;"><h1>Critical Error</h1><p>UI cannot initialize because of an internal problem (electronAPI not ready). Please restart.</p></div>';
        return; // Stop further execution
    }

    // Assign passed modules to scoped variables
    electronAPIForPreload = rcvdElectronAPI; // This is window.electronAPI from preload
    actualIpcBindingsModule = rcvdActualIpcBindings; // This is the full ipcRendererBindings.js module
    cueStoreModule = rcvdCueStore;
    audioControllerModule = rcvdAudioController;
    dragDropHandlerModule = rcvdDragDropHandler; // Store if ui.js needs to interact with it later
    appConfigUIModuleInternal = rcvdAppConfigUI;
    waveformControlsModule = rcvdWaveformControls;

    let uiModules = {}; // Declare uiModules as an object

    // Populate uiModules for sub-module initialization
    modalsModule = modals;
    uiModules.cueGrid = cueGrid; // These are the imported modules
    uiModules.configSidebar = configSidebar;
    uiModules.sidebars = sidebars; // Add sidebars module for config sidebar toggle
    uiModules.propertiesSidebar = propertiesSidebar;
    uiModules.waveformControls = waveformControlsModule; // Use the imported waveformControls
    uiModules.appConfigUI = appConfigUIModuleInternal; // Use the imported appConfigUI for its functions

    // Initialize App Config UI first as other modules might depend on config values
    // Use the *imported* appConfigUI module for initialization, not the one passed as a parameter
    // if we intend to call appConfigUI.init() which is part of the imported module.
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.init === 'function') {
        appConfigUIModuleInternal.init(electronAPIForPreload); // Initialize the imported appConfigUI
    } else {
        console.error('UI Init: Imported appConfigUI module or its init function is not available.');
    }

    // Pass the *assigned* cueStoreModule to utils
    utils.initUtils(cueStoreModule); 
    
    cacheCoreDOMElements();
    bindCoreEventListeners();

    const uiCoreInterface = {
        isEditMode,
        openPropertiesSidebar: propertiesSidebar.openPropertiesSidebar,
        getCurrentAppConfig: appConfigUIModuleInternal.getCurrentAppConfig,
        openNewCueModal: modalsModule.openNewCueModal, 
        showMultipleFilesDropModal: modalsModule.showMultipleFilesDropModal,
        getAudioFileBuffer: electronAPIForPreload.getAudioFileBuffer,
        getOrGenerateWaveformPeaks: electronAPIForPreload.getOrGenerateWaveformPeaks,
        highlightPlayingPlaylistItem: propertiesSidebar.highlightPlayingPlaylistItemInSidebar,
        toggleConfigSidebar: configSidebar.toggleConfigSidebar
    };

    // Pass the *assigned* modules to sub-module initializers
    cueGrid.initCueGrid(cueStoreModule, audioControllerModule, dragDropHandlerModule, uiCoreInterface);
    configSidebar.initConfigSidebar();
    sidebars.initSidebars(); // Initialize sidebars module for config sidebar toggle functionality

    // Log before initializing propertiesSidebar
    console.log('[UI.js Init] Attempting to initialize propertiesSidebar. Module:', propertiesSidebar);
    console.log('[UI.js Init] cueStoreModule type:', typeof cueStoreModule);
    console.log('[UI.js Init] audioControllerModule type:', typeof audioControllerModule);
    console.log('[UI.js Init] actualIpcBindingsModule type:', typeof actualIpcBindingsModule);
    console.log('[UI.js Init] uiCoreInterface keys:', uiCoreInterface ? Object.keys(uiCoreInterface) : 'null');

    propertiesSidebar.initPropertiesSidebar(cueStoreModule, audioControllerModule, actualIpcBindingsModule, uiCoreInterface);
    modalsModule.initModals(cueStoreModule, electronAPIForPreload, uiCoreInterface, waveformControlsModule);
    
    // Make uiModules available globally for other modules to access
    window.uiModules = uiModules;
    
    // updateModeUI(); // Defer this call until after initial cues are loaded
    console.log('UI Core Module Initialized (after main process ready). Mode UI update deferred until cues loaded.');

    // Return the actual module references (or specific functions if preferred)
    const initializedModules = {
        cueGridModule: cueGrid,
        configSidebarModule: configSidebar,
        propertiesSidebarModule: propertiesSidebar,
        modalsModule: modals
        // We can also expose specific functions directly here if that's cleaner for audioController
        // e.g., updateButtonPlayingState: cueGrid.updateButtonPlayingState,
        //       updateCueButtonTime: cueGrid.updateCueButtonTime,
        //       highlightPlayingPlaylistItem: sidebars.highlightPlayingPlaylistItem 
    };

    isUIModuleFullyInitialized = true; // SET FLAG HERE
    console.log('UI Core: isUIModuleFullyInitialized set to true.');
    return initializedModules;
}

function cacheCoreDOMElements() {
    appContainer = document.getElementById('appContainer');
    modeToggleBtn = document.getElementById('modeToggleBtn');
    stopAllButton = document.getElementById('stopAllButton');
    crossfadeToggleBtn = document.getElementById('crossfadeToggleBtn');

    // Modal element caching is now handled by modals.js module
    // App Config Sidebar element caching is now handled by appConfigUI.js module
}

function bindCoreEventListeners() {
    if (modeToggleBtn) modeToggleBtn.addEventListener('click', toggleMode);

    if (stopAllButton) {
        stopAllButton.addEventListener('click', () => {
            console.log('🛑 UI: Stop All button clicked!');
            // Access .default if audioControllerModule is the namespace import
            const ac = audioControllerModule && audioControllerModule.default ? audioControllerModule.default : audioControllerModule;
            console.log('🛑 UI: audioControllerModule available:', !!ac);
            console.log('🛑 UI: stopAll function available:', typeof ac?.stopAll);
            
            if (ac && typeof ac.stopAll === 'function') {
                const config = appConfigUIModuleInternal.getCurrentAppConfig(); // Get from appConfigUI
                const behavior = config.defaultStopAllBehavior || 'stop';
                
                // Determine useFade based on behavior
                const useFadeForStopAll = behavior === 'fade_out_and_stop'; 
                
                console.log('🛑 UI: Calling stopAll with options:', { useFade: useFadeForStopAll });
                // Pass useFade directly in the options
                // Also, preserve exceptCueId if it were ever to be used, though not currently by this button.
                ac.stopAll({ useFade: useFadeForStopAll }); 
            } else {
                console.error('🛑 UI: audioController or stopAll function not available!');
            }
        });
    }

    if (crossfadeToggleBtn) {
        crossfadeToggleBtn.addEventListener('click', () => {
            crossfadeEnabled = !crossfadeEnabled;
            updateCrossfadeButtonState();
            console.log('UI: Crossfade mode toggled to:', crossfadeEnabled);
            console.log('UI: window.ui.isCrossfadeEnabled now returns:', window.ui && window.ui.isCrossfadeEnabled && window.ui.isCrossfadeEnabled());
        });
        // Initialize the button state
        updateCrossfadeButtonState();
        console.log('UI: Crossfade button initialized. Initial state:', crossfadeEnabled);
    } else {
        console.error('UI: crossfadeToggleBtn not found! Crossfade will not work.');
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

    // Modal event listeners are now handled by modals.js module
    // App Config event listeners are now handled by appConfigUI.js module
}

function getCurrentAppMode() {
    // If shift is pressed, temporarily toggle the mode.
    // Otherwise, use the persistent currentMode.
    if (shiftKeyPressed) {
        return currentMode === 'edit' ? 'show' : 'edit';
    }
    return currentMode;
}

function toggleMode() {
    currentMode = (currentMode === 'edit') ? 'show' : 'edit';
    shiftKeyPressed = false; // Reset shift key on manual toggle
    updateModeUI();
}

function updateModeUI() {
    const effectiveMode = getCurrentAppMode();
    // const modeToggleBtnTextSpan = document.getElementById('modeToggleBtnText'); // Span is removed

    if (effectiveMode === 'show') {
        appContainer.classList.remove('edit-mode');
        appContainer.classList.add('show-mode');
        if (modeToggleBtn) {
            modeToggleBtn.classList.add('show-mode-active');
            modeToggleBtn.classList.remove('edit-mode-active');
            // Change the icon source instead of background image
            const modeToggleIcon = document.getElementById('modeToggleIcon');
            if (modeToggleIcon) {
                modeToggleIcon.src = '../../assets/icons/edit.png';
            }
        }
    } else { // 'edit'
        appContainer.classList.remove('show-mode');
        appContainer.classList.add('edit-mode');
        if (modeToggleBtn) {
            modeToggleBtn.classList.remove('show-mode-active');
            modeToggleBtn.classList.add('edit-mode-active');
            // Change the icon source instead of background image
            const modeToggleIcon = document.getElementById('modeToggleIcon');
            if (modeToggleIcon) {
                modeToggleIcon.src = '../../assets/icons/show_light.png';
            }
        }
    }
    
    console.log(`UI Mode Updated: Effective mode is now ${effectiveMode}`);
}

async function loadAndRenderCues() {
    console.log('UI Core: Attempting to load cues...');
    if (!cueStoreModule) {
        console.error('UI Core (loadAndRenderCues): cueStoreModule is not initialized!');
        return;
    }
    await cueStoreModule.loadCuesFromServer();
    console.log('UI Core: Cues loaded.');
    
    if (cueStoreModule && typeof cueStoreModule.getAllCues === 'function') {
        const cuesForGrid = cueStoreModule.getAllCues();
        console.log('UI Core (loadAndRenderCues): Cues retrieved from cueStoreModule for logging:', cuesForGrid);
    } else {
        console.error('UI Core (loadAndRenderCues): cueStoreModule or cueStoreModule.getAllCues is not available for logging!');
    }

    updateModeUI(); // Ensure mode is set before rendering grid
    
    if (cueGrid && typeof cueGrid.renderCues === 'function') {
        console.log('UI Core: Calling cueGrid.renderCues() after loading cues and updating mode.');
        cueGrid.renderCues(); // Explicitly call renderCues here
    } else {
        console.error('UI Core (loadAndRenderCues): cueGrid.renderCues is not available!');
    }
}

function isEditMode() {
    return getCurrentAppMode() === 'edit';
}

// Function to apply a new app configuration received from the main process
function applyAppConfiguration(newConfig) {
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.populateConfigSidebar === 'function') {
        console.log('UI Core: Applying new app configuration received from main by calling populateConfigSidebar:', newConfig);
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
// App configuration functions are now handled by appConfigUI.js module

// --- Crossfade Functions ---
function updateCrossfadeButtonState() {
    if (crossfadeToggleBtn) {
        if (crossfadeEnabled) {
            crossfadeToggleBtn.classList.remove('crossfade-disabled');
            crossfadeToggleBtn.classList.add('crossfade-enabled');
            crossfadeToggleBtn.title = 'Crossfade Mode Enabled - Click to Disable';
        } else {
            crossfadeToggleBtn.classList.remove('crossfade-enabled');
            crossfadeToggleBtn.classList.add('crossfade-disabled');
            crossfadeToggleBtn.title = 'Crossfade Mode Disabled - Click to Enable';
        }
    }
}

function isCrossfadeEnabled() {
    console.log('UI: isCrossfadeEnabled() called, returning:', crossfadeEnabled);
    return crossfadeEnabled;
}

// --- Workspace Change Handling ---
async function handleWorkspaceChange() {
    console.log('UI Core: Workspace did change. Reloading cues and app config.');
    
    // Comprehensive cleanup before changing workspace context to prevent memory leaks
    const ac = audioControllerModule && audioControllerModule.default ? audioControllerModule.default : audioControllerModule;
    if (ac && typeof ac.cleanupAllResources === 'function') {
        console.log('UI Core: Performing comprehensive cleanup before workspace change');
        ac.cleanupAllResources({ 
            source: 'workspace_change',
            forceUnload: true 
        });
    } else if (ac && typeof ac.stopAll === 'function') {
        // Fallback to stopAll if cleanupAllResources is not available
        console.log('UI Core: Performing fallback cleanup before workspace change');
        const currentEffectiveConfig = appConfigUIModuleInternal.getCurrentAppConfig(); 
        const behavior = currentEffectiveConfig.defaultStopAllBehavior || 'stop';
        const useFadeForStopAll = behavior === 'fade_out_and_stop';
        ac.stopAll({ 
            useFade: useFadeForStopAll,
            forceCleanup: true // Use force cleanup if available
        });
    }
    
    propertiesSidebar.hidePropertiesSidebar(); // Close properties sidebar as cue context is changing

    // Reload application configuration from the new workspace via appConfigUI module
    await appConfigUIModuleInternal.loadAndApplyAppConfig(); 
    
    // Reload and render cues for the new workspace
    await loadAndRenderCues(); 

    // No need to explicitly update audioController with appConfig here,
    // as loadAndApplyAppConfig in appConfigUI should handle notifying audioController.
    
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
        if (await propertiesSidebar.setFilePathInProperties(filePath)) {
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

            const cueId = await electronAPIForPreload.generateUUID();
            console.log("UI Core (SingleDrop): Generated UUID:", cueId); // New Log

            const fileName = filePath.split(/[\\\/]/).pop();
            const cueName = fileName.split('.').slice(0, -1).join('.') || 'New Cue';
            const newCueData = {
                id: cueId, name: cueName, type: 'single_file', filePath: filePath,
                volume: activeAppConfig.defaultVolume,
                fadeInTime: activeAppConfig.defaultFadeInTime,
                fadeOutTime: activeAppConfig.defaultFadeOutTime,
                loop: activeAppConfig.defaultLoopSingleCue,
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
        if (propertiesSidebar && typeof propertiesSidebar.addFilesToStagedPlaylist === 'function') {
            if (await propertiesSidebar.addFilesToStagedPlaylist(fileArray)) {
                console.log("UI Core (MultiDrop): Handled by open Properties Sidebar (playlist).");
                return;
            } else {
                console.warn("UI Core (MultiDrop): Properties sidebar did not handle multi-file drop. No fallback implemented yet for this specific case.");
                return;
            }
        } else {
            console.warn("UI Core (MultiDrop): Properties sidebar addFilesToStagedPlaylist function not available.");
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
    } else {
        console.warn('UI Core: cueGrid.renderCues is not available for refresh.');
    }
}


// Function called by ipcRendererBindings when playback time updates are received from main
function updateCueButtonTimeDisplay(data) {
    if (!cueGrid || typeof cueGrid.updateCueButtonTime !== 'function') {
        // console.warn('[UI_CORE_DEBUG] cueGrid.updateCueButtonTime is not available.');
        return;
    }
    // console.log(`[UI_TIME_DEBUG] updateCueButtonTimeDisplay called for cueId: ${data.cueId}, currentTimeSec: ${data.currentTimeSec}, status: ${data.status}`);

    // Ensure data contains necessary fields. Defaulting fade states to false if not present.
    const cueId = data.cueId;
    const isFadingIn = data.isFadingIn || false;
    const isFadingOut = data.isFadingOut || false;
    const fadeTimeRemainingMs = data.fadeTimeRemainingMs || 0;

    if (cueId) {
        // Use the time data directly from the IPC message instead of calling audioController.getPlaybackTimes()
        // This ensures we get real-time updates without additional function call overhead
        const timeData = {
            currentTimeFormatted: data.currentTimeFormatted || '00:00',
            currentTime: data.currentTimeSec || 0,
            duration: data.totalDurationSec || 0,
            durationFormatted: data.totalDurationFormatted || '00:00',
            remainingTime: data.remainingTimeSec || 0,
            remainingTimeFormatted: data.remainingTimeFormatted || '00:00',
            volume: typeof data.volume === 'number' ? data.volume : undefined,
            status: data.status || '',
            isDucked: data.isDucked || false
        };
        
        cueGrid.updateCueButtonTimeWithData(cueId, timeData, null, isFadingIn, isFadingOut, fadeTimeRemainingMs);
    } else {
        // console.warn('[UI_CORE_DEBUG] updateCueButtonTimeDisplay: cueId missing in data', data);
    }
}

function isUIFullyInitialized() { // NEW GETTER
    return isUIModuleFullyInitialized;
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
    applyAppConfiguration, // Export the new function
    isCrossfadeEnabled, // Export crossfade state

    updateCueButtonTimeDisplay, // Export the new function
    getCurrentAppMode, // Export for other modules if they need to know mode without shift key override
    isUIFullyInitialized // EXPORT NEW GETTER
};
