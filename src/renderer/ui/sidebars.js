import * as waveformControls from './waveformControls.js'; // Import the new module
import { formatWaveformTime } from './waveformControls.js';
import { debounce } from './utils.js'; // Import debounce

let cueStore;
let audioController;
let ipcRendererBindingsModule;
let uiCore; // For isEditMode, getCurrentAppConfig

// --- DOM Elements for Sidebars ---
// Config Sidebar
let configSidebar;
let configToggleBtn;

// Properties Sidebar
let propertiesSidebar;
let closePropertiesSidebarBtn;
let propCueIdInput, propCueNameInput, propCueTypeSelect, propSingleFileConfigDiv,
    propFilePathInput, propPlaylistConfigDiv, propPlaylistItemsUl,
    propPlaylistFilePathDisplay, propFadeInTimeInput, propFadeOutTimeInput,
    propLoopCheckbox, propTrimStartTimeInput, propTrimEndTimeInput, propTrimConfig,
    propVolumeRangeInput, propVolumeValueSpan, saveCuePropertiesButton, deleteCuePropertiesButton;
let propShufflePlaylistCheckbox, propRepeatOnePlaylistItemCheckbox, propRetriggerBehaviorSelect;
let propAddFilesToPlaylistBtn, propPlaylistFileInput;
let propPlaylistPlayModeSelect; // Added for playlist play mode
let propVolumeSlider, propVolumeValueDisplay;


// OSC Trigger Elements
let propOscTriggerEnabledCheckbox;
let propOscTriggerPathInput;
let propOscLearnBtn;

// WING Mixer Trigger Elements - REMOVED

// --- State for Properties Sidebar ---
let activePropertiesCueId = null;
let stagedPlaylistItems = [];
let draggedPlaylistItemIndex = null;
let currentEditCueId = null;

// Debounced version of handleSaveCueProperties
let debouncedSaveCueProperties;

function initSidebars(cs, ac, ipc, core) {
    cueStore = cs;
    audioController = ac;
    ipcRendererBindingsModule = ipc;
    uiCore = core;

    cacheSidebarDOMElements();
    // Initialize debounced save function after cacheSidebarDOMElements has run
    // and handleSaveCueProperties is defined.
    debouncedSaveCueProperties = debounce(handleSaveCueProperties, 500); 
    bindSidebarEventListeners();

    // Listen for learned OSC messages
    if (ipcRendererBindingsModule && typeof ipcRendererBindingsModule.onOscMessageLearned === 'function') {
        ipcRendererBindingsModule.onOscMessageLearned((learnedPath) => {
            if (propOscTriggerPathInput && activePropertiesCueId) {
                propOscTriggerPathInput.value = learnedPath;
                console.log(`Sidebar: Received learned OSC path: ${learnedPath} for cue ${activePropertiesCueId}`);
                // Potentially trigger a save or indicate change
            }
            if (propOscLearnBtn) {
                propOscLearnBtn.textContent = 'Learn';
                propOscLearnBtn.disabled = false;
            }
        });
    }
    if (ipcRendererBindingsModule && typeof ipcRendererBindingsModule.onOscLearnFailed === 'function') {
        ipcRendererBindingsModule.onOscLearnFailed((errorMsg) => {
            console.error(`Sidebar: OSC Learn mode failed or timed out: ${errorMsg}`);
            alert(`OSC Learn Failed: ${errorMsg}`);
            if (propOscLearnBtn) {
                propOscLearnBtn.textContent = 'Learn';
                propOscLearnBtn.disabled = false;
            }
        });
    }

    console.log('Sidebars Module Initialized (now SidebarManager)');
}

function cacheSidebarDOMElements() {
    // Config Sidebar
    configSidebar = document.getElementById('configSidebar');
    configToggleBtn = document.getElementById('configToggleBtn');

    // Properties Sidebar
    propertiesSidebar = document.getElementById('propertiesSidebar');
    closePropertiesSidebarBtn = document.getElementById('closePropertiesSidebarBtn');
    propCueIdInput = document.getElementById('propCueId');
    propCueNameInput = document.getElementById('propCueName');
    propCueTypeSelect = document.getElementById('propCueType');
    propSingleFileConfigDiv = document.getElementById('propSingleFileConfig');
    propFilePathInput = document.getElementById('propFilePath');
    propPlaylistConfigDiv = document.getElementById('propPlaylistConfig');
    propPlaylistItemsUl = document.getElementById('propPlaylistItems');
    propPlaylistFilePathDisplay = document.getElementById('propPlaylistFilePathDisplay');
    propFadeInTimeInput = document.getElementById('propFadeInTime');
    propFadeOutTimeInput = document.getElementById('propFadeOutTime');
    propLoopCheckbox = document.getElementById('propLoop');
    propTrimStartTimeInput = document.getElementById('propTrimStartTime');
    propTrimEndTimeInput = document.getElementById('propTrimEndTime');
    propTrimConfig = document.getElementById('propTrimConfig');
    propVolumeRangeInput = document.getElementById('propVolume');
    propVolumeValueSpan = document.getElementById('propVolumeValue');
    saveCuePropertiesButton = document.getElementById('saveCuePropertiesButton');
    deleteCuePropertiesButton = document.getElementById('deleteCuePropertiesButton');
    propShufflePlaylistCheckbox = document.getElementById('propShufflePlaylist');
    // Align with HTML id
    propRepeatOnePlaylistItemCheckbox = document.getElementById('propRepeatOnePlaylistItem');
    propRetriggerBehaviorSelect = document.getElementById('propRetriggerBehavior');
    propAddFilesToPlaylistBtn = document.getElementById('propAddFilesToPlaylistBtn');
    propPlaylistFileInput = document.getElementById('propPlaylistFileInput');
    propPlaylistPlayModeSelect = document.getElementById('propPlaylistPlayModeSelect');
    propVolumeSlider = document.getElementById('propVolume');
    propVolumeValueDisplay = document.getElementById('propVolumeValue');

    // Cache OSC Trigger Elements
    propOscTriggerEnabledCheckbox = document.getElementById('propOscTriggerEnabled');
    propOscTriggerPathInput = document.getElementById('propOscTriggerPath');
    propOscLearnBtn = document.getElementById('propOscLearnBtn');

    // Cache WING Mixer Trigger Elements - REMOVED

    if (propVolumeSlider && propVolumeValueDisplay) {
        propVolumeSlider.addEventListener('input', (e) => {
            propVolumeValueDisplay.textContent = parseFloat(e.target.value).toFixed(2);
        });
        // The 'change' event for saving will be handled by handleSaveCueProperties reading its value directly.
    }
}

function bindSidebarEventListeners() {
    if (configToggleBtn) configToggleBtn.addEventListener('click', toggleConfigSidebar);
    if (closePropertiesSidebarBtn) closePropertiesSidebarBtn.addEventListener('click', hidePropertiesSidebar);
    if (saveCuePropertiesButton) {
        saveCuePropertiesButton.style.display = 'none'; // Hide the save button
    }
    if (deleteCuePropertiesButton) deleteCuePropertiesButton.addEventListener('click', handleDeleteCueProperties);

    if (propCueTypeSelect) propCueTypeSelect.addEventListener('change', (e) => {
        const isPlaylist = e.target.value === 'playlist';
        if(propPlaylistConfigDiv) propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
        if(propSingleFileConfigDiv) propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
        const playlistSpecificControls = document.getElementById('playlistSpecificControls');
        if (playlistSpecificControls) {
            playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
        }

        const propTrimConfigDiv = document.getElementById('propTrimConfig');
        if (propTrimConfigDiv) {
            propTrimConfigDiv.style.display = isPlaylist ? 'none' : 'block';
        }

        const waveformDisplayContainer = document.getElementById('waveformDisplay');
        if (waveformDisplayContainer) { 
            waveformDisplayContainer.style.display = isPlaylist ? 'none' : 'block';
        }

        if (isPlaylist) {
            waveformControls.hideAndDestroyWaveform();
        } else {
            const cue = activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null;
            const currentFilePath = propFilePathInput ? propFilePathInput.value : null;

            if (cue && cue.filePath) {
                waveformControls.showWaveformForCue(cue);
            } else if (currentFilePath) { 
                waveformControls.showWaveformForCue({filePath: currentFilePath });
            } else {
                waveformControls.hideAndDestroyWaveform(); 
            }
        }
    });
    if (propVolumeRangeInput && propVolumeValueSpan) propVolumeRangeInput.addEventListener('input', (e) => {
        propVolumeValueSpan.textContent = parseFloat(e.target.value).toFixed(2);
    });

    if (propAddFilesToPlaylistBtn) {
        propAddFilesToPlaylistBtn.addEventListener('click', () => {
            if (propPlaylistFileInput) propPlaylistFileInput.click();
        });
    }
    if (propPlaylistFileInput) {
        propPlaylistFileInput.addEventListener('change', handlePropPlaylistFileSelect);
    }

    if (propOscLearnBtn) {
        propOscLearnBtn.addEventListener('click', () => {
            if (activePropertiesCueId) {
                console.log(`Sidebar: OSC Learn button clicked for cue ID: ${activePropertiesCueId}. Requesting learn mode.`);
                if (ipcRendererBindingsModule && typeof ipcRendererBindingsModule.sendStartOscLearn === 'function') {
                    ipcRendererBindingsModule.sendStartOscLearn(activePropertiesCueId);
                    propOscLearnBtn.textContent = 'Learning...';
                    propOscLearnBtn.disabled = true;
                } else {
                    alert('Error: Could not initiate OSC Learn mode (ipc).');
                    console.error('Error: ipcRendererBindingsModule.sendStartOscLearn is not a function or module not available.');
                }
            } else {
                console.warn('Sidebar: OSC Learn button clicked but no cue is being edited.');
            }
        });
    }

    // WING Mixer Trigger Event Listeners - REMOVED

    // --- Attach debounced save to all relevant input fields ---
    const inputsToAutoSave = [
        propCueNameInput, 
        propFilePathInput, // Though readonly, might be set programmatically
        propFadeInTimeInput, 
        propFadeOutTimeInput,
        propVolumeRangeInput, // Also propVolumeSlider - they are the same element
        propRetriggerBehaviorSelect,
        propOscTriggerPathInput,
        // propWingUserButtonInput, // REMOVED
        propPlaylistPlayModeSelect, // Added
    ];

    inputsToAutoSave.forEach(input => {
        if (input) {
            input.addEventListener('input', debouncedSaveCueProperties);
            // For select elements, 'change' is often more appropriate than 'input'
            if (input.tagName === 'SELECT') {
                input.removeEventListener('input', debouncedSaveCueProperties); // Remove 'input' if added
                input.addEventListener('change', debouncedSaveCueProperties);
            }
        }
    });

    const checkboxesToAutoSave = [
        propLoopCheckbox,
        propShufflePlaylistCheckbox,
        propRepeatOnePlaylistItemCheckbox,
        propOscTriggerEnabledCheckbox,
    ];

    checkboxesToAutoSave.forEach(checkbox => {
        if (checkbox) {
            checkbox.addEventListener('change', debouncedSaveCueProperties);
        }
    });
    // --- End of new event listener attachments ---
}

function toggleConfigSidebar() {
    if (configSidebar) configSidebar.classList.toggle('collapsed');
}

function openPropertiesSidebar(cue) {
    if (!cue || !propertiesSidebar || !uiCore) return;
    activePropertiesCueId = cue.id;
    const currentAppConfig = uiCore.getCurrentAppConfig();

    waveformControls.hideAndDestroyWaveform(); 

    if(propCueIdInput) propCueIdInput.value = cue.id;
    if(propCueNameInput) propCueNameInput.value = cue.name || '';
    if(propCueTypeSelect) propCueTypeSelect.value = cue.type || 'single'; 
    
    const isPlaylist = cue.type === 'playlist';
    if(propPlaylistConfigDiv) propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
    if(propSingleFileConfigDiv) propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';

    const playlistSpecificControls = document.getElementById('playlistSpecificControls');
    if (playlistSpecificControls) {
        playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
    }

    const waveformDisplayContainer = document.getElementById('waveformDisplay'); 
    if (waveformDisplayContainer) { 
        waveformDisplayContainer.style.display = isPlaylist ? 'none' : 'block';
    }

    if (isPlaylist) {
        if(propFilePathInput) propFilePathInput.value = ''; 
        stagedPlaylistItems = cue.playlistItems ? JSON.parse(JSON.stringify(cue.playlistItems)) : [];
        renderPlaylistInProperties(); 
        if(propPlaylistFilePathDisplay) propPlaylistFilePathDisplay.textContent = ''; 
        if(propShufflePlaylistCheckbox) propShufflePlaylistCheckbox.checked = cue.shuffle || false;
        if(propRepeatOnePlaylistItemCheckbox) propRepeatOnePlaylistItemCheckbox.checked = cue.repeatOne || false;
        if(propPlaylistPlayModeSelect) propPlaylistPlayModeSelect.value = cue.playlistPlayMode || 'continue';
        waveformControls.hideAndDestroyWaveform(); 
    } else {
        if(propFilePathInput) propFilePathInput.value = cue.filePath || '';
        if(propPlaylistItemsUl) propPlaylistItemsUl.innerHTML = ''; 
        stagedPlaylistItems = [];
        if (cue.filePath) {
            waveformControls.showWaveformForCue(cue);
        } else {
            waveformControls.hideAndDestroyWaveform(); 
        }
    }

    if(propFadeInTimeInput) propFadeInTimeInput.value = cue.fadeInTime !== undefined ? cue.fadeInTime : (currentAppConfig.defaultFadeInTime || 0);
    if(propFadeOutTimeInput) propFadeOutTimeInput.value = cue.fadeOutTime !== undefined ? cue.fadeOutTime : (currentAppConfig.defaultFadeOutTime || 0);
    if(propLoopCheckbox) propLoopCheckbox.checked = cue.loop !== undefined ? cue.loop : (currentAppConfig.defaultLoopSingleCue || false);
    
    if(propVolumeRangeInput) propVolumeRangeInput.value = cue.volume !== undefined ? cue.volume : (currentAppConfig.defaultVolume !== undefined ? currentAppConfig.defaultVolume : 1);
    if(propVolumeValueSpan) propVolumeValueSpan.textContent = parseFloat(propVolumeRangeInput.value).toFixed(2);
    
    if(propVolumeSlider) propVolumeSlider.value = cue.volume !== undefined ? cue.volume : (currentAppConfig.defaultVolume !== undefined ? currentAppConfig.defaultVolume : 1);
    if(propVolumeValueDisplay) propVolumeValueDisplay.textContent = parseFloat(propVolumeSlider.value).toFixed(2);
    
    if(propertiesSidebar) propertiesSidebar.classList.remove('hidden');

    if (propRetriggerBehaviorSelect) {
        propRetriggerBehaviorSelect.value = cue.retriggerBehavior !== undefined ? cue.retriggerBehavior : (currentAppConfig.defaultRetriggerBehavior || 'restart');
    }

    // Populate OSC Trigger fields
    if (propOscTriggerEnabledCheckbox) {
        propOscTriggerEnabledCheckbox.checked = cue.oscTrigger && cue.oscTrigger.enabled ? cue.oscTrigger.enabled : false;
    }
    if (propOscTriggerPathInput) {
        propOscTriggerPathInput.value = cue.oscTrigger && cue.oscTrigger.path ? cue.oscTrigger.path : '';
    }
    
    // Populate WING Mixer Trigger fields - REMOVED
    
    // Reset Learn button state
    if (propOscLearnBtn) {
        propOscLearnBtn.textContent = 'Learn';
        propOscLearnBtn.disabled = false;
    }
    
    // Make sure event listeners are bound for dynamic elements like playlist items if not already done
    bindPlaylistDragAndRemoveListenersIfNeeded();
}

function hidePropertiesSidebar() {
    if(propertiesSidebar) propertiesSidebar.classList.add('hidden');
    activePropertiesCueId = null;
    stagedPlaylistItems = [];
    waveformControls.hideAndDestroyWaveform();
}

function renderPlaylistInProperties() {
    if (!propPlaylistItemsUl || !ipcRendererBindingsModule) return;
    propPlaylistItemsUl.innerHTML = ''; 

    stagedPlaylistItems.forEach((item, index) => {
        const li = document.createElement('li');
        li.dataset.index = index; 
        li.dataset.path = item.path || ''; 
        li.dataset.itemId = item.id || '';

        li.addEventListener('dragover', handleDragOverPlaylistItem);
        li.addEventListener('drop', handleDropPlaylistItem);
        li.addEventListener('dragend', handleDragEndPlaylistItem); 
        
        const dragHandle = document.createElement('span');
        dragHandle.classList.add('playlist-item-drag-handle');
        dragHandle.innerHTML = '&#x2630;'; 
        dragHandle.draggable = true;
        dragHandle.addEventListener('dragstart', handleDragStartPlaylistItem);
        li.appendChild(dragHandle);

        const itemNameSpan = document.createElement('span');
        itemNameSpan.textContent = item.name || (item.path ? item.path.split(/[\\\/]/).pop() : 'Invalid Item');
        itemNameSpan.title = item.path; 
        itemNameSpan.classList.add('playlist-item-name'); 
        li.appendChild(itemNameSpan);

        const itemDurationSpan = document.createElement('span');
        itemDurationSpan.classList.add('playlist-item-duration');
        const formattedDuration = item.knownDuration ? formatWaveformTime(item.knownDuration) : '--:--';
        itemDurationSpan.textContent = ` (${formattedDuration})`
        li.appendChild(itemDurationSpan);

        const removeButton = document.createElement('button');
        removeButton.textContent = '✕'; 
        removeButton.title = 'Remove item'; 
        removeButton.classList.add('remove-playlist-item-btn');
        removeButton.dataset.index = index;
        removeButton.addEventListener('click', handleRemovePlaylistItem);
        li.appendChild(removeButton);
        
        propPlaylistItemsUl.appendChild(li);
    });

    if (stagedPlaylistItems.length === 0 && propPlaylistFilePathDisplay) {
        propPlaylistFilePathDisplay.textContent = 'Playlist is empty. Drag files here or click Add Files.';
    } else if (propPlaylistFilePathDisplay) {
        propPlaylistFilePathDisplay.textContent = `Playlist contains ${stagedPlaylistItems.length} item(s).`;
    }
}

function handleDragStartPlaylistItem(event) {
    const listItem = event.target.closest('li');
    if (!listItem) return;
    draggedPlaylistItemIndex = parseInt(listItem.dataset.index, 10);
    event.dataTransfer.effectAllowed = 'move';
    listItem.classList.add('dragging-playlist-item'); 
}

function handleDragOverPlaylistItem(event) {
    event.preventDefault(); 
    event.dataTransfer.dropEffect = 'move';
    const targetLi = event.target.closest('li');
    if (targetLi) {
        Array.from(propPlaylistItemsUl.children).forEach(childLi => childLi.classList.remove('drag-over-playlist-item'));
        targetLi.classList.add('drag-over-playlist-item');
    }
}

function handleDropPlaylistItem(event) {
    event.preventDefault();
    const targetLi = event.target.closest('li');
    if (!targetLi) return;

    const droppedOnItemIndex = parseInt(targetLi.dataset.index, 10);
    targetLi.classList.remove('drag-over-playlist-item');

    if (draggedPlaylistItemIndex !== null && draggedPlaylistItemIndex !== droppedOnItemIndex) {
        const itemToMove = stagedPlaylistItems.splice(draggedPlaylistItemIndex, 1)[0];
        stagedPlaylistItems.splice(droppedOnItemIndex, 0, itemToMove);
        renderPlaylistInProperties();
    }
}

function handleDragEndPlaylistItem(event) {
    const listItem = event.target.closest('li');
    if(listItem) listItem.classList.remove('dragging-playlist-item');
    Array.from(propPlaylistItemsUl.children).forEach(childLi => childLi.classList.remove('drag-over-playlist-item'));
    draggedPlaylistItemIndex = null;
}

function handleRemovePlaylistItem(event) {
    const indexToRemove = parseInt(event.target.dataset.index, 10);
    if (!isNaN(indexToRemove) && indexToRemove >= 0 && indexToRemove < stagedPlaylistItems.length) {
        stagedPlaylistItems.splice(indexToRemove, 1);
        renderPlaylistInProperties();
    }
}

async function handleSaveCueProperties() {
    if (!activePropertiesCueId || !uiCore || !cueStore) {
        console.warn('Sidebar: No active cue to save or uiCore/cueStore not available.');
        return;
    }
    
    // Verify the cue still exists in the store before trying to save
    const existingCue = cueStore.getCueById(activePropertiesCueId);
    if (!existingCue) {
        console.warn('Sidebar: Active cue not found in cueStore:', activePropertiesCueId);
        return;
    }
    
    const currentAppConfig = uiCore.getCurrentAppConfig();

    const cueDataToSave = {
        ...existingCue,
        name: propCueNameInput.value,
        type: propCueTypeSelect.value,
        filePath: propFilePathInput.value,
        fadeInTime: parseFloat(propFadeInTimeInput.value) || 0,
        fadeOutTime: parseFloat(propFadeOutTimeInput.value) || 0,
        loop: propLoopCheckbox.checked,
        retriggerBehavior: propRetriggerBehaviorSelect.value,
        volume: parseFloat(propVolumeSlider.value),
        shufflePlaylist: propShufflePlaylistCheckbox ? propShufflePlaylistCheckbox.checked : false,
        repeatOnePlaylistItem: propRepeatOnePlaylistItemCheckbox ? propRepeatOnePlaylistItemCheckbox.checked : false,
        playlistPlayMode: propPlaylistPlayModeSelect ? propPlaylistPlayModeSelect.value : 'continue',
    };

    // If it's a single file cue and trim times were edited via waveform, get them
    if (cueDataToSave.type === 'single_file' && waveformControls && typeof waveformControls.getCurrentTrimTimes === 'function') {
        const trimTimes = waveformControls.getCurrentTrimTimes();
        if (trimTimes) {
            // Trim times from waveform regions take priority
            cueDataToSave.trimStartTime = trimTimes.trimStartTime;
            cueDataToSave.trimEndTime = trimTimes.trimEndTime;
            console.log(`Sidebars (DEBUG save): Applied trimTimes from waveformControls: Start=${cueDataToSave.trimStartTime}, End=${cueDataToSave.trimEndTime}`);
        } else {
            // No trim regions exist - preserve existing trim times from cue if they exist
            const existingCue = cueStore.getCueById(activePropertiesCueId);
            if (existingCue && existingCue.trimStartTime !== undefined && existingCue.trimEndTime !== undefined) {
                // Preserve existing trim times
                cueDataToSave.trimStartTime = existingCue.trimStartTime;
                cueDataToSave.trimEndTime = existingCue.trimEndTime;
                console.log(`Sidebars (DEBUG save): Preserved existing trimTimes from cue: Start=${cueDataToSave.trimStartTime}, End=${cueDataToSave.trimEndTime}`);
            } else {
                // Fall back to input fields or defaults
                cueDataToSave.trimStartTime = parseFloat(propTrimStartTimeInput.value) || 0;
                cueDataToSave.trimEndTime = parseFloat(propTrimEndTimeInput.value) || (cueDataToSave.totalDuration || 0);
                console.log(`Sidebars (DEBUG save): trimTimes from waveformControls was null and no existing trim times. Using input fields: Start=${cueDataToSave.trimStartTime}, End=${cueDataToSave.trimEndTime}`);
            }
        }
    } else if (cueDataToSave.type !== 'single_file') {
        cueDataToSave.trimStartTime = 0;
        cueDataToSave.trimEndTime = 0;
        console.log(`Sidebars (DEBUG save): Cue type is not single_file. Clearing trim times.`);
    }
    
    // Preserve total duration for single file cues if already known, playlists get it from items
    if (cueDataToSave.type === 'single_file') {
        // Keep existing totalDuration if it exists
    } else if (cueDataToSave.type === 'playlist') {
        cueDataToSave.totalDuration = stagedPlaylistItems.reduce((acc, item) => acc + (item.duration || 0), 0);
    }

    // Add the values of the OSC trigger elements
    if (propOscTriggerEnabledCheckbox || propOscTriggerPathInput) {
        cueDataToSave.oscTrigger = {
            enabled: propOscTriggerEnabledCheckbox ? propOscTriggerEnabledCheckbox.checked : false,
            path: propOscTriggerPathInput ? propOscTriggerPathInput.value.trim() : ''
        };
    }

    // Add WING Mixer Trigger values - REMOVED

    try {
        console.log('Sidebar: Attempting to save cue with data:', cueDataToSave);
        // Use the correct function name based on preload.js
        if (!ipcRendererBindingsModule || typeof ipcRendererBindingsModule.addOrUpdateCue !== 'function') {
            console.error('Sidebar: ipcRendererBindingsModule or addOrUpdateCue is not available. Cannot save cue.');
            alert('Error: Could not communicate with the main process to save the cue.');
            return;
        }
        await ipcRendererBindingsModule.addOrUpdateCue(cueDataToSave);
        console.log(`Sidebar: Cue ${activePropertiesCueId} properties saved successfully.`);
        // Optionally, provide user feedback (e.g., a temporary "Saved!" message)
        // No, we decided against auto-closing: hidePropertiesSidebar(); 
    } catch (error) {
        console.error('Sidebar: Error saving cue properties:', error);
        alert(`Error saving cue: ${error.message || error}`);
    }
}

async function handleDeleteCueProperties() {
    if (!activePropertiesCueId || !cueStore || !audioController || !uiCore) return;
    if (confirm('Are you sure you want to delete this cue?')) {
        if (audioController.isPlaying(activePropertiesCueId)) {
            audioController.stop(activePropertiesCueId, false); 
        }
        await cueStore.deleteCue(activePropertiesCueId);
        hidePropertiesSidebar();
    }
}

function handlePropPlaylistFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0 || !ipcRendererBindingsModule) return;

    const newItemsPromises = Array.from(files).map(async (file) => ({
        id: await ipcRendererBindingsModule.generateUUID(), // Generate UUID for each item
        path: file.path, 
        name: file.name,
        knownDuration: await ipcRendererBindingsModule.getMediaDuration(file.path) // Get duration
    }));

    Promise.all(newItemsPromises).then(resolvedNewItems => {
        stagedPlaylistItems.push(...resolvedNewItems);
        renderPlaylistInProperties();
    });
    
    event.target.value = null; // Reset file input
}

// Getter for activePropertiesCueId for other modules if needed (e.g. dragDropHandler)
function getActivePropertiesCueId() {
    return activePropertiesCueId;
}

// Function to set single file path if properties sidebar is open for a single cue
async function setFilePathInProperties(filePath) {
    if (!activePropertiesCueId) return false;
    const activeCue = cueStore.getCueById(activePropertiesCueId);
    if (!activeCue || (activeCue.type !== 'single_file' && activeCue.type !== 'single')) return false;

    if (propFilePathInput) {
        propFilePathInput.value = filePath;
        if (activeCue.type === 'single_file' || activeCue.type === 'single') {
            waveformControls.showWaveformForCue({ ...activeCue, filePath: filePath });
        }
        return true;
    }
    return false;
}

// Ensure this is called during initialization
function bindPlaylistDragAndRemoveListenersIfNeeded() {
    if (propPlaylistItemsUl) {
        propPlaylistItemsUl.addEventListener('dragover', handleDragOverPlaylistItem);
        propPlaylistItemsUl.addEventListener('drop', handleDropPlaylistItem);
        propPlaylistItemsUl.addEventListener('dragend', handleDragEndPlaylistItem);
    }
}

// New function to be called from waveformControls
function handleCuePropertyChangeFromWaveform(trimStart, trimEnd) {
    console.log(`Sidebars (DEBUG): handleCuePropertyChangeFromWaveform received - Start: ${trimStart}, End: ${trimEnd}`);
    if (!activePropertiesCueId) {
        console.warn('Sidebars: Received trim change but no active cue ID.');
        return;
    }

    // Update the respective input fields if they exist
    if (propTrimStartTimeInput) {
        propTrimStartTimeInput.value = trimStart.toFixed(3); // Or however you want to format
    }
    if (propTrimEndTimeInput) {
        propTrimEndTimeInput.value = trimEnd.toFixed(3);
    }

    // Trigger the debounced save, which will gather all properties including these new trim times
    debouncedSaveCueProperties();
}

export {
    initSidebars,
    toggleConfigSidebar,
    openPropertiesSidebar,
    hidePropertiesSidebar,
    getActivePropertiesCueId,
    setFilePathInProperties,
    handleCuePropertyChangeFromWaveform,
}; 