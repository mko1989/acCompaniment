/**
 * Core event handlers for Howler sound instances (onload, onplay, onpause)
 */

import { applyDuckingOnPlay } from './playbackDucking.js';
import { createTimeUpdateInterval, scheduleTrimEndEnforcement, clearTimeUpdateIntervals } from './playbackTimeManager.js';

/**
 * Create onload event handler
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {number} actualItemIndexInOriginalList - Actual item index in original list
 * @param {boolean} isResumeForSeekAndFade - If playback is resuming
 * @param {object} mainCue - The main cue object
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onload event handler
 */
export function createOnloadHandler(cueId, sound, playingState, filePath, currentItemNameForEvents, actualItemIndexInOriginalList, isResumeForSeekAndFade, mainCue, audioControllerContext) {
    return () => {
        console.log(`[ONLOAD_DEBUG ${cueId}] Audio loaded: ${filePath} for cue: ${cueId} (item: ${currentItemNameForEvents})`);
        console.log(`[ONLOAD_DEBUG ${cueId}] Sound state: ${sound.state()}, duration: ${sound.duration()}`);
        const soundDuration = sound.duration();
        console.log(`[ONLOAD_DEBUG ${cueId}] For filePath: "${filePath}", Howler sound.duration() returned: ${soundDuration} (type: ${typeof soundDuration})`);
        playingState.duration = soundDuration; // Store duration on the playingState

        // Set audio output device for this sound instance
        if (audioControllerContext.audioControllerRef && 
            audioControllerContext.audioControllerRef.getCurrentAudioOutputDeviceId) {
            const deviceId = audioControllerContext.audioControllerRef.getCurrentAudioOutputDeviceId();
            if (deviceId && deviceId !== 'default') {
                console.log(`PlaybackEventHandlers: Setting audio output device to ${deviceId} for cue ${cueId}`);
                
                // Set the sink ID on the HTML5 Audio element
                if (sound._sounds && sound._sounds.length > 0) {
                    const audioNode = sound._sounds[0]._node;
                    if (audioNode && typeof audioNode.setSinkId === 'function') {
                        const sinkId = deviceId === 'default' ? '' : deviceId;
                        audioNode.setSinkId(sinkId).then(() => {
                            console.log(`PlaybackEventHandlers: Successfully set device for cue ${cueId}`);
                        }).catch(error => {
                            console.warn(`PlaybackEventHandlers: Failed to set device for cue ${cueId}:`, error);
                            
                            // If device not found, try to fall back to default device
                            if (error.name === 'NotFoundError' || error.message.includes('not found')) {
                                console.log(`PlaybackEventHandlers: Device not found, falling back to default for cue ${cueId}`);
                                audioNode.setSinkId('').then(() => {
                                    console.log(`PlaybackEventHandlers: Successfully set default device for cue ${cueId}`);
                                }).catch(fallbackError => {
                                    console.error(`PlaybackEventHandlers: Failed to set default device for cue ${cueId}:`, fallbackError);
                                });
                            }
                        });
                    }
                }
            }
        }

        // Inform UI/CueStore about the discovered duration for persistence
        if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
            const payload = { cueId, duration: soundDuration };
            if (playingState.isPlaylist) {
                const originalItem = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                if (originalItem && originalItem.id) {
                    payload.playlistItemId = originalItem.id;
                } else {
                    console.warn(`PlaybackEventHandlers: Playlist item ID not found for duration update. Cue: ${cueId}, Item Index: ${actualItemIndexInOriginalList}`);
                }
            }
            console.log('PlaybackEventHandlers: Sending cue-duration-update via ipcBindings.send', payload);
            audioControllerContext.ipcBindings.send('cue-duration-update', payload);
        } else {
            console.warn('PlaybackEventHandlers: ipcBindings.send is not available for cue-duration-update.');
        }
        
        if (audioControllerContext.sidebarsAPI && typeof audioControllerContext.sidebarsAPI.updateWaveformDisplayDuration === 'function') {
            audioControllerContext.sidebarsAPI.updateWaveformDisplayDuration(cueId, soundDuration, playingState.isPlaylist ? playingState.originalPlaylistItems[actualItemIndexInOriginalList]?.id : null);
        }

        let effectiveStartTime = 0;
        if (playingState.isPlaylist) {
            const item = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
            effectiveStartTime = item.trimStartTime || 0;
        } else {
            effectiveStartTime = mainCue.trimStartTime || 0;
        }

        if (isResumeForSeekAndFade && playingState.seekBeforeResume !== undefined) {
            console.log(`PlaybackEventHandlers: Resuming from seek position: ${playingState.seekBeforeResume} for ${currentItemNameForEvents}`);
            sound.seek(playingState.seekBeforeResume);
            delete playingState.seekBeforeResume;
        } else if (effectiveStartTime > 0 && !isResumeForSeekAndFade) {
            console.log(`PlaybackEventHandlers: Seeking to trimStartTime: ${effectiveStartTime} for ${currentItemNameForEvents}`);
            sound.seek(effectiveStartTime);
        }
        
        // Check if this is a crossfade situation - use crossfade duration instead of cue's fadeInTime
        const isCrossfadeIn = playingState.crossfadeInfo && playingState.crossfadeInfo.isCrossfadeIn;
        let fadeInDuration;
        let fadeInTargetVolume;
        
        if (isCrossfadeIn && playingState.crossfadeInfo) {
            // Use crossfade duration and target volume from crossfade info
            fadeInDuration = playingState.crossfadeInfo.crossfadeDuration || 2000;
            fadeInTargetVolume = playingState.crossfadeInfo.targetVolume || 1;
            console.log(`PlaybackEventHandlers: Crossfade-in detected - applying ${fadeInDuration}ms crossfade to volume ${fadeInTargetVolume}`);
        } else {
            // Use normal cue fade-in settings
            fadeInDuration = playingState.isPlaylist ? 
                           (playingState.originalPlaylistItems[actualItemIndexInOriginalList].fadeInTime !== undefined ? playingState.originalPlaylistItems[actualItemIndexInOriginalList].fadeInTime : (mainCue.fadeInTime !== undefined ? mainCue.fadeInTime : 0)) :
                           (mainCue.fadeInTime !== undefined ? mainCue.fadeInTime : 0);
            fadeInTargetVolume = sound.volume(); // Use current volume as target
        }
        
        if (fadeInDuration > 0 && !playingState.isPaused) {
            console.log(`PlaybackEventHandlers: Applying fade-in (${fadeInDuration}ms) for ${currentItemNameForEvents} to volume ${fadeInTargetVolume}`);
            sound.fade(0, fadeInTargetVolume, fadeInDuration); // Fade from 0 to target volume
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
    };
}

/**
 * Create onplay event handler
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {number} actualItemIndexInOriginalList - Actual item index in original list
 * @param {boolean} isResumeForSeekAndFade - If playback is resuming
 * @param {object} mainCue - The main cue object
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onplay event handler
 */
export function createOnplayHandler(cueId, sound, playingState, filePath, currentItemNameForEvents, actualItemIndexInOriginalList, isResumeForSeekAndFade, mainCue, audioControllerContext) {
    return () => {
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Fired for ${filePath}. isResumeForSeekAndFade: ${isResumeForSeekAndFade}`);
        
        // === Enhanced race condition protection START ===
        let currentGlobalState = null;
        
        // Skip race condition checks for independent instances (multiple instance mode)
        if (!playingState.isIndependentInstance) {
            // Check if this sound instance is stale or conflicting with a newer instance
            currentGlobalState = audioControllerContext.currentlyPlaying[cueId];
            
            // If no global state exists, this sound instance is likely stale
            // BUT: Don't stop immediately - this could be a legitimate new instance starting
            if (!currentGlobalState) {
                console.warn(`[RETRIGGER_DEBUG ${cueId}] onplay: No global state found for cue. This may be a new instance starting.`);
                // Don't stop - allow the new instance to proceed and establish state
            }
            
            // If there's already a different sound instance in the global state, this one is stale
            if (currentGlobalState && currentGlobalState.sound && currentGlobalState.sound !== sound) {
                console.warn(`[RETRIGGER_DEBUG ${cueId}] onplay: Different sound instance already exists in global state. This instance is stale. Stopping.`);
                if (sound.playing()) {
                    sound.stop();
                }
                return;
            }
            
            // Additional check: if the playingState passed to this function is different from current global state
            if (currentGlobalState && playingState !== currentGlobalState) {
                console.warn(`[RETRIGGER_DEBUG ${cueId}] onplay: playingState from closure differs from current global state. This may be a stale instance.`);
                // Don't immediately stop - allow it to proceed but log the warning
            }
        } else {
            console.log(`[RETRIGGER_DEBUG ${cueId}] onplay: Independent instance - skipping race condition checks.`);
        }
        
        // If this sound instance was marked for stopping with fade as part of retrigger behavior
        if (sound.acIsStoppingWithFade && (sound.acStopSource === 'fade_out_and_stop' || sound.acStopSource === 'restart')) {
            console.log(`[RETRIGGER_DEBUG ${cueId}] onplay: Suppressed for ${filePath}. Reason: acIsStoppingWithFade is true and acStopSource is '${sound.acStopSource}'.`);
            if (sound.playing()) {
                sound.stop();
            }
            return; 
        }
        // === Enhanced race condition protection END ===

        playingState.sound = sound; // IMPORTANT: Update the sound reference in the shared playingState
        playingState.isPaused = false;
        
        // Sound instance already tracked during creation
        
        // Update global state only for managed instances, not independent instances
        if (!playingState.isIndependentInstance) {
            audioControllerContext.currentlyPlaying[cueId] = playingState;
        }
        
        // Update current cue priority for Companion 
        // For independent instances, only update if no managed instance exists
        const shouldUpdateCompanion = !playingState.isIndependentInstance || 
                                    !audioControllerContext.currentlyPlaying[cueId];
        
        if (shouldUpdateCompanion && audioControllerContext._updateCurrentCueForCompanion) {
            audioControllerContext.lastCurrentCueId = audioControllerContext._updateCurrentCueForCompanion(
                audioControllerContext.cuePlayOrder || [],
                audioControllerContext.currentlyPlaying,
                audioControllerContext.lastCurrentCueId,
                audioControllerContext.sendPlaybackTimeUpdateRef
            );
        }

        // Apply ducking logic
        applyDuckingOnPlay(cueId, sound, playingState, audioControllerContext);

        // Create time update interval
        createTimeUpdateInterval(cueId, sound, playingState, currentItemNameForEvents, audioControllerContext);

        // Initial time update immediately on play
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Sending initial time update.`);
        audioControllerContext.sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'playing');

        if (audioControllerContext.cueGridAPI) {
            audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, true, playingState.isPlaylist ? currentItemNameForEvents : null);
            
            // Enhanced debugging for playlist highlighting
            console.log(`PlaybackEventHandlers (DEBUG HIGHLIGHT): CueID: ${cueId}, isPlaylist: ${playingState.isPlaylist}, sidebarsAPI exists: ${!!audioControllerContext.sidebarsAPI}, highlightFn exists: ${typeof audioControllerContext.sidebarsAPI?.highlightPlayingPlaylistItemInSidebar === 'function'}`);
            if (audioControllerContext.sidebarsAPI) {
                console.log(`PlaybackEventHandlers (DEBUG HIGHLIGHT): sidebarsAPI keys:`, Object.keys(audioControllerContext.sidebarsAPI));
            }
            console.log(`PlaybackEventHandlers (DEBUG HIGHLIGHT): actualItemIndexInOriginalList: ${actualItemIndexInOriginalList}, originalPlaylistItems length: ${playingState.originalPlaylistItems?.length}`);

            if (playingState.isPlaylist && audioControllerContext.sidebarsAPI && typeof audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar === 'function') {
                const currentItemForHighlight = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                console.log(`PlaybackEventHandlers: Attempting to highlight. CueID: ${cueId}, ItemID: ${currentItemForHighlight?.id}, currentItemForHighlight:`, currentItemForHighlight);
                if (currentItemForHighlight && currentItemForHighlight.id) {
                     console.log(`PlaybackEventHandlers: Calling highlightPlayingPlaylistItemInSidebar with cueId: ${cueId}, itemId: ${currentItemForHighlight.id}`);
                     audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, currentItemForHighlight.id);
                } else {
                     console.log(`PlaybackEventHandlers: No currentItemForHighlight.id, attempting to clear highlight for cue ${cueId}`);
                     audioControllerContext.sidebarsAPI.highlightPlayingPlaylistItemInSidebar(cueId, null); // Clear if no valid item
                }
            } else {
                console.log(`PlaybackEventHandlers: Highlighting conditions not met - isPlaylist: ${playingState.isPlaylist}, sidebarsAPI: ${!!audioControllerContext.sidebarsAPI}, highlightFn: ${typeof audioControllerContext.sidebarsAPI?.highlightPlayingPlaylistItemInSidebar}`);
            }
        }

        // Send status updates for UI feedback 
        // For independent instances, only send if no managed instance exists
        const shouldSendUIUpdates = !playingState.isIndependentInstance || 
                                  !audioControllerContext.currentlyPlaying[cueId];
        
        if (shouldSendUIUpdates && audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
            let statusDetails = {};
            if (playingState.isPlaylist) {
                statusDetails = {
                    playlistItemPath: filePath,
                    playlistItemName: currentItemNameForEvents
                };
            }
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onplay: Sending cue-status-update (playing). IsIndependent: ${playingState.isIndependentInstance}`);
            audioControllerContext.ipcBindings.send('cue-status-update', { cueId: cueId, status: 'playing', details: statusDetails });
        }

        // Get the latest cue data from the store to ensure we have current trim values
        if (!playingState.isPlaylist) {
            scheduleTrimEndEnforcement(cueId, sound, playingState, mainCue, filePath, audioControllerContext);
        }
    };
}

/**
 * Create onpause event handler
 * @param {string} cueId - The cue ID
 * @param {object} sound - The Howler sound instance
 * @param {object} playingState - The playing state
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onpause event handler
 */
export function createOnpauseHandler(cueId, sound, playingState, currentItemNameForEvents, audioControllerContext) {
    return () => {
        console.log(`[TIME_UPDATE_DEBUG ${cueId}] onpause: Fired for cue ${cueId}.`);
        
        clearTimeUpdateIntervals(cueId, playingState, audioControllerContext);
        
        playingState.isPaused = true;
        if (playingState.sound) { // Sound is this instance
            playingState.lastSeekPosition = sound.seek() || 0;
            console.log(`[TIME_UPDATE_DEBUG ${cueId}] onpause: lastSeekPosition set to ${playingState.lastSeekPosition}`);
        }

        audioControllerContext.sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'paused');

        if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
            audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false,
                playingState.isPlaylist ? currentItemNameForEvents : null
            );
        }
        if (audioControllerContext.ipcBindings && typeof audioControllerContext.ipcBindings.send === 'function') {
            audioControllerContext.ipcBindings.send('cue-status-update', { cueId: cueId, status: 'paused', details: {} });
        }
    };
}
