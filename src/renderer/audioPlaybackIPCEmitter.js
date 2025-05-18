let ipcBindings = null;
let formatTimeMMSS = null;

/**
 * Initializes the emitter with necessary dependencies.
 * @param {object} ipcRendererBindingsInstance - The IPC bindings instance.
 * @param {function} formatTimeMMSSFunc - The time formatting function.
 */
function init(ipcRendererBindingsInstance, formatTimeMMSSFunc) {
    ipcBindings = ipcRendererBindingsInstance;
    formatTimeMMSS = formatTimeMMSSFunc;
    console.log('AudioPlaybackIPCEmitter initialized.');
}

/**
 * Sends playback time updates via IPC.
 * @param {string} cueId - The ID of the cue.
 * @param {object} soundInstance - The Howler sound instance (can be null).
 * @param {object} playingState - The playing state object for the cue from audioController.
 * @param {string | null} currentItemName - Name of the current playlist item, if applicable.
 * @param {string | null} statusOverride - Optional status like 'playing', 'paused', 'stopped'.
 */
function sendPlaybackTimeUpdate(cueId, soundInstance, playingState, currentItemName, statusOverride = null) {
    if (!ipcBindings || !formatTimeMMSS) {
        console.warn('AudioPlaybackIPCEmitter not initialized or dependencies missing.');
        return;
    }

    if (!playingState || !playingState.cue) {
        console.warn(`AudioPlaybackIPCEmitter: Missing playingState or cue data for cueId: ${cueId}. playingState exists: ${!!playingState}, playingState.cue exists: ${!!(playingState && playingState.cue)}`);
        // Send a minimal stop message if cueId is known, to clear variables
        if (cueId) {
             ipcBindings.send('playback-time-update', {
                cueId: cueId,
                cueName: '',
                playlistItemName: '',
                currentTimeSec: 0,
                totalDurationSec: 0,
                remainingTimeSec: 0,
                currentTimeFormatted: formatTimeMMSS(0),
                totalDurationFormatted: formatTimeMMSS(0),
                remainingTimeFormatted: formatTimeMMSS(0),
                status: 'stopped'
            });
        }
        return;
    }

    const cue = playingState.cue;
    let currentTimeSec = 0;
    let totalDurationSec = playingState.duration || 0; // Use stored duration on playingState
    let status = statusOverride || 'stopped'; // Default to stopped if no override

    if (soundInstance && soundInstance.playing()) {
        currentTimeSec = soundInstance.seek() || 0;
        status = statusOverride || 'playing';
    } else if (soundInstance && playingState.isPaused) {
        currentTimeSec = soundInstance.seek() || 0; // Get current time even if paused
        status = statusOverride || 'paused';
    } else if (statusOverride) {
        status = statusOverride;
        // If status is 'paused' but no soundInstance, use last known seek time if available (future enhancement)
        // For now, if 'paused' override with no sound, currentTimeSec remains 0 unless playingState has it
        if (status === 'paused' && playingState.lastSeekPosition !== undefined) {
            currentTimeSec = playingState.lastSeekPosition;
        }
    }


    // If totalDurationSec is not valid from playingState.duration, try cue.knownDuration
    if (totalDurationSec <= 0 && cue.knownDuration > 0) {
        totalDurationSec = cue.knownDuration;
    }
    // For playlists, the 'duration' on playingState refers to the current item.
    // If it's a single cue, and trim times are set, the effective duration might be different.
    // This logic is simplified here; getPlaybackTimesUtil handles complex trim logic.
    // For IPC, we primarily need current seek, and the item's full duration.

    if (!playingState.isPlaylist) {
        if (cue.trimStartTime && cue.trimStartTime > 0) {
            const originalSeek = soundInstance ? soundInstance.seek() : currentTimeSec;
            currentTimeSec = Math.max(0, originalSeek - cue.trimStartTime);
            
            let itemEffectiveDuration = (cue.knownDuration || totalDurationSec) - cue.trimStartTime;
            if (cue.trimEndTime && cue.trimEndTime > cue.trimStartTime) {
                itemEffectiveDuration = Math.min(itemEffectiveDuration, cue.trimEndTime - cue.trimStartTime);
            }
            totalDurationSec = Math.max(0, itemEffectiveDuration);
        } else if (cue.trimEndTime && cue.trimEndTime > 0 && cue.trimEndTime < (cue.knownDuration || totalDurationSec)) {
            totalDurationSec = Math.min(cue.knownDuration || totalDurationSec, cue.trimEndTime);
        }
    }
    // Ensure totalDuration is not negative after adjustments
    totalDurationSec = Math.max(0, totalDurationSec);


    const remainingTimeSec = Math.max(0, totalDurationSec - currentTimeSec);

    const payload = {
        cueId: cueId,
        cueName: cue.name || '',
        playlistItemName: playingState.isPlaylist ? (currentItemName || '') : '',
        currentTimeSec: currentTimeSec,
        totalDurationSec: totalDurationSec,
        remainingTimeSec: remainingTimeSec,
        currentTimeFormatted: formatTimeMMSS(currentTimeSec),
        totalDurationFormatted: formatTimeMMSS(totalDurationSec),
        remainingTimeFormatted: formatTimeMMSS(remainingTimeSec),
        status: status
    };
    
    console.log('AudioPlaybackIPCEmitter sending:', payload);
    ipcBindings.send('playback-time-update', payload);
}

export {
    init,
    sendPlaybackTimeUpdate
}; 