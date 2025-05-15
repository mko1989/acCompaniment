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
        // Re-render all cues to ensure consistent state based on audioController.isPaused()
        // This handles cases like pause button press, or stop from companion etc.
        console.log(`updateButtonPlayingState: isPlaying=false, isCuedOverride=false for ${cueId}. Calling renderCues.`);
        renderCues(); 
    }
}

function updateCueButtonTime(cueId, elements = null) {
    if (!audioController) {
        return;
    }

    const times = audioController.getPlaybackTimes(cueId);
    if (!times) {
        // If times are null (e.g. cue not found or error), clear the display or set to default.
        // This depends on how we want to handle missing time information.
        // For now, just ensuring elements are found before trying to update.
        const currentElem = elements ? elements.current : document.getElementById(`cue-time-current-${cueId}`);
        const totalElem = elements ? elements.total : document.getElementById(`cue-time-total-${cueId}`);
        const remainingElem = elements ? elements.remaining : document.getElementById(`cue-time-remaining-${cueId}`);
        const separatorElem = elements ? elements.separator : document.getElementById(`cue-time-separator-${cueId}`);
        if (currentElem) currentElem.textContent = '';
        if (totalElem) totalElem.textContent = '--:--';
        if (remainingElem) remainingElem.textContent = '';
        if (separatorElem) separatorElem.textContent = '';
        return; 
    }

    const currentElem = elements ? elements.current : document.getElementById(`cue-time-current-${cueId}`);
    const totalElem = elements ? elements.total : document.getElementById(`cue-time-total-${cueId}`);
    const remainingElem = elements ? elements.remaining : document.getElementById(`cue-time-remaining-${cueId}`);
    const separatorElem = elements ? elements.separator : document.getElementById(`cue-time-separator-${cueId}`);

    if (!currentElem || !totalElem || !remainingElem || !separatorElem) {
        // This case should ideally not be hit if elements are always present or handled above.
        return;
    }

    const formattedCurrent = formatTime(times.currentTime);
    const formattedTotal = formatTime(times.totalPlaylistDuration); 
    const formattedRemaining = formatTime(times.currentItemRemainingTime);

    const DURATION_THRESHOLD_SECONDS = 0.05; // Only show total/remaining if duration is meaningful

    const isCurrentlyPlaying = audioController.isPlaying(cueId);
    const isCurrentlyPaused = audioController.isPaused(cueId);

    if (!isCurrentlyPlaying && !isCurrentlyPaused) { // Idle state
        if (times.totalPlaylistDuration > DURATION_THRESHOLD_SECONDS) {
            currentElem.textContent = ''; 
            separatorElem.textContent = ''; 
            totalElem.textContent = formattedTotal;
            // In idle, remaining is the total duration
            remainingElem.textContent = times.totalPlaylistDuration > 0 ? `(-${formattedTotal})` : ''; 
        } else {
            currentElem.textContent = '';
            separatorElem.textContent = '';
            // For idle, use totalPlaylistDuration for the main display. rawDuration is just for the 00:00 check.
            totalElem.textContent = (formatTime(times.totalPlaylistDuration) === '00:00' && times.rawDuration <= DURATION_THRESHOLD_SECONDS) ? '' : formattedTotal;
            remainingElem.textContent = '';
        }
    } else { // Playing or Paused state
        currentElem.textContent = formattedCurrent;
        if (formattedTotal === '--:--' || times.totalPlaylistDuration <= DURATION_THRESHOLD_SECONDS) { // Handles streams or very short files, check totalPlaylistDuration
            totalElem.textContent = '';
            separatorElem.textContent = '';
            remainingElem.textContent = ''; 
        } else {
            totalElem.textContent = formattedTotal;
            separatorElem.textContent = ' / ';
            // Add minus sign to remaining time in playing/paused state
            remainingElem.textContent = `(-${formattedRemaining})`;
        }
    }
}

export {
    initCueGrid,
    renderCues,
    updateButtonPlayingState, // Keep this exported if audioController calls it directly
    // updateCueButtonTime is mostly internal to renderCues now, but export if needed elsewhere
    updateCueButtonTime 
}; 