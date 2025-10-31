/**
 * Lifecycle event handlers for Howler sound instances (onend, onstop, onfade)
 */

import { handleDuckingTriggerStop } from './playbackDucking.js';
import { clearTimeUpdateIntervals, clearTrimEndTimer } from './playbackTimeManager.js';

/**
 * Create onend event handler
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} mainCue - The main cue object
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onend event handler
 */
export function createOnendHandler(cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext) {
    return () => {
        // console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Fired for ${filePath}.`);
        
        // Determine if this is a looping single cue - if so, don't cleanup, let Howler handle the loop
        const isLoopingSingleCue = !playingState.isPlaylist && mainCue.loop && !mainCue.trimStartTime && !mainCue.trimEndTime;
        
        // CRITICAL FIX: Clear time update intervals IMMEDIATELY to prevent continued "playing" status updates
        // This must happen before any other processing to stop the race condition
        // BUT: Don't clear intervals if looping - we want time updates to continue during loop
        if (!isLoopingSingleCue) {
            clearTimeUpdateIntervals(cueId, playingState, audioControllerContext);
            // console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Time update intervals cleared immediately to prevent race condition.`);
        }

        // CRITICAL FIX: Clear sound object immediately to prevent getPlaybackState from thinking it's still playing
        // BUT: Don't stop/cleanup if looping - Howler needs the sound instance to continue looping
        if (playingState.sound && !isLoopingSingleCue) {
            // console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Clearing sound object immediately to prevent false playing state.`);
            // Force stop the sound if it's still running (defensive programming)
            try {
                if (playingState.sound.playing && playingState.sound.playing()) {
                    playingState.sound.stop();
                }
                // Remove all event listeners to prevent memory leaks and interference
                playingState.sound.off();
            } catch (error) {
                console.warn(`[TIME_UPDATE_DEBUG ${cueId}] onend: Error stopping sound during cleanup:`, error);
            }
            playingState.sound = null;
        }

        let errorOccurred = false; // Placeholder, can be set by other event handlers if needed

        // Special handling for 'stop_and_cue_next' playlists:
        // The status update will be handled by _handlePlaylistEnd after it sets the cued state.
        // For other cases, send 'stopped' status now.
        const isStopAndCueNextPlaylist = playingState.isPlaylist && mainCue.playlistPlayMode === 'stop_and_cue_next';

        if (!isStopAndCueNextPlaylist && !isLoopingSingleCue) {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Not a 'stop_and_cue_next' playlist or not a playlist. Sending 'stopped' status.`);
            audioControllerContext.sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'stopped');
        } else if (isLoopingSingleCue) {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Looping single cue - skipping stopped status update. Howler will handle loop.`);
        } else {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Is a 'stop_and_cue_next' playlist. Deferring specific status update to _handlePlaylistEnd.`);
        }

        if (playingState.isPlaylist) {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Cue is a playlist. Calling _handlePlaylistEnd. Playlist Mode: ${mainCue.playlistPlayMode}`);
            // Time update intervals already cleared above - no need to clear again
            audioControllerContext._handlePlaylistEnd.call(audioControllerContext, cueId, errorOccurred, audioControllerContext);
        } else if (mainCue.loop) {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Single cue with loop=true. Howler should handle looping automatically.`);
            // IMPORTANT: Do NOT manually call sound.play() here!
            // When loop: true is set on the Howler instance, it handles looping internally.
            // Manual play() calls create overlapping instances, causing volume increase and distortion.
            // The onend event might fire during internal loop transitions, but we should let Howler handle it.
            
            // Only seek to trimStartTime if specified, but don't manually restart playback
            if (mainCue.trimStartTime && mainCue.trimStartTime > 0) {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Seeking to trimStartTime ${mainCue.trimStartTime} for loop.`);
                sound.seek(mainCue.trimStartTime);
            }
            // Note: We don't call sound.play() here because Howler's loop flag handles the restart
            // Also note: We don't cleanup the sound here because Howler needs it to continue looping
        } else {
            // Single cue, not looping, and not a playlist - it just ended.
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Single cue, no loop. Processing complete.`);
            // UI and state cleanup for a simple non-looping single cue that finished.
            if (audioControllerContext.currentlyPlaying[cueId]) { // Check if it wasn't already cleaned by a rapid stop call
                // Check if we're navigating - if so, don't delete the state
                if (audioControllerContext.currentlyPlaying[cueId].isNavigating || audioControllerContext.currentlyPlaying[cueId].preservedForNavigation) {
                    console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Navigation in progress, preserving state.`);
                    // Don't delete currentlyPlaying during navigation
                } else {
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
            if (audioControllerContext.cueGridAPI) audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            // IPC status update for 'stopped' was already sent above if not stop_and_cue_next
        }
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Cue item processing complete.`);
    };
}

/**
 * Create onstop event handler
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} mainCue - The main cue object
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onstop event handler
 */
export function createOnstopHandler(cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext) {
    return (soundId) => {
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Fired for ${filePath}. Sound ID: ${soundId}`);
        
        // Remove from all sound instances tracking
        if (sound._acSoundId && audioControllerContext.allSoundInstances && audioControllerContext.allSoundInstances[sound._acSoundId]) {
            delete audioControllerContext.allSoundInstances[sound._acSoundId];
            console.log(`[STOP_ALL_DEBUG] Removed sound instance ${sound._acSoundId} for cue ${cueId}. Remaining instances: ${Object.keys(audioControllerContext.allSoundInstances).length}`);
        }
        
        // Ensure this specific sound instance is the one we expect to stop.
        // This helps prevent a stale onstop from an old sound instance (e.g., after a quick restart)
        // from incorrectly clearing the state of a NEW sound instance.

        const globalPlayingStateForCue = audioControllerContext.currentlyPlaying[cueId];

        if (globalPlayingStateForCue && globalPlayingStateForCue.sound === sound) {
            // This 'onstop' pertains to the currently active sound instance for this cueId.
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Matched current sound instance. Processing stop for ${filePath}.`);

            // Clear Fading Flags
            globalPlayingStateForCue.isFadingIn = false;
            globalPlayingStateForCue.isFadingOut = false;
            globalPlayingStateForCue.fadeTotalDurationMs = 0;
            globalPlayingStateForCue.fadeStartTime = 0;

            // Send final 'stopped' update BEFORE fully deleting state
            // Use globalPlayingStateForCue as it's the definitive state object here.
            // Ensure currentItemNameForEvents is available or fallback if necessary
            const itemName = globalPlayingStateForCue.isPlaylist ? (globalPlayingStateForCue.originalPlaylistItems[globalPlayingStateForCue.currentItemIndex]?.name || currentItemNameForEvents || 'N/A') : (mainCue.name || 'N/A');
            audioControllerContext.sendPlaybackTimeUpdate(cueId, sound, globalPlayingStateForCue, itemName, 'stopped');

            // Now clear intervals and state
            clearTimeUpdateIntervals(cueId, globalPlayingStateForCue, audioControllerContext);
            clearTrimEndTimer(globalPlayingStateForCue);
            
            // Check if we're navigating - if so, don't delete the state
            if (globalPlayingStateForCue.isNavigating) {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Navigation in progress, preserving state.`);
                // Reset the sound reference but keep the state for navigation
                globalPlayingStateForCue.sound = null;
                // Mark as preserved to prevent other cleanup processes
                globalPlayingStateForCue.preservedForNavigation = true;
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Marked state as preserved for navigation.`);
                // Don't delete currentlyPlaying during navigation
            } else {
                delete audioControllerContext.currentlyPlaying[cueId];
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Deleted currentlyPlaying[${cueId}].`);
            }
            
            // Clear playlist highlighting when cue stops
            if (audioControllerContext.sidebarsAPI && typeof audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar === 'function') {
                audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, null);
            }
        } else if (globalPlayingStateForCue) {
            // An onstop event fired, but the sound instance (this 'sound') is not the one
            // currently tracked in currentlyPlaying[cueId].sound. This might be an old instance.
            // This is expected behavior when sounds are being replaced or cleaned up.
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Event for a sound instance that is NOT the active one in currentlyPlaying. Global state NOT deleted by this event. Global sound: ${globalPlayingStateForCue.sound_id}, This sound: ${soundId}`);
        } else {
            // An onstop event fired, but there's NO entry in currentlyPlaying for this cueId.
            // This implies it was already cleaned up, possibly by stopAll or another process.
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: currentlyPlaying[${cueId}] was already deleted or never existed for this stop event.`);
        }

        // Always try to update UI and send status if the sound object itself was valid,
        // as it did stop.
        if (sound) { // Check if 'sound' (the Howl instance for this onstop) is valid
            // For playlists in stop_and_cue_next mode, don't update UI here as _handlePlaylistEnd will handle it
            const isStopAndCueNextPlaylist = playingState.isPlaylist && mainCue.playlistPlayMode === 'stop_and_cue_next';
            
            if (!isStopAndCueNextPlaylist && audioControllerContext.cueGridAPI && typeof audioControllerContext.cueGridAPI.updateButtonPlayingState === 'function') {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false, null, false, false);
            }
            // The 'cue-status-update' IPC is still useful for non-remote listeners or specific main process logic
            if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
                audioControllerContext.ipcBindings.send('cue-status-update', {
                    cueId: cueId,
                    status: 'stopped',
                    details: { reason: 'onstop_event', itemName: currentItemNameForEvents } // currentItemNameForEvents is from createPlaybackInstance closure
                });
            }
        }
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Processing complete.`);

        // Handle ducking trigger stop
        handleDuckingTriggerStop(cueId, mainCue, audioControllerContext);

        const isFadedOutForStop = playingState.acIsStoppingWithFade && playingState.sound && playingState.sound.volume() === 0;
        const isRetriggerRelatedStop = playingState.acStopSource && 
                                 (playingState.acStopSource.includes('_stop') || playingState.acStopSource === 'restart');

        // --- START STOP ALL DEBUG ---            
        console.log(`[StopAll Debug OnStop ${cueId}] sound.acExplicitStopReason: ${sound.acExplicitStopReason}`);
        console.log(`[StopAll Debug OnStop ${cueId}] playingState.explicitStopReason: ${playingState.explicitStopReason}`);
        // --- END STOP ALL DEBUG --- 

        // Decision logic for onstop - use proper cleanup for different scenarios
        const explicitStopReason = sound.acExplicitStopReason || playingState.explicitStopReason;

        if (explicitStopReason === 'stop_all') {
            console.log(`PlaybackEventHandlers: onstop for ${cueId} - Reason: 'stop_all'. Using comprehensive cleanup.`);
            // Use comprehensive cleanup for stop_all operations
            if (audioControllerContext.currentlyPlaying[cueId]) {
                const state = audioControllerContext.currentlyPlaying[cueId];
                // Clean up using the audioPlaybackManager's cleanup utility
                if (typeof audioControllerContext._cleanupSoundInstance === 'function') {
                    audioControllerContext._cleanupSoundInstance(cueId, state, { 
                        forceUnload: true, 
                        source: 'onstop_stop_all' 
                    });
                } else {
                    // Fallback to manual cleanup
                    try {
                        if (state.sound && typeof state.sound.unload === 'function') {
                            state.sound.unload();
                        }
                    } catch (error) {
                        console.warn(`PlaybackEventHandlers: Error during fallback cleanup for ${cueId}:`, error);
                    }
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
        } else if (isFadedOutForStop || isRetriggerRelatedStop) {
            console.log(`PlaybackEventHandlers: onstop for ${cueId} - Reason: Faded out for stop or retrigger. Using comprehensive cleanup.`);
            // Use comprehensive cleanup for fade-out stops and retrigger-related stops
            if (audioControllerContext.currentlyPlaying[cueId]) {
                const state = audioControllerContext.currentlyPlaying[cueId];
                if (typeof audioControllerContext._cleanupSoundInstance === 'function') {
                    audioControllerContext._cleanupSoundInstance(cueId, state, { 
                        forceUnload: false, 
                        source: 'onstop_fade_or_retrigger' 
                    });
                } else {
                    // Fallback to manual cleanup
                    try {
                        if (state.sound && typeof state.sound.stop === 'function') {
                            state.sound.stop();
                            // Remove event listeners to prevent memory leaks
                            state.sound.off();
                        }
                    } catch (error) {
                        console.warn(`PlaybackEventHandlers: Error during fallback cleanup for ${cueId}:`, error);
                    }
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
        } else if (playingState.isPlaylist) {
            // For playlist items, ensure proper cleanup before delegating to _handlePlaylistEnd
            console.log(`PlaybackEventHandlers: onstop for playlist item ${currentItemNameForEvents} in ${cueId}. Cleaning up before delegation.`);
            
            // Clean up the current sound instance but don't clear the entire state
            // since _handlePlaylistEnd will handle the playlist logic
            if (audioControllerContext.currentlyPlaying[cueId] && audioControllerContext.currentlyPlaying[cueId].sound === sound) {
                try {
                    sound.unload();
                } catch (error) {
                    console.warn(`PlaybackEventHandlers: Error during playlist item cleanup for ${cueId}:`, error);
                }
                audioControllerContext.currentlyPlaying[cueId].sound = null;
            }
            
            // Only call _handlePlaylistEnd if we're not currently navigating
            // Navigation will handle the next item directly
            if (!playingState.isNavigating) {
                audioControllerContext._handlePlaylistEnd.call(audioControllerContext, mainCue.id, false, audioControllerContext);
            } else {
                console.log(`PlaybackEventHandlers: Skipping _handlePlaylistEnd for ${cueId} because navigation is in progress`);
            }
        } else if (!mainCue.loop) {
            // Single cue, not looping - use comprehensive cleanup
            console.log(`PlaybackEventHandlers: onstop for single, non-looping cue ${cueId}. Using comprehensive cleanup.`);
            if (audioControllerContext.currentlyPlaying[cueId]) {
                const state = audioControllerContext.currentlyPlaying[cueId];
                if (typeof audioControllerContext._cleanupSoundInstance === 'function') {
                    audioControllerContext._cleanupSoundInstance(cueId, state, { 
                        forceUnload: true, 
                        source: 'onstop_single_cue' 
                    });
                } else {
                    // Fallback to manual cleanup
                    try {
                        if (state.sound && typeof state.sound.unload === 'function') {
                            state.sound.unload();
                        }
                    } catch (error) {
                        console.warn(`PlaybackEventHandlers: Error during fallback cleanup for ${cueId}:`, error);
                    }
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
        } else {
            // Looping single cue - minimal cleanup, let it continue
            console.log(`PlaybackEventHandlers: onstop for ${cueId} - Looping single cue. Minimal cleanup.`);
            // For looping cues, we generally don't want to unload the sound
            // Just clear any intervals and timers
            if (audioControllerContext.currentlyPlaying[cueId]) {
                const state = audioControllerContext.currentlyPlaying[cueId];
                if (state.timeUpdateInterval) {
                    clearInterval(state.timeUpdateInterval);
                    state.timeUpdateInterval = null;
                }
                if (state.trimEndTimer) {
                    clearTimeout(state.trimEndTimer);
                    state.trimEndTimer = null;
                }
            }
        }
    };
}

/**
 * Create onfade event handler
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} mainCue - The main cue object
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onfade event handler
 */
export function createOnfadeHandler(cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext) {
    return (soundId) => {
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onfade: Event for ${filePath}. Current volume: ${sound.volume()}`);
        const playingState = audioControllerContext.currentlyPlaying[cueId]; 
        const currentVolume = sound.volume();

        if (!playingState) { 
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onfade: playingState for ${cueId} not found. Sound ID: ${soundId}. Aborting onfade logic.`);
            // Clean up any remaining intervals for this cue
            if (audioControllerContext.playbackIntervals && audioControllerContext.playbackIntervals[cueId]) { 
                clearInterval(audioControllerContext.playbackIntervals[cueId]);
                delete audioControllerContext.playbackIntervals[cueId];
            }
            return;
        }

        // --- START DIAGNOSTIC LOGGING ---
        console.log(`[FADE_STOP_DEBUG ${cueId}] onfade entered. acIsStoppingWithFade: ${playingState.acIsStoppingWithFade}, currentVolume: ${currentVolume}`);
        // --- END DIAGNOSTIC LOGGING ---
        
        if (playingState.acIsStoppingWithFade && currentVolume < 0.001) { 
            console.log(`PlaybackEventHandlers: Fade OUT to 0 complete for ${mainCue.name} (ID: ${cueId}), stopping sound.`);
    
            if (playingState.sound === sound) {
                // Preserve the explicitStopReason when stopping after fade out
                if (playingState.explicitStopReason) {
                    sound.acExplicitStopReason = playingState.explicitStopReason;
                }
                sound.stop(); 
            } else {
                console.warn(`[TIME_UPDATE_DEBUG ${cueId}] onfade: Fade to 0 complete, but sound instance in playingState is different or null. This sound ID: ${soundId}. State sound: ${playingState.sound_id || 'N/A'}`);
            }
            return; 
        } else if (playingState.acIsStoppingWithFade) {
            // --- START DIAGNOSTIC LOGGING ---
            console.log(`[FADE_STOP_DEBUG ${cueId}] onfade: acIsStoppingWithFade is TRUE, but currentVolume (${currentVolume}) is NOT < 0.001.`);
            // --- END DIAGNOSTIC LOGGING ---
            // If the sound is no longer playing and volume is near zero, ensure UI fade flags are cleared
            if (!sound.playing() || currentVolume <= 0.001) {
                playingState.isFadingOut = false;
                playingState.fadeTotalDurationMs = 0;
                playingState.fadeStartTime = 0;
                if (audioControllerContext.cueGridAPI && typeof audioControllerContext.cueGridAPI.updateButtonPlayingState === 'function') {
                    audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
                }
            }
        }
        
        if (playingState.isFadingIn) {
            const elapsedTime = Date.now() - playingState.fadeStartTime;
            const targetVolume = playingState.originalVolumeBeforeFadeIn !== undefined ? playingState.originalVolumeBeforeFadeIn : (mainCue.volume !== undefined ? mainCue.volume : 1);
            if (elapsedTime >= playingState.fadeTotalDurationMs || Math.abs(currentVolume - targetVolume) < 0.01) {
                console.log(`PlaybackEventHandlers: Fade IN complete for ${mainCue.name}.`);
                playingState.isFadingIn = false;
                // Send an update so the UI knows fading-in is done.
                audioControllerContext.sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'playing'); 
            }
        }
    };
}
