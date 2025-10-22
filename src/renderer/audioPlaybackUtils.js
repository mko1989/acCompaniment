// audioPlaybackUtils.js
// Utility functions for audio playback management

import { log } from './audioPlaybackLogger.js';

// Performance optimization: Pre-allocated objects to reduce garbage collection
const PERFORMANCE_CACHE = {
    // Reusable objects for getPlaybackState to reduce allocations
    playbackStateResponse: {
        isPlaying: false,
        isPaused: false,
        isPlaylist: false,
        currentTime: 0,
        currentTimeFormatted: '0:00',
        duration: 0,
        durationFormatted: '0:00',
        displayDuration: 0,
        displayDurationFormatted: '0:00',
        volume: 1,
        originalVolume: 1,
        isDucked: false,
        activeDuckingTriggerId: null,
        isCuedNext: false,
        isCued: false,
        itemBaseDuration: 0,
        currentPlaylistItemName: null,
        nextPlaylistItemName: null
    },
    // Cache for time calculations
    timeCalculationCache: {
        currentTime: 0,
        duration: 0,
        displayDuration: 0
    },
    // Cache for formatted time strings
    lastCurrentTime: -1,
    lastCurrentTimeFormatted: '',
    lastDuration: -1,
    lastDurationFormatted: ''
};

// Performance optimization: Throttle frequently called functions
const THROTTLE_CACHE = new Map();

function throttle(func, delay, key) {
    if (THROTTLE_CACHE.has(key)) {
        return THROTTLE_CACHE.get(key);
    }
    
    let timeoutId;
    let lastExecTime = 0;
    
    const throttledFunc = function(...args) {
        const currentTime = Date.now();
        
        if (currentTime - lastExecTime > delay) {
            lastExecTime = currentTime;
            return func.apply(this, args);
        } else {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                lastExecTime = Date.now();
                func.apply(this, args);
            }, delay - (currentTime - lastExecTime));
        }
    };
    
    THROTTLE_CACHE.set(key, throttledFunc);
    return throttledFunc;
}

function _generateShuffleOrder(cueId, currentlyPlaying) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist || !playingState.originalPlaylistItems) {
        console.error(`AudioPlaybackManager: _generateShuffleOrder called for ${cueId} but not a valid playlist state.`);
        playingState.shufflePlaybackOrder = []; // Ensure it's at least an empty array
        return;
    }
    const originalIndices = playingState.originalPlaylistItems.map((_, index) => index);
    
    // Fisher-Yates shuffle algorithm
    for (let i = originalIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [originalIndices[i], originalIndices[j]] = [originalIndices[j], originalIndices[i]];
    }
    playingState.shufflePlaybackOrder = originalIndices; // This now stores indices, not items
    console.log(`AudioPlaybackManager: Generated shuffle order (indices) for ${cueId}:`, playingState.shufflePlaybackOrder);
}

// Comprehensive cleanup for application shutdown or workspace changes
function cleanupAllResources(options, currentlyPlaying, pendingRestarts, playbackIntervals, allSoundInstances, _cleanupSoundInstance) {
    const { source = 'cleanupAllResources', forceUnload = true } = options;
    
    console.log(`AudioPlaybackManager: cleanupAllResources called. Source: ${source}`);
    
    // Get all active cues
    const activeCues = Object.keys(currentlyPlaying);
    console.log(`AudioPlaybackManager: Cleaning up ${activeCues.length} active cues`);
    
    // Clean up each active cue
    activeCues.forEach(cueId => {
        const state = currentlyPlaying[cueId];
        if (state) {
            console.log(`AudioPlaybackManager: Cleaning up cue ${cueId}`);
            _cleanupSoundInstance(cueId, state, { 
                forceUnload, 
                source: `${source}_cue_${cueId}` 
            });
        }
    });
    
    // Clear all pending restart operations
    Object.keys(pendingRestarts).forEach(cueId => {
        clearTimeout(pendingRestarts[cueId]);
        delete pendingRestarts[cueId];
        console.log(`AudioPlaybackManager: Cleared pending restart for ${cueId}`);
    });
    
    // Clear all remaining intervals (should be empty by now, but just in case)
    Object.keys(playbackIntervals).forEach(cueId => {
        clearInterval(playbackIntervals[cueId]);
        delete playbackIntervals[cueId];
        console.log(`AudioPlaybackManager: Cleared remaining interval for ${cueId}`);
    });
    
    // Clear state objects
    Object.keys(currentlyPlaying).forEach(key => delete currentlyPlaying[key]);
    Object.keys(playbackIntervals).forEach(key => delete playbackIntervals[key]);
    Object.keys(pendingRestarts).forEach(key => delete pendingRestarts[key]);
    Object.keys(allSoundInstances).forEach(key => delete allSoundInstances[key]);
    
    console.log(`AudioPlaybackManager: cleanupAllResources complete. ${activeCues.length} cues cleaned up.`);
}

function clearPerformanceCache() {
    THROTTLE_CACHE.clear();
    // Reset cached response objects
    Object.keys(PERFORMANCE_CACHE.playbackStateResponse).forEach(key => {
        PERFORMANCE_CACHE.playbackStateResponse[key] = 
            typeof PERFORMANCE_CACHE.playbackStateResponse[key] === 'boolean' ? false :
            typeof PERFORMANCE_CACHE.playbackStateResponse[key] === 'number' ? 0 :
            typeof PERFORMANCE_CACHE.playbackStateResponse[key] === 'string' ? '' : null;
    });
    log.info('Performance cache cleared');
}

export {
    PERFORMANCE_CACHE,
    THROTTLE_CACHE,
    throttle,
    _generateShuffleOrder,
    cleanupAllResources,
    clearPerformanceCache
};
