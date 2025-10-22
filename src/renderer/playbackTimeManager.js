/**
 * Time update and trim end management for playback instances
 */

/**
 * Create and manage time update interval for a playing sound
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} audioControllerContext - Audio controller context
 */
export function createTimeUpdateInterval(cueId, sound, playingState, currentItemNameForEvents, audioControllerContext) {
    const { sendPlaybackTimeUpdate, playbackIntervals, cueGridAPI } = audioControllerContext;
    
    // === Time Update Interval Management START ===
    // Optimized interval management with adaptive frequency
    const existingGlobalInterval = playbackIntervals[cueId];
    const existingStateInterval = playingState.timeUpdateInterval;
    
    if (existingGlobalInterval) {
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Clearing existing global interval before creating new one`);
        clearInterval(existingGlobalInterval);
        delete playbackIntervals[cueId];
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
        } else if (!sound.playing()) {
            // CRITICAL FIX: Stop interval immediately if sound is no longer playing
            intervalStopReason = "Sound is no longer playing (ended/stopped)";
        }

        if (intervalStopReason) {
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] Stopping interval after ${updateCounter} updates. Reason: ${intervalStopReason}`);
            clearInterval(newInterval);
            if (playbackIntervals[cueId] === newInterval) {
                delete playbackIntervals[cueId];
            }
            if (playingState.timeUpdateInterval === newInterval) {
                playingState.timeUpdateInterval = null;
            }
            return;
        }

        // Send time update for UI button time display
        // console.log(`[TIME_UPDATE_DEBUG ${cueId}] Interval update #${updateCounter}: sound.playing()=${sound.playing()}, sound.seek()=${sound.seek()}, sound.state()=${sound.state()}`);
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
            
            if (cueGridAPI && cueGridAPI.updateCueButtonTime) {
                // Use updateCueButtonTime directly for smoother fade timer updates
                cueGridAPI.updateCueButtonTime(
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
    playbackIntervals[cueId] = newInterval;
    
    console.log(`[TIME_UPDATE_DEBUG ${cueId}] Created optimized time update interval with ${updateInterval}ms frequency`);
    // === Time Update Interval Management END ===
}

/**
 * Schedule trim end enforcement for a sound
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {object} mainCue - The main cue object
 * @param {string} filePath - The file path
 * @param {object} audioControllerContext - Audio controller context
 */
export function scheduleTrimEndEnforcement(cueId, sound, playingState, mainCue, filePath, audioControllerContext) {
    const { currentlyPlaying } = audioControllerContext;
    
    const scheduleTrimEndEnforcement = () => {
        const currentCueForTimer = (audioControllerContext && typeof audioControllerContext.getGlobalCueById === 'function')
            ? audioControllerContext.getGlobalCueById(cueId)
            : mainCue;
        const latestTrimEndTime = currentCueForTimer.trimEndTime || mainCue.trimEndTime;
        const latestTrimStartTime = currentCueForTimer.trimStartTime || mainCue.trimStartTime || 0;
        const isLoopEnabled = !!(currentCueForTimer.loop || mainCue.loop);

        if (latestTrimEndTime > 0 && latestTrimEndTime > latestTrimStartTime) {
            const currentSeek = sound.seek() || 0;
            const remainingDuration = (latestTrimEndTime - Math.max(currentSeek, latestTrimStartTime)) * 1000;

            if (remainingDuration > 0) {
                if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                playingState.trimEndTimer = setTimeout(() => {
                    // Ensure this is still the active sound
                    if (!(currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound)) return;

                    console.log(`PlaybackTimeManager: Reached trimEnd for cue: ${cueId} (item: ${filePath}). TrimEnd: ${latestTrimEndTime}`);

                    if (isLoopEnabled) {
                        // Loop within the trimmed range: seek back to trim start and reschedule timer
                        try {
                            sound.seek(latestTrimStartTime || 0);
                            // If not playing due to internal state, ensure playback continues
                            if (!sound.playing()) {
                                sound.play();
                            }
                        } catch (e) {
                            console.warn(`PlaybackTimeManager: Error seeking to trimStart for loop on cue ${cueId}:`, e);
                        }

                        // Schedule next trim end enforcement for the next loop cycle
                        const nextDurationMs = (latestTrimEndTime - (latestTrimStartTime || 0)) * 1000;
                        if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                        playingState.trimEndTimer = setTimeout(() => {
                            // Re-enter enforcement
                            scheduleTrimEndEnforcement();
                        }, Math.max(10, nextDurationMs));
                        console.log(`PlaybackTimeManager: Looping within trim region. Next enforcement in ${nextDurationMs}ms.`);
                    } else {
                        // Not looping, stop playback at trim end
                        sound.stop();
                    }
                }, remainingDuration);
                console.log(`PlaybackTimeManager: Set trim end timer for ${remainingDuration}ms. Current seek: ${currentSeek}, Trim end: ${latestTrimEndTime}, loop: ${isLoopEnabled}`);
            } else if (currentSeek >= latestTrimEndTime) {
                console.log(`PlaybackTimeManager: Current seek ${currentSeek} is past trimEnd ${latestTrimEndTime} for cue: ${cueId}. ${isLoopEnabled ? 'Looping to trimStart.' : 'Stopping.'}`);
                if (isLoopEnabled) {
                    try {
                        sound.seek(latestTrimStartTime || 0);
                        if (!sound.playing()) sound.play();
                        // After immediate seek, schedule next enforcement
                        const nextDurationMs = (latestTrimEndTime - (latestTrimStartTime || 0)) * 1000;
                        if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                        playingState.trimEndTimer = setTimeout(() => {
                            scheduleTrimEndEnforcement();
                        }, Math.max(10, nextDurationMs));
                    } catch (e) {
                        console.warn(`PlaybackTimeManager: Error seeking to trimStart for loop on cue ${cueId}:`, e);
                    }
                } else {
                    sound.stop();
                }
            }
        }
    };

    scheduleTrimEndEnforcement();
}

/**
 * Clear time update intervals for a cue
 * @param {string} cueId - The cue ID
 * @param {object} playingState - The playing state
 * @param {object} audioControllerContext - Audio controller context
 */
export function clearTimeUpdateIntervals(cueId, playingState, audioControllerContext) {
    const { playbackIntervals } = audioControllerContext;
    
    if (playbackIntervals[cueId]) {
        clearInterval(playbackIntervals[cueId]);
        delete playbackIntervals[cueId];
    }
    
    if (playingState.timeUpdateInterval) {
        clearInterval(playingState.timeUpdateInterval);
        playingState.timeUpdateInterval = null;
    }
}

/**
 * Clear trim end timer for a cue
 * @param {object} playingState - The playing state
 */
export function clearTrimEndTimer(playingState) {
    if (playingState.trimEndTimer) {
        clearTimeout(playingState.trimEndTimer);
        playingState.trimEndTimer = null;
    }
}
