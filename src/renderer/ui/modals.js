let cueStore;
let ipcRendererBindingsModule;
let uiCore; // To get currentAppConfig
let waveformControlsModule; // For modal waveform functionality

// --- DOM Elements for Modals ---
// New/Edit Cue Config Modal
let cueConfigModal;
let closeCueConfigModalBtn;
let modalCueIdInput, modalCueNameInput, modalCueTypeSelect, modalSingleFileConfigDiv,
    modalFilePathInput, modalPlaylistConfigDiv, modalPlaylistItemsUl,
    modalPlaylistFilePathDisplay, modalFadeInTimeInput, modalFadeOutTimeInput,
    modalLoopCheckbox, modalTrimStartTimeInput, modalTrimEndTimeInput,
    modalVolumeRangeInput, modalVolumeValueSpan, modalSaveCueButton, modalWaveformDisplay;

// Multiple Files Drop Modal
let multipleFilesDropModal;
let closeMultipleFilesDropModalBtn;
let modalAddAsSeparateCuesBtn;
let modalAddAsPlaylistCueBtn;
let modalCancelMultipleFilesDropBtn;

// --- State for Modals ---
let droppedFilesList = null; // For the multiple files drop modal
let modalWaveformInstance = null; // For modal waveform instance

function initModals(cs, ipc, core, waveformControls) {
    cueStore = cs;
    ipcRendererBindingsModule = ipc;
    uiCore = core;
    waveformControlsModule = waveformControls;

    cacheModalDOMElements();
    bindModalEventListeners();
    console.log('Modals Module Initialized');
}

function cacheModalDOMElements() {
    // New/Edit Cue Config Modal
    cueConfigModal = document.getElementById('cueConfigModal');
    if (cueConfigModal) {
        closeCueConfigModalBtn = cueConfigModal.querySelector('.close-button');
        modalCueIdInput = document.getElementById('cueId'); // Assuming these IDs are inside cueConfigModal
        modalCueNameInput = document.getElementById('cueName');
        modalCueTypeSelect = document.getElementById('cueType');
        modalSingleFileConfigDiv = document.getElementById('singleFileConfig');
        modalFilePathInput = document.getElementById('filePath');
        modalPlaylistConfigDiv = document.getElementById('playlistConfig');
        modalPlaylistItemsUl = document.getElementById('playlistItems');
        modalPlaylistFilePathDisplay = document.getElementById('playlistFilePathDisplay');
        modalFadeInTimeInput = document.getElementById('fadeInTime');
        modalFadeOutTimeInput = document.getElementById('fadeOutTime');
        modalLoopCheckbox = document.getElementById('loop');
        modalTrimStartTimeInput = document.getElementById('trimStartTime');
        modalTrimEndTimeInput = document.getElementById('trimEndTime');
        modalVolumeRangeInput = document.getElementById('volume');
        modalVolumeValueSpan = document.getElementById('volumeValue');
        modalSaveCueButton = document.getElementById('saveCueButton');
        modalWaveformDisplay = document.getElementById('modalWaveformDisplay');
    }

    // Multiple Files Drop Modal
    multipleFilesDropModal = document.getElementById('multipleFilesDropModal');
    if (multipleFilesDropModal) {
        closeMultipleFilesDropModalBtn = multipleFilesDropModal.querySelector('.close-button');
        modalAddAsSeparateCuesBtn = document.getElementById('modalAddAsSeparateCues');
        modalAddAsPlaylistCueBtn = document.getElementById('modalAddAsPlaylistCue');
        modalCancelMultipleFilesDropBtn = document.getElementById('modalCancelMultipleFilesDrop');
    }
}

function bindModalEventListeners() {
    // New/Edit Cue Config Modal
    if (closeCueConfigModalBtn) closeCueConfigModalBtn.addEventListener('click', () => {
        // Note: Modal waveform display removed - modal is only for creating new cues
        if (cueConfigModal) cueConfigModal.style.display = 'none';
    });
    if (modalSaveCueButton) modalSaveCueButton.addEventListener('click', handleSaveNewCueFromModal);
    if (cueConfigModal) cueConfigModal.addEventListener('click', (event) => { // Close on outside click
        if (event.target === cueConfigModal) {
            // Note: Modal waveform display removed - modal is only for creating new cues
            cueConfigModal.style.display = 'none';
        }
    });
    if (modalCueTypeSelect) modalCueTypeSelect.addEventListener('change', (e) => {
        const isPlaylist = e.target.value === 'playlist';
        if(modalPlaylistConfigDiv) modalPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
        if(modalSingleFileConfigDiv) modalSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
        
        // Handle waveform display based on cue type
        if (modalWaveformDisplay) {
            modalWaveformDisplay.style.display = isPlaylist ? 'none' : 'block';
        }
        
        // Note: Modal waveform display removed - modal is only for creating new cues
        // Editing existing cues should use the properties sidebar which has proper waveform display
    });
    if(modalVolumeRangeInput && modalVolumeValueSpan) modalVolumeRangeInput.addEventListener('input', (e) => {
        modalVolumeValueSpan.textContent = parseFloat(e.target.value).toFixed(2);
    });
    
    // Note: Modal waveform display removed - modal is only for creating new cues
    // Editing existing cues should use the properties sidebar which has proper waveform display

    // Multiple Files Drop Modal
    if (closeMultipleFilesDropModalBtn) closeMultipleFilesDropModalBtn.addEventListener('click', hideMultipleFilesDropModal);
    if (modalAddAsSeparateCuesBtn) modalAddAsSeparateCuesBtn.addEventListener('click', handleAddFilesAsSeparateCues);
    if (modalAddAsPlaylistCueBtn) modalAddAsPlaylistCueBtn.addEventListener('click', handleAddFilesAsPlaylistCue);
    if (modalCancelMultipleFilesDropBtn) modalCancelMultipleFilesDropBtn.addEventListener('click', hideMultipleFilesDropModal);
    if (multipleFilesDropModal) multipleFilesDropModal.addEventListener('click', (event) => {
        if (event.target === multipleFilesDropModal) {
            hideMultipleFilesDropModal();
        }
    });
}

function openNewCueModal() {
    if (!cueConfigModal || !uiCore) return;
    const currentAppConfig = uiCore.getCurrentAppConfig();
    clearCueConfigModalFields(currentAppConfig); // Pass current app config for defaults
    
    // Note: Modal waveform display removed - modal is only for creating new cues
    // Editing existing cues should use the properties sidebar which has proper waveform display
    
    if(modalCueIdInput && ipcRendererBindingsModule && typeof ipcRendererBindingsModule.generateUUID === 'function') {
      ipcRendererBindingsModule.generateUUID().then(uuid => {
        if(modalCueIdInput) modalCueIdInput.value = uuid;
      }).catch(err => { 
          console.error('Modals: Error generating UUID via IPC for new cue:', err);
          if(modalCueIdInput) modalCueIdInput.value = 'cue_fb_' + Date.now() + Math.random().toString(36).substring(2, 9);
      });
    } else if (modalCueIdInput) {
        modalCueIdInput.value = 'cue_fb_' + Date.now() + Math.random().toString(36).substring(2, 9);
    }
    cueConfigModal.style.display = 'flex';
}

function clearCueConfigModalFields(appConfig) {
    if (!appConfig) {
        console.warn("Modals: AppConfig not available for clearing cue config modal fields with defaults.");
        // Fallback to some very basic defaults or just clear
        if(modalCueNameInput) modalCueNameInput.value = '';
        if(modalCueTypeSelect) modalCueTypeSelect.value = 'single';
        if(modalFilePathInput) modalFilePathInput.value = '';
        if(modalPlaylistConfigDiv) modalPlaylistConfigDiv.style.display = 'none';
        if(modalSingleFileConfigDiv) modalSingleFileConfigDiv.style.display = 'block';
        if(modalPlaylistItemsUl) modalPlaylistItemsUl.innerHTML = '';
        if(modalPlaylistFilePathDisplay) modalPlaylistFilePathDisplay.textContent = 'Drag files here or click to select';
        if(modalFadeInTimeInput) modalFadeInTimeInput.value = 0;
        if(modalFadeOutTimeInput) modalFadeOutTimeInput.value = 0;
        if(modalLoopCheckbox) modalLoopCheckbox.checked = false;
        if(modalTrimStartTimeInput) modalTrimStartTimeInput.value = '';
        if(modalTrimEndTimeInput) modalTrimEndTimeInput.value = '';
        if(modalVolumeRangeInput) modalVolumeRangeInput.value = 1;
        if(modalVolumeValueSpan) modalVolumeValueSpan.textContent = '1.00';
        return;
    }

    if(modalCueNameInput) modalCueNameInput.value = '';
    if(modalCueTypeSelect) modalCueTypeSelect.value = 'single';
    if(modalFilePathInput) modalFilePathInput.value = '';
    if(modalPlaylistConfigDiv) modalPlaylistConfigDiv.style.display = 'none'; 
    if(modalSingleFileConfigDiv) modalSingleFileConfigDiv.style.display = 'block'; 
    if(modalPlaylistItemsUl) modalPlaylistItemsUl.innerHTML = '';
    if(modalPlaylistFilePathDisplay) modalPlaylistFilePathDisplay.textContent = 'Drag files here or click to select';
    
    if(modalFadeInTimeInput) modalFadeInTimeInput.value = appConfig.defaultFadeInTime;
    if(modalFadeOutTimeInput) modalFadeOutTimeInput.value = appConfig.defaultFadeOutTime;
    if(modalLoopCheckbox) modalLoopCheckbox.checked = appConfig.defaultLoopSingleCue;
    
    if(modalTrimStartTimeInput) modalTrimStartTimeInput.value = '';
    if(modalTrimEndTimeInput) modalTrimEndTimeInput.value = '';
    if(modalVolumeRangeInput) modalVolumeRangeInput.value = 1;
    if(modalVolumeValueSpan && modalVolumeRangeInput) modalVolumeValueSpan.textContent = parseFloat(modalVolumeRangeInput.value).toFixed(2);
    
    // Hide modal waveform when clearing fields
    hideModalWaveform();
}

async function handleSaveNewCueFromModal() {
    if (!cueStore || !ipcRendererBindingsModule || !uiCore) {
        console.error("Modals: Core modules not available for saving cue.");
        return;
    }
    const currentAppConfig = uiCore.getCurrentAppConfig();

    let cueId = modalCueIdInput ? modalCueIdInput.value : null;
    if (!cueId) {
        try {
            cueId = await ipcRendererBindingsModule.generateUUID();
        } catch (err) {
            console.error('Modals: Error generating UUID for new cue save:', err);
            cueId = 'cue_fb_' + Date.now() + Math.random().toString(36).substring(2, 9); // Fallback
        }
    }

    const cueName = modalCueNameInput ? modalCueNameInput.value.trim() || 'Unnamed Cue' : 'Unnamed Cue';
    const cueType = modalCueTypeSelect ? modalCueTypeSelect.value : 'single'; 
    
    const newCueData = {
        id: cueId,
        name: cueName,
        type: cueType,
        filePath: (cueType === 'single' && modalFilePathInput) ? modalFilePathInput.value : null,
        playlistItems: [], 
        volume: modalVolumeRangeInput ? parseFloat(modalVolumeRangeInput.value) : 1,
        fadeInTime: modalFadeInTimeInput ? parseFloat(modalFadeInTimeInput.value) || 0 : currentAppConfig.defaultFadeInTime,
        fadeOutTime: modalFadeOutTimeInput ? parseFloat(modalFadeOutTimeInput.value) || 0 : currentAppConfig.defaultFadeOutTime,
        loop: modalLoopCheckbox ? modalLoopCheckbox.checked : currentAppConfig.defaultLoopSingleCue,
        trimStartTime: (modalTrimStartTimeInput && modalTrimStartTimeInput.value !== '') ? parseFloat(modalTrimStartTimeInput.value) : null,
        trimEndTime: (modalTrimEndTimeInput && modalTrimEndTimeInput.value !== '') ? parseFloat(modalTrimEndTimeInput.value) : null,
        shuffle: false, 
        repeatOne: false, 
        retriggerBehavior: currentAppConfig.defaultRetriggerBehavior 
    };

    if (cueType === 'playlist') {
        if(modalPlaylistItemsUl) {
            const itemPromises = Array.from(modalPlaylistItemsUl.children)
                .map(async li => ({ 
                    id: await ipcRendererBindingsModule.generateUUID(),
                    path: li.dataset.filePath, 
                    name: li.textContent 
                }));
            newCueData.playlistItems = (await Promise.all(itemPromises)).filter(item => item.path);
        }
        newCueData.filePath = null; 
    }

    try {
        await cueStore.addOrUpdateCue(newCueData);
        if (cueConfigModal) cueConfigModal.style.display = 'none';
    } catch (error) {
        console.error('Modals: Error saving new cue from modal:', error);
        alert(`Error saving cue: ${error.message}`);
    }
}


function showMultipleFilesDropModal(files) {
    if (!multipleFilesDropModal) {
        console.error("Modals: multipleFilesDropModal element not found.");
        return;
    }
    droppedFilesList = files; // Store the FileList object
    multipleFilesDropModal.style.display = 'flex';
}

function hideMultipleFilesDropModal() {
    if (!multipleFilesDropModal) return;
    multipleFilesDropModal.style.display = 'none';
    droppedFilesList = null; // Clear the stored files
}

async function handleAddFilesAsSeparateCues() {
    if (!droppedFilesList || droppedFilesList.length === 0 || !cueStore || !ipcRendererBindingsModule || !uiCore) return;
    const currentAppConfig = uiCore.getCurrentAppConfig();
    console.log('Modals: Adding dropped files as separate cues.');
    try {
        for (const file of droppedFilesList) { // droppedFilesList is a FileList
            const cueId = await ipcRendererBindingsModule.generateUUID();
            const fileName = file.name;
            const cueName = fileName.split('.').slice(0, -1).join('.') || 'New Cue';

            const newCueData = {
                id: cueId,
                name: cueName,
                type: 'single_file',
                filePath: file.path, // Electron File objects have a 'path' property
                volume: 1,
                fadeInTime: currentAppConfig.defaultFadeInTime,
                fadeOutTime: currentAppConfig.defaultFadeOutTime,
                loop: currentAppConfig.defaultLoopSingleCue,
                retriggerBehavior: currentAppConfig.defaultRetriggerBehavior,
                trimStartTime: null,
                trimEndTime: null
            };
            await cueStore.addOrUpdateCue(newCueData);
        }
    } catch (error) {
        console.error('Modals: Error creating separate cues from drop:', error);
        alert('Error creating cues: ' + error.message);
    }
    hideMultipleFilesDropModal();
}

async function handleAddFilesAsPlaylistCue() {
    if (!droppedFilesList || droppedFilesList.length === 0 || !cueStore || !ipcRendererBindingsModule || !uiCore) return;
    const currentAppConfig = uiCore.getCurrentAppConfig();
    console.log('Modals: Adding dropped files as a new playlist cue.');
    try {
        const playlistCueId = await ipcRendererBindingsModule.generateUUID();
        const defaultPlaylistName = 'New Playlist Cue'; 

        const playlistItemsPromises = Array.from(droppedFilesList).map(async (file) => {
            const itemId = await ipcRendererBindingsModule.generateUUID();
            return {
                id: itemId,
                path: file.path,
                name: file.name.split('.').slice(0, -1).join('.') || 'Playlist Item',
            };
        });
        const playlistItems = await Promise.all(playlistItemsPromises);

        const newCueData = {
            id: playlistCueId,
            name: defaultPlaylistName,
            type: 'playlist',
            playlistItems: playlistItems,
            volume: 1,
            fadeInTime: currentAppConfig.defaultFadeInTime,
            fadeOutTime: currentAppConfig.defaultFadeOutTime,
            loop: false,
            shuffle: false,
            repeatOne: false,
            retriggerBehavior: currentAppConfig.defaultRetriggerBehavior
        };

        await cueStore.addOrUpdateCue(newCueData);
        hideMultipleFilesDropModal();
    } catch (error) {
        console.error('Modals: Error adding files as playlist cue:', error);
        alert(`Error creating playlist cue: ${error.message}`);
    }
}

// Function to handle file drops on the new cue modal (if it's open)
// This is called by dragDropHandler.js when the target is identified as the new cue modal.
// This is currently NOT used as ui.js's assignFilesToRelevantTarget has the direct logic.
// If assignFilesToRelevantTarget is removed, this could be used by dragDropHandler.
function handleFileDropInNewCueModal(filePaths) {
    if (!cueConfigModal || cueConfigModal.style.display !== 'flex') return false;
    console.log("Modals: handleFileDropInNewCueModal called with paths:", filePaths);

    if (modalCueTypeSelect && modalCueTypeSelect.value === 'single') {
        if (filePaths.length === 1 && modalFilePathInput) {
             modalFilePathInput.value = filePaths[0];
             // Note: Modal waveform display removed - modal is only for creating new cues
             return true;
        }
    } else if (modalCueTypeSelect && modalCueTypeSelect.value === 'playlist') {
        if(modalPlaylistItemsUl) {
            filePaths.forEach(fp => {
                const li = document.createElement('li');
                li.textContent = fp.split(/[\\\/]/).pop();
                li.dataset.filePath = fp; 
                modalPlaylistItemsUl.appendChild(li);
            });
        }
        if (modalPlaylistFilePathDisplay) modalPlaylistFilePathDisplay.textContent = `Playlist: ${filePaths.length} file(s) added.`;
        return true;
    }
    return false;
}

/**
 * Handle file path input changes in modal
 */
function handleModalFilePathChange(e) {
    // Note: Modal waveform display removed - modal is only for creating new cues
    // Editing existing cues should use the properties sidebar which has proper waveform display
}

/**
 * Show waveform in modal for a given file path
 * Note: Modal waveform display removed - modal is only for creating new cues
 */
function showModalWaveform(filePath) {
    // Note: Modal waveform display removed - modal is only for creating new cues
    // Editing existing cues should use the properties sidebar which has proper waveform display
}

/**
 * Hide and destroy modal waveform
 */
function hideModalWaveform() {
    // Note: Modal waveform display removed - modal is only for creating new cues
    // Editing existing cues should use the properties sidebar which has proper waveform display
}

export {
    initModals,
    openNewCueModal,
    // clearCueConfigModalFields, // Primarily internal, called by openNewCueModal
    // handleSaveNewCueFromModal, // Primarily internal, called by event listener
    showMultipleFilesDropModal,
    hideMultipleFilesDropModal,
    // handleAddFilesAsSeparateCues, // Primarily internal
    // handleAddFilesAsPlaylistCue, // Primarily internal
    handleFileDropInNewCueModal // If dragDropHandler needs to call this directly
}; 