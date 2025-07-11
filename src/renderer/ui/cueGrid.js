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

function bindEventListeners() {
    // ... existing code ...
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
        const button = document.createElement('div');
        button.className = 'cue-button';
        button.id = `cue-btn-${cue.id}`;
        button.dataset.cueId = cue.id;

        const statusIndicator = document.createElement('div');
        statusIndicator.className = 'cue-status-indicator';
        statusIndicator.id = `cue-status-${cue.id}`;
        button.appendChild(statusIndicator);

        console.log(`[CueGrid renderCues] For cue ${cue.id}, cue.wingTrigger is:`, JSON.stringify(cue.wingTrigger));
        const wingLinkLabel = document.createElement('div');
        wingLinkLabel.className = 'wing-link-label';
        wingLinkLabel.id = `cue-wing-link-${cue.id}`;
        if (cue.wingTrigger && cue.wingTrigger.enabled) {
            wingLinkLabel.textContent = cue.name ? cue.name.substring(0, 12) : '';
        } else {
            wingLinkLabel.textContent = '';
        }
        button.appendChild(wingLinkLabel);

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
        
        // Append the button to the DOM first, so getElementById can find it if needed
        // and so that child elements are definitely part of the document for any selectors.
        cueGridContainer.appendChild(button);

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

    });

    if (dragDrop && typeof dragDrop.initializeCueButtonDragDrop === 'function') {
        dragDrop.initializeCueButtonDragDrop(cueGridContainer);
    }
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
    console.log(`[CueGrid UpdateButtonPlayingState ENTRY] cueId: ${cueId}, isPlaying(arg): ${isPlaying}, isCuedOverride: ${isCuedOverride}, elements received:`, elements ? typeof elements : 'null', elements);
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
        
        let playlistInfoHTML = ''; // Initialize playlistInfoHTML here

        if (actualIsPlaying) {
            button.classList.add('playing');
            statusIconSrc = '../../assets/icons/play.png';
            statusIconAlt = 'Playing';
            if (nameContainer && cue.type === 'playlist') {
                let playlistInfoHTML = '';
                if (currentItemName) {
                    playlistInfoHTML += `<span class="playlist-now-playing">(Now: ${currentItemName})</span>`;
                }
                if (nextItemName) {
                    if (playlistInfoHTML) playlistInfoHTML += '<br>';
                    playlistInfoHTML += `<span class="playlist-next-item-playing">(Next: ${nextItemName})</span>`;
                }
                if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
            }
        } else if (actualIsPaused) {
            button.classList.add('paused');
            if (cue.type === 'playlist' && actualIsCued) { // Specifically for playlist cued and paused
                statusIndicator.style.display = 'none';
                cuedTextIndicator.style.display = 'block';
                cuedTextIndicator.textContent = 'Cued';
                statusIconAlt = 'Playlist Cued'; // Alt text for accessibility if needed
            } else {
                statusIconSrc = '../../assets/icons/pause.png';
                statusIconAlt = 'Paused';
            }
            if (nameContainer && cue.type === 'playlist') {
                let playlistInfoHTML = '';
                if (currentItemName) {
                    playlistInfoHTML += `<span class="playlist-now-playing">(Paused: ${currentItemName})</span>`;
                }
                if (nextItemName) {
                    if (playlistInfoHTML) playlistInfoHTML += '<br>';
                    playlistInfoHTML += `<span class="playlist-next-item-playing">(Next: ${nextItemName})</span>`;
                }
                if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
            }
        } else if (actualIsCued) { // Covers idle playlists (where nextItemName is set) and explicitly cued items
            button.classList.add('cued');
            statusIconSrc = '../../assets/icons/play.png'; // Show play icon for cued state
            statusIconAlt = 'Cued';
            if (nameContainer && cue.type === 'playlist') {
                if (nextItemName) {
                    playlistInfoHTML += `<span class="next-playlist-item">(Next: ${nextItemName})</span>`;
                } else if (currentItemName) {
                    playlistInfoHTML += `<span class="next-playlist-item">(Cued: ${currentItemName})</span>`;
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
            let playlistInfoHTML = ''; // Initialize playlistInfoHTML here for fallback
            const firstItemName = cue.playlistItems[0]?.name || 'Item 1';
            playlistInfoHTML += `<span class="next-playlist-item">(Next: ${firstItemName})</span>`;
            if (playlistInfoHTML) nameHTML += `<br>${playlistInfoHTML}`;
        }
    }

    if (nameContainer) nameContainer.innerHTML = nameHTML;
    
    // Update WING Trigger Label here as well, as cue data might have changed
    console.log(`[CueGrid updateButtonPlayingState] For cue ${cue.id}, cue.wingTrigger is:`, JSON.stringify(cue.wingTrigger));
    const wingLink = button.querySelector('.wing-link-label');
    if (wingLink) {
        if (cue.wingTrigger && cue.wingTrigger.enabled) {
            wingLink.textContent = cue.name ? cue.name.substring(0, 12) : '';
            wingLink.style.display = 'block'; // Or 'inline-block', ensure it's visible
        } else {
            wingLink.textContent = '';
            wingLink.style.display = 'none'; // Hide if not enabled
        }
    }

    // Pass the elements through to updateCueButtonTime
    updateCueButtonTime(cueId, elements); 

    if (statusIndicator.style.display !== 'none') {
        statusIndicator.innerHTML = `<img src="${statusIconSrc}" alt="${statusIconAlt}" class="cue-status-icon">`;
    } else {
        statusIndicator.innerHTML = ''; // Clear if hidden to prevent old icon flash
    }


}

function updateCueButtonTime(cueId, elements = null, isFadingIn = false, isFadingOut = false, fadeTimeRemainingMs = 0) {
    console.log(`[CueGrid UpdateCueButtonTime ENTRY] cueId: ${cueId}, elements received:`, elements ? typeof elements : 'null', elements, `isFadingIn: ${isFadingIn}, isFadingOut: ${isFadingOut}, fadeMs: ${fadeTimeRemainingMs}`);

    if (!audioController || !cueStore) {
        console.warn(`updateCueButtonTime: audioController or cueStore not ready for cue ${cueId}`);
        return;
    }
    const cueFromStore = cueStore.getCueById(cueId);
    console.log(`[CueGrid UpdateCueButtonTime] cueId: ${cueId}, cueFromStore:`, cueFromStore ? JSON.parse(JSON.stringify(cueFromStore)) : 'null');

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
    console.log(`[CueGrid UpdateCueButtonTimeWithData] cueId: ${cueId}, timeData:`, timeData);

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
    // ... existing code ...
}

export {
    renderCues,
    updateButtonPlayingState, // Keep this exported if audioController calls it directly
    // updateCueButtonTime is mostly internal to renderCues now, but export if needed elsewhere
    updateCueButtonTime,
    updateCueButtonTimeWithData // New function for direct time data updates from IPC
}; 