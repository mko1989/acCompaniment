import { formatTime } from './utils.js';

let cueStore;
let audioController;
let dragDropHandler;
let uiCore; // To access functions like isEditMode, openPropertiesSidebar

// DOM Elements that cueGrid.js will manage or use
let cueGridContainer;

function initCueGrid(cs, ac, ddh, core) {
    cueStore = cs;
    audioController = ac;
    dragDropHandler = ddh;
    uiCore = core; // Reference to the core UI module for shared functions

    // Cache elements specific to cue grid - typically done in a broader DOM caching function
    // For now, assume cueGridContainer is accessible or passed if needed by other means.
    // This might be better handled by uiCore.js caching all static elements once.
    cueGridContainer = document.getElementById('cueGridContainer'); 
}

function renderCues() {
    if (!cueGridContainer || !cueStore || !audioController || !uiCore) {
        console.warn("renderCues (cueGrid.js) called before essential modules are initialized.");
        return;
    }
    cueGridContainer.innerHTML = ''; 
    const cues = cueStore.getAllCues();

    cues.forEach(cue => {
        const button = document.createElement('div');
        button.className = 'cue-button';
        button.id = `cue-btn-${cue.id}`;
        button.dataset.cueId = cue.id;

        const statusIndicator = document.createElement('div');
        statusIndicator.className = 'cue-status-indicator';
        statusIndicator.id = `cue-status-${cue.id}`;
        button.appendChild(statusIndicator);

        // ---- ADD WING LINK LABEL ----
        const wingLinkLabel = document.createElement('div');
        wingLinkLabel.className = 'wing-link-label';
        wingLinkLabel.id = `cue-wing-link-${cue.id}`;
        if (cue.wingTrigger && cue.wingTrigger.enabled && cue.wingTrigger.userButton) {
            wingLinkLabel.textContent = `ACue${cue.wingTrigger.userButton}`;
        } else {
            wingLinkLabel.textContent = ''; // Clear if not linked
        }
        button.appendChild(wingLinkLabel);
        // ---- END WING LINK LABEL ----

        const nameContainer = document.createElement('div');
        nameContainer.className = 'cue-button-name-container';
        button.appendChild(nameContainer);

        const timeContainer = document.createElement('div');
        timeContainer.className = 'cue-time-display-container';

        const timeCurrentElem = document.createElement('span');
        timeCurrentElem.className = 'cue-time-current';
        timeCurrentElem.id = `cue-time-current-${cue.id}`;
        timeCurrentElem.textContent = ''; 

        const timeSeparator = document.createElement('span');
        timeSeparator.className = 'cue-time-separator';
        timeSeparator.id = `cue-time-separator-${cue.id}`;
        timeSeparator.textContent = ''; 

        const timeTotalElem = document.createElement('span');
        timeTotalElem.className = 'cue-time-total';
        timeTotalElem.id = `cue-time-total-${cue.id}`;
        timeTotalElem.textContent = ''; 

        const timeRemainingElem = document.createElement('span');
        timeRemainingElem.className = 'cue-time-remaining';
        timeRemainingElem.id = `cue-time-remaining-${cue.id}`;
        timeRemainingElem.textContent = ''; 

        timeContainer.appendChild(timeCurrentElem);
        timeContainer.appendChild(timeSeparator);
        timeContainer.appendChild(timeTotalElem);
        timeContainer.appendChild(timeRemainingElem);
        button.appendChild(timeContainer);
        
        const isCurrentlyPlaying = audioController.isPlaying(cue.id);
        const isCurrentlyPaused = audioController.isPaused(cue.id);
        const isCurrentlyCued = audioController.isCued(cue.id); // Check if cued
        let nameHTML = cue.name || 'Unnamed Cue';

        if (isCurrentlyPlaying) {
            statusIndicator.textContent = 'Playing';
            button.classList.add('playing');
            if (cue.type === 'playlist') {
                const playlistItemName = audioController.getCurrentlyPlayingPlaylistItemName(cue.id);
                if (playlistItemName) {
                    nameHTML += `<br><span class="now-playing-item">(Now: ${playlistItemName})</span>`;
                }
            }
        } else if (isCurrentlyCued) {
            const nextItemName = audioController.getNextPlaylistItemName(cue.id);
            statusIndicator.textContent = 'Cued';
            button.classList.add('cued');
            if (cue.type === 'playlist' && nextItemName) {
                 nameHTML += `<br><span class="next-playlist-item">(Next: ${nextItemName})</span>`;
            }
        } else if (isCurrentlyPaused) {
            statusIndicator.textContent = 'Paused';
            button.classList.add('paused');
            if (cue.type === 'playlist') { // If paused mid-playlist, show current item
                const playlistItemName = audioController.getCurrentlyPlayingPlaylistItemName(cue.id);
                if (playlistItemName) {
                    nameHTML += `<br><span class="now-playing-item">(Paused: ${playlistItemName})</span>`;
                }
            }
        } else { // Stopped / Idle
            statusIndicator.textContent = 'Stopped';
            button.classList.remove('playing', 'paused', 'cued');
            if (cue.type === 'playlist') {
                const nextPlaylistItemName = audioController.getNextPlaylistItemName(cue.id);
                if (nextPlaylistItemName) {
                    nameHTML += `<br><span class="next-playlist-item">(Next: ${nextPlaylistItemName})</span>`;
                }
            }
        }
        
        // Update time display for all states
        updateCueButtonTime(cue.id, {
            current: timeCurrentElem,
            total: timeTotalElem,
            remaining: timeRemainingElem,
            separator: timeSeparator
        });

        nameContainer.innerHTML = nameHTML;

        button.addEventListener('click', (event) => handleCueButtonClick(event, cue));
        cueGridContainer.appendChild(button);
    });

    if (dragDropHandler && typeof dragDropHandler.initializeCueButtonDragDrop === 'function') {
        dragDropHandler.initializeCueButtonDragDrop(cueGridContainer);
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

    if (uiCore.isEditMode() && !event.shiftKey) {
        console.log(`UI: Edit mode click on cue ${cue.id}. Opening properties.`);
        uiCore.openPropertiesSidebar(cue);
    } else { 
        const retriggerBehavior = cue.retriggerBehavior || uiCore.getCurrentAppConfig().defaultRetriggerBehavior || 'restart';
        console.log(`UI: Show mode action for cue ${cue.id}. Using retrigger behavior: ${retriggerBehavior}`);
        audioController.toggle(cue, false, retriggerBehavior);
    }
}

function updateButtonPlayingState(cueId, isPlaying, statusTextArg = null, isCuedOverride = false) {
    const button = document.getElementById(`cue-btn-${cueId}`);
    if (!button || !cueStore) return;
    const cue = cueStore.getCueById(cueId);
    if (!cue) return;

    const statusIndicator = button.querySelector('.cue-status-indicator');
    const nameContainer = button.querySelector('.cue-button-name-container');

    button.classList.remove('playing', 'paused', 'cued'); // Clear all state classes first

    if (isPlaying) {
        button.classList.add('playing');
        if (statusIndicator) statusIndicator.textContent = 'Playing';
        if (nameContainer) {
            let nameHTML = cue.name || 'Cue';
            if (statusTextArg) { // This is playlistItemName when playing
                nameHTML += `<br><span class="now-playing-item">(Now: ${statusTextArg})</span>`;
            }
            nameContainer.innerHTML = nameHTML;
        }
    } else if (isCuedOverride) {
        button.classList.add('cued');
        if (statusIndicator) statusIndicator.textContent = 'Cued';
        
        if (nameContainer && statusTextArg && statusTextArg.startsWith('Next:')) {
            let nameHTML = cue.name || 'Cue';
            nameHTML += `<br><span class="next-playlist-item">(${statusTextArg})</span>`;
            nameContainer.innerHTML = nameHTML;
        } else if (nameContainer) {
            nameContainer.innerHTML = cue.name || 'Cue';
        }
        // No renderCues() call here to preserve this specific update.
    } else { // Not playing and not a cued override - means stopped or paused from external call
        // This path is hit by audioController when a sound stops or is paused NOT via direct UI interaction on THIS button.
        // It needs to accurately reflect the current state (could be paused, could be stopped and cued, could be fully stopped).
        button.classList.remove('playing', 'paused', 'cued'); // Clear all state classes first

        const isPaused = audioController.isPaused(cueId);
        const isCued = audioController.isCued(cueId);
        let nameHTML = cue.name || 'Unnamed Cue';

        if (isCued) {
            const nextItemName = audioController.getNextPlaylistItemName(cueId);
            if (statusIndicator) statusIndicator.textContent = 'Cued';
            button.classList.add('cued');
            if (nameContainer && cue.type === 'playlist' && nextItemName) {
                 nameHTML += `<br><span class="next-playlist-item">(Next: ${nextItemName})</span>`;
            }
        } else if (isPaused) {
            if (statusIndicator) statusIndicator.textContent = 'Paused';
            button.classList.add('paused');
            if (nameContainer && cue.type === 'playlist') { 
                const playlistItemName = audioController.getCurrentlyPlayingPlaylistItemName(cueId);
                if (playlistItemName) {
                    nameHTML += `<br><span class="now-playing-item">(Paused: ${playlistItemName})</span>`;
                }
            }
        } else { // Stopped / Idle
            if (statusIndicator) statusIndicator.textContent = 'Stopped';
            // classes already removed
            if (nameContainer && cue.type === 'playlist') {
                const nextPlaylistItemName = audioController.getNextPlaylistItemName(cueId);
                if (nextPlaylistItemName) {
                    nameHTML += `<br><span class="next-playlist-item">(Next: ${nextPlaylistItemName})</span>`;
                }
            }
        }
        if (nameContainer) nameContainer.innerHTML = nameHTML;
        updateCueButtonTime(cueId); // Update time display for this button
    }
}

function updateCueButtonTime(cueId, elements = null) {
    if (!audioController || !cueStore) { // Added cueStore check for safety
        console.warn(`updateCueButtonTime: audioController or cueStore not ready for cue ${cueId}`);
        return;
    }
    const cueFromStore = cueStore.getCueById(cueId);
    if (!cueFromStore) {
        console.warn(`updateCueButtonTime: Cue ${cueId} not found in cueStore.`);
        return;
    }

    let localElements = elements;
    if (!localElements) {
        const button = document.getElementById(`cue-btn-${cueId}`);
        if (!button) {
            // console.warn(`updateCueButtonTime: Button not found for cue ${cueId}`);
            return;
        }
        localElements = {
            current: button.querySelector(`#cue-time-current-${cueId}`),
            total: button.querySelector(`#cue-time-total-${cueId}`),
            remaining: button.querySelector(`#cue-time-remaining-${cueId}`),
            separator: button.querySelector(`#cue-time-separator-${cueId}`)
        };
    }

    const times = audioController.getPlaybackTimes(cueFromStore);

    console.log(`CueGrid: updateCueButtonTime for cue ${cueId}. Cue knownDuration: ${cueFromStore.knownDuration}. Fetched times object: ${JSON.stringify(times)}`);
    console.log(`CueGrid: updateCueButtonTime for cue ${cueId}. Fetched times.currentItemDurationFormatted: ${times.currentItemDurationFormatted}`);

    if (localElements.current) localElements.current.textContent = times.currentTimeFormatted;
    if (localElements.separator) localElements.separator.textContent = (times.currentTime > 0 || times.currentItemDuration > 0) ? ' / ' : '';
    if (localElements.total) {
        localElements.total.textContent = times.currentItemDurationFormatted;
        // console.log(`CueGrid (cue ${cueId}): elements.total.textContent AFTER SET: "${localElements.total.textContent}" (intended: "${times.currentItemDurationFormatted}")`);
    }
    if (localElements.remaining) {
        localElements.remaining.textContent = (times.currentItemRemainingTime > 0 || times.currentTime > 0) ? `-${times.currentItemRemainingTimeFormatted}` : '';
        localElements.remaining.style.display = (times.currentItemRemainingTime > 0 || times.currentTime > 0) ? 'inline' : 'none';
    }
}

function updateAllCueButtonTimes() {
    // ... existing code ...
}

export {
    initCueGrid,
    renderCues,
    updateButtonPlayingState, // Keep this exported if audioController calls it directly
    // updateCueButtonTime is mostly internal to renderCues now, but export if needed elsewhere
    updateCueButtonTime 
}; 