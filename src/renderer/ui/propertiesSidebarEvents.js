/**
 * Event Handling for Properties Sidebar
 * Manages event listeners and event handling logic
 */

import * as waveformControls from './waveformControls.js';
import { updateDuckingControlsVisibility } from './propertiesSidebarDOM.js';
import { 
    handleDragOverPlaylistItem, 
    handleDropPlaylistItem, 
    handleDragEndPlaylistItem,
    handleRemovePlaylistItem
} from './propertiesSidebarPlaylist.js';

let debouncedSaveCueProperties;
let activePropertiesCueId;
let cueStore;
let domElements;
let ipcRendererBindingsModule;

/**
 * Initialize event handlers
 * @param {Function} saveCallback - Debounced save function
 * @param {Function} setActiveCueId - Function to set active cue ID
 * @param {Object} csModule - Cue store module
 * @param {Object} elements - DOM elements object
 * @param {Object} ipcAPI - IPC renderer bindings module
 */
function initEventHandlers(saveCallback, setActiveCueId, csModule, elements, ipcAPI) {
    debouncedSaveCueProperties = saveCallback;
    activePropertiesCueId = setActiveCueId;
    cueStore = csModule;
    domElements = elements;
    ipcRendererBindingsModule = ipcAPI;
}

/**
 * Bind all event listeners for the properties sidebar
 * @param {Function} hidePropertiesSidebar - Function to hide sidebar
 * @param {Function} handleDeleteCueProperties - Function to handle cue deletion
 * @param {Function} renderPlaylistInProperties - Function to render playlist
 * @param {Function} setStagedPlaylistItems - Function to set staged playlist items
 */
function bindPropertiesSidebarEventListeners(hidePropertiesSidebar, handleDeleteCueProperties, renderPlaylistInProperties, setStagedPlaylistItems) {
    console.log('[PropertiesSidebarEventListeners] BINDING LISTENERS START');
    console.log('  propCueNameInput (at bind start):', domElements.propCueNameInput ? 'Exists' : 'NULL');
    console.log('  debouncedSaveCueProperties (at bind start):', typeof debouncedSaveCueProperties);

    if (domElements.closePropertiesSidebarBtn) {
        domElements.closePropertiesSidebarBtn.addEventListener('click', hidePropertiesSidebar);
    }
    if (domElements.saveCuePropertiesButton) {
        domElements.saveCuePropertiesButton.style.display = 'none';
    }
    if (domElements.deleteCuePropertiesButton) {
        domElements.deleteCuePropertiesButton.addEventListener('click', handleDeleteCueProperties);
    }

    // Cue type change handler
    if (domElements.propCueTypeSelect) {
        domElements.propCueTypeSelect.addEventListener('change', (e) => {
            handleCueTypeChange(e, renderPlaylistInProperties, setStagedPlaylistItems);
        });
    }

    // Volume range input handler
    if (domElements.propVolumeRangeInput && domElements.propVolumeValueSpan) {
        domElements.propVolumeRangeInput.addEventListener('input', (e) => {
            domElements.propVolumeValueSpan.textContent = parseFloat(e.target.value).toFixed(2);
        });
    }

    // Ducking level input handler
    if (domElements.propDuckingLevelInput && domElements.propDuckingLevelValueSpan) {
        domElements.propDuckingLevelInput.addEventListener('input', (e) => {
            domElements.propDuckingLevelValueSpan.textContent = e.target.value;
            console.log(`[PropertiesSidebarEventListeners] INPUT event on propDuckingLevelInput. Value: ${e.target.value}`);
            debouncedSaveCueProperties();
        });
    }

    // Auto-save inputs
    const inputsToAutoSave = [
        domElements.propCueNameInput, 
        domElements.propFilePathInput, 
        domElements.propFadeInTimeInput, 
        domElements.propFadeOutTimeInput,
        domElements.propVolumeRangeInput, 
        domElements.propRetriggerBehaviorSelect, 
        domElements.propPlaylistPlayModeSelect,
    ];
    inputsToAutoSave.forEach(input => {
        if (input) {
            input.addEventListener('input', () => {
                console.log(`[PropertiesSidebarEventListeners] INPUT event on: ${input.id || 'anonymous input'}. Value: ${input.value}`);
                debouncedSaveCueProperties();
            });
            if (input.tagName === 'SELECT') {
                input.addEventListener('change', () => {
                    console.log(`[PropertiesSidebarEventListeners] CHANGE event on SELECT: ${input.id || 'anonymous select'}. Value: ${input.value}`);
                    debouncedSaveCueProperties();
                });
            }
        }
    });

    // Auto-save checkboxes
    const checkboxesToAutoSave = [
        domElements.propLoopCheckbox, 
        domElements.propShufflePlaylistCheckbox, 
        domElements.propRepeatOnePlaylistItemCheckbox,
    ];
    checkboxesToAutoSave.forEach(checkbox => {
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                console.log(`[PropertiesSidebarEventListeners] CHANGE event on CHECKBOX: ${checkbox.id || 'anonymous checkbox'}. Checked: ${checkbox.checked}`);
                debouncedSaveCueProperties();
            });
        }
    });

    // Ducking trigger checkbox handler
    if (domElements.propIsDuckingTriggerCheckbox) {
        if (!domElements.propIsDuckingTriggerCheckbox.hasAttribute('data-ducking-listener-attached')) {
            domElements.propIsDuckingTriggerCheckbox.addEventListener('change', () => {
                updateDuckingControlsVisibility(domElements.propIsDuckingTriggerCheckbox.checked);
                debouncedSaveCueProperties();
            });
            domElements.propIsDuckingTriggerCheckbox.setAttribute('data-ducking-listener-attached', 'true');
        }
    }

    // Enable ducking checkbox handler
    if (domElements.propEnableDuckingCheckbox) {
        if (!domElements.propEnableDuckingCheckbox.hasAttribute('data-enable-ducking-listener-attached')) {
            domElements.propEnableDuckingCheckbox.addEventListener('change', debouncedSaveCueProperties);
            domElements.propEnableDuckingCheckbox.setAttribute('data-enable-ducking-listener-attached', 'true');
        }
    }

    // Bind playlist drag/drop listeners
    bindPlaylistDragAndRemoveListeners(renderPlaylistInProperties, setStagedPlaylistItems);
}

/**
 * Handle cue type change
 * @param {Event} e - Change event
 * @param {Function} renderPlaylistInProperties - Function to render playlist
 * @param {Function} setStagedPlaylistItems - Function to set staged playlist items
 */
async function handleCueTypeChange(e, renderPlaylistInProperties, setStagedPlaylistItems) {
    const isPlaylist = e.target.value === 'playlist';
    
    if(domElements.propPlaylistConfigDiv) {
        domElements.propPlaylistConfigDiv.style.display = isPlaylist ? 'block' : 'none';
    }
    if(domElements.propSingleFileConfigDiv) {
        domElements.propSingleFileConfigDiv.style.display = isPlaylist ? 'none' : 'block';
    }
    
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
        
        // Convert single file to playlist item if there's a filePath
        const cue = typeof activePropertiesCueId === 'function' ? null : (activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null);
        const currentFilePath = domElements.propFilePathInput ? domElements.propFilePathInput.value.trim() : null;
        
        // Get existing playlist items or initialize empty array
        const existingPlaylistItems = (cue && cue.playlistItems && Array.isArray(cue.playlistItems)) ? cue.playlistItems : [];
        
        // If converting from single_file to playlist and there's a filePath, convert it to a playlist item
        if (currentFilePath && existingPlaylistItems.length === 0) {
            try {
                const itemId = ipcRendererBindingsModule && typeof ipcRendererBindingsModule.generateUUID === 'function' 
                    ? await ipcRendererBindingsModule.generateUUID() 
                    : `item_${Date.now()}_${Math.random()}`;
                
                // Extract name from file path (filename without extension)
                const fileName = currentFilePath.split(/[\\\/]/).pop() || 'Playlist Item';
                const itemName = fileName.includes('.') ? fileName.split('.').slice(0, -1).join('.') : fileName;
                
                const newPlaylistItem = {
                    id: itemId,
                    path: currentFilePath,
                    name: itemName || 'Playlist Item'
                };
                
                setStagedPlaylistItems([newPlaylistItem]);
                renderPlaylistInProperties(domElements.propPlaylistItemsUl, domElements.propPlaylistFilePathDisplay);
                
                // Clear the filePath input since it's now a playlist item
                if (domElements.propFilePathInput) {
                    domElements.propFilePathInput.value = '';
                }
            } catch (error) {
                console.error('[PropertiesSidebar] Error converting filePath to playlist item:', error);
                // Fallback: still set empty array if conversion fails
                setStagedPlaylistItems([]);
                renderPlaylistInProperties(domElements.propPlaylistItemsUl, domElements.propPlaylistFilePathDisplay);
            }
        } else {
            // If no filePath or already has playlist items, just render existing items
            setStagedPlaylistItems(existingPlaylistItems);
            renderPlaylistInProperties(domElements.propPlaylistItemsUl, domElements.propPlaylistFilePathDisplay);
        }
    } else {
        const cue = typeof activePropertiesCueId === 'function' ? null : (activePropertiesCueId ? cueStore.getCueById(activePropertiesCueId) : null);
        const currentFilePath = domElements.propFilePathInput ? domElements.propFilePathInput.value : null;
        if (cue && cue.filePath) {
            waveformControls.showWaveformForCue(cue);
        } else if (currentFilePath) {
            waveformControls.showWaveformForCue({filePath: currentFilePath });
        } else {
            waveformControls.hideAndDestroyWaveform();
        }
        
        // Clear playlist items when converting back to single file
        setStagedPlaylistItems([]);
    }
}

/**
 * Bind playlist drag and remove listeners
 * @param {Function} renderPlaylistInProperties - Function to render playlist
 * @param {Function} setStagedPlaylistItems - Function to set staged playlist items
 */
function bindPlaylistDragAndRemoveListeners(renderPlaylistInProperties, setStagedPlaylistItems) {
    if (domElements.propPlaylistItemsUl) {
        domElements.propPlaylistItemsUl.addEventListener('dragover', (e) => {
            handleDragOverPlaylistItem(e, domElements.propPlaylistItemsUl);
        });
        domElements.propPlaylistItemsUl.addEventListener('drop', (e) => {
            handleDropPlaylistItem(e, domElements.propPlaylistItemsUl, domElements.propPlaylistFilePathDisplay);
        });
        domElements.propPlaylistItemsUl.addEventListener('dragend', () => {
            handleDragEndPlaylistItem(domElements.propPlaylistItemsUl);
        });
    }
}

/**
 * Update active properties cue ID
 * @param {string} cueId - New active cue ID
 */
function updateActivePropertiesCueId(cueId) {
    activePropertiesCueId = cueId;
}

export {
    initEventHandlers,
    bindPropertiesSidebarEventListeners,
    updateActivePropertiesCueId
};
