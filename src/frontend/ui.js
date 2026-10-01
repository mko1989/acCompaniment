// Companion_soundboard/src/renderer/ui.js
// Manages core UI logic, initializes sub-modules, and handles interactions not covered by sub-modules.
// Adapted from Electron version to work in browser environment.

// Import UI sub-modules
import * as cueGrid from './ui/cueGrid.js';
import * as utils from './ui/utils.js';
import * as configSidebar from './ui/configSidebar.js';
import * as propertiesSidebar from './ui/propertiesSidebar.js';
import * as modals from './ui/modals.js';
import * as appConfigUI from './ui/appConfigUI.js';
import * as waveformControls from './ui/waveformControls.js';
import * as projects from './ui/projects.js';

// Module references that will be initialized
let cueStoreModule; // Renamed for clarity, will hold the passed cueStore module
let audioControllerModule; // Renamed for clarity
let websocketBindings; // Changed from electronAPIForPreload - WebSocket bindings instead of electronAPI
let actualWebSocketBindingsModule; // Changed from actualIpcBindingsModule - To store the actual WebSocket bindings module
let dragDropHandlerModule; // Renamed for clarity
let appConfigUIModuleInternal; // To hold the passed appConfigUI module
let modalsModule; // To be initialized
let waveformControlsModule;
let isUIModuleFullyInitialized = false; // NEW FLAG

// Core DOM Elements (not managed by sub-modules yet)
let appContainer;
let modeToggleBtn;
let stopAllButton;

// Core UI State
let currentMode = 'edit'; // 'edit' or 'show'
let shiftKeyPressed = false;

// Corrected init signature to match renderer.js
async function init(rcvdCueStore, rcvdAudioController, rcvdWebSocketBindings, rcvdDragDropHandler, rcvdAppConfigUI, rcvdWaveformControls, rcvdActualWebSocketBindings) {
    console.log('UI Core: init function started.');
    console.log('UI Core: Received rcvdWebSocketBindings. Type:', typeof rcvdWebSocketBindings, 'Keys:', rcvdWebSocketBindings ? Object.keys(rcvdWebSocketBindings) : 'undefined');
    console.log('UI Core: Received rcvdActualWebSocketBindings. Type:', typeof rcvdActualWebSocketBindings, 'Keys:', rcvdActualWebSocketBindings ? Object.keys(rcvdActualWebSocketBindings) : 'undefined');

    // In browser environment, we don't need to wait for main process
    // WebSocket connection is already established in renderer.js
    console.log('UI Core: WebSocket bindings ready. Proceeding with UI initialization.');

    // Assign passed modules to scoped variables
    websocketBindings = rcvdWebSocketBindings; // Changed from electronAPIForPreload
    actualWebSocketBindingsModule = rcvdActualWebSocketBindings; // Changed from actualIpcBindingsModule
    cueStoreModule = rcvdCueStore;
    audioControllerModule = rcvdAudioController;
    dragDropHandlerModule = rcvdDragDropHandler; // Store if ui.js needs to interact with it later
    appConfigUIModuleInternal = rcvdAppConfigUI;
    waveformControlsModule = rcvdWaveformControls;

    let uiModules = {}; // Declare uiModules as an object

    // Populate uiModules for sub-module initialization. There is no
    // separate "sidebars" module here — configSidebar.js and
    // propertiesSidebar*.js cover everything the legacy sidebars.js did,
    // except per-cue OSC triggering (intentionally not carried forward).
    modalsModule = modals;
    uiModules.cueGrid = cueGrid;
    uiModules.configSidebar = configSidebar;
    uiModules.propertiesSidebar = propertiesSidebar;
    uiModules.waveformControls = waveformControlsModule;
    uiModules.appConfigUI = appConfigUIModuleInternal;

    // AppConfigUI is initialized in renderer.js before ui.init — only wire sidebar API here
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.setUiApi === 'function') {
        appConfigUIModuleInternal.setUiApi({
            toggleSidebar: (name, open) => {
                if (name === 'configSidebar') configSidebar.setConfigSidebarOpen(!!open);
            }
        });
    }

    // Pass the *assigned* cueStoreModule to utils
    utils.initUtils(cueStoreModule); 
    
    cacheCoreDOMElements();
    bindCoreEventListeners();

    const uiCoreInterface = {
        isEditMode,
        openPropertiesSidebar: propertiesSidebar.openPropertiesSidebar,
        getCurrentAppConfig: appConfigUIModuleInternal && typeof appConfigUIModuleInternal.getCurrentAppConfig === 'function' 
            ? appConfigUIModuleInternal.getCurrentAppConfig 
            : () => ({}), // Fallback to empty config
        openNewCueModal: modalsModule.openNewCueModal,
        showMultipleFilesDropModal: modalsModule.showMultipleFilesDropModal,
        highlightPlayingPlaylistItem: propertiesSidebar.highlightPlayingPlaylistItemInSidebar,
        toggleConfigSidebar: configSidebar.toggleConfigSidebar
    };

    // Pass the *assigned* modules to sub-module initializers
    cueGrid.initCueGrid(cueStoreModule, audioControllerModule, dragDropHandlerModule, uiCoreInterface);
    configSidebar.initConfigSidebar();
    projects.init();
    propertiesSidebar.initPropertiesSidebar(cueStoreModule, audioControllerModule, actualWebSocketBindingsModule, uiCoreInterface);
    modalsModule.initModals(cueStoreModule, actualWebSocketBindingsModule, uiCoreInterface, waveformControlsModule);
    
    // Initialize waveformControls if it has an init function
    if (waveformControlsModule && typeof waveformControlsModule.init === 'function') {
        waveformControlsModule.init({
            websocketBindings: actualWebSocketBindingsModule,
            onTrimChange: propertiesSidebar.handleCuePropertyChangeFromWaveform || null,
            cueStore: cueStoreModule
        });
    }
    
    // Make uiModules available globally for other modules to access
    window.uiModules = uiModules;
    
    // updateModeUI(); // Defer this call until after initial cues are loaded
    console.log('UI Core Module Initialized. Mode UI update deferred until cues loaded.');

    // Return the actual module references (or specific functions if preferred)
    const initializedModules = {
        cueGridModule: cueGrid,
        configSidebarModule: configSidebar,
        propertiesSidebarModule: propertiesSidebar,
        modalsModule: modalsModule
        // We can also expose specific functions directly here if that's cleaner for audioController
        // e.g., updateButtonPlayingState: cueGrid.updateButtonPlayingState,
        //       updateCueButtonTime: cueGrid.updateCueButtonTime,
        //       highlightPlayingPlaylistItem: sidebars.highlightPlayingPlaylistItem 
    };

    isUIModuleFullyInitialized = true; // SET FLAG HERE
    console.log('UI Core: isUIModuleFullyInitialized set to true.');
    return initializedModules;
}

let configToggleBtn;
let addFilesButton;
let fileInput;

function cacheCoreDOMElements() {
    appContainer = document.getElementById('appContainer');
    modeToggleBtn = document.getElementById('modeToggleBtn');
    stopAllButton = document.getElementById('stopAllButton');
    configToggleBtn = document.getElementById('configToggleBtn');
    addFilesButton = document.getElementById('addFilesButton');
    fileInput = document.getElementById('fileInput');

    // Modal element caching is now handled by modals.js module
    // App Config Sidebar element caching is now handled by appConfigUI.js module
}

function bindCoreEventListeners() {
    if (modeToggleBtn) modeToggleBtn.addEventListener('click', toggleMode);
    if (configToggleBtn && configSidebar && typeof configSidebar.toggleConfigSidebar === 'function') {
        configToggleBtn.addEventListener('click', () => configSidebar.toggleConfigSidebar());
    }

    if (addFilesButton && fileInput) {
        addFilesButton.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const files = fileInput.files;
            if (!files || files.length === 0) {
                return;
            }
            const dropTarget = document.getElementById('cueGridContainer')
                || document.getElementById('mainDropArea');
            try {
                if (files.length === 1) {
                    await handleSingleFileDrop(files[0], dropTarget);
                } else {
                    await handleMultipleFileDrop(files, dropTarget);
                }
            } catch (error) {
                console.error('UI Core: Error adding files via file picker:', error);
            } finally {
                fileInput.value = '';
            }
        });
    }

    // XFADE: crossfade mode lives on the server (so every open UI, the
    // remote page and Companion agree on it); the button just asks for a
    // change and repaints from the server's broadcast.
    const crossfadeToggleBtn = document.getElementById('crossfadeToggleBtn');
    const acForCrossfade = audioControllerModule?.default || audioControllerModule;
    if (crossfadeToggleBtn && acForCrossfade?.onCrossfadeModeChange) {
        acForCrossfade.onCrossfadeModeChange((enabled) => {
            crossfadeToggleBtn.classList.toggle('crossfade-enabled', enabled);
            crossfadeToggleBtn.classList.toggle('crossfade-disabled', !enabled);
            crossfadeToggleBtn.setAttribute('aria-pressed', String(enabled));
            crossfadeToggleBtn.title = enabled
                ? 'Crossfade mode is on - click to turn off'
                : 'Crossfade mode is off - click to turn on';
        });
        crossfadeToggleBtn.addEventListener('click', () => {
            acForCrossfade.setCrossfadeMode(!acForCrossfade.isCrossfadeEnabled());
        });
    }

    if (stopAllButton) {
        stopAllButton.addEventListener('click', () => {
            console.log('🛑 UI: Stop All button clicked!');
            // Access .default if audioControllerModule is the namespace import
            const ac = audioControllerModule && audioControllerModule.default ? audioControllerModule.default : audioControllerModule;
            console.log('🛑 UI: audioControllerModule available:', !!ac);
            console.log('🛑 UI: stopAll function available:', typeof ac?.stopAll);
            
            if (ac && typeof ac.stopAll === 'function') {
                const config = appConfigUIModuleInternal && typeof appConfigUIModuleInternal.getCurrentAppConfig === 'function'
                    ? appConfigUIModuleInternal.getCurrentAppConfig() 
                    : {}; // Fallback to empty config
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

    if (effectiveMode === 'show') {
        appContainer.classList.remove('edit-mode');
        appContainer.classList.add('show-mode');
        if (modeToggleBtn) {
            modeToggleBtn.classList.add('show-mode-active');
            modeToggleBtn.classList.remove('edit-mode-active');
            // Change the icon source instead of background image
            const modeToggleIcon = document.getElementById('modeToggleIcon');
            if (modeToggleIcon) {
                modeToggleIcon.src = '/assets/icons/edit.png'; // Changed from '../../assets/icons/edit.png'
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
                modeToggleIcon.src = '/assets/icons/show_light.png'; // Changed from '../../assets/icons/show_light.png'
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

// Function to apply a new app configuration received from the server
function applyAppConfiguration(newConfig) {
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.populateConfigSidebar === 'function') {
        console.log('UI Core: Applying new app configuration received from server by calling populateConfigSidebar:', newConfig);
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

// --- Workspace Change Handling ---

// Every `workspace-updated` broadcast: a rename of the open project only
// updates its name; switching to another project reloads everything.
function handleWorkspaceUpdated(workspace) {
    if (projects.handleWorkspaceUpdated(workspace)) {
        handleWorkspaceChange();
    }
}

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
        const currentEffectiveConfig = appConfigUIModuleInternal && typeof appConfigUIModuleInternal.getCurrentAppConfig === 'function'
            ? appConfigUIModuleInternal.getCurrentAppConfig() 
            : {};
        const behavior = currentEffectiveConfig.defaultStopAllBehavior || 'stop';
        const useFadeForStopAll = behavior === 'fade_out_and_stop';
        ac.stopAll({ 
            useFade: useFadeForStopAll,
            forceCleanup: true // Use force cleanup if available
        });
    }
    
    propertiesSidebar.hidePropertiesSidebar(); // Close properties sidebar as cue context is changing

    // Reload application configuration from the new workspace via appConfigUI module
    if (appConfigUIModuleInternal && typeof appConfigUIModuleInternal.forceLoadAndApplyAppConfiguration === 'function') {
        try {
            await appConfigUIModuleInternal.forceLoadAndApplyAppConfiguration();
        } catch (error) {
            console.error('UI Core: Failed to reload app config on workspace change:', error);
        }
    }

    // Reload and render cues for the new workspace
    await loadAndRenderCues();

    // No need to explicitly update audioController with appConfig here,
    // as loadAndApplyAppConfig in appConfigUI should handle notifying audioController.
    
    console.log('UI Core: Workspace change handling complete.');
}

// Exposed for dragDropHandler to add files to a specific cue if properties sidebar is open
async function handleSingleFileDrop(file, dropTargetElement) {
    // In browser, file is a File object, not a filePath string
    const mainDropArea = document.getElementById('cueGridContainer'); // Main grid
    const propertiesSidebarDOM = document.getElementById('propertiesSidebar');
    const cueConfigModalDOM = document.getElementById('cueConfigModal');
    const multipleFilesDropModalDOM = document.getElementById('multipleFilesDropModal');

    // 1. Try to delegate to properties sidebar if it's the target
    if (propertiesSidebarDOM && !propertiesSidebarDOM.classList.contains('hidden') && propertiesSidebarDOM.contains(dropTargetElement)) {
        // In browser, we need to upload the file first, then set the path
        const formData = new FormData();
        formData.append('audioFile', file);
        
        const uploadResponse = await fetch('/api/audio/upload', {
            method: 'POST',
            body: formData
        });
        
        const uploadResult = await uploadResponse.json();
        
        if (uploadResult.success && await propertiesSidebar.setFilePathInProperties(uploadResult.audioFile)) {
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
        console.log("UI Core (SingleDrop): Matched general drop area. Attempting to create cue...");
        try {
            const activeAppConfig = appConfigUIModuleInternal && typeof appConfigUIModuleInternal.getCurrentAppConfig === 'function'
                ? appConfigUIModuleInternal.getCurrentAppConfig() 
                : {}; // Fallback to empty config
            if (!activeAppConfig) {
                console.error("UI Core (SingleDrop): App config not available!");
                alert('Error: App configuration is not loaded. Cannot create cue.');
                return;
            }
            console.log("UI Core (SingleDrop): App config loaded:", activeAppConfig);

            // In browser, we need to upload the file first, then create the cue
            const formData = new FormData();
            formData.append('audioFile', file);
            formData.append('name', file.name.replace(/\.[^/.]+$/, "")); // Remove extension

            const uploadResponse = await fetch('/api/audio/upload', {
                method: 'POST',
                body: formData
            });

            const uploadResult = await uploadResponse.json();

            if (!uploadResult.success) {
                throw new Error(uploadResult.error || 'Failed to upload audio file');
            }

            console.log("UI Core (SingleDrop): Audio file uploaded:", uploadResult.audioFile.id);

            const fileName = file.name;
            const cueName = fileName.split('.').slice(0, -1).join('.') || 'New Cue';
            const newCueData = {
                name: cueName, 
                type: 'single_file', 
                audioFileId: uploadResult.audioFile.id,
                relativePath: uploadResult.audioFile.relativePath,
                volume: activeAppConfig.defaultVolume || 1.0,
                fadeInTime: activeAppConfig.defaultFadeInTime || 0,
                fadeOutTime: activeAppConfig.defaultFadeOutTime || 0,
                loop: activeAppConfig.defaultLoopSingleCue || false,
                retriggerBehavior: activeAppConfig.defaultRetriggerBehavior || 'restart',
                shufflePlaylist: false, 
                repeatOnePlaylistItem: false, 
                trimStartTime: null, 
                trimEndTime: null,
            };
            console.log("UI Core (SingleDrop): Prepared new cue data:", newCueData);

            if (!cueStoreModule) {
                console.error('UI Core (handleSingleFileDrop): cueStoreModule is not initialized!');
                alert('Error: Cue store not available. Cannot create cue.');
                return;
            }
            await cueStoreModule.addOrUpdateCue(newCueData);
            console.log("UI Core (SingleDrop): Successfully called cueStoreModule.addOrUpdateCue. Cue should be created/updated.");
        } catch (error) {
            console.error('UI Core (SingleDrop): Error creating cue from drop:', error);
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
        const handled = await propertiesSidebar.addFilesToStagedPlaylist(files);
        if (handled) {
            console.log("UI Core (MultiDrop): Files added to open playlist's staged items.");
            return;
        }
        console.log("UI Core (MultiDrop): Properties sidebar open but not on a playlist cue. Falling back to general drop handling.");
    }

    // 2. If not properties sidebar, check for general drop area to show modal
    if (dropTargetElement === mainDropArea ||
        (document.body.contains(dropTargetElement) &&
         (!propertiesSidebarDOM || !propertiesSidebarDOM.contains(dropTargetElement)) &&
         (!cueConfigModalDOM || !cueConfigModalDOM.contains(dropTargetElement)) &&
         (!multipleFilesDropModalDOM || !multipleFilesDropModalDOM.contains(dropTargetElement)))) {
        if (modalsModule && typeof modalsModule.showMultipleFilesDropModal === 'function') {
            modalsModule.showMultipleFilesDropModal(files); // Show modal for multiple files
            console.log("UI Core (MultiDrop): Showed multiple files modal for general drop.");
        } else {
            console.log("UI Core (MultiDrop): Multiple files dropped. Modal not available - using fallback.");
            // Fallback: create separate cues for each file
            const fileArray = Array.from(files);
            for (const file of fileArray) {
                await handleSingleFileDrop(file, dropTargetElement);
            }
        }
    } else {
         // If not a general area, and not properties sidebar, try assignFilesToRelevantTarget
         // This might be a drop on a cue button or the new cue modal itself.
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


// Highlights the playing item in the properties sidebar's playlist (when
// that playlist is the one open), from the server's playlist position.
function syncPlaylistHighlight(cueId, status, playlistIndex) {
    const cue = cueStoreModule?.getCueById?.(cueId);
    if (!cue || cue.type !== 'playlist' || typeof propertiesSidebar.highlightPlayingPlaylistItemInSidebar !== 'function') {
        return;
    }
    const isActive = status === 'playing' || status === 'paused';
    const index = typeof playlistIndex === 'number' ? playlistIndex : cue.currentPlaylistIndex;
    const itemId = isActive ? (cue.playlistItems?.[index]?.id ?? null) : null;
    propertiesSidebar.highlightPlayingPlaylistItemInSidebar(cueId, itemId);
}

// Function called by WebSocket bindings when playback time updates are received from server
function handleCueStatusUpdate(payload) {
    if (!payload?.cueId || !cueGrid) {
        return;
    }

    const { cueId, status } = payload;
    const isPlaying = status === 'playing';
    const isPaused = status === 'paused';
    const isCued = status === 'cued_next' || status === 'cued';

    if (cueGrid.updateButtonPlayingState) {
        cueGrid.updateButtonPlayingState(cueId, isPlaying || isPaused, null, isCued, null);
    }
    syncPlaylistHighlight(cueId, status, payload.playlistIndex);
}

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
        const timeData = {
            currentTimeFormatted: data.currentTimeFormatted || '00:00',
            currentTime: data.currentTimeSec || 0,
            duration: data.totalDurationSec || 0,
            durationFormatted: data.totalDurationFormatted || '00:00',
            remainingTime: data.remainingTimeSec || 0,
            remainingTimeFormatted: data.remainingTimeFormatted || '00:00'
        };
        cueGrid.updateCueButtonTimeWithData(cueId, timeData, null, isFadingIn, isFadingOut, fadeTimeRemainingMs);
        if (typeof cueGrid.updateCueButtonLevel === 'function') {
            cueGrid.updateCueButtonLevel(cueId, data.peakLevel || 0);
        }
        // Update playing state (playing/paused/cued classes) so buttons show visual feedback
        const status = data.status || 'stopped';
        const isPlaying = status === 'playing';
        const isPaused = status === 'paused';
        const isCued = status === 'cued_next' || status === 'cued';
        if (cueGrid.updateButtonPlayingState) {
            cueGrid.updateButtonPlayingState(cueId, isPlaying || isPaused, null, isCued, null);
        }
        if (typeof data.playlistIndex === 'number') {
            syncPlaylistHighlight(cueId, status, data.playlistIndex);
        }
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
    handleWorkspaceChange, // Called by WebSocket via renderer.js
    handleWorkspaceUpdated,

    // Core UI utility functions passed to sub-modules as part of uiCoreInterface
    isEditMode,
    // getCurrentAppConfig, // Removed, use uiCoreInterface.getCurrentAppConfig
    updateModeUI, // If called by renderer.js (e.g. after shift key for testing)

    // New global drop handlers (called by dragDropHandler.js)
    handleSingleFileDrop,
    handleMultipleFileDrop,
    refreshCueGrid, // Export the new function
    applyAppConfiguration, // Export the new function
    updateCueButtonTimeDisplay, // Export the new function
    handleCueStatusUpdate,
    getCurrentAppMode, // Export for other modules if they need to know mode without shift key override
    isUIFullyInitialized // EXPORT NEW GETTER
};

