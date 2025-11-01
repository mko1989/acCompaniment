// Companion_soundboard/src/renderer/audioPlaybackStateManagement.js
// State management functions for audio playback management

import { log } from './audioPlaybackLogger.js';
import { PERFORMANCE_CACHE } from './audioPlaybackUtils.js';

// Current cue priority management functions
export function _addToPlayOrder(cueId, cuePlayOrder) {
    // Safety check: ensure cuePlayOrder is an array
    if (!cuePlayOrder || !Array.isArray(cuePlayOrder)) {
        console.warn('_addToPlayOrder: cuePlayOrder is not an array:', cuePlayOrder);
        return [cueId];
    }
    // Remove cueId if it already exists in the array
    const newOrder = cuePlayOrder.filter(id => id !== cueId);
    // Add to the beginning (most recent)
    newOrder.unshift(cueId);
    console.log(`AudioPlaybackManager: Updated play order - current: ${cueId}, order: [${newOrder.join(', ')}]`);
    return newOrder;
}

export function _removeFromPlayOrder(cueId, cuePlayOrder) {
    // Safety check: ensure cuePlayOrder is an array
    if (!cuePlayOrder || !Array.isArray(cuePlayOrder)) {
        console.warn('_removeFromPlayOrder: cuePlayOrder is not an array:', cuePlayOrder);
        return [];
    }
    const newOrder = cuePlayOrder.filter(id => id !== cueId);
    console.log(`AudioPlaybackManager: Removed ${cueId} from play order - remaining: [${newOrder.join(', ')}]`);
    return newOrder;
}

export function _getCurrentPriorityCue(cuePlayOrder, currentlyPlaying) {
    // Safety check: ensure cuePlayOrder is iterable
    if (!cuePlayOrder || !Array.isArray(cuePlayOrder)) {
        console.warn('_getCurrentPriorityCue: cuePlayOrder is not iterable:', cuePlayOrder);
        return null;
    }
    
    // Find the first cue in play order that is actually still playing
    for (const cueId of cuePlayOrder) {
        const playingState = currentlyPlaying[cueId];
        if (playingState && playingState.sound && (playingState.sound.playing() || playingState.isPaused)) {
            return cueId;
        }
    }
    return null;
}

export function _updateCurrentCueForCompanion(cuePlayOrder, currentlyPlaying, lastCurrentCueId, sendPlaybackTimeUpdateRef) {
    const newCurrentCueId = _getCurrentPriorityCue(cuePlayOrder, currentlyPlaying);
    
    if (newCurrentCueId !== lastCurrentCueId) {
        console.log(`AudioPlaybackManager: Current cue changed from ${lastCurrentCueId} to ${newCurrentCueId}`);
        
        // Send current cue update to companion
        if (sendPlaybackTimeUpdateRef && newCurrentCueId) {
            const playingState = currentlyPlaying[newCurrentCueId];
            if (playingState && playingState.sound) {
                const currentItemName = playingState.isPlaylist ? 
                    playingState.originalPlaylistItems[playingState.currentPlaylistItemIndex]?.name || null : 
                    null;
                
                // Send special update with "current_cue" prefix for companion variables
                sendPlaybackTimeUpdateRef(
                    `current_cue_${newCurrentCueId}`, 
                    playingState.sound, 
                    playingState, 
                    currentItemName, 
                    playingState.sound.playing() ? 'playing' : 'paused'
                );
            }
        }
        
        return newCurrentCueId;
    }
    
    return lastCurrentCueId;
}

// Enhanced memory management utility
export function _cleanupSoundInstance(cueId, state, options = {}, context) {
    // Safety check: ensure context is provided
    if (!context) {
        log.error(`_cleanupSoundInstance: Context is undefined for ${cueId}`);
        // Fallback: try to delete from global state if available
        if (state && typeof state.sound !== 'undefined' && state.sound) {
            try {
                if (state.sound.playing && typeof state.sound.playing === 'function' && state.sound.playing()) {
                    state.sound.stop();
                }
                state.sound.off();
                if (options.forceUnload) {
                    state.sound.unload();
                }
            } catch (error) {
                log.error(`_cleanupSoundInstance: Error during fallback cleanup for ${cueId}:`, error);
            }
        }
        return;
    }
    
    const {
        currentlyPlaying,
        playbackIntervals,
        pendingRestarts,
        sidebarsAPIRef,
        _removeFromPlayOrder,
        _updateCurrentCueForCompanion
    } = context;

    const { 
        forceUnload = false, 
        clearIntervals = true, 
        clearTimers = true,
        clearState = true,
        source = 'unknown'
    } = options;
    
    log.debug(`_cleanupSoundInstance for ${cueId}. Source: ${source}, forceUnload: ${forceUnload}`);
    
    if (!state) {
        log.warn(`_cleanupSoundInstance: No state provided for ${cueId}`);
        return;
    }
    
    // Clear intervals first to prevent memory leaks
    if (clearIntervals) {
        if (state.timeUpdateInterval) {
            clearInterval(state.timeUpdateInterval);
            state.timeUpdateInterval = null;
            log.verbose(`_cleanupSoundInstance: Cleared state interval for ${cueId}`);
        }
        
        if (playbackIntervals[cueId]) {
            clearInterval(playbackIntervals[cueId]);
            delete playbackIntervals[cueId];
            log.verbose(`_cleanupSoundInstance: Cleared global interval for ${cueId}`);
        }
    }
    
    // Clear timers
    if (clearTimers) {
        if (state.trimEndTimer) {
            clearTimeout(state.trimEndTimer);
            state.trimEndTimer = null;
            log.verbose(`_cleanupSoundInstance: Cleared trimEndTimer for ${cueId}`);
        }
        
        // Clear any pending restart operations
        if (pendingRestarts[cueId]) {
            clearTimeout(pendingRestarts[cueId]);
            delete pendingRestarts[cueId];
            log.verbose(`_cleanupSoundInstance: Cleared pending restart for ${cueId}`);
        }
    }
    
    // Handle sound instance cleanup
    if (state.sound) {
        const sound = state.sound;
        
        try {
            // Stop the sound if it's playing
            if (sound.playing()) {
                log.verbose(`_cleanupSoundInstance: Stopping playing sound for ${cueId}`);
                sound.stop();
            }
            
            // Remove all event listeners to prevent memory leaks and interference
            log.verbose(`_cleanupSoundInstance: Removing event listeners for ${cueId}`);
            sound.off();
            
            // Only unload if explicitly forced (e.g., during app shutdown)
            // For normal cleanup, just stop and remove event listeners to allow reuse
            if (forceUnload) {
                log.verbose(`_cleanupSoundInstance: Force unloading sound for ${cueId}`);
                sound.unload();
            } else {
                log.verbose(`_cleanupSoundInstance: Stopping sound for ${cueId} (preserving for reuse)`);
                // Just stop the sound, don't unload to allow reuse via preloading system
            }
            
        } catch (error) {
            log.error(`_cleanupSoundInstance: Error during sound cleanup for ${cueId}:`, error);
            
            // Force unload even if there was an error
            try {
                sound.unload();
            } catch (unloadError) {
                log.error(`_cleanupSoundInstance: Error during force unload for ${cueId}:`, unloadError);
            }
        }
        
        // Clear the sound reference
        state.sound = null;
    }
    
    // Clear fade-related state
    state.isFadingIn = false;
    state.isFadingOut = false;
    state.fadeTotalDurationMs = 0;
    state.fadeStartTime = 0;
    state.acIsStoppingWithFade = false;
    state.acStopSource = null;
    state.explicitStopReason = null;
    
    // Clear ducking state
    state.isDucked = false;
    state.activeDuckingTriggerId = null;
    state.originalVolumeBeforeDuck = null;
    
    // Clear the state from global tracking if requested
    if (clearState && currentlyPlaying[cueId] === state) {
        delete currentlyPlaying[cueId];
        // Remove from play order and update current cue
        // Ensure cuePlayOrder is an array before passing to _removeFromPlayOrder
        const currentCuePlayOrder = context.cuePlayOrder || [];
        context.cuePlayOrder = _removeFromPlayOrder(cueId, currentCuePlayOrder);
        context.lastCurrentCueId = _updateCurrentCueForCompanion(context.cuePlayOrder, currentlyPlaying, context.lastCurrentCueId, context.sendPlaybackTimeUpdateRef);
        
        // Clear playlist highlighting
        if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
            sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, null);
        }
        
        log.verbose(`_cleanupSoundInstance: Cleared global state for ${cueId}`);
    }
    
    log.debug(`_cleanupSoundInstance: Cleanup complete for ${cueId}`);
}

// Performance-optimized version of getPlaybackState
export function getPlaybackState(cueId, context) {
    const {
        currentlyPlaying,
        getPlaybackTimesUtilRef,
        formatTimeMMSSRef
    } = context;

    const playingState = currentlyPlaying[cueId];
    if (!playingState) {
        return null;
    }

    const sound = playingState.sound;
    const mainCueFromState = playingState.cue;
    
    // Reuse the cached response object to reduce allocations
    const response = PERFORMANCE_CACHE.playbackStateResponse;
    
    // CRITICAL FIX: Check if sound is actually playing AND not in a cued state (for playlists)
    // Also ensure sound is not null and has valid duration to prevent false "playing" states
    if (sound && sound.playing && typeof sound.playing === 'function' && sound.playing() && 
        sound.duration && sound.duration() > 0 && // Ensure sound has valid duration
        !(playingState.isPlaylist && (playingState.isCuedNext || playingState.isPaused))) {
        // Cache time calculations to avoid repeated calls
        const times = getPlaybackTimesUtilRef ? getPlaybackTimesUtilRef(
            sound, 
            playingState.duration, 
            playingState.originalPlaylistItems, 
            playingState.currentPlaylistItemIndex, 
            mainCueFromState,
            playingState.shufflePlaybackOrder,
            playingState.isCuedNext
        ) : PERFORMANCE_CACHE.timeCalculationCache;

        // Optimize duration calculations
        const itemBaseDuration = playingState.isPlaylist ? 
            (playingState.originalPlaylistItems && playingState.originalPlaylistItems[playingState.currentPlaylistItemIndex]?.knownDuration) || 0 :
            (mainCueFromState.knownDuration || 0);
        
        const displayDuration = playingState.isPlaylist ? times.totalPlaylistDuration : itemBaseDuration;
        
        // Optimize time formatting - only format when values change
        let currentTimeFormatted = '00:00';
        let durationFormatted = '00:00';
        
        if (formatTimeMMSSRef) {
            if (times.currentTime !== PERFORMANCE_CACHE.lastCurrentTime) {
                PERFORMANCE_CACHE.lastCurrentTime = times.currentTime;
                currentTimeFormatted = formatTimeMMSSRef(times.currentTime);
                PERFORMANCE_CACHE.lastCurrentTimeFormatted = currentTimeFormatted;
            } else {
                currentTimeFormatted = PERFORMANCE_CACHE.lastCurrentTimeFormatted;
            }
            
            if (displayDuration !== PERFORMANCE_CACHE.lastDuration) {
                PERFORMANCE_CACHE.lastDuration = displayDuration;
                durationFormatted = formatTimeMMSSRef(displayDuration);
                PERFORMANCE_CACHE.lastDurationFormatted = durationFormatted;
            } else {
                durationFormatted = PERFORMANCE_CACHE.lastDurationFormatted;
            }
        }

        // Get playlist item names efficiently
        let currentPlaylistItemName = null;
        let nextPlaylistItemName = null;
        
        if (playingState.isPlaylist) {
            // Get current item name - use shuffle order if shuffled
            const currentLogicalIndex = playingState.currentPlaylistItemIndex;
            let currentOriginalIndex = currentLogicalIndex;
            
            if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > currentLogicalIndex) {
                currentOriginalIndex = playingState.shufflePlaybackOrder[currentLogicalIndex];
            }
            
            if (currentOriginalIndex >= 0 && currentOriginalIndex < playingState.originalPlaylistItems.length) {
                const currentItem = playingState.originalPlaylistItems[currentOriginalIndex];
                currentPlaylistItemName = currentItem?.name || currentItem?.path?.split(/[\\\/]/).pop() || `Item ${currentOriginalIndex + 1}`;
            }
            
            // Calculate next item name - use shuffle order if shuffled
            let nextLogicalIndex = currentLogicalIndex + 1;
            let nextOriginalIndex = nextLogicalIndex;
            
            if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder) {
                if (nextLogicalIndex < playingState.shufflePlaybackOrder.length) {
                    nextOriginalIndex = playingState.shufflePlaybackOrder[nextLogicalIndex];
                } else if (mainCueFromState.loop && playingState.shufflePlaybackOrder.length > 0) {
                    // Loop back to first item in shuffle order
                    nextOriginalIndex = playingState.shufflePlaybackOrder[0];
                } else {
                    nextOriginalIndex = -1; // No next item
                }
            } else {
                if (nextLogicalIndex >= playingState.originalPlaylistItems.length) {
                    if (mainCueFromState.loop) {
                        nextOriginalIndex = 0; // Loop back to first item
                    } else {
                        nextOriginalIndex = -1; // No next item
                    }
                }
            }
            
            if (nextOriginalIndex >= 0 && nextOriginalIndex < playingState.originalPlaylistItems.length) {
                const nextItem = playingState.originalPlaylistItems[nextOriginalIndex];
                nextPlaylistItemName = nextItem?.name || nextItem?.path?.split(/[\\\/]/).pop() || `Item ${nextOriginalIndex + 1}`;
            }
        }

        // Update response object properties (reusing same object)
        response.isPlaying = true;
        response.isPaused = playingState.isPaused;
        response.isPlaylist = mainCueFromState.type === 'playlist';
        response.volume = sound.volume();
        response.currentTime = times.currentTime;
        response.currentTimeFormatted = currentTimeFormatted;
        response.duration = displayDuration;
        response.durationFormatted = durationFormatted;
        response.isFadingIn = playingState.isFadingIn || false;
        response.isFadingOut = playingState.isFadingOut || false;
        response.isDucked = playingState.isDucked || false;
        response.activeDuckingTriggerId = playingState.activeDuckingTriggerId || null;
        response.isCuedNext = playingState.isCuedNext || false;
        response.isCued = playingState.isCued || false;
        response.itemBaseDuration = itemBaseDuration;
        response.currentPlaylistItemName = currentPlaylistItemName;
        response.nextPlaylistItemName = nextPlaylistItemName;
        
        return response;
    } else if (playingState) {
        // Handle non-playing states efficiently
        const mainCueFromState = playingState.cue;

        // For cued playlists, optimize the response
        if (mainCueFromState && mainCueFromState.type === 'playlist' && 
            playingState.isPaused && (playingState.isCuedNext || playingState.isCued)) {
            
            let nextItemName = null;
            let nextItemDuration = 0;
            
            // Optimize next item lookup
            if (playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 0) {
                const nextLogicalIdx = playingState.currentPlaylistItemIndex;
                let nextOriginalIdx = nextLogicalIdx;
                
                if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > nextLogicalIdx) {
                    nextOriginalIdx = playingState.shufflePlaybackOrder[nextLogicalIdx];
                }
                
                if (nextOriginalIdx >= 0 && nextOriginalIdx < playingState.originalPlaylistItems.length) {
                    const nextItem = playingState.originalPlaylistItems[nextOriginalIdx];
                    nextItemName = nextItem?.name || `Item ${nextOriginalIdx + 1}`;
                    nextItemDuration = nextItem?.knownDuration || 0;
                }
            }
            
            // Update response object
            response.isPlaying = false;
            response.isPaused = true;
            response.isPlaylist = true;
            response.volume = mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0;
            response.currentTime = 0;
            response.currentTimeFormatted = '00:00';
            response.duration = nextItemDuration;
            response.durationFormatted = formatTimeMMSSRef ? formatTimeMMSSRef(nextItemDuration) : '00:00';
            response.isFadingIn = false;
            response.isFadingOut = false;
            response.isDucked = false;
            response.activeDuckingTriggerId = null;
            response.isCuedNext = playingState.isCuedNext || false;
            response.isCued = playingState.isCued || true;
            response.itemBaseDuration = nextItemDuration;
            response.currentPlaylistItemName = null;
            response.nextPlaylistItemName = nextItemName;
            
            return response;
        }
        
        // Handle other playlist states
        if (mainCueFromState && mainCueFromState.type === 'playlist' && mainCueFromState.playlistItems && mainCueFromState.playlistItems.length > 0) {
            const firstItemName = mainCueFromState.playlistItems[0]?.name || 'Item 1';
            const firstItemDuration = mainCueFromState.playlistItems[0]?.knownDuration || 0;
            
            response.isPlaying = false;
            response.isPaused = false;
            response.isPlaylist = true;
            response.volume = mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0;
            response.currentTime = 0;
            response.currentTimeFormatted = '00:00';
            response.duration = firstItemDuration;
            response.durationFormatted = formatTimeMMSSRef ? formatTimeMMSSRef(firstItemDuration) : '00:00';
            response.isFadingIn = false;
            response.isFadingOut = false;
            response.isDucked = false;
            response.activeDuckingTriggerId = null;
            response.isCuedNext = false;
            response.isCued = false;
            response.itemBaseDuration = firstItemDuration;
            response.currentPlaylistItemName = null;
            response.nextPlaylistItemName = firstItemName;
            
            return response;
        }
        
        // Handle other non-playing states (like paused single files)
        response.isPlaying = false;
        response.isPaused = playingState.isPaused;
        response.isPlaylist = false;
        response.volume = mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0;
        response.currentTime = 0;
        response.currentTimeFormatted = '00:00';
        response.duration = mainCueFromState.knownDuration || 0;
        response.durationFormatted = formatTimeMMSSRef ? formatTimeMMSSRef(mainCueFromState.knownDuration || 0) : '00:00';
        response.isFadingIn = false;
        response.isFadingOut = false;
        response.isDucked = false;
        response.activeDuckingTriggerId = null;
        response.isCuedNext = false;
        response.isCued = false;
        response.itemBaseDuration = mainCueFromState.knownDuration || 0;
        response.currentPlaylistItemName = null;
        response.nextPlaylistItemName = null;
        
        return response;
    }
    
    return null;
}
