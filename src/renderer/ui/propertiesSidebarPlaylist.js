/**
 * Playlist Management for Properties Sidebar
 * Handles playlist rendering, drag/drop operations, and item management
 */

import { formatWaveformTime } from './waveformControls.js';
import { getDragAfterElement } from './propertiesSidebarUtils.js';

// --- State for Playlist Management ---
let stagedPlaylistItems = [];
let debouncedSaveCueProperties;
let ipcRendererBindingsModule;

// Debounce highlighting to prevent multiple rapid calls during re-renders
let highlightTimeout = null;
let lastHighlightCall = { cueId: null, playlistItemId: null };

/**
 * Initialize playlist management
 * @param {Function} saveCallback - Debounced save function
 * @param {Object} ipcAPI - IPC renderer bindings module
 */
function initPlaylistManager(saveCallback, ipcAPI) {
    debouncedSaveCueProperties = saveCallback;
    ipcRendererBindingsModule = ipcAPI;
}

/**
 * Set staged playlist items
 * @param {Array} items - Array of playlist items
 */
function setStagedPlaylistItems(items) {
    stagedPlaylistItems = items ? JSON.parse(JSON.stringify(items)) : [];
}

/**
 * Get staged playlist items
 * @returns {Array} Current staged playlist items
 */
function getStagedPlaylistItems() {
    return stagedPlaylistItems;
}

/**
 * Render playlist items in the properties sidebar
 * @param {HTMLElement} propPlaylistItemsUl - The UL element to render into
 * @param {HTMLElement} propPlaylistFilePathDisplay - Display element for playlist info
 */
function renderPlaylistInProperties(propPlaylistItemsUl, propPlaylistFilePathDisplay) {
    if (!propPlaylistItemsUl || !ipcRendererBindingsModule) {
        console.warn('[PropertiesSidebar] renderPlaylistInProperties: Missing required dependencies', {
            propPlaylistItemsUl: !!propPlaylistItemsUl,
            ipcRendererBindingsModule: !!ipcRendererBindingsModule
        });
        return;
    }
    
    // Remember which item was highlighted before re-rendering
    const currentlyHighlightedItem = propPlaylistItemsUl.querySelector('.playlist-item-playing');
    const highlightedItemId = currentlyHighlightedItem ? currentlyHighlightedItem.dataset.itemId : null;
    console.log(`[PropertiesSidebar] renderPlaylistInProperties: preserving highlight for itemId=${highlightedItemId}`);
    
    propPlaylistItemsUl.innerHTML = '';
    
    // Validate stagedPlaylistItems is an array
    if (!Array.isArray(stagedPlaylistItems)) {
        console.warn('[PropertiesSidebar] stagedPlaylistItems is not an array:', stagedPlaylistItems);
        stagedPlaylistItems = [];
    }
    
    stagedPlaylistItems.forEach((item, index) => {
        const li = document.createElement('li');
        li.classList.add('playlist-item');
        li.dataset.index = index;
        li.dataset.path = item.path || '';
        li.dataset.itemId = item.id || '';
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
        const formattedDuration = item.knownDuration && item.knownDuration > 0 ? formatWaveformTime(item.knownDuration) : '--:--';
        itemDurationSpan.textContent = ` (${formattedDuration})`;
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
    
    // Restore highlighting after re-rendering if there was a highlighted item
    if (highlightedItemId) {
        console.log(`[PropertiesSidebar] renderPlaylistInProperties: restoring highlight for itemId=${highlightedItemId}`);
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
            const itemToHighlight = propPlaylistItemsUl.querySelector(`li[data-item-id="${highlightedItemId}"]`);
            if (itemToHighlight) {
                itemToHighlight.classList.add('playlist-item-playing');
                console.log(`[PropertiesSidebar] renderPlaylistInProperties: successfully restored highlight`);
            } else {
                console.warn(`[PropertiesSidebar] renderPlaylistInProperties: could not find item to restore highlight`);
            }
        });
    }
    
    if (stagedPlaylistItems.length === 0 && propPlaylistFilePathDisplay) {
        propPlaylistFilePathDisplay.textContent = 'Playlist is empty. Drag files here or click Add Files.';
    } else if (propPlaylistFilePathDisplay) {
        propPlaylistFilePathDisplay.textContent = `Playlist contains ${stagedPlaylistItems.length} item(s).`;
    }
}

/**
 * Handle drag start for playlist items
 * @param {DragEvent} event - Drag start event
 */
function handleDragStartPlaylistItem(event) {
    const listItem = event.target.closest('li');
    if (!listItem) return;
    const itemId = listItem.dataset.itemId;
    if (!itemId) {
        event.preventDefault(); return;
    }
    event.dataTransfer.setData('application/json', JSON.stringify({ type: 'playlist-item-reorder', itemId: itemId }));
    event.dataTransfer.effectAllowed = 'move';
    listItem.classList.add('dragging-playlist-item');
}

/**
 * Handle drag over for playlist items
 * @param {DragEvent} event - Drag over event
 * @param {HTMLElement} propPlaylistItemsUl - The playlist UL element
 */
function handleDragOverPlaylistItem(event, propPlaylistItemsUl) {
    event.preventDefault();
    const isFileDrag = Array.from(event.dataTransfer.types).includes('Files');
    if (isFileDrag) {
        event.dataTransfer.dropEffect = 'copy';
    } else {
        event.dataTransfer.dropEffect = 'move';
        const draggable = document.querySelector('.dragging-playlist-item');
        if (draggable && propPlaylistItemsUl) {
            const afterElement = getDragAfterElement(propPlaylistItemsUl, event.clientY);
            if (afterElement == null) {
                propPlaylistItemsUl.appendChild(draggable);
            } else {
                propPlaylistItemsUl.insertBefore(draggable, afterElement);
            }
        }
    }
}

/**
 * Handle drop for playlist items
 * @param {DragEvent} event - Drop event
 * @param {HTMLElement} propPlaylistItemsUl - The playlist UL element
 * @param {HTMLElement} propPlaylistFilePathDisplay - Display element for playlist info
 */
async function handleDropPlaylistItem(event, propPlaylistItemsUl, propPlaylistFilePathDisplay) {
    event.stopPropagation(); event.preventDefault();
    const ul = event.target.closest('ul#propPlaylistItems');
    if (!ul) {
        const draggingElement = document.querySelector('.dragging-playlist-item');
        if (draggingElement) draggingElement.classList.remove('dragging-playlist-item');
        return;
    }
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
        const files = Array.from(event.dataTransfer.files);
        const audioFiles = files.filter(file => file.name.toLowerCase().match(/\.(mp3|wav|aac|m4a|ogg)$/));
        if (audioFiles.length > 0) {
            for (const file of audioFiles) {
                const newItemId = await ipcRendererBindingsModule.generateUUID();
                const itemName = file.name;
                const itemPath = file.path;
                let itemDuration = 0;
                try {
                    const durationResult = await ipcRendererBindingsModule.getMediaDuration(itemPath);
                    if (durationResult && typeof durationResult === 'number' && durationResult > 0) {
                        itemDuration = durationResult;
                    } else {
                        console.warn(`PropertiesSidebar: Invalid duration result for ${itemPath}:`, durationResult);
                    }
                } catch (error) { 
                    console.error(`PropertiesSidebar: Error getting duration for ${itemPath}:`, error);
                    // Duration will remain 0, which is handled gracefully in the UI
                }
                stagedPlaylistItems.push({
                    id: newItemId, name: itemName, path: itemPath, volume: 1, fadeInTime: 0, fadeOutTime: 0,
                    trimStartTime: 0, trimEndTime: 0, knownDuration: itemDuration
                });
            }
            renderPlaylistInProperties(propPlaylistItemsUl, propPlaylistFilePathDisplay);
            await debouncedSaveCueProperties();
        }
        const draggingElementGlobal = document.querySelector('.dragging-playlist-item');
        if (draggingElementGlobal) draggingElementGlobal.classList.remove('dragging-playlist-item');
        return;
    }
    let draggedItemData;
    try { draggedItemData = JSON.parse(event.dataTransfer.getData('application/json')); }
    catch (e) { 
        const stillDragging = document.querySelector('.dragging-playlist-item');
        if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
        return; 
    }
    if (!draggedItemData || draggedItemData.type !== 'playlist-item-reorder' || !draggedItemData.itemId) {
        const stillDragging = document.querySelector('.dragging-playlist-item');
        if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
        return;
    }
    const draggedItemId = draggedItemData.itemId;
    const draggedItem = stagedPlaylistItems.find(p_item => p_item.id === draggedItemId);
    const originalIndexOfDragged = stagedPlaylistItems.findIndex(p_item => p_item.id === draggedItemId);
    if (!draggedItem || originalIndexOfDragged === -1) {
        const stillDragging = document.querySelector('.dragging-playlist-item');
        if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
        return;
    }
    stagedPlaylistItems.splice(originalIndexOfDragged, 1);
    const afterElement = getDragAfterElement(ul, event.clientY);
    if (afterElement) {
        const insertBeforeItemId = afterElement.dataset.itemId;
        const insertBeforeIndex = stagedPlaylistItems.findIndex(p_item => p_item.id === insertBeforeItemId);
        if (insertBeforeIndex !== -1) stagedPlaylistItems.splice(insertBeforeIndex, 0, draggedItem);
        else stagedPlaylistItems.push(draggedItem);
    } else {
        stagedPlaylistItems.push(draggedItem);
    }
    renderPlaylistInProperties(propPlaylistItemsUl, propPlaylistFilePathDisplay);
    debouncedSaveCueProperties();
    const stillDragging = document.querySelector('.dragging-playlist-item');
    if (stillDragging) stillDragging.classList.remove('dragging-playlist-item');
}

/**
 * Handle drag end for playlist items
 * @param {HTMLElement} propPlaylistItemsUl - The playlist UL element
 */
function handleDragEndPlaylistItem(propPlaylistItemsUl) {
    const draggingElem = propPlaylistItemsUl ? propPlaylistItemsUl.querySelector('.dragging-playlist-item') : null;
    if(draggingElem) draggingElem.classList.remove('dragging-playlist-item');
    if(propPlaylistItemsUl) Array.from(propPlaylistItemsUl.children).forEach(childLi => childLi.classList.remove('drag-over-playlist-item'));
}

/**
 * Handle removal of playlist items
 * @param {Event} event - Click event on remove button
 * @param {HTMLElement} propPlaylistItemsUl - The playlist UL element
 * @param {HTMLElement} propPlaylistFilePathDisplay - Display element for playlist info
 */
function handleRemovePlaylistItem(event, propPlaylistItemsUl, propPlaylistFilePathDisplay) {
    const indexToRemove = parseInt(event.target.dataset.index, 10);
    if (!isNaN(indexToRemove) && indexToRemove >= 0 && indexToRemove < stagedPlaylistItems.length) {
        stagedPlaylistItems.splice(indexToRemove, 1);
        renderPlaylistInProperties(propPlaylistItemsUl, propPlaylistFilePathDisplay);
        debouncedSaveCueProperties();
    }
}

/**
 * Highlight playing playlist item in sidebar
 * @param {string} cueId - Cue ID
 * @param {string} playlistItemId - Playlist item ID
 * @param {string} activePropertiesCueId - Currently active properties cue ID
 * @param {HTMLElement} propPlaylistItemsUl - The playlist UL element
 */
function highlightPlayingPlaylistItemInSidebar(cueId, playlistItemId, activePropertiesCueId, propPlaylistItemsUl) {
    console.log(`[PropertiesSidebar] highlightPlayingPlaylistItemInSidebar called: cueId=${cueId}, playlistItemId=${playlistItemId}`);
    console.log(`[PropertiesSidebar] activePropertiesCueId=${activePropertiesCueId}, propPlaylistItemsUl exists=${!!propPlaylistItemsUl}`);
    
    if (!activePropertiesCueId || activePropertiesCueId !== cueId || !propPlaylistItemsUl) {
        console.log(`[PropertiesSidebar] Highlighting skipped - conditions not met`);
        return;
    }
    
    // Debounce rapid successive calls (common during re-renders)
    if (highlightTimeout) {
        clearTimeout(highlightTimeout);
    }
    
    // Store the call parameters for the debounced execution
    lastHighlightCall = { cueId, playlistItemId };
    
    highlightTimeout = setTimeout(() => {
        _performHighlighting(lastHighlightCall.cueId, lastHighlightCall.playlistItemId, activePropertiesCueId, propPlaylistItemsUl);
        highlightTimeout = null;
    }, 50); // 50ms debounce
}

/**
 * Perform the actual highlighting operation
 * @param {string} cueId - Cue ID
 * @param {string} playlistItemId - Playlist item ID
 * @param {string} activePropertiesCueId - Currently active properties cue ID
 * @param {HTMLElement} propPlaylistItemsUl - The playlist UL element
 */
function _performHighlighting(cueId, playlistItemId, activePropertiesCueId, propPlaylistItemsUl) {
    console.log(`[PropertiesSidebar] _performHighlighting executing: cueId=${cueId}, playlistItemId=${playlistItemId}`);
    
    if (!activePropertiesCueId || activePropertiesCueId !== cueId || !propPlaylistItemsUl) {
        console.log(`[PropertiesSidebar] _performHighlighting skipped - conditions changed`);
        return;
    }
    
    const items = propPlaylistItemsUl.querySelectorAll('li.playlist-item');
    console.log(`[PropertiesSidebar] Found ${items.length} playlist items to check`);
    
    let highlightedCount = 0;
    
    // First pass: remove all highlights
    items.forEach((itemLi, index) => {
        const wasHighlighted = itemLi.classList.contains('playlist-item-playing');
        itemLi.classList.remove('playlist-item-playing');
        
        if (wasHighlighted) {
            console.log(`[PropertiesSidebar] Removed highlight from item ${index}: id=${itemLi.dataset.itemId}`);
        }
    });
    
    // Force a reflow to ensure CSS changes are applied (Mac M1 fix)
    // eslint-disable-next-line no-unused-expressions
    propPlaylistItemsUl.offsetHeight;
    
    // Second pass: add highlight if needed
    if (playlistItemId !== null && playlistItemId !== undefined) {
        items.forEach((itemLi, index) => {
            const itemId = itemLi.dataset.itemId;
            
            if (itemId === playlistItemId) {
                // Mac M1 specific fix: Use multiple strategies to ensure highlighting works
                const applyHighlight = () => {
                    itemLi.classList.add('playlist-item-playing');
                    
                    // Force a repaint by briefly changing a property
                    const originalDisplay = itemLi.style.display;
                    itemLi.style.display = 'none';
                    itemLi.offsetHeight; // Force reflow
                    itemLi.style.display = originalDisplay;
                    
                    // Verify the class was applied
                    if (!itemLi.classList.contains('playlist-item-playing')) {
                        console.warn(`[PropertiesSidebar] Class not applied on first try for item ${index}, retrying...`);
                        setTimeout(() => {
                            itemLi.classList.add('playlist-item-playing');
                        }, 10);
                    }
                };
                
                // Use requestAnimationFrame to ensure DOM is ready
                requestAnimationFrame(() => {
                    applyHighlight();
                    // Double-check after a short delay for Mac M1
                    setTimeout(() => {
                        if (!itemLi.classList.contains('playlist-item-playing')) {
                            console.warn(`[PropertiesSidebar] Highlighting failed for item ${index}, forcing reapply...`);
                            applyHighlight();
                        }
                    }, 50);
                });
                
                highlightedCount++;
                console.log(`[PropertiesSidebar] Highlighted item ${index}: id=${itemId}`);
            }
        });
    }
    
    console.log(`[PropertiesSidebar] Highlighting complete: ${highlightedCount} items highlighted`);
}

export {
    initPlaylistManager,
    setStagedPlaylistItems,
    getStagedPlaylistItems,
    renderPlaylistInProperties,
    handleDragStartPlaylistItem,
    handleDragOverPlaylistItem,
    handleDropPlaylistItem,
    handleDragEndPlaylistItem,
    handleRemovePlaylistItem,
    highlightPlayingPlaylistItemInSidebar
};
