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
    console.log(`🔵 AudioPlaybackManager: _cuePlaylistAtPosition called for ${cueId}, index ${targetIndex}`);
    
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
        console.log(`🔵 AudioPlaybackManager: Updating UI to show cued state for ${cueId}: ${cuedName}`);
        sidebarsAPIRef.cueGrid.updateButtonPlayingState(cueId, false, `Next: ${cuedName}`, true);
    } else if (typeof window !== 'undefined' && window.uiModules?.cueGrid?.updateButtonPlayingState) {
        console.log(`🔵 AudioPlaybackManager: Using fallback UI to show cued state for ${cueId}: ${cuedName}`);
        window.uiModules.cueGrid.updateButtonPlayingState(cueId, false, `Next: ${cuedName}`, true);
    }
    
    // CRITICAL FIX: Send playback time update to companion module for cued state
    // Even though there's no sound instance, we need to inform the companion about the cued status
    if (sendPlaybackTimeUpdateRef && playlistState) {
        console.log(`AudioPlaybackManager: Sending cued state update to companion for ${cueId}`);
        // Pass null for sound since it's cued, and override status to 'paused' (cued is a type of paused state)
        sendPlaybackTimeUpdateRef(cueId, null, playlistState, cuedName, 'paused');
    }
    
    console.log(`🔵 AudioPlaybackManager: Playlist ${cueId} cued at index ${clampedIndex} (${cuedName})`);
}

// Helper function to start a playlist at a specific position
function startPlaylistAtPosition(cueId, targetIndex, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, cuePlayOrder) {
    console.log(`🔵 AudioPlaybackManager: startPlaylistAtPosition called for ${cueId}, index ${targetIndex}`);
    
    // Check if playlist already has state - if so, update it instead of skipping
    if (currentlyPlaying[cueId]) {
        console.log(`🔵 AudioPlaybackManager: Playlist ${cueId} already has state, updating to index ${targetIndex}`);
        const existingState = currentlyPlaying[cueId];
        
        // Stop any existing sound
        if (existingState.sound) {
            try {
                existingState.sound.stop();
                existingState.sound.unload();
            } catch (error) {
                console.warn(`Error stopping existing sound during restart:`, error);
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

function playlistNavigateNext(cueId, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, startPlaylistAtPosition, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef = null) {
    const timestamp = new Date().toISOString();
    log.debug(`Playlist navigate next for cue ${cueId} at ${timestamp}`);
    
    // Block rapid navigation calls
    if (navigationBlocked.has(cueId)) {
        console.log(`🔵 AudioPlaybackManager: Navigation blocked for ${cueId}, ignoring rapid call at ${timestamp}`);
        return true;
    }
    
    // Block navigation for this cue for 300ms (reduced to be less aggressive)
    navigationBlocked.add(cueId);
    console.log(`🔵 AudioPlaybackManager: Navigation blocked added for ${cueId} at ${timestamp}`);
    setTimeout(() => {
        navigationBlocked.delete(cueId);
        console.log(`🔵 AudioPlaybackManager: Navigation unblocked for ${cueId} at ${new Date().toISOString()}`);
    }, 100);
    
    console.log(`🔵 AudioPlaybackManager: Starting navigation for ${cueId} at ${timestamp}`);
    
    const playingState = currentlyPlaying[cueId];
    console.log(`🔵 AudioPlaybackManager: Playing state for ${cueId}:`, playingState ? {
        isPlaylist: playingState.isPlaylist,
        currentPlaylistItemIndex: playingState.currentPlaylistItemIndex,
        isPaused: playingState.isPaused,
        isCuedNext: playingState.isCuedNext
    } : 'null');
    
    // Get the cue data to check if it's a playlist
    const cue = getGlobalCueByIdRef(cueId);
    console.log(`🔵 AudioPlaybackManager: Cue data for ${cueId}:`, cue ? {
        type: cue.type,
        playlistItemsLength: cue.playlistItems?.length || 0,
        name: cue.name
    } : 'null');
    
    if (!cue || cue.type !== 'playlist') {
        log.warn(`playlistNavigateNext called for non-playlist cue ${cueId}`);
        return false;
    }
    
    // If playlist is not currently playing (no state OR no sound instance), determine next position to CUE (not play)
    if (!playingState || !playingState.sound) {
        // Get last known position for this playlist, or start at 0
        let startIndex = lastPlaylistPositions.get(cueId);
        if (startIndex === undefined) {
            startIndex = 0; // Start from beginning if no history
        }
        startIndex = startIndex + 1; // Move to next item
        
        // Get playlist length to check bounds
        const cue = getGlobalCueByIdRef(cueId);
        const maxIndex = (cue.playlistItems || []).length - 1;
        
        if (startIndex > maxIndex) {
            if (cue.loop) {
                startIndex = 0; // Loop back to start if at end
            } else {
                startIndex = maxIndex; // Stay at last item if no loop
            }
        }
        
        log.info(`Idle playlist navigation: Cueing ${cueId} at index ${startIndex} (last position was ${lastPlaylistPositions.get(cueId) || 'start'})`);
        
        // Update the last position
        lastPlaylistPositions.set(cueId, startIndex);
        
        // CUE the playlist at this position (don't play it)
        _cuePlaylistAtPosition(cueId, startIndex, currentlyPlaying, getGlobalCueByIdRef, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder || [], sendPlaybackTimeUpdateRef);
        return true;
    }
    
    if (!playingState.isPlaylist) {
        log.warn(`playlistNavigateNext called for non-playlist playingState ${cueId}`);
        return false;
    }
    
    const mainCue = playingState.cue;
    
    // Use current index from the state
    const currentIndex = playingState.currentPlaylistItemIndex;
    const currentOrderLength = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                              ? playingState.shufflePlaybackOrder.length 
                              : playingState.originalPlaylistItems.length;
    
    let nextIndex = currentIndex + 1;
    
    console.log(`🔵 AudioPlaybackManager: BEFORE NAVIGATION - Current index: ${currentIndex}, Next index: ${nextIndex}, Playlist length: ${currentOrderLength}`);
    
    // Handle end of playlist
    if (nextIndex >= currentOrderLength) {
        if (mainCue.loop) {
            nextIndex = 0; // Loop back to start
            console.log(`🔵 AudioPlaybackManager: Looping back to start (index 0)`);
            // Re-shuffle if needed
            if (mainCue.shuffle && playingState.originalPlaylistItems.length > 1) {
                _generateShuffleOrder(cueId);
            }
        } else {
            log.info(`Playlist ${cueId} at end, cannot navigate next without loop`);
            // Stay at current position instead of clearing state
            return false;
        }
    }
    
    // Set navigation flag to prevent cleanup during navigation (short duration)
    playingState.isNavigating = true;
    
    // Stop current sound and play next item
    if (playingState.sound) {
        try {
            // Remove event listeners before stopping to prevent ghost events
            const soundToStop = playingState.sound;
            soundToStop.off(); // Remove all event listeners
            soundToStop.stop();
            soundToStop.unload();
        } catch (error) {
            console.warn(`Error stopping sound during navigation for ${cueId}:`, error);
        }
        playingState.sound = null;
    }
    
    log.info(`Navigating playlist ${cueId} to next item (index ${nextIndex})`);
    
    // Update the current playlist item index
    playingState.currentPlaylistItemIndex = nextIndex;
    playingState.isCuedNext = false;
    playingState.isPaused = false;
    
    console.log(`🔵 AudioPlaybackManager: Playing item at index ${nextIndex} for ${cueId}`);
    
    // Play the next item immediately
    _playTargetItem(cueId, nextIndex, false);
    
    // Update playlist highlighting if available
    if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
        const mainCue = playingState.cue;
        let cuedOriginalIdx = nextIndex;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > nextIndex) {
            cuedOriginalIdx = playingState.shufflePlaybackOrder[nextIndex];
        }
        const playingItem = playingState.originalPlaylistItems[cuedOriginalIdx];
        if (playingItem && playingItem.id) {
            sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, playingItem.id);
        }
    }
    
    // Update last position tracker
    lastPlaylistPositions.set(cueId, nextIndex);
    
    // Clear navigation flag quickly after the play call completes
    setTimeout(() => {
        if (currentlyPlaying[cueId]) {
            currentlyPlaying[cueId].isNavigating = false;
            console.log(`🔵 AudioPlaybackManager: Navigation flag cleared for ${cueId}`);
        }
    }, 50); // Very short delay just to let the play operation start
    
    return true;
}

function playlistNavigatePrevious(cueId, fromExternal, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, _generateShuffleOrder, startPlaylistAtPosition, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef = null) {
    const timestamp = new Date().toISOString();
    log.debug(`Playlist navigate previous for cue ${cueId} at ${timestamp}`);
    
    // Block rapid navigation calls
    if (navigationBlocked.has(cueId)) {
        console.log(`🔵 AudioPlaybackManager: Navigation blocked for ${cueId}, ignoring rapid call at ${timestamp}`);
        return true;
    }
    
    // Block navigation for this cue for 300ms (reduced to be less aggressive)
    navigationBlocked.add(cueId);
    console.log(`🔵 AudioPlaybackManager: Navigation blocked added for ${cueId} at ${timestamp}`);
    setTimeout(() => {
        navigationBlocked.delete(cueId);
        console.log(`🔵 AudioPlaybackManager: Navigation unblocked for ${cueId} at ${new Date().toISOString()}`);
    }, 100);
    
    console.log(`🔵 AudioPlaybackManager: Starting navigation for ${cueId} at ${timestamp}`);
    
    const playingState = currentlyPlaying[cueId];
    
    // Get the cue data to check if it's a playlist
    const cue = getGlobalCueByIdRef(cueId);
    if (!cue || cue.type !== 'playlist') {
        log.warn(`playlistNavigatePrevious called for non-playlist cue ${cueId}`);
        return false;
    }
    
    // If playlist is not currently playing, cue it at the previous position
    if (!playingState || !playingState.sound) {
        // Get current position or default to last item
        let prevIndex = lastPlaylistPositions.get(cueId);
        if (prevIndex === undefined || prevIndex <= 0) {
            prevIndex = (cue.playlistItems || []).length - 1; // Go to last item
        } else {
            prevIndex = prevIndex - 1; // Go to previous item
        }
        
        log.info(`Idle playlist navigation: Cueing ${cueId} at index ${prevIndex}`);
        lastPlaylistPositions.set(cueId, prevIndex);
        
        // CUE the playlist at this position (don't play it)
        _cuePlaylistAtPosition(cueId, prevIndex, currentlyPlaying, getGlobalCueByIdRef, _generateShuffleOrder, sidebarsAPIRef, cuePlayOrder || [], sendPlaybackTimeUpdateRef);
        return true;
    }
    
    if (!playingState.isPlaylist) {
        log.warn(`playlistNavigatePrevious called for non-playlist playingState ${cueId}`);
        return false;
    }
    
    const mainCue = playingState.cue;
    const currentOrderLength = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                              ? playingState.shufflePlaybackOrder.length 
                              : playingState.originalPlaylistItems.length;
    
    const currentIndex = playingState.currentPlaylistItemIndex;
    let prevIndex = currentIndex - 1;
    
    console.log(`🔵 AudioPlaybackManager: Current index: ${currentIndex}, Previous index: ${prevIndex}, Playlist length: ${currentOrderLength}`);
    
    // Handle beginning of playlist
    if (prevIndex < 0) {
        if (mainCue.loop) {
            prevIndex = currentOrderLength - 1; // Loop to end
            console.log(`🔵 AudioPlaybackManager: Looping to end (index ${prevIndex})`);
        } else {
            log.info(`Playlist ${cueId} at beginning, cannot navigate previous without loop`);
            return false;
        }
    }
    
    // Set navigation flag to prevent cleanup during navigation (short duration)
    playingState.isNavigating = true;
    
    // Stop current sound and play previous item
    if (playingState.sound) {
        try {
            // Remove event listeners before stopping to prevent ghost events
            const soundToStop = playingState.sound;
            soundToStop.off(); // Remove all event listeners
            soundToStop.stop();
            soundToStop.unload();
        } catch (error) {
            console.warn(`Error stopping sound during navigation for ${cueId}:`, error);
        }
        playingState.sound = null;
    }
    
    log.info(`Navigating playlist ${cueId} to previous item (index ${prevIndex})`);
    
    // Update the current playlist item index
    playingState.currentPlaylistItemIndex = prevIndex;
    playingState.isCuedNext = false;
    playingState.isPaused = false;
    
    console.log(`🔵 AudioPlaybackManager: Playing item at index ${prevIndex} for ${cueId}`);
    
    // Play the previous item immediately
    _playTargetItem(cueId, prevIndex, false);
    
    // Update playlist highlighting if available
    if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
        const mainCue = playingState.cue;
        let cuedOriginalIdx = prevIndex;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > prevIndex) {
            cuedOriginalIdx = playingState.shufflePlaybackOrder[prevIndex];
        }
        const playingItem = playingState.originalPlaylistItems[cuedOriginalIdx];
        if (playingItem && playingItem.id) {
            sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, playingItem.id);
        }
    }
    
    // Clear navigation flag quickly after the play call completes
    setTimeout(() => {
        if (currentlyPlaying[cueId]) {
            currentlyPlaying[cueId].isNavigating = false;
            console.log(`🔵 AudioPlaybackManager: Navigation flag cleared for ${cueId}`);
        }
    }, 50); // Very short delay just to let the play operation start
    
    return true;
}

export {
    startPlaylistAtPosition,
    playlistNavigateNext,
    playlistNavigatePrevious,
    _cuePlaylistAtPosition,
    navigationBlocked,
    lastPlaylistPositions
};
