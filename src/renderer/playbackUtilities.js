/**
 * Utility functions for playback instance management
 */

/**
 * Helper function to find the next playable item in a playlist
 * @param {object} playingState - The playing state object
 * @param {number} currentIndex - Current item index
 * @returns {number} Index of next playable item, or -1 if none found
 */
export function findNextPlayableItem(playingState, currentIndex) {
    if (!playingState.isPlaylist || !playingState.originalPlaylistItems) {
        return -1;
    }
    
    const mainCue = playingState.cue;
    const items = playingState.originalPlaylistItems;
    const shuffleOrder = playingState.shufflePlaybackOrder;
    const failedItems = playingState.failedItems || new Set();
    
    // If we're in shuffle mode, use the shuffled order
    const orderToUse = (mainCue.playlistMode === 'shuffle' && shuffleOrder) ? shuffleOrder : 
                       Array.from({length: items.length}, (_, i) => i);
    
    const currentIndexInOrder = orderToUse.indexOf(currentIndex);
    if (currentIndexInOrder === -1) {
        console.warn(`[findNextPlayableItem] Current index ${currentIndex} not found in order`);
        return -1;
    }
    
    // Look for the next playable item starting from the next position
    for (let i = currentIndexInOrder + 1; i < orderToUse.length; i++) {
        const itemIndex = orderToUse[i];
        if (!failedItems.has(itemIndex)) {
            console.log(`[findNextPlayableItem] Found next playable item at index ${itemIndex}`);
            return itemIndex;
        }
    }
    
    console.log(`[findNextPlayableItem] No more playable items found after index ${currentIndex}`);
    return -1;
}

/**
 * Get audio codec support information for debugging
 * @returns {object} Object with codec support information
 */
export function getAudioCodecSupport() {
    const audio = document.createElement('audio');
    return {
        mp3: audio.canPlayType('audio/mpeg') !== '',
        wav: audio.canPlayType('audio/wav') !== '',
        ogg: audio.canPlayType('audio/ogg') !== '',
        aac: audio.canPlayType('audio/aac') !== '',
        m4a: audio.canPlayType('audio/mp4') !== '',
        flac: audio.canPlayType('audio/flac') !== ''
    };
}

/**
 * Get audio context information for debugging  
 * @returns {object} Audio context information or error details
 */
export function getAudioContextInfo() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            const ctx = new AudioContext();
            const info = {
                sampleRate: ctx.sampleRate,
                state: ctx.state,
                maxChannelCount: ctx.destination.maxChannelCount
            };
            ctx.close();
            return info;
        }
    } catch (e) {
        return { error: e.message };
    }
    return { error: 'AudioContext not available' };
}

/**
 * Send error notification to user interface
 * @param {object} errorContext - Error context object
 */
export function notifyErrorToUser(errorContext) {
    console.error('[notifyErrorToUser] Audio error occurred:', errorContext);
    
    // You could extend this to show user-facing notifications
    // For now, we'll just log the error context
    if (errorContext.specificError) {
        console.error(`[notifyErrorToUser] Specific error: ${errorContext.specificError}`);
    }
}
