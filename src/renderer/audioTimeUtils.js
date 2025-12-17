// Retrieve shared utilities from the global scope (loaded via <script> in index.html)
const { formatTimeMMSS, calculateEffectiveTrimmedDurationSec } = window.timeUtils || {
    formatTimeMMSS: (s) => '00:00',
    calculateEffectiveTrimmedDurationSec: () => 0
};

/**
 * Gets current playback times for a cue.
 * This function is now the "Util" version, designed to be called by audioController.
 * @param {Howl | null} sound - The active Howler sound instance, or null if idle/no sound.
 * @param {number} itemBaseDuration - The known duration of the current item (for single cue, it's the cue's duration; for playlist, current item's).
 * @param {Array | null} playlistOriginalItems - Array of original playlist items if mainCue is a playlist.
 * @param {number | null} currentPlaylistItemLogicalIndex - The logical index (respecting shuffle order) of the currently playing/cued item in a playlist.
 * @param {object} mainCue - The full cue object from cueStore.
 * @param {Array | null} playlistShuffleOrder - The shuffle order array if playlist is shuffled.
 * @param {boolean} isCurrentlyCuedNext - True if playlist is in 'stop_after_item_cue_next' mode and cued to the next item.
 * @returns {object} Object with currentTime, totalPlaylistDuration, currentItemDuration, currentItemRemainingTime, rawDuration
 */
function getPlaybackTimesUtil(
    sound, 
    itemBaseDuration, 
    playlistOriginalItems, 
    currentPlaylistItemLogicalIndex, 
    mainCue,
    playlistShuffleOrder,
    isCurrentlyCuedNext // True if playlist item ended and next is cued (for stop_after_item_cue_next mode)
) {
    let currentTime = 0;
    let displayTotalDuration = 0; // What the UI shows as "total" (can be playlist total or item total)
    let displayCurrentItemDuration = 0; // What the UI shows for the current item
    let displayItemRemainingTime = 0;
    let rawSoundDuration = 0; // Actual Howler sound.duration() if available

    if (!mainCue) {
        return { currentTime: 0, totalPlaylistDuration: 0, currentItemDuration: 0, currentItemRemainingTime: 0, rawDuration: 0 };
    }
    
    if (sound && typeof sound.seek === 'function' && sound.playing()) {
        // --- ACTIVE SOUND ---
        currentTime = sound.seek();
        rawSoundDuration = sound.duration() || 0; // Duration of the specific playing Howl instance
        displayCurrentItemDuration = itemBaseDuration > 0 ? itemBaseDuration : rawSoundDuration;

        if (mainCue.type === 'playlist') {
            if (playlistOriginalItems && playlistOriginalItems.length > 0) {
                // FIX: Only calculate total if we have valid durations for items
                const itemsWithValidDurations = playlistOriginalItems.filter(item => item.knownDuration && item.knownDuration > 0);
                if (itemsWithValidDurations.length === playlistOriginalItems.length) {
                    // All items have valid durations, calculate total
                    displayTotalDuration = playlistOriginalItems.reduce((total, item) => total + (item.knownDuration || 0), 0);
                } else {
                    // Some items missing durations, use current item duration as fallback
                    displayTotalDuration = displayCurrentItemDuration;
                    // console.log(`audioTimeUtils: Playlist ${mainCue.id} has ${playlistOriginalItems.length - itemsWithValidDurations.length} items without durations, using current item duration as fallback`);
                }
                if (mainCue.repeatOne) {
                    // If repeating one item, total duration effectively becomes that item's duration.
                     displayTotalDuration = displayCurrentItemDuration;
                }
            } else {
                displayTotalDuration = 0; // No items in playlist
            }
        } else { // Single file cue
            displayTotalDuration = displayCurrentItemDuration; // For single cue, total is its own duration
        }
        
        // Adjust for trim times (applies primarily to single file cues, or individual playlist items if they had such properties)
        if (mainCue.type !== 'playlist') {
            let actualSeek = sound.seek(); // Raw seek
            const trimStartTime = mainCue.trimStartTime || 0;
            const trimEndTime = mainCue.trimEndTime; // Can be undefined

            if (trimStartTime > 0) {
                currentTime = Math.max(0, actualSeek - trimStartTime);
                displayCurrentItemDuration = (itemBaseDuration > 0 ? itemBaseDuration : rawSoundDuration) - trimStartTime;
                if (trimEndTime && trimEndTime > trimStartTime) {
                    displayCurrentItemDuration = Math.min(displayCurrentItemDuration, trimEndTime - trimStartTime);
                }
                displayCurrentItemDuration = Math.max(0, displayCurrentItemDuration);
            } else if (trimEndTime && trimEndTime > 0 && trimEndTime < (itemBaseDuration > 0 ? itemBaseDuration : rawSoundDuration)) {
                // Only trimEndTime is set (and no trimStartTime)
                displayCurrentItemDuration = Math.min((itemBaseDuration > 0 ? itemBaseDuration : rawSoundDuration), trimEndTime);
            }
            // For single file cues, the "total" display is just the (potentially trimmed) item duration.
            displayTotalDuration = displayCurrentItemDuration;
        }
        displayItemRemainingTime = Math.max(0, displayCurrentItemDuration - currentTime);

    } else {
        // --- IDLE OR CUED STATE ---
        currentTime = 0; // No active playback
        
        if (mainCue.type === 'playlist') {
            if (playlistOriginalItems && playlistOriginalItems.length > 0) {
                // FIX: Only calculate total if we have valid durations for items
                const itemsWithValidDurations = playlistOriginalItems.filter(item => item.knownDuration && item.knownDuration > 0);
                if (itemsWithValidDurations.length === playlistOriginalItems.length) {
                    // All items have valid durations, calculate total
                    displayTotalDuration = playlistOriginalItems.reduce((total, item) => total + (item.knownDuration || 0), 0);
                } else {
                    // Some items missing durations, use first item duration as fallback
                    displayTotalDuration = playlistOriginalItems[0]?.knownDuration || 0;
                    // console.log(`audioTimeUtils: Playlist ${mainCue.id} has ${playlistOriginalItems.length - itemsWithValidDurations.length} items without durations in idle state, using first item duration as fallback`);
                }
                
                let itemToDisplayIndex = 0; // Default to the first item in logical order
                if (isCurrentlyCuedNext && currentPlaylistItemLogicalIndex !== null && currentPlaylistItemLogicalIndex < playlistOriginalItems.length) {
                    // If explicitly cued to a next item (e.g., after stop_after_item_cue_next)
                    itemToDisplayIndex = currentPlaylistItemLogicalIndex;
                }

                let actualItemOriginalIndex = itemToDisplayIndex;
                if (mainCue.shuffle && playlistShuffleOrder && playlistShuffleOrder.length > itemToDisplayIndex) {
                    actualItemOriginalIndex = playlistShuffleOrder[itemToDisplayIndex];
                }

                if (actualItemOriginalIndex >= 0 && actualItemOriginalIndex < playlistOriginalItems.length) {
                    displayCurrentItemDuration = playlistOriginalItems[actualItemOriginalIndex]?.knownDuration || 0;
                } else {
                    displayCurrentItemDuration = 0; // Invalid index, no valid item
                }

                if (mainCue.repeatOne) {
                    displayTotalDuration = displayCurrentItemDuration; // If repeatOne, total effectively becomes current item's.
                }
            }
        } else { // Single file cue
            // Use the shared utility for effective duration calculation
            displayCurrentItemDuration = calculateEffectiveTrimmedDurationSec(mainCue);
            displayTotalDuration = displayCurrentItemDuration;
        }
        displayItemRemainingTime = displayCurrentItemDuration; // In idle, remaining is full item duration
    }

    return {
        currentTime: typeof currentTime === 'number' ? currentTime : 0,
        totalPlaylistDuration: typeof displayTotalDuration === 'number' && isFinite(displayTotalDuration) ? displayTotalDuration : 0,
        currentItemDuration: typeof displayCurrentItemDuration === 'number' && isFinite(displayCurrentItemDuration) ? displayCurrentItemDuration : 0,
        currentItemRemainingTime: typeof displayItemRemainingTime === 'number' && isFinite(displayItemRemainingTime) ? displayItemRemainingTime : 0,
        rawDuration: typeof rawSoundDuration === 'number' ? rawSoundDuration : 0 // Raw duration of the Howl sound if playing
    };
}

export {
    formatTimeMMSS,
    getPlaybackTimesUtil,
    calculateEffectiveTrimmedDurationSec
};
