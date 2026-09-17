/**
 * Ducking logic for playback instances
 */

/**
 * Apply ducking logic when a cue starts playing
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {object} audioControllerContext - Audio controller context
 */
export function applyDuckingOnPlay(cueId, sound, playingState, audioControllerContext) {
    // Ducking logic: Called on play
    const fullCueData = audioControllerContext.getGlobalCueById(cueId);
    if (fullCueData) {
        if (fullCueData.isDuckingTrigger) {
            console.log(`PlaybackDucking: Cue ${cueId} is a ducking trigger. Applying ducking.`);
            if (audioControllerContext._applyDucking) {
                audioControllerContext._applyDucking(cueId);
            } else {
                console.warn(`PlaybackDucking: _applyDucking function not available in audioControllerContext for cue ${cueId}`);
            }
        } else if (fullCueData.enableDucking) {
            // Check if any other trigger cue is currently active
            let activeTriggerCueDetails = null;
            for (const otherCueId in audioControllerContext.currentlyPlaying) {
                if (otherCueId === cueId) continue; // Skip self
                const otherPlayingState = audioControllerContext.currentlyPlaying[otherCueId];
                if (otherPlayingState && otherPlayingState.sound && otherPlayingState.sound.playing()) {
                    const otherFullCue = audioControllerContext.getGlobalCueById(otherCueId);
                    if (otherFullCue && otherFullCue.isDuckingTrigger) {
                        activeTriggerCueDetails = otherFullCue;
                        break;
                    }
                }
            }

            if (activeTriggerCueDetails) {
                console.log(`PlaybackDucking: Cue ${cueId} should start ducked due to active trigger ${activeTriggerCueDetails.id}.`);
                // Use the cue's configured volume as the base for ducking if starting ducked
                playingState.originalVolumeBeforeDuck = fullCueData.volume !== undefined ? fullCueData.volume : 1.0;
                const duckingLevelPercentage = activeTriggerCueDetails.duckingLevel !== undefined ? activeTriggerCueDetails.duckingLevel : 80;
                const targetVolumeMultiplier = 1 - (duckingLevelPercentage / 100);
                const duckToVolume = playingState.originalVolumeBeforeDuck * targetVolumeMultiplier;
                
                sound.volume(duckToVolume); // Set Howler's volume directly
                playingState.isDucked = true;
                playingState.activeDuckingTriggerId = activeTriggerCueDetails.id;
                console.log(`PlaybackDucking: Cue ${cueId} initial volume set to ${duckToVolume} (ducked).`);
            } else {
                // Ensure if it was previously ducked by a now-gone trigger, its volume is correct.
                // This path is less likely if _revertDucking works, but good for safety.
                if (playingState.isDucked) {
                     console.warn(`PlaybackDucking: Cue ${cueId} was marked isDucked but no active trigger. Resetting volume if needed.`);
                     // This implies a state inconsistency or a trigger stopped without proper reversion.
                     // Resetting to its own configured volume if different.
                     const configuredVolume = fullCueData.volume !== undefined ? fullCueData.volume : 1.0;
                     if (sound.volume() !== configuredVolume) {
                         sound.volume(configuredVolume);
                     }
                     playingState.isDucked = false;
                     playingState.activeDuckingTriggerId = null;
                     playingState.originalVolumeBeforeDuck = null; // Should have been cleared by _revertDucking
                }
            }
        }
    } else {
        console.warn(`PlaybackDucking: Could not get fullCueData for ${cueId} in onplay for ducking logic.`);
    }
}

/**
 * Handle ducking trigger stop - revert ducking for other cues
 * @param {string} cueId - The cue ID that stopped
 * @param {object} mainCue - The main cue object
 * @param {object} audioControllerContext - Audio controller context
 */
export function handleDuckingTriggerStop(cueId, mainCue, audioControllerContext) {
    // If the cue was a ducking trigger, revert ducking for other cues
    if (mainCue && mainCue.isDuckingTrigger) {
        console.log(`PlaybackDucking: Cue ${cueId} (a ducking trigger) stopped. Reverting ducking.`);
        if (audioControllerContext._revertDucking) {
            audioControllerContext._revertDucking(cueId);
        } else {
            console.warn(`PlaybackDucking: _revertDucking function not available in audioControllerContext for cue ${cueId}`);
        }
    }
}
