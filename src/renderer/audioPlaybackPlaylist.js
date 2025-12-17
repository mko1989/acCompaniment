// audioPlaybackPlaylist.js
// Playlist navigation and management functions for audio playback

import { log } from './audioPlaybackLogger.js';
import { _addToPlayOrder } from './audioPlaybackStateManagement.js';

// Simple navigation blocking to prevent rapid multiple calls
const navigationBlocked = new Set();

// Track last playlist positions for idle navigation
const lastPlaylistPositions = new Map();

// Helper function to cue a playlist at a specific position (without playing)
function _cuePlaylistAtPosition(cueId, targetIndex, currentlyPlaying, getGlobalCueByIdRef, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef = null) {
    log.debug(`_cuePlaylistAtPosition called for ${cueId}, index ${targetIndex}`);
    
    const cue = getGlobalCueByIdRef(cueId);
    if (!cue || cue.type !== 'playlist' || !cue.playlistItems || cue.playlistItems.length === 0) {
        log.warn(`_cuePlaylistAtPosition: Invalid playlist cue ${cueId}`);
        return;
    }
    
    // Clamp target index to valid range
    const clampedIndex = Math.max(0, Math.min(targetIndex, cue.playlistItems.length - 1));
    log.info(`Cueing playlist ${cueId} at index ${clampedIndex}`);
    
    // Create or update playlist state as CUED (not playing)
    const playlistState = {
        cue: cue,
        isPlaylist: true,
        currentPlaylistItemIndex: clampedIndex,
        isPaused: true,
        isCued: true,
        isCuedNext: true,
        volume: cue.volume || 1,
        originalVolumeBeforeDuck: null,
        isDucked: false,
        activeDuckingTriggerId: null,
        sound: null,
        playlistItems: cue.playlistItems,
        originalPlaylistItems: cue.playlistItems.slice(),
        shufflePlaybackOrder: []
    };
    
    currentlyPlaying[cueId] = playlistState;
    
    // Generate shuffle order if needed (pass currentlyPlaying as second arg)
    if (cue.shuffle && cue.playlistItems.length > 1) {
        _generateShuffleOrder(cueId, currentlyPlaying);
    }
    
    // Determine the name of the cued item for UI display
    let cuedOriginalIdx = clampedIndex;
    if (cue.shuffle && playlistState.shufflePlaybackOrder && playlistState.shufflePlaybackOrder.length > clampedIndex) {
        cuedOriginalIdx = playlistState.shufflePlaybackOrder[clampedIndex];
    }
    
    let cuedName = 'Item';
    if (cuedOriginalIdx >= 0 && cuedOriginalIdx < cue.playlistItems.length) {
        const item = cue.playlistItems[cuedOriginalIdx];
        cuedName = item.name || item.path?.split(/[\\\/]/).pop() || `Item ${cuedOriginalIdx + 1}`;
    }
    
    // Update UI to show cued state
    if (sidebarsAPIRef && typeof sidebarsAPIRef.cueGrid?.updateButtonPlayingState === 'function') {
        log.debug(`Updating UI to show cued state for ${cueId}: ${cuedName}`);
        sidebarsAPIRef.cueGrid.updateButtonPlayingState(cueId, false, `Next: ${cuedName}`, true);
    } else if (typeof window !== 'undefined' && window.uiModules?.cueGrid?.updateButtonPlayingState) {
        log.debug(`Using fallback UI to show cued state for ${cueId}: ${cuedName}`);
        window.uiModules.cueGrid.updateButtonPlayingState(cueId, false, `Next: ${cuedName}`, true);
    }
    
    // Send playback time update to companion module for cued state
    if (sendPlaybackTimeUpdateRef && playlistState) {
        log.debug(`Sending cued state update to companion for ${cueId}`);
        sendPlaybackTimeUpdateRef(cueId, null, playlistState, cuedName, 'paused');
    }
    
    log.info(`Playlist ${cueId} cued at index ${clampedIndex} (${cuedName})`);
}

// Helper function to start a playlist at a specific position
function startPlaylistAtPosition(cueId, targetIndex, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, cuePlayOrder) {
    log.debug(`startPlaylistAtPosition called for ${cueId}, index ${targetIndex}`);
    
    // Check if playlist already has state - if so, update it instead of skipping
    if (currentlyPlaying[cueId]) {
        log.debug(`Playlist ${cueId} already has state, updating to index ${targetIndex}`);
        const existingState = currentlyPlaying[cueId];
        
        // Stop any existing sound
        if (existingState.sound) {
            try {
                existingState.sound.stop();
                existingState.sound.unload();
            } catch (error) {
                log.warn(`Error stopping existing sound during restart:`, error);
            }
            existingState.sound = null;
        }
        
        // Update the state to the new position
        existingState.currentPlaylistItemIndex = targetIndex;
        existingState.isPaused = false;
        existingState.isCued = false;
        existingState.isCuedNext = false;
        
        // Play the target item
        _playTargetItem(cueId, targetIndex, false);
        return { success: true, cuePlayOrder };
    }
    
    const cue = getGlobalCueByIdRef(cueId);
    if (!cue || cue.type !== 'playlist' || !cue.playlistItems || cue.playlistItems.length === 0) {
        log.warn(`startPlaylistAtPosition: Invalid playlist cue ${cueId}`);
        return { success: false, cuePlayOrder };
    }
    
    // Clamp target index to valid range
    const clampedIndex = Math.max(0, Math.min(targetIndex, cue.playlistItems.length - 1));
    log.info(`Starting playlist ${cueId} at index ${clampedIndex}`);
    
    // Initialize playlist state
    const initialPlayingState = {
        cue: cue,
        isPlaylist: true,
        currentPlaylistItemIndex: clampedIndex,
        isPaused: false,
        isCued: false,
        volume: cue.volume || 1,
        originalVolumeBeforeDuck: null,
        isDucked: false,
        activeDuckingTriggerId: null,
        sound: null,
        
        playlistItems: cue.playlistItems,
        originalPlaylistItems: cue.playlistItems.slice(),
        shufflePlaybackOrder: []
    };
    
    currentlyPlaying[cueId] = initialPlayingState;
    
    // Generate shuffle order if needed
    if (cue.shuffle && cue.playlistItems.length > 1) {
        _generateShuffleOrder(cueId);
    }
    
    // Play the target item
    _playTargetItem(cueId, clampedIndex, false);
    
    // Add to play order and return updated order
    const updatedCuePlayOrder = _addToPlayOrder(cueId, cuePlayOrder);
    
    return { success: true, cuePlayOrder: updatedCuePlayOrder };
}

/**
 * Internal helper to handle playlist navigation (next/prev)
 * @param {string} cueId 
 * @param {number} direction 1 for next, -1 for previous
 * @param {boolean} fromExternal 
 * @param {object} currentlyPlaying 
 * @param {function} getGlobalCueByIdRef 
 * @param {function} _playTargetItem 
 * @param {function} _generateShuffleOrder 
 * @param {object} sidebarsAPIRef 
 * @param {Array} cuePlayOrder 
 * @param {function} sendPlaybackTimeUpdateRef 
 */
function _navigatePlaylist(cueId, direction, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef) {
    const timestamp = new Date().toISOString();
    log.debug(`Playlist navigate ${direction > 0 ? 'next' : 'previous'} for cue ${cueId} at ${timestamp}`);
    
    // Block rapid navigation calls
    if (navigationBlocked.has(cueId)) {
        log.debug(`Navigation blocked for ${cueId}, ignoring rapid call`);
        return true;
    }
    
    // Block navigation for this cue for 100ms
    navigationBlocked.add(cueId);
    setTimeout(() => {
        navigationBlocked.delete(cueId);
        log.debug(`Navigation unblocked for ${cueId}`);
    }, 100);
    
    const playingState = currentlyPlaying[cueId];
    const cue = getGlobalCueByIdRef(cueId);
    
    if (!cue || cue.type !== 'playlist') {
        log.warn(`_navigatePlaylist called for non-playlist cue ${cueId}`);
        return false;
    }
    
    const playlistItems = cue.playlistItems || [];
    const maxIndex = playlistItems.length - 1;

    // Idle Navigation (Cueing)
    if (!playingState || !playingState.sound) {
        let lastPos = lastPlaylistPositions.get(cueId);
        let targetIndex;

        if (direction > 0) { // Next
            // Default to 0 if undefined, then +1 -> index 1. (Preserving original behavior)
            let startIndex = lastPos !== undefined ? lastPos : 0;
            targetIndex = startIndex + 1;
            
            if (targetIndex > maxIndex) {
                if (cue.loop) {
                    targetIndex = 0;
                } else {
                    targetIndex = maxIndex; // Stay at end
                }
            }
        } else { // Previous
            // Default to last item if undefined
            if (lastPos === undefined || lastPos <= 0) {
                targetIndex = maxIndex;
            } else {
                targetIndex = lastPos - 1;
            }
        }
        
        log.info(`Idle playlist navigation: Cueing ${cueId} at index ${targetIndex} (last pos: ${lastPos})`);
        lastPlaylistPositions.set(cueId, targetIndex);
        
        _cuePlaylistAtPosition(cueId, targetIndex, currentlyPlaying, getGlobalCueByIdRef, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder || [], sendPlaybackTimeUpdateRef);
        return true;
    }
    
    // Playing Navigation
    if (!playingState.isPlaylist) {
        log.warn(`_navigatePlaylist called for non-playlist playingState ${cueId}`);
        return false;
    }
    
    const mainCue = playingState.cue;
    const currentIndex = playingState.currentPlaylistItemIndex;
    const currentOrderLength = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                              ? playingState.shufflePlaybackOrder.length 
                              : playingState.originalPlaylistItems.length;
    
    let nextIndex = currentIndex + direction;
    
    log.debug(`Current index: ${currentIndex}, Target index: ${nextIndex}, Playlist length: ${currentOrderLength}`);
    
    // Boundary checks
    if (direction > 0) { // Next
        if (nextIndex >= currentOrderLength) {
            if (mainCue.loop) {
                nextIndex = 0;
                log.debug(`Looping back to start (index 0)`);
                // Re-shuffle if needed
                if (mainCue.shuffle && playingState.originalPlaylistItems.length > 1) {
                    _generateShuffleOrder(cueId);
                }
            } else {
                log.info(`Playlist ${cueId} at end, cannot navigate next without loop`);
                return false;
            }
        }
    } else { // Previous
        if (nextIndex < 0) {
            if (mainCue.loop) {
                nextIndex = currentOrderLength - 1;
                log.debug(`Looping to end (index ${nextIndex})`);
            } else {
                log.info(`Playlist ${cueId} at beginning, cannot navigate previous without loop`);
                return false;
            }
        }
    }
    
    // Set navigation flag
    playingState.isNavigating = true;
    
    // Stop current sound
    if (playingState.sound) {
        try {
            const soundToStop = playingState.sound;
            soundToStop.off(); 
            soundToStop.stop();
            soundToStop.unload();
        } catch (error) {
            log.warn(`Error stopping sound during navigation for ${cueId}:`, error);
        }
        playingState.sound = null;
    }
    
    log.info(`Navigating playlist ${cueId} to ${direction > 0 ? 'next' : 'previous'} item (index ${nextIndex})`);
    
    // Update state
    playingState.currentPlaylistItemIndex = nextIndex;
    playingState.isCuedNext = false;
    playingState.isPaused = false;
    
    // Play new item
    _playTargetItem(cueId, nextIndex, false);
    
    // Update sidebar highlight
    if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
        let targetOriginalIdx = nextIndex;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > nextIndex) {
            targetOriginalIdx = playingState.shufflePlaybackOrder[nextIndex];
        }
        const playingItem = playingState.originalPlaylistItems[targetOriginalIdx];
        if (playingItem && playingItem.id) {
            sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, playingItem.id);
        }
    }
    
    // Update last position
    lastPlaylistPositions.set(cueId, nextIndex);
    
    // Clear navigation flag
    setTimeout(() => {
        if (currentlyPlaying[cueId]) {
            currentlyPlaying[cueId].isNavigating = false;
            log.debug(`Navigation flag cleared for ${cueId}`);
        }
    }, 50);
    
    return true;
}

function playlistNavigateNext(cueId, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, startPlaylistAtPositionRef, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef = null) {
    return _navigatePlaylist(cueId, 1, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef);
}

function playlistNavigatePrevious(cueId, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, startPlaylistAtPositionRef, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef = null) {
    return _navigatePlaylist(cueId, -1, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef);
}

// Function to jump to a specific item in a playlist
function playlistJumpToItem(cueId, targetIndex, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, startPlaylistAtPositionRef, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef = null) {
    const timestamp = new Date().toISOString();
    log.debug(`Playlist jump to item for cue ${cueId}, index ${targetIndex} at ${timestamp}`);
    
    const cue = getGlobalCueByIdRef(cueId);
    if (!cue || cue.type !== 'playlist' || !cue.playlistItems || cue.playlistItems.length === 0) {
        log.warn(`playlistJumpToItem called for invalid playlist cue ${cueId}`);
        return false;
    }
    
    // Clamp target index to valid range
    const clampedIndex = Math.max(0, Math.min(targetIndex, cue.playlistItems.length - 1));
    
    const playingState = currentlyPlaying[cueId];
    
    if (!playingState || (!playingState.sound && !playingState.isPaused && !playingState.isCuedNext)) {
        // Playlist is not currently playing - start it at the target position
        log.info(`Idle playlist jump: Starting ${cueId} at index ${clampedIndex}`);
        // Note: startPlaylistAtPosition is called here, but we defined it locally.
        // If it's passed as an argument 'startPlaylistAtPositionRef', we should probably use that or the local one?
        // The export at the bottom exports the local 'startPlaylistAtPosition'.
        // The arguments to this function include 'startPlaylistAtPosition', which seems to be the function itself passed in?
        // Let's use the local one defined in this file to be safe/consistent.
        startPlaylistAtPosition(cueId, clampedIndex, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, cuePlayOrder);
        return true;
    }
    
    if (!playingState.isPlaylist) {
        log.warn(`playlistJumpToItem called for non-playlist playingState ${cueId}`);
        return false;
    }
    
    // Update the current index
    playingState.currentPlaylistItemIndex = clampedIndex;
    playingState.isPaused = false;
    playingState.isCuedNext = false;
    playingState.isNavigating = true;
    
    // Stop current sound if playing
    if (playingState.sound) {
        try {
            playingState.sound.stop();
            playingState.sound.unload();
        } catch (error) {
            log.warn(`Error stopping sound during jump:`, error);
        }
        playingState.sound = null;
    }
    
    log.info(`Jumping to item at index ${clampedIndex} for ${cueId}`);
    
    // Play the target item immediately
    _playTargetItem(cueId, clampedIndex, false);
    
    // Update playlist highlighting if available
    if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
        const mainCue = playingState.cue;
        let targetOriginalIdx = clampedIndex;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > clampedIndex) {
            targetOriginalIdx = playingState.shufflePlaybackOrder[clampedIndex];
        }
        const playingItem = playingState.originalPlaylistItems[targetOriginalIdx];
        if (playingItem && playingItem.id) {
            sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, playingItem.id);
        }
    }
    
    // Update last position tracker
    lastPlaylistPositions.set(cueId, clampedIndex);
    
    // Clear navigation flag quickly after the play call completes
    setTimeout(() => {
        if (currentlyPlaying[cueId]) {
            currentlyPlaying[cueId].isNavigating = false;
            log.debug(`Navigation flag cleared for ${cueId}`);
        }
    }, 50);
    
    return true;
}

export {
    startPlaylistAtPosition,
    playlistNavigateNext,
    playlistNavigatePrevious,
    playlistJumpToItem,
    _cuePlaylistAtPosition,
    navigationBlocked,
    lastPlaylistPositions
};
