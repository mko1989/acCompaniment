import { formatTime } from './utils.js';

let isInitialized = false;
let cueStore, audioController, dragDrop, uiCore; // Scoped module refs
let cueButtonMap = {}; // To store references to cue button DOM elements
let dragOverCueId = null;
let cueGridContainer;

export function initCueGrid(cs, ac, dd, ui) {
    console.log('CueGrid: Initializing...');
    cueStore = cs;
    audioController = ac;
    dragDrop = dd;
    uiCore = ui;
    cacheDOMElements();
    bindEventListeners();
    isInitialized = true; // Set initialization flag
    console.log('CueGrid: Initialized successfully.');
    // Do not call renderCues() here; let ui.loadAndRenderCues in renderer.js handle the first render.
}

function cacheDOMElements() {
    cueGridContainer = document.getElementById('cueGridContainer'); 
}

// Track navigation button clicks to prevent rapid clicking
const navigationClickBlocked = new Set();

function bindEventListeners() {
    // Add global event listener for playlist navigation buttons
    if (cueGridContainer) {
        cueGridContainer.addEventListener('click', (event) => {
            if (event.target.classList.contains('playlist-nav-btn')) {
                event.stopPropagation(); // Prevent triggering the cue button click
                event.preventDefault(); // Prevent any default behavior
                
                const cueId = event.target.getAttribute('data-cue-id');
                const buttonType = event.target.classList.contains('playlist-prev-btn') ? 'prev' : 'next';
                const navigationKey = `${cueId}-${buttonType}`;
                
                // Block rapid clicking at the UI level
                if (navigationClickBlocked.has(navigationKey)) {
                    console.log(`🚫 CueGrid: Navigation click blocked for ${cueId} (${buttonType}) - too rapid`);
                    return;
                }
                
                // Block this navigation for 200ms at UI level
                navigationClickBlocked.add(navigationKey);
                console.log(`🔒 CueGrid: UI-level block added for ${navigationKey}`);
                setTimeout(() => {
                    navigationClickBlocked.delete(navigationKey);
                    console.log(`🔓 CueGrid: UI-level block removed for ${navigationKey}`);
                }, 200);
                
                if (event.target.classList.contains('playlist-prev-btn')) {
                    console.log(`CueGrid: Previous playlist item for cue ${cueId}`);
                    audioController.default.playlistNavigatePrevious(cueId);
                } else if (event.target.classList.contains('playlist-next-btn')) {
                    console.log(`CueGrid: Next playlist item for cue ${cueId}`);
                    audioController.default.playlistNavigateNext(cueId);
                }
            }
        });
    }
}

function renderCues() {
    if (!isInitialized) {
        console.warn('renderCues (cueGrid.js) called before initCueGrid has completed. Aborting render.');
        return;
    }
    if (!cueGridContainer || !cueStore || !audioController || !uiCore) {
        console.warn("renderCues (cueGrid.js) called before essential modules are initialized.");
        return;
    }
    cueGridContainer.innerHTML = ''; 
    const cues = cueStore.getAllCues();

    // Check if there are no cues and show empty state message
    if (!cues || cues.length === 0) {
        const emptyStateMessage = document.createElement('div');
        emptyStateMessage.className = 'empty-state-message';
        emptyStateMessage.innerHTML = `
            <div class="empty-state-content">
                <h3>No cues yet</h3>
                <p>Drag and drop audio files here to create cues</p>
            </div>
        `;
        cueGridContainer.appendChild(emptyStateMessage);
        
        // Still initialize drag drop for the empty container
        if (dragDrop && typeof dragDrop.initializeCueButtonDragDrop === 'function') {
            dragDrop.initializeCueButtonDragDrop(cueGridContainer);
        }
        return;
    }

    cues.forEach(cue => {
        // Create a wrapper for the cue button and navigation controls
        const cueWrapper = document.createElement('div');
        cueWrapper.className = 'cue-wrapper';
        cueWrapper.style.position = 'relative';
        cueWrapper.style.display = 'inline-block';
        
        const button = document.createElement('div');
        button.className = 'cue-button';
        button.id = `cue-btn-${cue.id}`;
        button.dataset.cueId = cue.id;
        button.dataset.cueType = cue.type || 'single';

        const statusIndicator = document.createElement('div');
        statusIndicator.className = 'cue-status-indicator';
        statusIndicator.id = `cue-status-${cue.id}`;
        button.appendChild(statusIndicator);


        const nameContainer = document.createElement('div');
        nameContainer.className = 'cue-button-name-container';
        button.appendChild(nameContainer);

        const timeContainer = document.createElement('div');
        timeContainer.className = 'cue-time-display-container';

        const timeCurrentElem = document.createElement('span');
        timeCurrentElem.className = 'cue-time-current';
        timeCurrentElem.id = `cue-time-current-${cue.id}`;
        // timeCurrentElem.textContent = ''; // Set by updateCueButtonTime

        const timeSeparator = document.createElement('span');
        timeSeparator.className = 'cue-time-separator';
        timeSeparator.id = `cue-time-separator-${cue.id}`;
        // timeSeparator.textContent = ''; // Set by updateCueButtonTime

        const timeTotalElem = document.createElement('span');
        timeTotalElem.className = 'cue-time-total';
        timeTotalElem.id = `cue-time-total-${cue.id}`;
        // timeTotalElem.textContent = ''; // Set by updateCueButtonTime

        const timeRemainingElem = document.createElement('span');
        timeRemainingElem.className = 'cue-time-remaining';
        timeRemainingElem.id = `cue-time-remaining-${cue.id}`;
        // timeRemainingElem.textContent = ''; // Set by updateCueButtonTime

        timeContainer.appendChild(timeCurrentElem);
        timeContainer.appendChild(timeSeparator);
        timeContainer.appendChild(timeTotalElem);
        timeContainer.appendChild(timeRemainingElem);
        button.appendChild(timeContainer);

        // Add the button to the wrapper first
        cueWrapper.appendChild(button);
        
        // Add playlist navigation controls OUTSIDE the button for playlist cues
        if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 1) {
            const playlistNavContainer = document.createElement('div');
            playlistNavContainer.className = 'playlist-nav-container';
            
            const prevButton = document.createElement('button');
            prevButton.className = 'playlist-nav-btn playlist-prev-btn';
            prevButton.innerHTML = '◀';
            prevButton.title = 'Previous item';
            prevButton.setAttribute('data-cue-id', cue.id);
            
            const nextButton = document.createElement('button');
            nextButton.className = 'playlist-nav-btn playlist-next-btn';
            nextButton.innerHTML = '▶';
            nextButton.title = 'Next item';
            nextButton.setAttribute('data-cue-id', cue.id);
            
            playlistNavContainer.appendChild(prevButton);
            playlistNavContainer.appendChild(nextButton);
            
            // Add navigation controls to the wrapper, NOT the button
            cueWrapper.appendChild(playlistNavContainer);
        }
        
        // Append the wrapper to the DOM (contains both button and navigation)
        cueGridContainer.appendChild(cueWrapper);

        const elementsForTimeUpdate = {
            current: timeCurrentElem,
            separator: timeSeparator,
            total: timeTotalElem,
            remaining: timeRemainingElem
        };

        const isCurrentlyPlaying = audioController.default.isPlaying(cue.id);
        const isCurrentlyCued = audioController.default.isCued(cue.id);
        // Pass the created elements directly for initial setup
        updateButtonPlayingState(cue.id, isCurrentlyPlaying, null, isCurrentlyCued, elementsForTimeUpdate);

        button.addEventListener('click', (event) => handleCueButtonClick(event, cue));

        // Add drag and drop for reordering in edit mode
        if (uiCore && uiCore.isEditMode && uiCore.isEditMode()) {
            button.draggable = true;
            button.classList.add('draggable-cue');
            
            button.addEventListener('dragstart', (e) => {
                if (!uiCore.isEditMode()) return;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', cue.id);
                const wrapper = button.closest('.cue-wrapper');
                if (wrapper) {
                    wrapper.classList.add('dragging-cue');
                }
                button.classList.add('dragging');
                cueGridContainer.classList.add('drag-active');
            });

            button.addEventListener('dragend', (e) => {
                const wrapper = button.closest('.cue-wrapper');
                if (wrapper) {
                    wrapper.classList.remove('dragging-cue');
                }
                button.classList.remove('dragging');
                cueGridContainer.classList.remove('drag-active');
                // Remove all drag indicators
                document.querySelectorAll('.drag-insert-before, .drag-insert-after').forEach(el => {
                    el.classList.remove('drag-insert-before', 'drag-insert-after');
                });
            });

            // Handle dragover on the wrapper to show insertion point
            const wrapper = button.closest('.cue-wrapper');
            if (wrapper) {
                wrapper.addEventListener('dragover', (e) => {
                    if (!uiCore.isEditMode()) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    
                    // Check if there's a cue being dragged (look for dragging-cue class)
                    const draggedWrapper = document.querySelector('.cue-wrapper.dragging-cue');
                    if (!draggedWrapper || draggedWrapper === wrapper) return;
                    
                    // Clear previous indicators
                    document.querySelectorAll('.drag-insert-before, .drag-insert-after').forEach(el => {
                        el.classList.remove('drag-insert-before', 'drag-insert-after');
                    });
                    
                    // Determine if we should insert before or after this element
                    // For horizontal grid layout, use x coordinate instead of y
                    const rect = wrapper.getBoundingClientRect();
                    const x = e.clientX;
                    const midpoint = rect.left + rect.width / 2;
                    
                    if (x < midpoint) {
                        // Insert before this element (to the left)
                        wrapper.classList.add('drag-insert-before');
                    } else {
                        // Insert after this element (to the right)
                        wrapper.classList.add('drag-insert-after');
                    }
                });

                wrapper.addEventListener('dragleave', (e) => {
                    // Only remove if we're actually leaving the wrapper (not just entering a child)
                    const rect = wrapper.getBoundingClientRect();
                    const x = e.clientX;
                    const y = e.clientY;
                    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                        wrapper.classList.remove('drag-insert-before', 'drag-insert-after');
                    }
                });

                wrapper.addEventListener('drop', async (e) => {
                    if (!uiCore.isEditMode()) return;
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const draggedCueId = e.dataTransfer.getData('text/plain');
                    const draggedButton = document.querySelector(`[data-cue-id="${draggedCueId}"]`);
                    if (!draggedButton || draggedButton === button) {
                        wrapper.classList.remove('drag-insert-before', 'drag-insert-after');
                        return;
                    }
                    
                    const draggedWrapper = draggedButton.closest('.cue-wrapper');
                    if (!draggedWrapper || draggedWrapper === wrapper) {
                        wrapper.classList.remove('drag-insert-before', 'drag-insert-after');
                        return;
                    }
                    
                    // Determine insertion position based on which class is active
                    let insertBefore = false;
                    if (wrapper.classList.contains('drag-insert-before')) {
                        insertBefore = true;
                    } else if (wrapper.classList.contains('drag-insert-after')) {
                        insertBefore = false;
                    } else {
                        // Fallback: use midpoint with x coordinate for horizontal grid
                        const rect = wrapper.getBoundingClientRect();
                        const x = e.clientX;
                        const midpoint = rect.left + rect.width / 2;
                        insertBefore = x < midpoint;
                    }
                    
                    // Remove dragged element from its current position first
                    draggedWrapper.remove();
                    
                    // Insert at the correct position
                    if (insertBefore) {
                        cueGridContainer.insertBefore(draggedWrapper, wrapper);
                    } else {
                        // Insert after - need to get next sibling
                        const nextSibling = wrapper.nextSibling;
                        if (nextSibling) {
                            cueGridContainer.insertBefore(draggedWrapper, nextSibling);
                        } else {
                            cueGridContainer.appendChild(draggedWrapper);
                        }
                    }
                    
                    // Clear visual indicators
                    wrapper.classList.remove('drag-insert-before', 'drag-insert-after');
                    
                    // Get all cues in current DOM order and save
                    const allCueWrappers = Array.from(cueGridContainer.querySelectorAll('.cue-wrapper'));
                    const newOrder = allCueWrappers.map(w => {
                        const btn = w.querySelector('.cue-button');
                        return btn ? btn.dataset.cueId : null;
                    }).filter(id => id !== null);
                    
                    // Reorder cues in cueStore
                    if (cueStore && typeof cueStore.reorderCues === 'function') {
                        await cueStore.reorderCues(newOrder);
                    } else if (cueStore && typeof cueStore.saveReorderedCues === 'function') {
                        // Fallback: manually reorder and save
                        const allCues = cueStore.getAllCues();
                        const reorderedCues = newOrder.map(cueId => 
                            allCues.find(c => c.id === cueId)
                        ).filter(c => c !== undefined);
                        
                        await cueStore.saveReorderedCues(reorderedCues);
                    }
                });
            }
        }
    });

    // Add drag and drop handlers to the container itself for handling drops at the very beginning
    if (uiCore && uiCore.isEditMode && uiCore.isEditMode()) {
        cueGridContainer.addEventListener('dragover', (e) => {
            if (!uiCore.isEditMode()) return;
            
            // Only handle if dragging over empty space (not a cue wrapper)
            if (e.target === cueGridContainer || e.target.classList.contains('empty-state-message') || e.target.closest('.empty-state-message')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                // Check if there's a cue being dragged
                const draggedWrapper = document.querySelector('.cue-wrapper.dragging-cue');
                if (!draggedWrapper) return;
                
                // Clear any existing indicators
                document.querySelectorAll('.drag-insert-before, .drag-insert-after').forEach(el => {
                    el.classList.remove('drag-insert-before', 'drag-insert-after');
                });
                
                // Find the first cue wrapper to insert before
                const firstWrapper = cueGridContainer.querySelector('.cue-wrapper:not(.dragging-cue)');
                if (firstWrapper) {
                    firstWrapper.classList.add('drag-insert-before');
                }
            }
        });

        cueGridContainer.addEventListener('drop', async (e) => {
            if (!uiCore.isEditMode()) return;
            
            // Only handle if dropping on empty space
            if (e.target !== cueGridContainer && !e.target.classList.contains('empty-state-message')) {
                return; // Let the wrapper handle it
            }
            
            e.preventDefault();
            e.stopPropagation();
            
            const draggedCueId = e.dataTransfer.getData('text/plain');
            if (!draggedCueId) return;
            
            const draggedButton = document.querySelector(`[data-cue-id="${draggedCueId}"]`);
            if (!draggedButton) return;
            
            const draggedWrapper = draggedButton.closest('.cue-wrapper');
            if (!draggedWrapper) return;
            
            // Get the first wrapper to insert before
            const firstWrapper = cueGridContainer.querySelector('.cue-wrapper:not(.dragging-cue)');
            
            // Remove dragged element from current position
            draggedWrapper.remove();
            
            // Insert at the beginning
            if (firstWrapper) {
                cueGridContainer.insertBefore(draggedWrapper, firstWrapper);
            } else {
                cueGridContainer.appendChild(draggedWrapper);
            }
            
            // Clear visual indicators
            document.querySelectorAll('.drag-insert-before, .drag-insert-after').forEach(el => {
                el.classList.remove('drag-insert-before', 'drag-insert-after');
            });
            
            // Get all cues in current DOM order and save
            const allCueWrappers = Array.from(cueGridContainer.querySelectorAll('.cue-wrapper'));
            const newOrder = allCueWrappers.map(w => {
                const btn = w.querySelector('.cue-button');
                return btn ? btn.dataset.cueId : null;
            }).filter(id => id !== null);
            
            // Reorder cues in cueStore
            if (cueStore && typeof cueStore.reorderCues === 'function') {
                await cueStore.reorderCues(newOrder);
            } else if (cueStore && typeof cueStore.saveReorderedCues === 'function') {
                const allCues = cueStore.getAllCues();
                const reorderedCues = newOrder.map(cueId => 
                    allCues.find(c => c.id === cueId)
                ).filter(c => c !== undefined);
                
                await cueStore.saveReorderedCues(reorderedCues);
            }
        });
    }

    if (dragDrop && typeof dragDrop.initializeCueButtonDragDrop === 'function') {
        dragDrop.initializeCueButtonDragDrop(cueGridContainer);
    }
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.cue-wrapper:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function handleCueButtonClick(event, cue) {
    if (!cue) {
        console.error(`UI: Cue not found.`);
        return;
    }
    if (!uiCore || !audioController) {
        console.error("cueGrid.handleCueButtonClick: uiCore or audioController not initialized.");
        return;
    }

    // If the effective mode (which considers the shift key via uiCore.isEditMode()) is 'edit',
    // then open properties. Otherwise, toggle the cue.
    if (uiCore.isEditMode()) { 
        console.log(`UI: Edit mode click on cue ${cue.id}. Opening properties.`);
        uiCore.openPropertiesSidebar(cue);
    } else { 
        const retriggerBehavior = cue.retriggerBehavior || uiCore.getCurrentAppConfig().defaultRetriggerBehavior || 'restart';
        console.log(`UI: Show mode action for cue ${cue.id}. Using retrigger behavior: ${retriggerBehavior}`);
        audioController.default.toggle(cue.id, false, retriggerBehavior);
    }
}

function updateButtonPlayingState(cueId, isPlaying, statusTextArg = null, isCuedOverride = false, elements = null) {
    // console.log(`[CueGrid UpdateButtonPlayingState ENTRY] cueId: ${cueId}, isPlaying(arg): ${isPlaying}, isCuedOverride: ${isCuedOverride}, elements received:`, elements ? typeof elements : 'null', elements);
    const button = document.getElementById(`cue-btn-${cueId}`);
    if (!button || !cueStore || !audioController) return;
    const cue = cueStore.getCueById(cueId);
    if (!cue) return;

    const statusIndicator = button.querySelector('.cue-status-indicator');
    const nameContainer = button.querySelector('.cue-button-name-container');
    let nameHTML = ''; // Start with empty and build up
    const mainCueNameSpan = `<span class="cue-button-main-name">${cue.name || 'Cue'}</span>`;
    nameHTML += mainCueNameSpan;

    let statusIconSrc = '../../assets/icons/stop.png';
    let statusIconAlt = 'Stopped';

    // Ensure a text indicator element exists or create it
    let cuedTextIndicator = button.querySelector('.cue-cued-text-indicator');
    if (!cuedTextIndicator) {
        cuedTextIndicator = document.createElement('div');
        cuedTextIndicator.className = 'cue-cued-text-indicator';
        button.insertBefore(cuedTextIndicator, button.firstChild); // Add to top-left
    }

    button.classList.remove('playing', 'paused', 'cued');
    statusIndicator.style.display = 'block'; // Default to visible
    cuedTextIndicator.style.display = 'none'; // Default to hidden

    // Handle crossfade status text (if provided)
    // Only treat as crossfade text if it contains fade-related keywords
    const isCrossfadeText = statusTextArg && (statusTextArg.includes('Fade Out') || statusTextArg.includes('Fade In') || statusTextArg.includes('Crossfade'));
    
    if (isCrossfadeText) {
        console.log(`🎵 [CueGrid] Displaying crossfade text: "${statusTextArg}" for cue ${cueId}`);
        
        // Apply crossfade styling directly to the button
        button.classList.add('crossfade-active');
        
        // Change button background for crossfade with !important to override hover
        if (statusTextArg.includes('Fade Out')) {
            button.style.setProperty('background-color', 'rgba(255, 69, 0, 0.8)', 'important'); // Red-orange for fade out
            button.classList.add('crossfade-fade-out');
        } else if (statusTextArg.includes('Fade In')) {
            button.style.setProperty('background-color', 'rgba(255, 165, 0, 0.8)', 'important'); // Orange for fade in
            button.classList.add('crossfade-fade-in');
        }
        
        // Update the name container to show crossfade text prominently
        if (nameContainer) {
            const originalName = cue.name || 'Cue';
            nameHTML = `<span class="cue-button-main-name">${originalName}</span><br><span class="crossfade-timer" style="font-size: 16px; font-weight: bold; color: white;">${statusTextArg}</span>`;
        }
        
        // Hide status indicator during crossfade to make timer more prominent
        statusIndicator.style.display = 'none';
        
        // Apply the updated HTML and continue normal processing for visual states
        if (nameContainer) nameContainer.innerHTML = nameHTML;
        
        // Set button to playing state during crossfade
        button.classList.add('playing');
        
        return; // Don't process normal state logic when showing crossfade
    } else {
        // Clear crossfade styling when no crossfade text
        button.classList.remove('crossfade-active', 'crossfade-fade-out', 'crossfade-fade-in');
        button.style.removeProperty('background-color'); // Reset to default
    }

    // Get comprehensive state from audioController
    const playbackState = audioController.default.getPlaybackTimes(cue.id);
    // console.log(`[CueGrid updateButtonPlayingState for ${cue.id}] Playback state from AC:`, playbackState ? JSON.parse(JSON.stringify(playbackState)) : null);

    if (playbackState) {
        const actualIsPlaying = playbackState.isPlaying;
        const actualIsPaused = playbackState.isPaused;
        // isCued can be from playbackState.isCued (which includes isCuedNext) or the override
        const actualIsCued = isCuedOverride || playbackState.isCued;
        const currentItemName = playbackState.currentPlaylistItemName;
        const nextItemName = playbackState.nextPlaylistItemName;
        
        // console.log(`[CueGrid updateButtonPlayingState for ${cueId}] State analysis: actualIsPlaying=${actualIsPlaying}, actualIsPaused=${actualIsPaused}, actualIsCued=${actualIsCued}, isCuedOverride=${isCuedOverride}, playbackState.isCued=${playbackState.isCued}`);
        
        let playlistInfoHTML = ''; // Initialize playlistInfoHTML here

        if (actualIsPlaying) {
            button.classList.add('playing');
            statusIconSrc = '../../assets/icons/play.png';
            statusIconAlt = 'Playing';
            if (nameContainer && cue.type === 'playlist') {
                if (currentItemName) {
                    playlistInfoHTML += `<span class="playlist-now-playing">(Now: ${currentItemName})</span>`;
                }
                if (nextItemName) {
                    if (playlistInfoHTML) playlistInfoHTML += '<br>';
                    playlistInfoHTML += `<span class="playlist-next-item-playing">(Next: ${nextItemName})</span>`;
                }
                if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
            }
        } else if (actualIsCued && !actualIsPlaying) {
            // Prioritize cued state over paused state - this handles playlist items that have ended and are cued for next
            button.classList.add('cued');
            statusIconSrc = '../../assets/icons/pause.png'; // Show pause icon for cued state
            statusIconAlt = 'Cued';
            if (nameContainer && cue.type === 'playlist') {
                if (nextItemName) {
                    playlistInfoHTML += `<span class="next-playlist-item">(Next: ${nextItemName})</span>`;
                } else if (currentItemName) {
                    playlistInfoHTML += `<span class="next-playlist-item">(Cued: ${currentItemName})</span>`;
                }
                if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
            }
        } else if (actualIsPaused) {
            // Normal paused state (not cued)
            button.classList.add('paused');
            statusIconSrc = '../../assets/icons/pause.png';
            statusIconAlt = 'Paused';
            if (nameContainer && cue.type === 'playlist') {
                if (currentItemName) {
                    playlistInfoHTML += `<span class="playlist-now-playing">(Paused: ${currentItemName})</span>`;
                }
                if (nextItemName) {
                    if (playlistInfoHTML) playlistInfoHTML += '<br>';
                    playlistInfoHTML += `<span class="playlist-next-item-playing">(Next: ${nextItemName})</span>`;
                }
                if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
            }
        } else { // Stopped / Idle (and not specifically cued by logic above, e.g. single file cue just stopped)
            // For idle single file cues, playbackState might be null or have isPlaying/isPaused false.
            // If it's a playlist and truly idle (no specific next item from isCued logic), 
            // playbackState.nextPlaylistItemName (first item) should be populated by audioController's fallback.
            if (nameContainer && cue.type === 'playlist' && nextItemName) {
                 playlistInfoHTML += `<span class="next-playlist-item">(Next: ${nextItemName})</span>`;
                 if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
            }
        }
    } else {
        // Fallback if playbackState is null (should be rare with new audioController logic but handle defensively)
        console.warn(`[CueGrid updateButtonPlayingState for ${cue.id}] Playback state was null. Defaulting to stopped state.`);
         if (nameContainer && cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
            // Basic fallback for idle playlist if everything else failed
            const firstItemName = cue.playlistItems[0]?.name || 'Item 1';
            playlistInfoHTML += `<span class="next-playlist-item">(Next: ${firstItemName})</span>`;
            if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
        }
    }

    if (nameContainer) nameContainer.innerHTML = nameHTML;
    

    // Pass the elements through to updateCueButtonTime
    updateCueButtonTime(cueId, elements); 

    if (statusIndicator.style.display !== 'none') {
        statusIndicator.innerHTML = `<img src="${statusIconSrc}" alt="${statusIconAlt}" class="cue-status-icon">`;
    } else {
        statusIndicator.innerHTML = ''; // Clear if hidden to prevent old icon flash
    }


}

function updateCueButtonTime(cueId, elements = null, isFadingIn = false, isFadingOut = false, fadeTimeRemainingMs = 0) {
    // console.log(`[CueGrid UpdateCueButtonTime ENTRY] cueId: ${cueId}, elements received:`, elements ? typeof elements : 'null', elements, `isFadingIn: ${isFadingIn}, isFadingOut: ${isFadingOut}, fadeMs: ${fadeTimeRemainingMs}`);

    if (!audioController || !cueStore) {
        console.warn(`updateCueButtonTime: audioController or cueStore not ready for cue ${cueId}`);
        return;
    }
    const cueFromStore = cueStore.getCueById(cueId);
    // console.log(`[CueGrid UpdateCueButtonTime] cueId: ${cueId}, cueFromStore:`, cueFromStore ? JSON.parse(JSON.stringify(cueFromStore)) : 'null');

    if (!cueFromStore) {
        // console.warn(`updateCueButtonTime: Cue ${cueId} not found in cueStore.`);
        return;
    }

    const button = document.getElementById(`cue-btn-${cueId}`);
    if (!button) {
        return;
    }

    let localElements = elements;
    if (!localElements) {
        localElements = {
            current: button.querySelector(`#cue-time-current-${cueId}`),
            total: button.querySelector(`#cue-time-total-${cueId}`),
            remaining: button.querySelector(`#cue-time-remaining-${cueId}`),
            separator: button.querySelector(`#cue-time-separator-${cueId}`)
        };
    }

    const playbackTimes = audioController.default.getPlaybackTimes(cueId);
    // --- START DIAGNOSTIC LOG ---
    console.log(`[CueGrid updateCueButtonTime] For cue ${cueId}, audioController.getPlaybackTimes returned:`, JSON.stringify(playbackTimes));
    // --- END DIAGNOSTIC LOG ---

    let displayCurrentTimeFormatted = "00:00";
    let displayCurrentTime = 0;
    let displayItemDuration = 0;
    let displayItemDurationFormatted = "00:00";
    let displayItemRemainingTime = 0; 
    let displayItemRemainingTimeFormatted = "";

    if (playbackTimes) {
        displayCurrentTimeFormatted = playbackTimes.currentTimeFormatted || "00:00";
        displayCurrentTime = playbackTimes.currentTime || 0;
        displayItemDuration = playbackTimes.duration || 0;
        displayItemDurationFormatted = playbackTimes.durationFormatted || "00:00";
        
        if (typeof playbackTimes.remainingTime === 'number') {
            displayItemRemainingTime = playbackTimes.remainingTime;
            displayItemRemainingTimeFormatted = playbackTimes.remainingTimeFormatted || formatTimeMMSS(playbackTimes.remainingTime) || "";
        } else if (displayItemDuration > 0 && displayCurrentTime <= displayItemDuration) {
            displayItemRemainingTime = displayItemDuration - displayCurrentTime;
            displayItemRemainingTimeFormatted = formatTimeMMSS(displayItemRemainingTime);
        }

    } else {
        console.warn(`[CueGrid UpdateCueButtonTime] cueId: ${cueId}, getPlaybackTimes returned null. Using default display values.`);
    }

    _updateButtonTimeDisplay(button, localElements, displayCurrentTimeFormatted, displayCurrentTime, displayItemDuration, displayItemDurationFormatted, displayItemRemainingTime, displayItemRemainingTimeFormatted, isFadingIn, isFadingOut, fadeTimeRemainingMs);
}

// New function that uses time data directly from IPC instead of calling audioController.getPlaybackTimes()
function updateCueButtonTimeWithData(cueId, timeData, elements = null, isFadingIn = false, isFadingOut = false, fadeTimeRemainingMs = 0) {
    // console.log(`[CueGrid UpdateCueButtonTimeWithData] cueId: ${cueId}, timeData:`, timeData);

    if (!cueStore) {
        console.warn(`updateCueButtonTimeWithData: cueStore not ready for cue ${cueId}`);
        return;
    }

    const cueFromStore = cueStore.getCueById(cueId);
    if (!cueFromStore) {
        return;
    }

    const button = document.getElementById(`cue-btn-${cueId}`);
    if (!button) {
        return;
    }

    let localElements = elements;
    if (!localElements) {
        localElements = {
            current: button.querySelector(`#cue-time-current-${cueId}`),
            total: button.querySelector(`#cue-time-total-${cueId}`),
            remaining: button.querySelector(`#cue-time-remaining-${cueId}`),
            separator: button.querySelector(`#cue-time-separator-${cueId}`)
        };
    }

    // Use the provided time data directly
    const displayCurrentTimeFormatted = timeData.currentTimeFormatted || "00:00";
    const displayCurrentTime = timeData.currentTime || 0;
    const displayItemDuration = timeData.duration || 0;
    const displayItemDurationFormatted = timeData.durationFormatted || "00:00";
    const displayItemRemainingTime = timeData.remainingTime || 0;
    const displayItemRemainingTimeFormatted = timeData.remainingTimeFormatted || "";

    _updateButtonTimeDisplay(button, localElements, displayCurrentTimeFormatted, displayCurrentTime, displayItemDuration, displayItemDurationFormatted, displayItemRemainingTime, displayItemRemainingTimeFormatted, isFadingIn, isFadingOut, fadeTimeRemainingMs);
}

// Helper function to update the button display (extracted from original updateCueButtonTime)
function _updateButtonTimeDisplay(button, localElements, displayCurrentTimeFormatted, displayCurrentTime, displayItemDuration, displayItemDurationFormatted, displayItemRemainingTime, displayItemRemainingTimeFormatted, isFadingIn, isFadingOut, fadeTimeRemainingMs) {

    if (localElements.current) localElements.current.textContent = displayCurrentTimeFormatted;
    if (localElements.separator) localElements.separator.textContent = (displayCurrentTime > 0 || displayItemDuration > 0) ? ' / ' : '';
    if (localElements.total) {
        localElements.total.textContent = displayItemDurationFormatted;
    }
    if (localElements.remaining) {
        const showRemaining = displayItemRemainingTime > 0 && displayCurrentTime < displayItemDuration;
        localElements.remaining.textContent = showRemaining ? `-${displayItemRemainingTimeFormatted}` : '';
        localElements.remaining.style.display = showRemaining ? 'inline' : 'none';
    }

    const isActuallyFading = (isFadingIn || isFadingOut) && fadeTimeRemainingMs > 0;

    // Clear previous fade-specific classes first
    button.classList.remove('fading', 'fading-in', 'fading-out');

    if (isActuallyFading) {
        button.classList.add('fading');
        // Don't remove playing/paused if it's just starting to fade from that state
        // button.classList.remove('playing', 'paused', 'stopped', 'cued'); 

        if (isFadingOut) {
            button.classList.add('fading-out');
            button.classList.remove('fading-in'); // Ensure only one fade direction class
        } else if (isFadingIn) {
            button.classList.add('fading-in');
            button.classList.remove('fading-out');
        }

        if (localElements.current) localElements.current.textContent = `Fading: ${(fadeTimeRemainingMs / 1000).toFixed(1)}s`;
        if (localElements.separator) localElements.separator.textContent = '';
        if (localElements.total) localElements.total.textContent = '';
        if (localElements.remaining) {
            localElements.remaining.textContent = '';
            localElements.remaining.style.display = 'none';
        }
    } else {
        // Not fading, ensure normal time display
        // Class 'fading', 'fading-in', 'fading-out' are already removed above
        if (localElements.current) localElements.current.textContent = displayCurrentTimeFormatted;
        if (localElements.separator) localElements.separator.textContent = (displayCurrentTime > 0 || displayItemDuration > 0) ? ' / ' : '';
        if (localElements.total) localElements.total.textContent = displayItemDurationFormatted;
        if (localElements.remaining) {
            const showRemaining = displayItemRemainingTime > 0 && displayCurrentTime < displayItemDuration;
            localElements.remaining.textContent = showRemaining ? `-${displayItemRemainingTimeFormatted}` : '';
            localElements.remaining.style.display = showRemaining ? 'inline' : 'none';
        }
    }
}

function formatTimeMMSS(timeInSeconds) {
    if (isNaN(timeInSeconds) || timeInSeconds < 0) {
        return "00:00";
    }
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateAllCueButtonTimes() {
    if (!isInitialized || !cueStore || !audioController) {
        console.warn('updateAllCueButtonTimes: CueGrid not initialized or dependencies missing');
        return;
    }
    
    const cues = cueStore.getAllCues();
    if (!cues || cues.length === 0) {
        return;
    }
    
    cues.forEach(cue => {
        updateCueButtonTime(cue.id);
    });
}

export {
    renderCues,
    updateButtonPlayingState, // Keep this exported if audioController calls it directly
    // updateCueButtonTime is mostly internal to renderCues now, but export if needed elsewhere
    updateCueButtonTime,
    updateCueButtonTimeWithData // New function for direct time data updates from IPC
}; 