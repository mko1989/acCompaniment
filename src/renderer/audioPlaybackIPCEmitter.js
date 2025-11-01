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

    // CAPTURE INITIAL VALUES & ADD LOGGING
    const initialPlayingStateDuration = playingState.duration;
    const initialCueKnownDuration = cue.knownDuration;

    let totalDurationSec = initialPlayingStateDuration || 0;
    // console.log(`[CUE_DURATION_DEBUG ${cueId}] Initial totalDurationSec from playingState.duration (${initialPlayingStateDuration}): ${totalDurationSec}`);

    if (totalDurationSec <= 0 && initialCueKnownDuration > 0) {
        totalDurationSec = initialCueKnownDuration;
        // console.log(`[CUE_DURATION_DEBUG ${cueId}] totalDurationSec updated from cue.knownDuration (${initialCueKnownDuration}): ${totalDurationSec}`);
    }
    // END CAPTURE INITIAL VALUES & ADD LOGGING

    // Check if cue is fading in or out - set status to 'fading' if so
    const isFading = playingState && (playingState.isFadingIn || playingState.isFadingOut);
    
    let status = statusOverride || 'stopped'; // Default to stopped if no override

    if (soundInstance && soundInstance.playing()) {
        currentTimeSec = soundInstance.seek() || 0;
        // If fading, override status to 'fading', otherwise use override or 'playing'
        status = isFading ? 'fading' : (statusOverride || 'playing');
    } else if (soundInstance && playingState.isPaused) {
        currentTimeSec = soundInstance.seek() || 0; // Get current time even if paused
        // If fading, override status to 'fading', otherwise use override or 'paused'
        status = isFading ? 'fading' : (statusOverride || 'paused');
    } else if (statusOverride) {
        // If fading and no sound instance, still set status to 'fading'
        status = isFading ? 'fading' : statusOverride;
        // If status is 'paused' but no soundInstance, use last known seek time if available (future enhancement)
        // For now, if 'paused' override with no sound, currentTimeSec remains 0 unless playingState has it
        if (status === 'paused' && playingState.lastSeekPosition !== undefined) {
            currentTimeSec = playingState.lastSeekPosition;
        } else if (status === 'stopped') {
            // CRITICAL FIX: For stopped cues, reset to 0 and ensure we calculate correct idle duration
            currentTimeSec = 0;
            console.log(`[CUE_DURATION_DEBUG ${cueId}] Status is 'stopped', reset currentTimeSec to 0`);
        }
    }

    // If totalDurationSec is not valid from playingState.duration, try cue.knownDuration
    // This specific block is now handled above with logging, but the original logic's intent is preserved.

    if (!playingState.isPlaylist) {
        // For logging, capture the duration before trimming is applied
        const preTrimTotalDurationSec = totalDurationSec;
        let itemEffectiveDuration = -1; // For logging if complex trim is applied

        if (cue.trimStartTime && cue.trimStartTime > 0) {
            // For stopped cues, don't adjust currentTimeSec based on seek position
            if (status !== 'stopped') {
                const originalSeek = soundInstance ? soundInstance.seek() : currentTimeSec;
                currentTimeSec = Math.max(0, originalSeek - cue.trimStartTime);
            }
            
            // Use initialCueKnownDuration if available, otherwise preTrimTotalDurationSec (which might itself be from knownDuration or playingState.duration)
            let sourceDurationForTrimCalc = (initialCueKnownDuration > 0 ? initialCueKnownDuration : preTrimTotalDurationSec);
            itemEffectiveDuration = sourceDurationForTrimCalc - cue.trimStartTime;

            if (cue.trimEndTime && cue.trimEndTime > cue.trimStartTime) {
                itemEffectiveDuration = Math.min(itemEffectiveDuration, cue.trimEndTime - cue.trimStartTime);
            }
            totalDurationSec = Math.max(0, itemEffectiveDuration);
            console.log(`[CUE_DURATION_DEBUG ${cueId}] Post-trim (start/end) totalDurationSec: ${totalDurationSec}. (Source for trim: ${sourceDurationForTrimCalc}, trimStart: ${cue.trimStartTime}, trimEnd: ${cue.trimEndTime}, calculated effectiveItemDur: ${itemEffectiveDuration})`);

        } else if (cue.trimEndTime && cue.trimEndTime > 0 && cue.trimEndTime < (initialCueKnownDuration > 0 ? initialCueKnownDuration : preTrimTotalDurationSec)) {
            // Use initialCueKnownDuration if available, otherwise preTrimTotalDurationSec
            let sourceDurationForTrimCalc = (initialCueKnownDuration > 0 ? initialCueKnownDuration : preTrimTotalDurationSec);
            totalDurationSec = Math.min(sourceDurationForTrimCalc, cue.trimEndTime);
            console.log(`[CUE_DURATION_DEBUG ${cueId}] Post-trim (end only) totalDurationSec: ${totalDurationSec}. (Source for trim: ${sourceDurationForTrimCalc}, trimEnd: ${cue.trimEndTime})`);
        }
    }
    // Ensure totalDuration is not negative after adjustments
    totalDurationSec = Math.max(0, totalDurationSec);


    const remainingTimeSec = Math.max(0, totalDurationSec - currentTimeSec);

    // ADD FINAL COMPREHENSIVE LOG (commented out to reduce log spam)
    // console.log(`[CUE_DURATION_DEBUG ${cueId}] Final IPC Payload Values:
    //     Status: ${status}
    //     Cue Name: ${cue.name || ''}
    //     Playlist Item Name: ${playingState.isPlaylist ? (currentItemName || '') : 'N/A'}
    //     CurrentTimeSec: ${currentTimeSec} (Formatted: ${formatTimeMMSS(currentTimeSec)})
    //     TotalDurationSec: ${totalDurationSec} (Formatted: ${formatTimeMMSS(totalDurationSec)})
    //     RemainingTimeSec: ${remainingTimeSec} (Formatted: ${formatTimeMMSS(remainingTimeSec)})
    //     Initial playingState.duration: ${initialPlayingStateDuration}
    //     Initial cue.knownDuration: ${initialCueKnownDuration}
    //     Is Playlist: ${playingState.isPlaylist}
    //     Trim Start: ${cue.trimStartTime || 'N/A'}, Trim End: ${cue.trimEndTime || 'N/A'}`);

    // Check if this is a current cue update (for Companion priority)
    const isCurrentCueUpdate = cueId.startsWith('current_cue_');
    const actualCueId = isCurrentCueUpdate ? cueId.replace('current_cue_', '') : cueId;
    
    const payload = {
        cueId: actualCueId,
        cueName: cue.name || '',
        playlistItemName: playingState.isPlaylist ? (currentItemName || '') : '',
        currentTimeSec: currentTimeSec,
        totalDurationSec: totalDurationSec,
        remainingTimeSec: remainingTimeSec,
        currentTimeFormatted: formatTimeMMSS(currentTimeSec),
        totalDurationFormatted: formatTimeMMSS(totalDurationSec),
        remainingTimeFormatted: formatTimeMMSS(remainingTimeSec),
        status: status,
        originalKnownDuration: cue.knownDuration || 0,
        isFadingIn: playingState ? playingState.isFadingIn || false : false,
        isFadingOut: playingState ? playingState.isFadingOut || false : false,
        fadeTimeRemainingMs: calculateRemainingFadeTime(playingState),
        fadeTotalDurationMs: playingState ? playingState.fadeTotalDurationMs || 0 : 0,
        isCurrentCue: isCurrentCueUpdate // Flag for Companion to know this is the priority cue
    };
    
    // console.log(`[IPC_DEBUG] AudioPlaybackIPCEmitter sending to 'playback-time-update':`, {cueId, currentTimeSec, status});
    ipcBindings.send('playback-time-update', payload);
}

// Helper function to calculate remaining fade time
function calculateRemainingFadeTime(playingState) {
    if (playingState?.isFadingIn || playingState?.isFadingOut) {
        if (playingState.fadeStartTime > 0 && playingState.fadeTotalDurationMs > 0) {
            const elapsedFadeTime = Date.now() - playingState.fadeStartTime;
            return Math.max(0, playingState.fadeTotalDurationMs - elapsedFadeTime);
        }
    }
    return 0;
}

export {
    init,
    sendPlaybackTimeUpdate
}; 