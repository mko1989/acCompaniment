// Companion_soundboard/src/renderer/ui.js
// Manages core UI logic, initializes sub-modules, and handles interactions not covered by sub-modules.

// Import UI sub-modules
import * as cueGrid from './ui/cueGrid.js';
import * as utils from './ui/utils.js';
import * as sidebars from './ui/sidebars.js';
import * as modals from './ui/modals.js';
import * as appConfigUI from './ui/appConfigUI.js'; // Import new module

// Module references that will be initialized
let cueStore;
let audioController;
let ipcRendererBindingsModule;
let dragDropHandler;

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
/*
let currentAppConfig = {
    defaultFadeInTime: 0,
    defaultFadeOutTime: 0,
    defaultLoop: false,
    defaultVolume: 1,
    defaultRetriggerBehavior: 'restart',
    defaultStopAllBehavior: 'stop',
    audioOutputDevice: 'default'
};
*/

// MOVED to modals.js: droppedFilesList

async function init(cs, ac, ipc, ddh) {
    cueStore = cs;
    audioController = ac;
    ipcRendererBindingsModule = ipc;
    dragDropHandler = ddh;

    utils.initUtils(cueStore);
    
    await appConfigUI.initAppConfigUI(ipcRendererBindingsModule, audioController);

    cacheCoreDOMElements();
    bindCoreEventListeners();

    const uiCoreInterface = {
        isEditMode,
        openPropertiesSidebar: sidebars.openPropertiesSidebar,
        getCurrentAppConfig: appConfigUI.getCurrentAppConfig,
        openNewCueModal: modals.openNewCueModal, 
        showMultipleFilesDropModal: modals.showMultipleFilesDropModal
    };

    cueGrid.initCueGrid(cueStore, audioController, dragDropHandler, uiCoreInterface);
    sidebars.initSidebars(cueStore, audioController, ipcRendererBindingsModule, uiCoreInterface);
    modals.initModals(cueStore, ipcRendererBindingsModule, uiCoreInterface);
    
    updateModeUI();
    console.log('UI Core Module Initialized');

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
    if (addCueButton) addCueButton.addEventListener('click', modals.openNewCueModal); 

    if (stopAllButton) {
        stopAllButton.addEventListener('click', () => {
            if (audioController && typeof audioController.stopAll === 'function') {
                const config = appConfigUI.getCurrentAppConfig(); // Get from appConfigUI
                const behavior = config.defaultStopAllBehavior || 'stop';
                audioController.stopAll({ behavior: behavior });
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
    await cueStore.loadCuesFromServer();
    console.log('UI Core: Cues loaded, rendering grid via cueGrid module.');
    cueGrid.renderCues();
}

function isEditMode() {
    return getCurrentAppMode() === 'edit';
}

// getCurrentAppConfig MOVED (accessed via appConfigUI.getCurrentAppConfig through uiCoreInterface)

// --- App Configuration Functions (MOVED to appConfigUI.js) ---
/*
async function loadAndApplyAppConfiguration() { ... }
function populateConfigSidebar() { ... }
async function handleAppConfigChange() { ... }
async function populateAudioOutputDevicesDropdown() { ... }
*/

// --- Legacy Drag and Drop Target Assignment ---
// This function's role needs to be re-evaluated.
// dragDropHandler.js now directly calls handleSingleFileDrop/handleMultipleFileDrop.
// Those handlers, in turn, can delegate to sidebars.js or modals.js if the drop target is specific.
function assignFilesToRelevantTarget(filePaths, dropTargetElement) {
    if (!filePaths || filePaths.length === 0) return;
    console.log(`UI Core (assignFilesToRelevantTarget): Assigning files to target:`, filePaths, dropTargetElement);

    const propertiesSidebarDOM = document.getElementById('propertiesSidebar'); // Direct DOM check
    const cueConfigModalDOM = document.getElementById('cueConfigModal'); // Direct DOM check

    // 1. Check Properties Sidebar (if open)
    if (propertiesSidebarDOM && !propertiesSidebarDOM.classList.contains('hidden') && propertiesSidebarDOM.contains(dropTargetElement)) {
        const activeCueId = sidebars.getActivePropertiesCueId(); // Get active cue ID from sidebars module
        if (activeCueId) {
            const cue = cueStore.getCueById(activeCueId);
            if (cue) {
                if (cue.type === 'playlist') {
                    // Convert filePaths (simple array of paths) to the structure sidebars.addFilesToStagedPlaylist expects
                    const filesForPlaylist = filePaths.map(fp => ({ path: fp, name: fp.split(/[\\\/]/).pop() }));
                    sidebars.addFilesToStagedPlaylist(filesForPlaylist); // Call sidebars module
                    return;
                } else if ((cue.type === 'single_file' || cue.type === 'single') && filePaths.length === 1) {
                    sidebars.setFilePathInProperties(filePaths[0]); // Call sidebars module
                    return;
                }
            }
        }
    }

    // 2. Check New Cue Modal (if open AND is the target)
    if (cueConfigModalDOM && cueConfigModalDOM.style.display === 'flex' && cueConfigModalDOM.contains(dropTargetElement)) {
        // Call the function in modals.js to actually handle the file assignment.
        // modals.handleFileDropInNewCueModal will apply the files if the modal type is appropriate.
        if (modals.handleFileDropInNewCueModal(filePaths)) {
            console.log("UI Core (assignFilesToRelevantTarget): Drop successfully handled by New Cue Modal via modals.js.");
            return; // Drop was handled
        } else {
            console.log("UI Core (assignFilesToRelevantTarget): Drop on New Cue Modal, but not handled by modals.js (e.g., wrong modal state or type).");
            // Potentially still return if we consider the modal the definitive target, even if no action was taken.
            // For now, let's return to prevent further processing if it was on the modal.
            return;
        }
    }

    // 3. Check Cue Button (Edit Mode)
    const cueButtonTarget = dropTargetElement.closest('.cue-button');
    if (cueButtonTarget && cueButtonTarget.dataset.cueId && isEditMode()) {
        const cueId = cueButtonTarget.dataset.cueId;
        const targetCue = cueStore.getCueById(cueId);
        if (targetCue) {
            sidebars.openPropertiesSidebar(targetCue); // Open sidebar for this cue
            // File assignment to the now-open sidebar should ideally be handled by a subsequent drop event
            // directly onto the sidebar, or by passing files to openPropertiesSidebar if that's desired.
            // For now, just opening it.
            console.log(`UI Core (assign): Files dropped on cue button ${cueId}. Opened properties.`);
        }
        return;
    }
    
    console.warn("UI Core (assign): assignFilesToRelevantTarget did not find a specific target. Drop might be handled by newer global handlers or ignored.", dropTargetElement);
}


// --- App Configuration (To be moved to appConfigUI.js) ---
async function loadAndApplyAppConfiguration() {
    if (!ipcRendererBindingsModule) return;
    try {
        const loadedConfig = await ipcRendererBindingsModule.getAppConfig();
        if (loadedConfig && typeof loadedConfig === 'object') {
            currentAppConfig = { ...currentAppConfig, ...loadedConfig };
        }
    } catch (error) {
        console.error('UI Core: Error loading app configuration:', error);
    }
    populateConfigSidebar();
    await populateAudioOutputDevicesDropdown();
    // Initial device set is now in init() after modules are ready
}

function populateConfigSidebar() {
    if (defaultFadeInInput) defaultFadeInInput.value = currentAppConfig.defaultFadeInTime;
    if (defaultFadeOutInput) defaultFadeOutInput.value = currentAppConfig.defaultFadeOutTime;
    if (defaultLoopCheckbox) defaultLoopCheckbox.checked = currentAppConfig.defaultLoop;
    if (defaultVolumeInput) defaultVolumeInput.value = currentAppConfig.defaultVolume;
    if (defaultVolumeValueDisplay) defaultVolumeValueDisplay.textContent = parseFloat(currentAppConfig.defaultVolume).toFixed(2);
    if (retriggerBehaviorSelect) retriggerBehaviorSelect.value = currentAppConfig.defaultRetriggerBehavior;
    if (defaultStopAllBehaviorSelect) defaultStopAllBehaviorSelect.value = currentAppConfig.defaultStopAllBehavior;
}

async function handleAppConfigChange() {
    if (!ipcRendererBindingsModule) return;
    const newConfig = {
        defaultFadeInTime: defaultFadeInInput ? parseFloat(defaultFadeInInput.value) || 0 : currentAppConfig.defaultFadeInTime,
        defaultFadeOutTime: defaultFadeOutInput ? parseFloat(defaultFadeOutInput.value) || 0 : currentAppConfig.defaultFadeOutTime,
        defaultLoop: defaultLoopCheckbox ? defaultLoopCheckbox.checked : currentAppConfig.defaultLoop,
        defaultVolume: defaultVolumeInput ? parseFloat(defaultVolumeInput.value) : currentAppConfig.defaultVolume,
        defaultRetriggerBehavior: retriggerBehaviorSelect ? retriggerBehaviorSelect.value : currentAppConfig.defaultRetriggerBehavior,
        defaultStopAllBehavior: defaultStopAllBehaviorSelect ? defaultStopAllBehaviorSelect.value : currentAppConfig.defaultStopAllBehavior,
        audioOutputDevice: audioOutputSelect ? audioOutputSelect.value : 'default'
    };
    const oldDeviceId = currentAppConfig.audioOutputDevice;
    currentAppConfig = { ...currentAppConfig, ...newConfig };
    
    await ipcRendererBindingsModule.saveAppConfig(currentAppConfig);

    if (audioController && typeof audioController.updateAppConfig === 'function') {
        audioController.updateAppConfig(currentAppConfig);
    }
    if (audioController && typeof audioController.setAudioOutputDevice === 'function') {
        if (oldDeviceId !== currentAppConfig.audioOutputDevice) {
            audioController.setAudioOutputDevice(currentAppConfig.audioOutputDevice);
        }
    }
    if (audioController && typeof audioController.setDefaultRetriggerBehavior === 'function') {
        audioController.setDefaultRetriggerBehavior(currentAppConfig.defaultRetriggerBehavior);
    }
}

async function populateAudioOutputDevicesDropdown() {
    if (!audioOutputSelect || !ipcRendererBindingsModule) return;
    audioOutputSelect.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = 'System Default Device';
    audioOutputSelect.appendChild(defaultOption);

    try {
        const devices = await ipcRendererBindingsModule.getAudioOutputDevices();
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Device ${device.deviceId.substring(0,8)}`;
            audioOutputSelect.appendChild(option);
        });
        audioOutputSelect.value = currentAppConfig.audioOutputDevice || 'default';
        if (audioOutputSelect.value !== currentAppConfig.audioOutputDevice && currentAppConfig.audioOutputDevice !== 'default') {
            currentAppConfig.audioOutputDevice = 'default';
        }
    } catch (error) {
        console.error('UI Core: Error populating audio output devices:', error);
    }
}

// --- Workspace Change Handling ---
async function handleWorkspaceChange() {
    console.log('UI Core: Handling workspace change.');
    if (audioController && typeof audioController.stopAll === 'function') {
        audioController.stopAll({ behavior: 'stop', forceNoFade: true });
    }
    sidebars.hidePropertiesSidebar();
    await loadAndApplyAppConfiguration(); // Reloads and reapplies config
    await loadAndRenderCues(); // Reloads and re-renders cues
    if (audioController && typeof audioController.updateAppConfig === 'function') { // Ensure audio controller gets new config
        audioController.updateAppConfig(currentAppConfig);
    }
     if (audioController && typeof audioController.setAudioOutputDevice === 'function') { // And new audio device
        audioController.setAudioOutputDevice(currentAppConfig.audioOutputDevice || 'default');
    }
    console.log('UI Core: Workspace change handling complete.');
}

// --- Global Drag and Drop Handlers (called by dragDropHandler.js) ---
// These determine if a general drop creates new cues or opens the "multiple files" modal.
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
        try {
            const cueId = await ipcRendererBindingsModule.generateUUID();
            const fileName = filePath.split(/[\\\\\\/]/).pop();
            const cueName = fileName.split('.').slice(0, -1).join('.') || 'New Cue';
            const newCueData = {
                id: cueId, name: cueName, type: 'single_file', filePath: filePath,
                volume: currentAppConfig.defaultVolume,
                fadeInTime: currentAppConfig.defaultFadeInTime,
                fadeOutTime: currentAppConfig.defaultFadeOutTime,
                loop: currentAppConfig.defaultLoop,
                retriggerBehavior: currentAppConfig.defaultRetriggerBehavior,
                shuffle: false, repeatOne: false, trimStartTime: null, trimEndTime: null,
            };
            await cueStore.addOrUpdateCue(newCueData);
            console.log("UI Core (SingleDrop): Created new cue from general drop.");
        } catch (error) {
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
            assignFilesToRelevantTarget(Array.from(files).map(f => f.path), dropTargetElement);
            return;
        }
    }

    // 2. If not properties sidebar, check for general drop area to show modal
    if (dropTargetElement === mainDropArea ||
        (document.body.contains(dropTargetElement) &&
         (!propertiesSidebarDOM || !propertiesSidebarDOM.contains(dropTargetElement)) &&
         (!cueConfigModalDOM || !cueConfigModalDOM.contains(dropTargetElement)) &&
         (!multipleFilesDropModalDOM || !multipleFilesDropModalDOM.contains(dropTargetElement)))) {
        modals.showMultipleFilesDropModal(files); // Show modal for multiple files
        console.log("UI Core (MultiDrop): Showed multiple files modal for general drop.");
    } else {
         // If not a general area, and not properties sidebar, try assignFilesToRelevantTarget
         // This might be a drop on a cue button or the new cue modal itself.
         assignFilesToRelevantTarget(Array.from(files).map(f => f.path), dropTargetElement);
         console.log("UI Core (MultiDrop): Drop target not general area. Delegated to assignFilesToRelevantTarget.", dropTargetElement);
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
    assignFilesToRelevantTarget, // Legacy, review or remove
    handleWorkspaceChange, // Called by IPC via renderer.js

    // Core UI utility functions passed to sub-modules as part of uiCoreInterface
    isEditMode,
    // getCurrentAppConfig, // Removed, use uiCoreInterface.getCurrentAppConfig
    updateModeUI, // If called by renderer.js (e.g. after shift key for testing)

    // New global drop handlers (called by dragDropHandler.js)
    handleSingleFileDrop,
    handleMultipleFileDrop,
    refreshCueGrid // Export the new function
};
