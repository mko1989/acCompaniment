import { getGlobalCueById, formatTime } from './utils.js'; // Assuming utils.js is in the same directory

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
    propLoopCheckbox, propTrimStartTimeInput, propTrimEndTimeInput,
    propVolumeRangeInput, propVolumeValueSpan, saveCuePropertiesButton, deleteCuePropertiesButton;
let propShufflePlaylistCheckbox, propRepeatOnePlaylistItemCheckbox, propRetriggerBehaviorSelect;
let propAddFilesToPlaylistBtn, propPlaylistFileInput;
let propPlaylistPlayModeSelect; // Added for playlist play mode

// --- State for Properties Sidebar ---
let activePropertiesCueId = null;
let stagedPlaylistItems = [];
let draggedPlaylistItemIndex = null;

function initSidebars(cs, ac, ipc, core) {
    cueStore = cs;
    audioController = ac;
    ipcRendererBindingsModule = ipc;
    uiCore = core;

    cacheSidebarDOMElements();
    bindSidebarEventListeners();
    console.log('Sidebars Module Initialized');
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
    propVolumeRangeInput = document.getElementById('propVolume');
    propVolumeValueSpan = document.getElementById('propVolumeValue');
    saveCuePropertiesButton = document.getElementById('saveCuePropertiesButton');
    deleteCuePropertiesButton = document.getElementById('deleteCuePropertiesButton');
    propShufflePlaylistCheckbox = document.getElementById('propShufflePlaylist');
    propRepeatOnePlaylistItemCheckbox = document.getElementById('propRepeatOnePlaylistItem');
    propRetriggerBehaviorSelect = document.getElementById('propRetriggerBehavior');
    propAddFilesToPlaylistBtn = document.getElementById('propAddFilesToPlaylistBtn');
    propPlaylistFileInput = document.getElementById('propPlaylistFileInput');
    propPlaylistPlayModeSelect = document.getElementById('propPlaylistPlayModeSelect'); // Added
}

function bindSidebarEventListeners() {
    if (configToggleBtn) configToggleBtn.addEventListener('click', toggleConfigSidebar);
    if (closePropertiesSidebarBtn) closePropertiesSidebarBtn.addEventListener('click', hidePropertiesSidebar);
    if (saveCuePropertiesButton) saveCuePropertiesButton.addEventListener('click', handleSaveCueProperties);
    if (deleteCuePropertiesButton) deleteCuePropertiesButton.addEventListener('click', handleDeleteCueProperties);

    if (propCueTypeSelect) propCueTypeSelect.addEventListener('change', (e) => {
        const isPlaylist = e.target.value === 'playlist';
        if(propPlaylistConfigDiv) propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
        if(propSingleFileConfigDiv) propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
        const playlistSpecificControls = document.getElementById('playlistSpecificControls');
        if (playlistSpecificControls) {
            playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
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
}

function toggleConfigSidebar() {
    if (configSidebar) configSidebar.classList.toggle('collapsed');
}

function openPropertiesSidebar(cue) {
    if (!cue || !propertiesSidebar || !uiCore) return;
    activePropertiesCueId = cue.id;
    const currentAppConfig = uiCore.getCurrentAppConfig(); // Get app config from core UI

    if(propCueIdInput) propCueIdInput.value = cue.id;
    if(propCueNameInput) propCueNameInput.value = cue.name || '';
    if(propCueTypeSelect) propCueTypeSelect.value = cue.type || 'single'; 
    
    const isPlaylist = propCueTypeSelect.value === 'playlist';
    if(propPlaylistConfigDiv) propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
    if(propSingleFileConfigDiv) propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';

    const playlistSpecificControls = document.getElementById('playlistSpecificControls');
    if (playlistSpecificControls) {
        playlistSpecificControls.style.display = isPlaylist ? 'block' : 'none';
    }

    if (isPlaylist) {
        if(propFilePathInput) propFilePathInput.value = ''; 
        stagedPlaylistItems = cue.playlistItems ? JSON.parse(JSON.stringify(cue.playlistItems)) : [];
        renderPlaylistInProperties(); 
        if(propPlaylistFilePathDisplay) propPlaylistFilePathDisplay.textContent = ''; 
        if(propShufflePlaylistCheckbox) propShufflePlaylistCheckbox.checked = cue.shuffle || false;
        if(propRepeatOnePlaylistItemCheckbox) propRepeatOnePlaylistItemCheckbox.checked = cue.repeatOne || false;
        if(propPlaylistPlayModeSelect) propPlaylistPlayModeSelect.value = cue.playlistPlayMode || 'continue'; // Added
    } else {
        if(propFilePathInput) propFilePathInput.value = cue.filePath || '';
        if(propPlaylistItemsUl) propPlaylistItemsUl.innerHTML = ''; 
        stagedPlaylistItems = [];
    }

    if(propFadeInTimeInput) propFadeInTimeInput.value = cue.fadeInTime !== undefined ? cue.fadeInTime : (currentAppConfig.defaultFadeInTime || 0);
    if(propFadeOutTimeInput) propFadeOutTimeInput.value = cue.fadeOutTime !== undefined ? cue.fadeOutTime : (currentAppConfig.defaultFadeOutTime || 0);
    if(propLoopCheckbox) propLoopCheckbox.checked = cue.loop !== undefined ? cue.loop : (currentAppConfig.defaultLoop || false);
    if(propTrimStartTimeInput) propTrimStartTimeInput.value = cue.trimStartTime !== undefined ? cue.trimStartTime : '';
    if(propTrimEndTimeInput) propTrimEndTimeInput.value = cue.trimEndTime !== undefined ? cue.trimEndTime : '';
    if(propVolumeRangeInput) propVolumeRangeInput.value = cue.volume !== undefined ? cue.volume : (currentAppConfig.defaultVolume !== undefined ? currentAppConfig.defaultVolume : 1);
    if(propVolumeValueSpan) propVolumeValueSpan.textContent = parseFloat(propVolumeRangeInput.value).toFixed(2);
    
    if(propertiesSidebar) propertiesSidebar.classList.remove('hidden');

    if (propRetriggerBehaviorSelect) {
        propRetriggerBehaviorSelect.value = cue.retriggerBehavior || currentAppConfig.defaultRetriggerBehavior || 'restart';
    }
}

function hidePropertiesSidebar() {
    if(propertiesSidebar) propertiesSidebar.classList.add('hidden');
    activePropertiesCueId = null;
    stagedPlaylistItems = [];
}

function renderPlaylistInProperties() {
    if (!propPlaylistItemsUl || !ipcRendererBindingsModule) return;
    propPlaylistItemsUl.innerHTML = ''; 

    stagedPlaylistItems.forEach((item, index) => {
        const li = document.createElement('li');
        li.dataset.index = index; 
        li.dataset.path = item.path || ''; 
        li.dataset.itemId = item.id || '';

        // ---- START DEBUG LOG ----
        console.log(`Sidebars/renderPlaylistInProperties loop: Item: ${item.name}, KnownDuration: ${item.knownDuration}`);
        // ---- END DEBUG LOG ----

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

        // Add item duration
        const itemDurationSpan = document.createElement('span');
        itemDurationSpan.classList.add('playlist-item-duration');
        const formattedDuration = item.knownDuration ? formatTime(item.knownDuration) : '--:--';
        // ---- START DEBUG LOG ----
        console.log(`Sidebars/renderPlaylistInProperties loop: Item: ${item.name}, FormattedDuration: ${formattedDuration}`);
        // ---- END DEBUG LOG ----
        itemDurationSpan.textContent = ` (${formattedDuration})`
        li.appendChild(itemDurationSpan);

        // ---- START DEBUG LOG ----
        console.log(`Sidebars/renderPlaylistInProperties loop: Final li.innerHTML for ${item.name}:`, li.innerHTML);
        // ---- END DEBUG LOG ----

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
    if (!activePropertiesCueId || !ipcRendererBindingsModule) {
        console.error('Cannot save cue properties: No active cue or IPC bindings.');
        return;
    }
    const cueFromStore = cueStore.getCueById(activePropertiesCueId); // Get existing cue to preserve non-UI managed fields
    if (!cueFromStore) {
        console.error('Cannot save cue properties: Cue not found in store', activePropertiesCueId);
        return;
    }

    const currentAppConfig = uiCore.getCurrentAppConfig();

    const updatedCueData = {
        ...cueFromStore, // Preserve existing fields
        id: activePropertiesCueId,
        name: propCueNameInput.value || 'Unnamed Cue',
        type: propCueTypeSelect.value,
        fadeInTime: parseInt(propFadeInTimeInput.value, 10) || 0,
        fadeOutTime: parseInt(propFadeOutTimeInput.value, 10) || 0,
        loop: propLoopCheckbox.checked,
        retriggerBehavior: propRetriggerBehaviorSelect.value || currentAppConfig.defaultRetriggerBehavior || 'restart',
        trimStartTime: parseFloat(propTrimStartTimeInput.value) || 0,
        trimEndTime: parseFloat(propTrimEndTimeInput.value) || 0,
        volume: parseFloat(propVolumeRangeInput.value),
        // Ensure playlist specific properties are handled correctly
        shuffle: propCueTypeSelect.value === 'playlist' ? propShufflePlaylistCheckbox.checked : false,
        repeatOne: propCueTypeSelect.value === 'playlist' ? propRepeatOnePlaylistItemCheckbox.checked : false,
        playlistPlayMode: propCueTypeSelect.value === 'playlist' ? (propPlaylistPlayModeSelect.value || 'continue') : undefined, // Added
        filePath: propCueTypeSelect.value === 'playlist' ? null : propFilePathInput.value,
        playlistItems: propCueTypeSelect.value === 'playlist' ? stagedPlaylistItems : [],
    };

    // Clean up conditional properties if type changed
    if (updatedCueData.type !== 'playlist') {
        delete updatedCueData.playlistItems;
        delete updatedCueData.shuffle;
        delete updatedCueData.repeatOne;
        delete updatedCueData.playlistPlayMode; // Added
    } else {
        delete updatedCueData.filePath;
    }

    console.log('Sidebars: Saving Cue Properties:', updatedCueData);

    try {
        await ipcRendererBindingsModule.addOrUpdateCue(updatedCueData);
        console.log('Cue properties saved for', activePropertiesCueId);
        // Optionally, refresh the cue grid or specific button after saving
        // if (uiCore && uiCore.refreshCueGrid) uiCore.refreshCueGrid(); 
        // No, cueStore will get an update and trigger refresh via its own mechanism
    } catch (error) {
        console.error('Error saving cue properties:', error);
        // TODO: Show error to user
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
        // uiCore.renderCues(); // Core UI should handle re-rendering
    }
}

function handlePropPlaylistFileSelect(event) {
    const files = event.target.files;
    if (!files || files.length === 0 || !ipcRendererBindingsModule) return;

    const newItemsPromises = Array.from(files).map(async (file) => ({
        id: await ipcRendererBindingsModule.generateUUID(), // Generate UUID for each item
        path: file.path, 
        name: file.name,
        // duration: null // Will be discovered by main process
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

// Function to add files to staged playlist if properties sidebar is open for a playlist cue
async function addFilesToStagedPlaylist(files) {
    if (!activePropertiesCueId || !ipcRendererBindingsModule) return false;
    const activeCue = cueStore.getCueById(activePropertiesCueId);
    if (!activeCue || activeCue.type !== 'playlist') return false;

    const newItemsPromises = Array.from(files).map(async (file) => ({
        id: await ipcRendererBindingsModule.generateUUID(),
        path: file.path,
        name: file.name,
        // duration: null 
    }));
    const resolvedNewItems = await Promise.all(newItemsPromises);
    stagedPlaylistItems.push(...resolvedNewItems);
    renderPlaylistInProperties();
    console.log(`Sidebars: Files added to staged playlist for cue ${activePropertiesCueId}.`);
    return true;
}

// Function to set single file path if properties sidebar is open for a single cue
function setFilePathInProperties(filePath) {
    if (!activePropertiesCueId) return false;
    const activeCue = cueStore.getCueById(activePropertiesCueId);
    if (!activeCue || (activeCue.type !== 'single_file' && activeCue.type !== 'single')) return false;

    if (propFilePathInput) {
        propFilePathInput.value = filePath;
        console.log(`Sidebars: File path updated in properties for cue ${activePropertiesCueId}.`);
        return true;
    }
    return false;
}

/**
 * Highlights the currently playing item in the playlist view of the properties sidebar.
 * @param {string} cueId The ID of the cue (playlist)
 * @param {string | null} activePlaylistItemId The ID of the playlist item to highlight, or null to clear all highlights for this cue.
 */
function highlightPlayingPlaylistItem(cueId, activePlaylistItemId) {
    // ---- START DEBUG LOG ----
    console.log(`Sidebars/highlightPlayingPlaylistItem: Received CueID: ${cueId}, ActiveItemID: ${activePlaylistItemId}, CurrentOpenPropertiesCueID: ${activePropertiesCueId}`);
    // ---- END DEBUG LOG ----

    if (!activePropertiesCueId || activePropertiesCueId !== cueId || !propPlaylistItemsUl) {
        // Properties sidebar not open for this cue, or playlist UL not found
        return;
    }

    const listItems = propPlaylistItemsUl.querySelectorAll('li[data-item-id]');
    listItems.forEach(li => {
        const itemIdFromDOM = li.dataset.itemId;
        // ---- START DEBUG LOG ----
        console.log(`Sidebars/highlightLoop: Checking item ${itemIdFromDOM}. ActiveItemID: ${activePlaylistItemId}. Match: ${activePlaylistItemId && itemIdFromDOM === activePlaylistItemId}`);
        // ---- END DEBUG LOG ----
        if (activePlaylistItemId && itemIdFromDOM === activePlaylistItemId) {
            li.classList.add('playing-in-sidebar');
        } else {
            li.classList.remove('playing-in-sidebar');
        }
    });
}

// New function to be called when cue data (specifically playlist items) might have changed
function refreshPlaylistPropertiesView(updatedCueId) {
    if (activePropertiesCueId && activePropertiesCueId === updatedCueId && propPlaylistItemsUl) {
        const cue = cueStore.getCueById(updatedCueId); // Get the latest cue data
        if (cue && cue.type === 'playlist') {
            console.log(`Sidebars: Refreshing playlist view for cue ${updatedCueId} due to potential update.`);
            // ---- START DEBUG LOG ----
            console.log('Sidebars/refreshPlaylistPropertiesView: Cue data received from cueStore:', JSON.parse(JSON.stringify(cue)));
            // ---- END DEBUG LOG ----
            stagedPlaylistItems = cue.playlistItems ? JSON.parse(JSON.stringify(cue.playlistItems)) : [];
            renderPlaylistInProperties();
        } else {
            console.warn(`Sidebars: Tried to refresh playlist view for ${updatedCueId}, but it's not the active playlist or data is missing.`);
        }
    }
}

export {
    initSidebars,
    toggleConfigSidebar,
    openPropertiesSidebar,
    hidePropertiesSidebar,
    getActivePropertiesCueId,
    addFilesToStagedPlaylist,
    setFilePathInProperties,
    highlightPlayingPlaylistItem,
    refreshPlaylistPropertiesView,
    // renderPlaylistInProperties, // Mostly internal, but export if needed
    // handleSaveCueProperties, // Called by event listener
    // handleDeleteCueProperties, // Called by event listener
    // Expose stagedPlaylistItems directly or via a getter if other modules need to inspect it without modifying
    // For now, keeping it internal. If dragDropHandler needs more complex interaction, can expose.
}; 