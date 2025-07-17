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
        html5: false, // Use Web Audio API for better loop performance, especially on Windows
        preload: true, // Preload for better loop performance
        format: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'], // Specify supported formats
        onload: () => {
            console.log(`PlaybackInstanceHandler: Audio loaded: ${filePath} for cue: ${cueId} (item: ${currentItemNameForEvents})`);
            const soundDuration = sound.duration();
            console.log(`PlaybackInstanceHandler: For filePath: "${filePath}", Howler sound.duration() returned: ${soundDuration} (type: ${typeof soundDuration})`);
            playingState.duration = soundDuration; // Store duration on the playingState

            // Set audio output device for this sound instance
            if (audioControllerContext.audioControllerRef && 
                audioControllerContext.audioControllerRef.getCurrentAudioOutputDeviceId) {
                const deviceId = audioControllerContext.audioControllerRef.getCurrentAudioOutputDeviceId();
                if (deviceId && deviceId !== 'default') {
                    console.log(`PlaybackInstanceHandler: Setting audio output device to ${deviceId} for cue ${cueId}`);
                    
                    // Set the sink ID on the HTML5 Audio element
                    if (sound._sounds && sound._sounds.length > 0) {
                        const audioNode = sound._sounds[0]._node;
                        if (audioNode && typeof audioNode.setSinkId === 'function') {
                            const sinkId = deviceId === 'default' ? '' : deviceId;
                            audioNode.setSinkId(sinkId).then(() => {
                                console.log(`PlaybackInstanceHandler: Successfully set device for cue ${cueId}`);
                            }).catch(error => {
                                console.warn(`PlaybackInstanceHandler: Failed to set device for cue ${cueId}:`, error);
                            });
                        }
                    }
                }
            }

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
            
            // === Enhanced race condition protection START ===
            // Check if this sound instance is stale or conflicting with a newer instance
            const currentGlobalState = audioControllerContext.currentlyPlaying[cueId];
            
            // If no global state exists, this sound instance is likely stale
            if (!currentGlobalState) {
                console.warn(`[RETRIGGER_DEBUG ${cueId}] onplay: No global state found for cue. This sound instance may be stale. Stopping.`);
                if (sound.playing()) {
                    sound.stop();
                }
                return; 
            }
            
            // If there's already a different sound instance in the global state, this one is stale
            if (currentGlobalState.sound && currentGlobalState.sound !== sound) {
                console.warn(`[RETRIGGER_DEBUG ${cueId}] onplay: Different sound instance already exists in global state. This instance is stale. Stopping.`);
                if (sound.playing()) {
                    sound.stop();
                }
                return;
            }
            
            // If this sound instance was marked for stopping with fade as part of retrigger behavior
            if (sound.acIsStoppingWithFade && (sound.acStopSource === 'fade_out_and_stop' || sound.acStopSource === 'restart')) {
                console.log(`[RETRIGGER_DEBUG ${cueId}] onplay: Suppressed for ${filePath}. Reason: acIsStoppingWithFade is true and acStopSource is '${sound.acStopSource}'.`);
                if (sound.playing()) {
                    sound.stop();
                }
                return; 
            }
            
            // Additional check: if the playingState passed to this function is different from current global state
            if (playingState !== currentGlobalState) {
                console.warn(`[RETRIGGER_DEBUG ${cueId}] onplay: playingState from closure differs from current global state. This may be a stale instance.`);
                // Don't immediately stop - allow it to proceed but log the warning
            }
            // === Enhanced race condition protection END ===

            playingState.sound = sound; // IMPORTANT: Update the sound reference in the shared playingState
            playingState.isPaused = false;
            
            // Update current cue priority for Companion
            if (audioControllerContext._updateCurrentCueForCompanion) {
                audioControllerContext._updateCurrentCueForCompanion();
            }

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

            // === Time Update Interval Management START ===
            // Optimized interval management with adaptive frequency
            const existingGlobalInterval = audioControllerContext.playbackIntervals[cueId];
            const existingStateInterval = playingState.timeUpdateInterval;
            
            if (existingGlobalInterval) {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Clearing existing global interval before creating new one`);
                clearInterval(existingGlobalInterval);
                delete audioControllerContext.playbackIntervals[cueId];
            }
            
            if (existingStateInterval) {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Clearing existing state interval before creating new one`);
                clearInterval(existingStateInterval);
                playingState.timeUpdateInterval = null;
            }
            
            // High-precision update frequency for smooth fading display (0.1s precision)
            const duration = sound.duration();
            let updateInterval = 100; // 100ms (0.1s) for precise fading display
            
            // Only use slower intervals for very long tracks to save CPU
            if (duration > 600) { // 10+ minutes - use slightly slower updates
                updateInterval = 250; // 0.25 seconds
            }
            
            // Always use high precision for fading operations
            const appConfig = audioControllerContext.getAppConfigFunc ? audioControllerContext.getAppConfigFunc() : {};
            // Force high precision for better user experience
            updateInterval = 100; // Always 100ms for smooth fade display

            console.log(`[TIME_UPDATE_DEBUG ${cueId}] Using adaptive update interval: ${updateInterval}ms for duration: ${duration}s`);
            
            // Performance-optimized time update logic
            let lastUpdateTime = 0;
            let updateCounter = 0;
            
            const newInterval = setInterval(() => {
                const now = Date.now();
                
                // Skip update if too soon (debouncing)
                if (now - lastUpdateTime < updateInterval - 50) {
                    return;
                }
                
                lastUpdateTime = now;
                updateCounter++;
                
                // Get fresh references each time the interval runs
                const latestGlobalState = audioControllerContext.currentlyPlaying[cueId];
                let intervalStopReason = "";

                // Enhanced validation checks with early returns for performance
                if (!latestGlobalState) {
                    intervalStopReason = "Global state for cueId is MISSING";
                } else if (latestGlobalState !== playingState) {
                    intervalStopReason = "Global state object for cueId CHANGED";
                } else if (latestGlobalState.sound !== sound) {
                    intervalStopReason = "Sound instance in state does not match interval's sound";
                } else if (latestGlobalState.isPaused) {
                    intervalStopReason = "State is marked as paused";
                }

                if (intervalStopReason) {
                    console.log(`[TIME_UPDATE_DEBUG ${cueId}] Stopping interval after ${updateCounter} updates. Reason: ${intervalStopReason}`);
                    clearInterval(newInterval);
                    if (audioControllerContext.playbackIntervals[cueId] === newInterval) {
                        delete audioControllerContext.playbackIntervals[cueId];
                    }
                    if (playingState.timeUpdateInterval === newInterval) {
                        playingState.timeUpdateInterval = null;
                    }
                    return;
                }

                // Send time update for UI button time display
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] Interval update #${updateCounter}: sound.playing()=${sound.playing()}, sound.seek()=${sound.seek()}, sound.state()=${sound.state()}`);
                sendPlaybackTimeUpdate(cueId, sound, latestGlobalState, currentItemNameForEvents, 'playing');

                // Always update fade state for smooth fading timer
                let isFadingIn = false;
                let isFadingOut = false;
                let fadeTimeRemainingMs = 0;

                if (latestGlobalState.isFadingIn) {
                            isFadingIn = true;
                    const fadeElapsed = now - latestGlobalState.fadeStartTime;
                    fadeTimeRemainingMs = Math.max(0, latestGlobalState.fadeTotalDurationMs - fadeElapsed);
                } else if (latestGlobalState.isFadingOut) {
                            isFadingOut = true;
                    const fadeElapsed = now - latestGlobalState.fadeStartTime;
                    fadeTimeRemainingMs = Math.max(0, latestGlobalState.fadeTotalDurationMs - fadeElapsed);
                }

                // Update button state if fading or if fade status changed
                const isFading = isFadingIn || isFadingOut;
                const fadeStatusChanged = (isFadingIn !== latestGlobalState.lastUIFadingIn || 
                                         isFadingOut !== latestGlobalState.lastUIFadingOut);
                
                if (isFading || fadeStatusChanged) {
                    latestGlobalState.lastUIFadingIn = isFadingIn;
                    latestGlobalState.lastUIFadingOut = isFadingOut;
                    
                    if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateCueButtonTime) {
                        // Use updateCueButtonTime directly for smoother fade timer updates
                        audioControllerContext.cueGridAPI.updateCueButtonTime(
                        cueId, 
                            null, // elements 
                        isFadingIn, 
                        isFadingOut, 
                        fadeTimeRemainingMs
                    );
                }
                }
                
                // Performance optimization: Only send detailed state updates periodically for non-fade data
                const shouldSendDetailedUpdate = updateCounter % 4 === 0; // Every 4th update
            }, updateInterval);
            
            // Store the interval reference in both locations for proper cleanup
            playingState.timeUpdateInterval = newInterval;
            audioControllerContext.playbackIntervals[cueId] = newInterval;
            
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] Created optimized time update interval with ${updateInterval}ms frequency`);
            // === Time Update Interval Management END ===

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
            // Clear the specific interval for this sound instance
            if (playingState.timeUpdateInterval) {
                clearInterval(playingState.timeUpdateInterval);
                playingState.timeUpdateInterval = null;
            }
            if (playbackIntervals[cueId]) { // Also clear the one in the shared map if it's this one
                clearInterval(playbackIntervals[cueId]);
                delete playbackIntervals[cueId];
            }

            let errorOccurred = false; // Placeholder, can be set by other event handlers if needed

            // Special handling for 'stop_and_cue_next' playlists:
            // The status update will be handled by _handlePlaylistEnd after it sets the cued state.
            // For other cases, send 'stopped' status now.
            const isStopAndCueNextPlaylist = playingState.isPlaylist && mainCue.playlistPlayMode === 'stop_and_cue_next';

            if (!isStopAndCueNextPlaylist) {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Not a 'stop_and_cue_next' playlist or not a playlist. Sending 'stopped' status.`);
                sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'stopped');
            } else {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Is a 'stop_and_cue_next' playlist. Deferring specific status update to _handlePlaylistEnd.`);
            }

            if (playingState.isPlaylist) {
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Cue is a playlist. Calling _handlePlaylistEnd. Playlist Mode: ${mainCue.playlistPlayMode}`);
                audioControllerContext._handlePlaylistEnd(cueId, errorOccurred);
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
            } else {
                // Single cue, not looping, and not a playlist - it just ended.
                console.log(`[TIME_UPDATE_DEBUG ${cueId}] onend: Single cue, no loop. Processing complete.`);
                // UI and state cleanup for a simple non-looping single cue that finished.
                if (currentlyPlaying[cueId]) { // Check if it wasn't already cleaned by a rapid stop call
                    delete currentlyPlaying[cueId];
                }
                if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
                // IPC status update for 'stopped' was already sent above if not stop_and_cue_next
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
                
                // Clear playlist highlighting when cue stops
                if (audioControllerContext.sidebarsAPI && typeof audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar === 'function') {
                    audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, null);
                }
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

            // If the cue was a ducking trigger, revert ducking for other cues
            if (mainCue && mainCue.isDuckingTrigger) {
                console.log(`PlaybackInstanceHandler: Cue ${cueId} (a ducking trigger) stopped. Reverting ducking.`);
                audioControllerContext._revertDucking(cueId);
            }

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
                console.log(`PlaybackInstanceHandler: onstop for ${cueId} - Reason: 'stop_all'. Using comprehensive cleanup.`);
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
                            console.warn(`PlaybackInstanceHandler: Error during fallback cleanup for ${cueId}:`, error);
                    }
                        delete audioControllerContext.currentlyPlaying[cueId];
                    }
                }
            } else if (isFadedOutForStop || isRetriggerRelatedStop) {
                console.log(`PlaybackInstanceHandler: onstop for ${cueId} - Reason: Faded out for stop or retrigger. Using comprehensive cleanup.`);
                // Use comprehensive cleanup for fade-out stops and retrigger-related stops
                if (audioControllerContext.currentlyPlaying[cueId]) {
                    const state = audioControllerContext.currentlyPlaying[cueId];
                    if (typeof audioControllerContext._cleanupSoundInstance === 'function') {
                        audioControllerContext._cleanupSoundInstance(cueId, state, { 
                            forceUnload: true, 
                            source: 'onstop_fade_or_retrigger' 
                        });
                    } else {
                        // Fallback to manual cleanup
                        try {
                            if (state.sound && typeof state.sound.unload === 'function') {
                                state.sound.unload();
                            }
                        } catch (error) {
                            console.warn(`PlaybackInstanceHandler: Error during fallback cleanup for ${cueId}:`, error);
                    }
                        delete audioControllerContext.currentlyPlaying[cueId];
                    }
                }
            } else if (playingState.isPlaylist) {
                // For playlist items, ensure proper cleanup before delegating to _handlePlaylistEnd
                console.log(`PlaybackInstanceHandler: onstop for playlist item ${currentItemNameForEvents} in ${cueId}. Cleaning up before delegation.`);
                
                // Clean up the current sound instance but don't clear the entire state
                // since _handlePlaylistEnd will handle the playlist logic
                if (audioControllerContext.currentlyPlaying[cueId] && audioControllerContext.currentlyPlaying[cueId].sound === sound) {
                    try {
                        sound.unload();
                    } catch (error) {
                        console.warn(`PlaybackInstanceHandler: Error during playlist item cleanup for ${cueId}:`, error);
                    }
                    audioControllerContext.currentlyPlaying[cueId].sound = null;
                }
                
                audioControllerContext._handlePlaylistEnd(mainCue.id, false);
            } else if (!mainCue.loop) {
                // Single cue, not looping - use comprehensive cleanup
                console.log(`PlaybackInstanceHandler: onstop for single, non-looping cue ${cueId}. Using comprehensive cleanup.`);
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
                            console.warn(`PlaybackInstanceHandler: Error during fallback cleanup for ${cueId}:`, error);
                    }
                        delete audioControllerContext.currentlyPlaying[cueId];
                    }
                }
            } else {
                // Looping single cue - minimal cleanup, let it continue
                console.log(`PlaybackInstanceHandler: onstop for ${cueId} - Looping single cue. Minimal cleanup.`);
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
            console.error(`[ERROR_HANDLER ${cueId}] onloaderror: Failed to load ${filePath}:`, err, `(Sound ID: ${id})`);
            
            // Enhanced error context
            const errorContext = {
                cueId,
                filePath,
                itemName: currentItemNameForEvents,
                isPlaylist: playingState.isPlaylist,
                playlistIndex: actualItemIndexInOriginalList,
                soundId: id,
                error: err,
                errorType: 'loaderror',
                timestamp: Date.now(),
                userAgent: navigator.userAgent,
                audioCodecs: _getAudioCodecSupport()
            };
            
            console.error('[ERROR_HANDLER] Complete error context:', errorContext);
            
            const playingState = audioControllerContext.currentlyPlaying[cueId];
            if (playingState) {
                // Clean up intervals to prevent memory leaks
                if (playingState.timeUpdateInterval) {
                    clearInterval(playingState.timeUpdateInterval);
                    playingState.timeUpdateInterval = null;
                }
                if (audioControllerContext.playbackIntervals[cueId]) {
                    clearInterval(audioControllerContext.playbackIntervals[cueId]);
                    delete audioControllerContext.playbackIntervals[cueId];
                }
                
                // Enhanced error recovery for playlists
                if (playingState.isPlaylist) {
                    console.warn(`[ERROR_HANDLER ${cueId}] Load error for playlist item. Attempting recovery...`);
                    
                    // Mark this item as failed to prevent infinite retry loops
                    if (!playingState.failedItems) {
                        playingState.failedItems = new Set();
                    }
                    playingState.failedItems.add(actualItemIndexInOriginalList);
                    
                    // Try to find the next playable item
                    const nextPlayableIndex = _findNextPlayableItem(playingState, actualItemIndexInOriginalList);
                    
                    if (nextPlayableIndex !== -1) {
                        console.log(`[ERROR_HANDLER ${cueId}] Found next playable item at index ${nextPlayableIndex}`);
                        setTimeout(() => {
                            try {
                                playingState.currentPlaylistItemIndex = nextPlayableIndex;
                                audioControllerContext._playTargetItem(cueId, nextPlayableIndex, false);
                            } catch (retryError) {
                                console.error(`[ERROR_HANDLER ${cueId}] Error during playlist recovery:`, retryError);
                                audioControllerContext._handlePlaylistEnd(cueId, true);
                            }
                        }, 100);
                } else {
                        console.error(`[ERROR_HANDLER ${cueId}] No more playable items in playlist`);
                        audioControllerContext._handlePlaylistEnd(cueId, true);
                    }
                } else {
                    // For single files, try alternative file formats or provide better error feedback
                    console.error(`[ERROR_HANDLER ${cueId}] Single file load error. Checking for alternatives...`);
                    
                    // Check if file exists and provide specific error messages
                    if (typeof electronAPIForPreload !== 'undefined' && electronAPIForPreload.checkFileExists) {
                        electronAPIForPreload.checkFileExists(filePath).then((exists) => {
                            if (!exists) {
                                console.error(`[ERROR_HANDLER ${cueId}] File does not exist: ${filePath}`);
                                errorContext.specificError = 'file_not_found';
                            } else {
                                console.error(`[ERROR_HANDLER ${cueId}] File exists but failed to load - likely codec/format issue`);
                                errorContext.specificError = 'codec_unsupported';
                            }
                            _notifyErrorToUser(errorContext);
                        }).catch(() => {
                            console.error(`[ERROR_HANDLER ${cueId}] Unable to check file existence`);
                            errorContext.specificError = 'file_check_failed';
                            _notifyErrorToUser(errorContext);
                        });
                    } else {
                        errorContext.specificError = 'load_failed_unknown';
                        _notifyErrorToUser(errorContext);
                    }
                    
                    // Clean up state for single file
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
            }
            
            // Update UI state
            if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            }
            
            // Send enhanced error report via IPC
            if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
                audioControllerContext.ipcBindings.send('cue-status-update', { 
                    cueId: cueId, 
                    status: 'error', 
                    details: { 
                        error: 'loaderror', 
                        message: err ? (typeof err === 'string' ? err : JSON.stringify(err)) : 'Unknown load error',
                        context: errorContext,
                        recoveryAttempted: playingState?.isPlaylist || false
                    } 
                });
            }
        },
        
        onplayerror: (id, err) => {
            console.error(`[ERROR_HANDLER ${cueId}] onplayerror: Failed to play ${filePath}:`, err, `(Sound ID: ${id})`);
            
            // Enhanced error context
            const errorContext = {
                cueId,
                filePath,
                itemName: currentItemNameForEvents,
                isPlaylist: playingState.isPlaylist,
                playlistIndex: actualItemIndexInOriginalList,
                soundId: id,
                error: err,
                errorType: 'playererror',
                timestamp: Date.now(),
                userAgent: navigator.userAgent,
                audioContext: _getAudioContextInfo()
            };
            
            console.error('[ERROR_HANDLER] Complete error context:', errorContext);
            
            const playingState = audioControllerContext.currentlyPlaying[cueId];
            if (playingState) {
                // Clean up intervals
                if (playingState.timeUpdateInterval) {
                    clearInterval(playingState.timeUpdateInterval);
                    playingState.timeUpdateInterval = null;
                }
                if (audioControllerContext.playbackIntervals[cueId]) {
                    clearInterval(audioControllerContext.playbackIntervals[cueId]);
                    delete audioControllerContext.playbackIntervals[cueId];
                }
                
                // Enhanced error recovery for playlists
                if (playingState.isPlaylist) {
                    console.warn(`[ERROR_HANDLER ${cueId}] Play error for playlist item. Attempting recovery...`);
                    
                    // Mark this item as failed
                    if (!playingState.failedItems) {
                        playingState.failedItems = new Set();
                    }
                    playingState.failedItems.add(actualItemIndexInOriginalList);
                    
                    // Try to find the next playable item
                    const nextPlayableIndex = _findNextPlayableItem(playingState, actualItemIndexInOriginalList);
                    
                    if (nextPlayableIndex !== -1) {
                        console.log(`[ERROR_HANDLER ${cueId}] Found next playable item at index ${nextPlayableIndex}`);
                        setTimeout(() => {
                            try {
                                playingState.currentPlaylistItemIndex = nextPlayableIndex;
                                audioControllerContext._playTargetItem(cueId, nextPlayableIndex, false);
                            } catch (retryError) {
                                console.error(`[ERROR_HANDLER ${cueId}] Error during playlist recovery:`, retryError);
                                audioControllerContext._handlePlaylistEnd(cueId, true);
                            }
                        }, 100);
                } else {
                        console.error(`[ERROR_HANDLER ${cueId}] No more playable items in playlist`);
                        audioControllerContext._handlePlaylistEnd(cueId, true);
                    }
                } else {
                    // For single files, attempt retry with different audio settings
                    console.error(`[ERROR_HANDLER ${cueId}] Single file play error. Attempting alternative playback...`);
                    
                    // Attempt retry with HTML5 audio disabled (fallback to Web Audio)
                    if (playingState.retryCount === undefined) {
                        playingState.retryCount = 0;
                    }
                    
                    if (playingState.retryCount < 1) {
                        playingState.retryCount++;
                        console.log(`[ERROR_HANDLER ${cueId}] Retrying playback with different settings (attempt ${playingState.retryCount})`);
                        
                        setTimeout(() => {
                            try {
                                // Create new sound instance with different settings
                                const retrySound = new Howl({
                                    src: [filePath],
                                    volume: mainCue.volume !== undefined ? mainCue.volume : 1,
                                    loop: mainCue.loop || false,
                                    html5: true, // Try HTML5 Audio as fallback if Web Audio fails
                                    format: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'] // Specify multiple formats
                                });
                                
                                retrySound.once('load', () => {
                                    console.log(`[ERROR_HANDLER ${cueId}] Retry successful`);
                                    playingState.sound = retrySound;
                                    retrySound.play();
                                });
                                
                                retrySound.once('loaderror', () => {
                                    console.error(`[ERROR_HANDLER ${cueId}] Retry also failed`);
                                    errorContext.specificError = 'retry_failed';
                                    _notifyErrorToUser(errorContext);
                                    delete audioControllerContext.currentlyPlaying[cueId];
                                });
                                
                            } catch (retryError) {
                                console.error(`[ERROR_HANDLER ${cueId}] Error during retry:`, retryError);
                                errorContext.specificError = 'retry_exception';
                                _notifyErrorToUser(errorContext);
                    delete audioControllerContext.currentlyPlaying[cueId];
                }
                        }, 200);
                    } else {
                        console.error(`[ERROR_HANDLER ${cueId}] Max retry attempts reached`);
                        errorContext.specificError = 'max_retries_exceeded';
                        _notifyErrorToUser(errorContext);
                        delete audioControllerContext.currentlyPlaying[cueId];
                    }
                }
            }
            
            // Update UI state
            if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            }
            
            // Send enhanced error report via IPC
            if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
                audioControllerContext.ipcBindings.send('cue-status-update', { 
                    cueId: cueId, 
                    status: 'error', 
                    details: { 
                        error: 'playererror', 
                        message: err ? (typeof err === 'string' ? err : JSON.stringify(err)) : 'Unknown play error',
                        context: errorContext,
                        recoveryAttempted: playingState?.isPlaylist || playingState?.retryCount > 0
                    } 
                });
            }
        }
    });

    return sound;
}

// Helper function to find the next playable item in a playlist
function _findNextPlayableItem(playingState, currentIndex) {
    if (!playingState.isPlaylist || !playingState.originalPlaylistItems) {
        return -1;
    }
    
    const mainCue = playingState.cue;
    const items = playingState.originalPlaylistItems;
    const shuffleOrder = playingState.shufflePlaybackOrder;
    const failedItems = playingState.failedItems || new Set();
    
    // Determine the search space based on shuffle settings
    const searchSpace = mainCue.shuffle && shuffleOrder && shuffleOrder.length > 0 
        ? shuffleOrder.map((originalIndex, logicalIndex) => ({ logical: logicalIndex, original: originalIndex }))
        : items.map((_, index) => ({ logical: index, original: index }));
    
    // Find current position in search space
    const currentPosition = searchSpace.findIndex(item => 
        mainCue.shuffle ? item.logical === currentIndex : item.original === currentIndex
    );
    
    // Search forward from current position
    for (let i = currentPosition + 1; i < searchSpace.length; i++) {
        const candidate = searchSpace[i];
        if (!failedItems.has(candidate.original)) {
            return candidate.logical; // Return the logical index for playback
        }
    }
    
    // If looping is enabled, search from the beginning
    if (mainCue.loop) {
        for (let i = 0; i < currentPosition; i++) {
            const candidate = searchSpace[i];
            if (!failedItems.has(candidate.original)) {
                return candidate.logical;
            }
        }
    }
    
    return -1; // No playable items found
}

// Helper function to get audio codec support information
function _getAudioCodecSupport() {
    const audio = document.createElement('audio');
    return {
        mp3: audio.canPlayType('audio/mpeg') !== '',
        wav: audio.canPlayType('audio/wav') !== '',
        ogg: audio.canPlayType('audio/ogg') !== '',
        aac: audio.canPlayType('audio/aac') !== '',
        m4a: audio.canPlayType('audio/mp4') !== '',
        webm: audio.canPlayType('audio/webm') !== '',
        opus: audio.canPlayType('audio/ogg; codecs="opus"') !== ''
    };
}

// Helper function to get audio context information
function _getAudioContextInfo() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            return { available: false, reason: 'AudioContext not supported' };
        }
        
        const context = new AudioContext();
        const info = {
            available: true,
            state: context.state,
            sampleRate: context.sampleRate,
            baseLatency: context.baseLatency,
            outputLatency: context.outputLatency,
            maxChannelCount: context.destination.maxChannelCount
        };
        
        // Clean up the test context
        context.close();
        return info;
    } catch (error) {
        return { available: false, reason: error.message };
    }
}

// Helper function to notify user of errors with appropriate UI feedback
function _notifyErrorToUser(errorContext) {
    console.error('[ERROR_HANDLER] Notifying user of error:', errorContext);
    
    // Create user-friendly error message
    let userMessage = '';
    let technicalDetails = '';
    
    switch (errorContext.specificError) {
        case 'file_not_found':
            userMessage = `Audio file not found: ${errorContext.itemName}`;
            technicalDetails = `The file "${errorContext.filePath}" could not be found. It may have been moved, deleted, or the path is incorrect.`;
            break;
        case 'codec_unsupported':
            userMessage = `Unsupported audio format: ${errorContext.itemName}`;
            technicalDetails = `The audio file format is not supported by your browser. Supported formats: MP3, WAV, OGG, AAC, M4A.`;
            break;
        case 'retry_failed':
            userMessage = `Audio playback failed: ${errorContext.itemName}`;
            technicalDetails = `Multiple attempts to play the audio file have failed. The file may be corrupted or incompatible.`;
            break;
        case 'max_retries_exceeded':
            userMessage = `Audio playback repeatedly failed: ${errorContext.itemName}`;
            technicalDetails = `The system has exhausted all retry attempts for this audio file.`;
            break;
        default:
            userMessage = `Audio error: ${errorContext.itemName}`;
            technicalDetails = `An unexpected error occurred during audio playback.`;
    }
    
    // Try to show a user-friendly notification if available
    if (typeof window !== 'undefined' && window.showUserNotification) {
        window.showUserNotification('error', userMessage, technicalDetails);
    } else {
        // Fallback to console error with structured information
        console.error('[USER_ERROR]', {
            message: userMessage,
            details: technicalDetails,
            cueId: errorContext.cueId,
            filePath: errorContext.filePath,
            timestamp: new Date(errorContext.timestamp).toISOString()
        });
    }
    
    // Log to error reporting service if available
    if (typeof window !== 'undefined' && window.reportError) {
        window.reportError({
            type: 'audio_playback_error',
            context: errorContext,
            userMessage,
            technicalDetails
        });
    }
} 