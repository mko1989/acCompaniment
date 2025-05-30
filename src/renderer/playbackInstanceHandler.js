/**
 * Creates a Howler sound instance and sets up its event handlers.
 * @param {string} filePath - Path to the audio file.
 * @param {string} cueId - The ID of the cue.
 * @param {object} mainCue - The main cue object.
 * @param {object} playingState - The specific playing state for this cue instance from currentlyPlaying.
 * @param {string} currentItemNameForEvents - Name of the current item, for events.
 * @param {number} actualItemIndexInOriginalList - Index of item in original list (for playlists).
 * @param {boolean} isResumeForSeekAndFade - If playback is resuming.
 * @param {object} audioControllerContext - Context object with refs from audioController.
 * @returns {Howl | null} The Howler sound instance or null on immediate error.
 */
export function createPlaybackInstance(
    filePath,
    cueId,
    mainCue,
    playingState,
    currentItemNameForEvents,
    actualItemIndexInOriginalList,
    isResumeForSeekAndFade,
    audioControllerContext
) {
    const {
        currentlyPlaying,
        playbackIntervals,
        ipcBindings,
        cueGridAPI,
        sidebarsAPI,
        sendPlaybackTimeUpdate,
        _handlePlaylistEnd,
        _playTargetItem, // For error recovery
        _applyDucking
    } = audioControllerContext;

    const sound = new Howl({
        src: [filePath],
        volume: mainCue.volume !== undefined ? mainCue.volume : 1,
        loop: playingState.isPlaylist ? false : (mainCue.loop || false),
        html5: true, // Recommended for longer tracks and seeking
        onload: () => {
            console.log(`PlaybackInstanceHandler: Audio loaded: ${filePath} for cue: ${cueId} (item: ${currentItemNameForEvents})`);
            const soundDuration = sound.duration();
            console.log(`PlaybackInstanceHandler: For filePath: "${filePath}", Howler sound.duration() returned: ${soundDuration} (type: ${typeof soundDuration})`);
            playingState.duration = soundDuration; // Store duration on the playingState

            // Inform UI/CueStore about the discovered duration for persistence
            if (ipcBindings && typeof ipcBindings.send === 'function') {
                const payload = { cueId, duration: soundDuration };
                if (playingState.isPlaylist) {
                    const originalItem = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                    if (originalItem && originalItem.id) {
                        payload.playlistItemId = originalItem.id;
                    } else {
                        console.warn(`PlaybackInstanceHandler: Playlist item ID not found for duration update. Cue: ${cueId}, Item Index: ${actualItemIndexInOriginalList}`);
                    }
                }
                console.log('PlaybackInstanceHandler: Sending cue-duration-update via ipcBindings.send', payload);
                ipcBindings.send('cue-duration-update', payload);
            } else {
                console.warn('PlaybackInstanceHandler: ipcBindings.send is not available for cue-duration-update.');
            }
            
            if (sidebarsAPI && typeof sidebarsAPI.updateWaveformDisplayDuration === 'function') {
                sidebarsAPI.updateWaveformDisplayDuration(cueId, soundDuration, playingState.isPlaylist ? playingState.originalPlaylistItems[actualItemIndexInOriginalList]?.id : null);
            }

            let effectiveStartTime = 0;
            if (playingState.isPlaylist) {
                const item = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                effectiveStartTime = item.trimStartTime || 0;
            } else {
                effectiveStartTime = mainCue.trimStartTime || 0;
            }

            if (isResumeForSeekAndFade && playingState.seekBeforeResume !== undefined) {
                console.log(`PlaybackInstanceHandler: Resuming from seek position: ${playingState.seekBeforeResume} for ${currentItemNameForEvents}`);
                sound.seek(playingState.seekBeforeResume);
                delete playingState.seekBeforeResume;
            } else if (effectiveStartTime > 0 && !isResumeForSeekAndFade) {
                console.log(`PlaybackInstanceHandler: Seeking to trimStartTime: ${effectiveStartTime} for ${currentItemNameForEvents}`);
                sound.seek(effectiveStartTime);
            }
            
            const fadeInDuration = playingState.isPlaylist ? 
                                   (playingState.originalPlaylistItems[actualItemIndexInOriginalList].fadeInTime !== undefined ? playingState.originalPlaylistItems[actualItemIndexInOriginalList].fadeInTime : (mainCue.fadeInTime !== undefined ? mainCue.fadeInTime : 0)) :
                                   (mainCue.fadeInTime !== undefined ? mainCue.fadeInTime : 0);

            if (fadeInDuration > 0 && !playingState.isPaused) {
                console.log(`PlaybackInstanceHandler: Applying fade-in (${fadeInDuration}ms) for ${currentItemNameForEvents}`);
                sound.fade(0, sound.volume(), fadeInDuration); // Fade from 0 to target volume
                // Play is called by Howler after fade starts, or implicitly by fade itself if it's smart.
                // However, to be certain, and if fade doesn't auto-play, we might need it.
                // Let's assume fade handles triggering playback. If not, add sound.play() here.
                // TESTING: Howler's .fade() does not automatically start playback if the sound isn't already playing.
                // If the sound is new, it must be played.
                sound.play(); // Ensure play is called if fading in a new sound
            } else if (!playingState.isPaused) {
                // No fade-in, just play directly
                sound.play();
            }
        },
        onplay: () => {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Fired for ${filePath}. isResumeForSeekAndFade: ${isResumeForSeekAndFade}`);
            
            // === Additions for retrigger race condition START ===
            // If this sound instance was told to stop with fade as part of a 'fade_out_and_stop' retrigger,
            // then its 'onplay' event should be a no-op or ensure it truly stops.
            if (sound.acIsStoppingWithFade && sound.acStopSource === 'fade_out_and_stop') {
                console.log(`[RETRIGGER_DEBUG ${cueId}] onplay: Suppressed for ${filePath}. Reason: acIsStoppingWithFade is true and acStopSource is 'fade_out_and_stop'.`);
                if (sound.playing()) { // If Howler somehow still considers it playing via this event
                    sound.stop();     // Stop it immediately to prevent unwanted playback or further events.
                }
                // It's crucial to not proceed with setting up intervals or updating UI as playing
                // because this sound instance is on its way out due to the retrigger.
                return; 
            }
            // === Additions for retrigger race condition END ===

            playingState.sound = sound; // IMPORTANT: Update the sound reference in the shared playingState
            playingState.isPaused = false;

            // Ducking logic: Called on play
            const fullCueData = audioControllerContext.getGlobalCueById(cueId);
            if (fullCueData) {
                if (fullCueData.isDuckingTrigger) {
                    console.log(`PlaybackInstanceHandler: Cue ${cueId} is a ducking trigger. Applying ducking.`);
                    audioControllerContext._applyDucking(cueId);
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
                        console.log(`PlaybackInstanceHandler: Cue ${cueId} should start ducked due to active trigger ${activeTriggerCueDetails.id}.`);
                        // Use the cue's configured volume as the base for ducking if starting ducked
                        playingState.originalVolumeBeforeDuck = fullCueData.volume !== undefined ? fullCueData.volume : 1.0;
                        const duckToVolume = playingState.originalVolumeBeforeDuck * (activeTriggerCueDetails.duckingLevel / 100.0);
                        
                        sound.volume(duckToVolume); // Set Howler's volume directly
                        playingState.isDucked = true;
                        playingState.activeDuckingTriggerId = activeTriggerCueDetails.id;
                        console.log(`PlaybackInstanceHandler: Cue ${cueId} initial volume set to ${duckToVolume} (ducked).`);
                    } else {
                        // Ensure if it was previously ducked by a now-gone trigger, its volume is correct.
                        // This path is less likely if _revertDucking works, but good for safety.
                        if (playingState.isDucked) {
                             console.warn(`PlaybackInstanceHandler: Cue ${cueId} was marked isDucked but no active trigger. Resetting volume if needed.`);
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
                console.warn(`PlaybackInstanceHandler: Could not get fullCueData for ${cueId} in onplay for ducking logic.`);
            }

            if (playingState.timeUpdateInterval) {
                clearInterval(playingState.timeUpdateInterval);
                playingState.timeUpdateInterval = null;
            }
            if (playbackIntervals[cueId]) {
                clearInterval(playbackIntervals[cueId]);
                delete playbackIntervals[cueId];
            }

            // Initial time update immediately on play
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Sending initial time update.`);
            sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'playing');

            if (cueGridAPI) {
                cueGridAPI.updateButtonPlayingState(cueId, true, playingState.isPlaylist ? currentItemNameForEvents : null);
                
                // Log conditions BEFORE the if statement for highlighting
                console.log(`PlaybackInstanceHandler (DEBUG HIGHLIGHT): CueID: ${cueId}, isPlaylist: ${playingState.isPlaylist}, sidebarsAPI exists: ${!!sidebarsAPI}, highlightFn exists: ${typeof sidebarsAPI?.highlightPlayingPlaylistItemInSidebar === 'function'}`);

                if (playingState.isPlaylist && sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItemInSidebar === 'function') {
                    const currentItemForHighlight = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                    console.log(`PlaybackInstanceHandler: Attempting to highlight. CueID: ${cueId}, ItemID: ${currentItemForHighlight?.id}, SidebarsAPI available: ${!!sidebarsAPI}`);
                    if (currentItemForHighlight && currentItemForHighlight.id) {
                         sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, currentItemForHighlight.id);
                    } else {
                         console.log(`PlaybackInstanceHandler: No currentItemForHighlight.id, attempting to clear highlight for cue ${cueId}`);
                         sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, null); // Clear if no valid item
                    }
                }
            }

            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: About to set up setInterval.`);
            const newInterval = setInterval(() => {
                // playingState is from closure, was audioControllerContext.currentlyPlaying[cueId] at creation.
                // sound is from closure, the Howl instance.

                const latestGlobalState = currentlyPlaying[cueId]; // Freshly get from audioControllerContext.currentlyPlaying
                let intervalStopReason = "";

                if (!latestGlobalState) {
                    // If global state is gone, and we're not in a state where we expect it to be gone soon (like fading to stop/restart)
                    if (!playingState.isFadingOutToStop && !playingState.isFadingOutToRestart) {
                        intervalStopReason = "Global state for cueId is MISSING and not actively fading to stop/restart.";
                    } else if (!sound.playing() && (playingState.isFadingOutToStop || playingState.isFadingOutToRestart)) {
                        // If it's meant to be fading out but is no longer 'playing' according to Howler, it's effectively stopped or will stop imminently.
                        // This can happen if stop() was called directly after fade initiated.
                        intervalStopReason = "Global state present, sound not playing during an intended fade out. Assuming stop.";
                    }
                } else if (latestGlobalState !== playingState) {
                    intervalStopReason = `Global state object for cueId CHANGED. This interval is for a stale state.`;
                    console.log(`[TIME_UPDATE_DEBUG ${cueId}] setInterval: Old state sound ID (from closure): ${playingState.sound ? (playingState.sound._sounds && playingState.sound._sounds[0] ? playingState.sound._sounds[0]._id : 'N/A') : 'N/A'}, New state sound ID (latestGlobalState): ${latestGlobalState.sound ? (latestGlobalState.sound._sounds && latestGlobalState.sound._sounds[0] ? latestGlobalState.sound._sounds[0]._id : 'N/A') : 'N/A'}`);
                } else if (latestGlobalState.sound !== sound) {
                    intervalStopReason = `Sound instance in state (ID: ${latestGlobalState.sound ? (latestGlobalState.sound._sounds && latestGlobalState.sound._sounds[0] ? latestGlobalState.sound._sounds[0]._id : 'N/A') : 'N/A'}) does not match interval's sound (ID: ${sound ? (sound._sounds && sound._sounds[0] ? sound._sounds[0]._id : 'N/A') : 'N/A'}).`;
                } else if (!sound.playing() && !latestGlobalState.isFadingOutToStop && !latestGlobalState.isFadingOutToRestart) {
                    // If sound.playing() is false, and we are not in a controlled fade-out, then stop the interval.
                    intervalStopReason = "Sound not playing (sound.playing() is false) and not in a fade-out process.";
                } else if (latestGlobalState.isPaused) {
                    intervalStopReason = "State is marked as paused";
                }

                if (intervalStopReason) {
                    console.log(`[TIME_UPDATE_DEBUG ${cueId}] setInterval: Stopping. Reason: ${intervalStopReason}. Cue: ${currentItemNameForEvents}, Path: ${filePath}`);
                    clearInterval(newInterval);
                    if (playbackIntervals[cueId] === newInterval) {
                        delete playbackIntervals[cueId];
                    }
                    if (playingState.timeUpdateInterval === newInterval) {
                        playingState.timeUpdateInterval = null;
                    }
                    if (latestGlobalState && latestGlobalState.timeUpdateInterval === newInterval) {
                        latestGlobalState.timeUpdateInterval = null;
                    }
                    return;
                }

                // If all checks pass, or we are in a fade out, proceed to update time
                const currentSeek = typeof sound.seek === 'function' ? sound.seek() : -1;
                const expectedDuration = latestGlobalState.duration; // Use duration from the latest state

                // console.log(`[TIME_UPDATE_DEBUG ${cueId}] setInterval: Conditions met. CurrentSeek: ${currentSeek}, Expected Duration: ${expectedDuration}. Calling sendPlaybackTimeUpdate.`);
                
                let statusForUpdate = 'playing';
                if (latestGlobalState && latestGlobalState.isFadingOut) {
                    statusForUpdate = 'fading_out';
                }

                sendPlaybackTimeUpdate(cueId, sound, latestGlobalState, currentItemNameForEvents, statusForUpdate);

                // Update UI time directly for smoother updates
                let isFadingIn = false;
                let isFadingOut = false;
                let fadeTimeRemainingMs = 0;

                if (latestGlobalState) {
                    if (latestGlobalState.isFadingIn && latestGlobalState.fadeStartTime && latestGlobalState.fadeTotalDurationMs > 0) {
                        const elapsedFadeMs = Date.now() - latestGlobalState.fadeStartTime;
                        if (elapsedFadeMs < latestGlobalState.fadeTotalDurationMs) {
                            isFadingIn = true;
                            fadeTimeRemainingMs = latestGlobalState.fadeTotalDurationMs - elapsedFadeMs;
                        }
                    }
                    if (!isFadingIn && latestGlobalState.isFadingOut && latestGlobalState.fadeStartTime && latestGlobalState.fadeTotalDurationMs > 0) {
                        const elapsedFadeMs = Date.now() - latestGlobalState.fadeStartTime;
                        if (elapsedFadeMs < latestGlobalState.fadeTotalDurationMs) {
                            isFadingOut = true;
                            fadeTimeRemainingMs = latestGlobalState.fadeTotalDurationMs - elapsedFadeMs;
                        }
                    }
                }

                // --- START EXTENDED DIAGNOSTIC LOG FOR FADING UI --- 
                const shouldLogFadeDetails = isFadingIn || isFadingOut; // Log if either flag is true
                if (shouldLogFadeDetails) { 
                    console.log(`[FADE_DETAILS_LOG ${cueId}] Interval Update. Calculated: isFadingIn=${isFadingIn}, isFadingOut=${isFadingOut}, fadeTimeRemainingMs=${fadeTimeRemainingMs}. From State: state.isFadingIn=${latestGlobalState?.isFadingIn}, state.isFadingOut=${latestGlobalState?.isFadingOut}, state.totalMs=${latestGlobalState?.fadeTotalDurationMs}, state.startTime=${latestGlobalState?.fadeStartTime}. SoundVolume: ${sound.volume()}`);
                }
                // --- END EXTENDED DIAGNOSTIC LOG FOR FADING UI --- 

                if (cueGridAPI && typeof cueGridAPI.updateCueButtonTime === 'function') {
                    // Call with null for elements, so it fetches times internally using audioController.
                    // Pass fading parameters correctly.
                    cueGridAPI.updateCueButtonTime(
                        cueId, 
                        null, // elements = null
                        isFadingIn, 
                        isFadingOut, 
                        fadeTimeRemainingMs
                    );
                }
            }, 250);
            playbackIntervals[cueId] = newInterval; // Store globally by cueId
            playingState.timeUpdateInterval = newInterval; // Store on specific playingState

            if (ipcBindings && typeof ipcBindings.send === 'function') {
                let statusDetails = {};
                if (playingState.isPlaylist) {
                    statusDetails = {
                        playlistItemPath: filePath,
                        playlistItemName: currentItemNameForEvents
                    };
                }
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Sending cue-status-update (playing).`);
                ipcBindings.send('cue-status-update', { cueId: cueId, status: 'playing', details: statusDetails });
            }

            if (!playingState.isPlaylist && mainCue.trimEndTime > 0 && mainCue.trimEndTime > (mainCue.trimStartTime || 0)) {
                const currentSeek = sound.seek() || 0;
                const effectiveTrimStart = mainCue.trimStartTime || 0;
                const remainingDuration = (mainCue.trimEndTime - Math.max(currentSeek, effectiveTrimStart)) * 1000;

                if (remainingDuration > 0) {
                    if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                    playingState.trimEndTimer = setTimeout(() => {
                        if (currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound) {
                            console.log(`PlaybackInstanceHandler: Reached trimEnd for cue: ${cueId} (item: ${filePath})`);
                            sound.stop();
                        }
                    }, remainingDuration);
                } else if (currentSeek >= mainCue.trimEndTime) {
                     console.log(`PlaybackInstanceHandler: Current seek ${currentSeek} is past trimEnd ${mainCue.trimEndTime} for cue: ${cueId}. Stopping.`);
                     sound.stop();
                }
            }
        },
        onpause: () => {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onpause: Fired for ${filePath}.`);
            
            if (playbackIntervals[cueId]) { // Clear global interval if this sound instance was managing it
                clearInterval(playbackIntervals[cueId]);
            }
            // The specific playingState.timeUpdateInterval should also be cleared
            if (playingState.timeUpdateInterval) {
                 clearInterval(playingState.timeUpdateInterval);
                 playingState.timeUpdateInterval = null;
            }
            playingState.isPaused = true;
            if (playingState.sound) { // Sound is this instance
                playingState.lastSeekPosition = sound.seek() || 0;
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onpause: lastSeekPosition set to ${playingState.lastSeekPosition}`);
            }

            sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'paused');

            if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                cueGridAPI.updateButtonPlayingState(cueId, false,
                    playingState.isPlaylist ? currentItemNameForEvents : null
                );
            }
            if (ipcBindings && typeof ipcBindings.send === 'function') {
                ipcBindings.send('cue-status-update', { cueId: cueId, status: 'paused', details: {} });
            }
        },
        onend: () => {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Fired for ${filePath}.`);
            const playingState = currentlyPlaying[cueId];

            if (playingState && playingState.isRestarting) {
                console.log(`PlaybackInstanceHandler: onend - cue ${cueId} was restarting. State likely cleared by onstop. No further action.`);
                // isRestarting flag means this onend is from a sound.stop() call during a restart sequence.
                // The main state (currentlyPlaying[cueId]) should have been deleted by onstop.
                return; 
            }

            if (playingState && playingState.isFadingOutToRestart) {
                console.log(`PlaybackInstanceHandler: onend - cue ${cueId} was fading out to restart. Restart logic is separate.`);
                // This might occur if fade completes. Restart is handled by toggle's setTimeout.
                // Ensure we don't proceed with playlist logic here.
                return;
            }

            // Clear the specific sound instance from the state, as it has ended.
            if (playbackIntervals[cueId]) {
                clearInterval(playbackIntervals[cueId]);
                delete playbackIntervals[cueId];
            }
            if (playingState.timeUpdateInterval) {
                clearInterval(playingState.timeUpdateInterval);
                playingState.timeUpdateInterval = null;
            }
            
            // Clear Fading Flags
            playingState.isFadingIn = false;
            playingState.isFadingOut = false;
            playingState.fadeTotalDurationMs = 0;
            playingState.fadeStartTime = 0;

            sendPlaybackTimeUpdate(cueId, null, playingState, currentItemNameForEvents, 'stopped');
            
            let handledByLoopOrPlaylist = false;
            playingState.isPaused = false; // Ensure not stuck in paused state

            if (playingState.isPlaylist) {
                if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItemInSidebar === 'function') {
                    sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, null);
                }
                _handlePlaylistEnd(cueId, false); // Call audioController's playlist handler
                handledByLoopOrPlaylist = true;
            } else if (mainCue.loop && !playingState.isStopping) { 
                console.log(`PlaybackInstanceHandler: Looping single cue ${cueId}`);
                const trimStart = mainCue.trimStartTime || 0;
                sound.seek(trimStart);
                sound.play(); // Re-play this same sound instance

                // Restart interval (this will be set up again by onplay)
                if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                     cueGridAPI.updateButtonPlayingState(cueId, true, null);
                }
                handledByLoopOrPlaylist = true;
            }

            if (!handledByLoopOrPlaylist) {
                // Genuine stop for a single cue, or playlist handled by _handlePlaylistEnd already cleared it
                if (currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound) { // Check if this is still the active sound
                     delete currentlyPlaying[cueId];
                     console.log(`PlaybackInstanceHandler: Cleared currentlyPlaying state for ${cueId} in onend.`);
                }
                if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                    cueGridAPI.updateButtonPlayingState(cueId, false, null);
                }
                // Sidebars highlight for playlist would have been cleared by playlist handler.
                if (ipcBindings && typeof ipcBindings.send === 'function') {
                    ipcBindings.send('cue-status-update', { cueId: cueId, status: 'stopped', details: {} });
                }
            }

            if (ipcBindings && typeof ipcBindings.send === 'function') {
                // console.log("onend: Sending cue-status-update to main process for cue: ", cueId);
                ipcBindings.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'ended' } });
            }
            
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Cue item processing complete.`);
        },
        onstop: (soundId) => {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Fired for ${filePath}. Sound ID: ${soundId}`);
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
                if (audioControllerContext.playbackIntervals[cueId]) {
                    clearInterval(audioControllerContext.playbackIntervals[cueId]);
                    delete audioControllerContext.playbackIntervals[cueId];
                    console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Cleared global playbackIntervals.`);
                }
                if (globalPlayingStateForCue.timeUpdateInterval) { // Also clear the interval stored on the state object itself
                    clearInterval(globalPlayingStateForCue.timeUpdateInterval);
                    globalPlayingStateForCue.timeUpdateInterval = null;
                }
                if (globalPlayingStateForCue.trimEndTimer) {
                    clearTimeout(globalPlayingStateForCue.trimEndTimer);
                    globalPlayingStateForCue.trimEndTimer = null;
                    console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Cleared trimEndTimer.`);
                }
                delete audioControllerContext.currentlyPlaying[cueId];
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Deleted currentlyPlaying[${cueId}].`);
            } else if (globalPlayingStateForCue) {
                // An onstop event fired, but the sound instance (this 'sound') is not the one
                // currently tracked in currentlyPlaying[cueId].sound. This might be an old instance.
                console.warn(`[TIME_UPDATE_DEBUG ${cueId}] onstop: Event for a sound instance that is NOT the active one in currentlyPlaying. Global state NOT deleted by this event. Global sound: ${globalPlayingStateForCue.sound_id}, This sound: ${soundId}`);
            } else {
                // An onstop event fired, but there's NO entry in currentlyPlaying for this cueId.
                // This implies it was already cleaned up, possibly by stopAll or another process.
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onstop: currentlyPlaying[${cueId}] was already deleted or never existed for this stop event.`);
            }

            // Always try to update UI and send status if the sound object itself was valid,
            // as it did stop.
            if (sound) { // Check if 'sound' (the Howl instance for this onstop) is valid
                if (audioControllerContext.cueGridAPI && typeof audioControllerContext.cueGridAPI.updateButtonPlayingState === 'function') {
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
        },
        onfade: (soundId) => {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onfade: Event for ${filePath}. Current volume: ${sound.volume()}`);
            const playingState = audioControllerContext.currentlyPlaying[cueId]; 
            const currentVolume = sound.volume();

            if (!playingState) { 
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onfade: playingState for ${cueId} not found. Sound ID: ${soundId}. Aborting onfade logic.`);
                if (audioControllerContext.playbackIntervals[cueId] && audioControllerContext.playbackIntervals[cueId] === playingState?.timeUpdateInterval) { 
                    clearInterval(audioControllerContext.playbackIntervals[cueId]);
                    delete audioControllerContext.playbackIntervals[cueId];
                }
                return;
            }

            // --- START DIAGNOSTIC LOGGING ---
            console.log(`[FADE_STOP_DEBUG ${cueId}] onfade entered. acIsStoppingWithFade: ${playingState.acIsStoppingWithFade}, currentVolume: ${currentVolume}`);
            // --- END DIAGNOSTIC LOGGING ---
            
            if (playingState.acIsStoppingWithFade && currentVolume < 0.001) { 
                console.log(`PlaybackInstanceHandler: Fade OUT to 0 complete for ${mainCue.name} (ID: ${cueId}), stopping sound.`);
        
                if (playingState.sound === sound) {
                    sound.stop(); 
                } else {
                    console.warn(`[TIME_UPDATE_DEBUG ${cueId}] onfade: Fade to 0 complete, but sound instance in playingState is different or null. This sound ID: ${soundId}. State sound: ${playingState.sound_id || 'N/A'}`);
                }
                return; 
            } else if (playingState.acIsStoppingWithFade) {
                // --- START DIAGNOSTIC LOGGING ---
                console.log(`[FADE_STOP_DEBUG ${cueId}] onfade: acIsStoppingWithFade is TRUE, but currentVolume (${currentVolume}) is NOT < 0.001.`);
                // --- END DIAGNOSTIC LOGGING ---
            }
            
            if (playingState.isFadingIn) {
                const elapsedTime = Date.now() - playingState.fadeStartTime;
                const targetVolume = playingState.originalVolumeBeforeFadeIn !== undefined ? playingState.originalVolumeBeforeFadeIn : (mainCue.volume !== undefined ? mainCue.volume : 1);
                if (elapsedTime >= playingState.fadeTotalDurationMs || Math.abs(currentVolume - targetVolume) < 0.01) {
                    console.log(`PlaybackInstanceHandler: Fade IN complete for ${mainCue.name}.`);
                    playingState.isFadingIn = false;
                    // Send an update so the UI knows fading-in is done.
                    audioControllerContext.sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'playing'); 
                }
            }
        },
        onloaderror: (id, err) => {
            console.error(`[TIME_UPDATE_DEBUG ${cueId}] onloaderror: Error loading ${filePath}:`, err, `(Sound ID: ${id})`);
            const playingState = audioControllerContext.currentlyPlaying[cueId];
            if (playingState) {
                if (playingState.timeUpdateInterval) {
                    clearInterval(playingState.timeUpdateInterval);
                    playingState.timeUpdateInterval = null;
                }
                if (audioControllerContext.playbackIntervals[cueId]) {
                    clearInterval(audioControllerContext.playbackIntervals[cueId]);
                    delete audioControllerContext.playbackIntervals[cueId];
                }
                if (playingState.isPlaylist) {
                    console.warn(`[TIME_UPDATE_DEBUG ${cueId}] onloaderror: Attempting to play next item in playlist due to load error.`);
                    audioControllerContext._handlePlaylistEnd(cueId, true); // true indicates an error, try next
                } else {
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
            if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            }
            if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
                audioControllerContext.ipcBindings.send('cue-status-update', { cueId: cueId, status: 'error', details: { error: 'loaderror', message: err ? (typeof err === 'string' ? err : JSON.stringify(err)) : 'Unknown load error'} });
            }
        },
        onplayerror: (id, err) => {
            console.error(`[TIME_UPDATE_DEBUG ${cueId}] onplayerror: Error playing ${filePath}:`, err, `(Sound ID: ${id})`);
            const playingState = audioControllerContext.currentlyPlaying[cueId];
            if (playingState) {
                if (playingState.timeUpdateInterval) {
                    clearInterval(playingState.timeUpdateInterval);
                    playingState.timeUpdateInterval = null;
                }
                if (audioControllerContext.playbackIntervals[cueId]) {
                    clearInterval(audioControllerContext.playbackIntervals[cueId]);
                    delete audioControllerContext.playbackIntervals[cueId];
                }
                if (playingState.isPlaylist) {
                    console.warn(`[TIME_UPDATE_DEBUG ${cueId}] onplayerror: Attempting to play next item in playlist due to play error.`);
                    audioControllerContext._handlePlaylistEnd(cueId, true); // true indicates an error, try next
                } else {
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
            if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            }
            if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
                audioControllerContext.ipcBindings.send('cue-status-update', { cueId: cueId, status: 'error', details: { error: 'playerror', message: err ? (typeof err === 'string' ? err : JSON.stringify(err)) : 'Unknown play error' } });
            }
        }
    });

    return sound;
} 