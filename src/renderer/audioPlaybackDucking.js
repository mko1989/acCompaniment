// audioPlaybackDucking.js
// Ducking logic for audio playback management

import { log } from './audioPlaybackLogger.js';

// --- Ducking Logic ---
const DUCKING_FADE_DURATION = 1000; // 1 second for ducking fades

function _applyDucking(triggerCueId, currentlyPlaying, getGlobalCueByIdRef) {
    log.debug(`Applying ducking triggered by ${triggerCueId}`);
    const triggerCue = getGlobalCueByIdRef(triggerCueId);
    if (!triggerCue || !triggerCue.isDuckingTrigger) return;

    const duckingLevelPercentage = triggerCue.duckingLevel !== undefined ? triggerCue.duckingLevel : 80; // Default 80%
    const targetVolumeMultiplier = 1 - (duckingLevelPercentage / 100);

    for (const cueId in currentlyPlaying) {
        if (cueId === triggerCueId) continue; // Don't duck the trigger itself

        const playingState = currentlyPlaying[cueId];
        const affectedCue = getGlobalCueByIdRef(cueId); // Get full cue data

        if (affectedCue && affectedCue.enableDucking && playingState.sound && !playingState.isDucked) {
            log.debug(`Ducking cue ${cueId} to ${duckingLevelPercentage}% due to trigger ${triggerCueId}`);
            playingState.originalVolumeBeforeDuck = playingState.sound.volume(); // Store current volume
            playingState.isDucked = true;
            playingState.activeDuckingTriggerId = triggerCueId;
            // Fade to ducked volume
            playingState.sound.fade(playingState.originalVolumeBeforeDuck, playingState.originalVolume * targetVolumeMultiplier, DUCKING_FADE_DURATION);
        }
    }
}

function _revertDucking(triggerCueIdStop, currentlyPlaying) {
    log.debug(`Reverting ducking for trigger ${triggerCueIdStop}`);
    for (const cueId in currentlyPlaying) {
        const playingState = currentlyPlaying[cueId];
        // Only revert if this specific trigger caused the ducking
        if (playingState.isDucked && playingState.activeDuckingTriggerId === triggerCueIdStop && playingState.sound) {
            log.debug(`Reverting duck for cue ${cueId} from trigger ${triggerCueIdStop}. Original volume: ${playingState.originalVolumeBeforeDuck}`);
            // FIXED: Fade back to the actual volume that was stored before ducking
            const targetVolume = playingState.originalVolumeBeforeDuck ?? 
                                (playingState.cue.volume ?? 1.0);
            playingState.sound.fade(playingState.sound.volume(), targetVolume, DUCKING_FADE_DURATION);
            playingState.isDucked = false;
            playingState.activeDuckingTriggerId = null;
            playingState.originalVolumeBeforeDuck = null; 
        }
    }
}

export {
    _applyDucking,
    _revertDucking,
    DUCKING_FADE_DURATION
};
