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
        _playTargetItem // For error recovery
    } = audioControllerContext;

    const sound = new Howl({
        src: [filePath],
        volume: mainCue.volume !== undefined ? mainCue.volume : 1,
        loop: playingState.isPlaylist ? false : (mainCue.loop || false),
        html5: true, // Recommended for longer tracks and seeking
        onload: () => {
            console.log(`PlaybackInstanceHandler: Audio loaded: ${filePath} for cue: ${cueId} (item: ${currentItemNameForEvents})`);
            const soundDuration = sound.duration();
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
            console.log(`PlaybackInstanceHandler: Playing: ${cueId} (item: ${filePath}), isResume: ${isResumeForSeekAndFade}`);
            playingState.sound = sound; // IMPORTANT: Update the sound reference in the shared playingState
            playingState.isPaused = false;

            if (playingState.timeUpdateInterval) {
                clearInterval(playingState.timeUpdateInterval);
                playingState.timeUpdateInterval = null;
            }
            if (playbackIntervals[cueId]) {
                clearInterval(playbackIntervals[cueId]);
                delete playbackIntervals[cueId];
            }

            sendPlaybackTimeUpdate(cueId, sound, playingState, currentItemNameForEvents, 'playing');

            if (cueGridAPI) {
                cueGridAPI.updateButtonPlayingState(cueId, true, playingState.isPlaylist ? currentItemNameForEvents : null);
                if (playingState.isPlaylist && sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function') {
                    const currentItemForHighlight = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                    if (currentItemForHighlight && currentItemForHighlight.id) {
                         sidebarsAPI.highlightPlayingPlaylistItem(cueId, currentItemForHighlight.id);
                    } else {
                         sidebarsAPI.highlightPlayingPlaylistItem(cueId, null); // Clear if no valid item
                    }
                }
            }

            const newInterval = setInterval(() => {
                // Check against the sound instance in playingState, which should be this one.
                if (playingState.sound && playingState.sound.playing() && 
                    currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === playingState.sound &&
                    !currentlyPlaying[cueId].isPaused) { 
                    
                    const currentSeek = typeof playingState.sound.seek === 'function' ? playingState.sound.seek() : -1; // Defensively check seek
                    const currentDuration = playingState.duration; // Duration set on onload
                    console.log(`PlaybackInterval (${cueId} - ${currentItemNameForEvents}): seek=${currentSeek}, state.duration=${currentDuration}`);

                    // --- DEBUG LOGGING FOR playingState --- 
                    console.log(`PlaybackInterval (${cueId}): Inspecting playingState before sendPlaybackTimeUpdate. Keys: ${Object.keys(playingState || {}).join(', ')}`);
                    if (playingState) {
                        console.log(`PlaybackInterval (${cueId}): playingState.cue defined? ${!!playingState.cue}. Cue Keys: ${Object.keys(playingState.cue || {}).join(', ')}`);
                        if (playingState.cue) {
                            console.log(`PlaybackInterval (${cueId}): playingState.cue.id: ${playingState.cue.id}, playingState.cue.name: ${playingState.cue.name}`);
                        }
                    }
                    // --- END DEBUG LOGGING --- 

                    sendPlaybackTimeUpdate(cueId, playingState.sound, playingState, currentItemNameForEvents, 'playing');
                    if (cueGridAPI && typeof cueGridAPI.updateCueButtonTime === 'function') {
                        console.log(`PlaybackInterval: About to call cueGridAPI.updateCueButtonTime for ${cueId}`); // DEBUG LOG
                        cueGridAPI.updateCueButtonTime(cueId);
                    } else {
                        console.warn(`PlaybackInterval: cueGridAPI or updateCueButtonTime not available for ${cueId}. API: ${!!cueGridAPI}, Fn: ${typeof cueGridAPI?.updateCueButtonTime}`);
                    }
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
            console.log(`PlaybackInstanceHandler: Paused: ${cueId}`);
            
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
            console.log(`PlaybackInstanceHandler: Cue item finished (onend event): ${filePath} for cue ${cueId}`);
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
            
            sendPlaybackTimeUpdate(cueId, null, playingState, currentItemNameForEvents, 'stopped');
            
            let handledByLoopOrPlaylist = false;
            playingState.isPaused = false; // Ensure not stuck in paused state

            if (playingState.isPlaylist) {
                if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function') {
                    sidebarsAPI.highlightPlayingPlaylistItem(cueId, null);
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
        },
        onstop: () => {
            console.log(`PlaybackInstanceHandler: Cue item stopped (onstop event): ${filePath} for cue ${cueId}`);

            if (playbackIntervals[cueId]) {
                clearInterval(playbackIntervals[cueId]);
                delete playbackIntervals[cueId];
            }
            if (playingState.timeUpdateInterval) {
                clearInterval(playingState.timeUpdateInterval);
                playingState.timeUpdateInterval = null;
            }

            sendPlaybackTimeUpdate(cueId, null, playingState, currentItemNameForEvents, 'stopped');
            
            // If this stop was part of playlist progression or error, _handlePlaylistEnd or error handlers might have already cleaned up.
            // This is a general cleanup for explicit stops or end of non-looping single cues.
            if (currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound) {
                 // If it's a playlist and not explicitly stopping, onend should handle it.
                 // If it is stopping, or a single cue, then clear it.
                if (playingState.isStopping || !playingState.isPlaylist) {
                    delete currentlyPlaying[cueId];
                    console.log(`PlaybackInstanceHandler: Cleared currentlyPlaying state for ${cueId} in onstop.`);
                }
            }


            if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                cueGridAPI.updateButtonPlayingState(cueId, false, null);
            }
            if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && playingState.isPlaylist) {
                sidebarsAPI.highlightPlayingPlaylistItem(cueId, null); // Clear highlight on stop for playlist
            }
            if (ipcBindings && typeof ipcBindings.send === 'function') {
                ipcBindings.send('cue-status-update', { cueId: cueId, status: 'stopped', details: {} });
            }
        },
        onfade: () => {
            // Check against playingState.sound as it should be this instance
            if (playingState && playingState.sound === sound && sound.volume() === 0) {
                console.log(`PlaybackInstanceHandler: Fade out complete for cue: ${cueId} (item: ${filePath})`);
                if (playingState.isStopping) {
                    sound.stop(); 
                } else {
                    console.warn(`PlaybackInstanceHandler: onfade to 0 for ${cueId} but isStopping is false.`);
                }
            }
        },
        onloaderror: (loadErrSoundId, error) => {
            console.error(`PlaybackInstanceHandler: Error loading audio: ${filePath} for cue ${cueId}:`, error);
            // Ensure playingState.sound is this sound if it was set, or if it's the one we are attempting to load
            if ( (playingState.sound === sound) || (playingState.sound === null && currentlyPlaying[cueId] === playingState) ) {
                if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                
                if (playingState.isPlaylist) {
                    console.log(`PlaybackInstanceHandler: Error loading playlist item ${filePath}, trying next via _playTargetItem.`);
                    // _playTargetItem will advance index and call itself.
                    // It needs to be called from audioController's scope.
                    // We can pass _playTargetItem in the context.
                     const nextItemIndex = playingState.currentPlaylistItemIndex + 1;
                     const listLength = mainCue.shuffle ? playingState.shufflePlaybackOrder.length : playingState.originalPlaylistItems.length;
                    if (nextItemIndex < listLength) {
                         _playTargetItem(cueId, nextItemIndex, false); // Call audioController's function
                    } else {
                        _handlePlaylistEnd(cueId, true); // Error, end of playlist
                    }
                } else {
                    delete currentlyPlaying[cueId];
                    if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
                }
            }
            if (ipcBindings && typeof ipcBindings.send === 'function') {
                ipcBindings.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: `load_error: ${String(error)} on ${filePath}` } });
            }
            sound.unload();
            if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && playingState.isPlaylist) {
                sidebarsAPI.highlightPlayingPlaylistItem(cueId, null);
            }
        },
        onplayerror: (playErrSoundId, error) => {
            console.error(`PlaybackInstanceHandler: Error playing audio: ${filePath} for cue ${cueId}:`, error);
            if (playingState.sound === sound) { // Only if this sound instance caused the error
                if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                if (playingState.isPlaylist) {
                    console.log(`PlaybackInstanceHandler: Error playing playlist item ${filePath}, trying next via _playTargetItem.`);
                    const nextItemIndex = playingState.currentPlaylistItemIndex + 1;
                    const listLength = mainCue.shuffle ? playingState.shufflePlaybackOrder.length : playingState.originalPlaylistItems.length;
                    if (nextItemIndex < listLength) {
                         _playTargetItem(cueId, nextItemIndex, false);
                    } else {
                        _handlePlaylistEnd(cueId, true);
                    }
                } else {
                    delete currentlyPlaying[cueId];
                    if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
                }
            }
            if (ipcBindings && typeof ipcBindings.send === 'function') {
                ipcBindings.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: `play_error: ${String(error)} on ${filePath}` } });
            }
            sound.unload();
            if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && playingState.isPlaylist) {
                sidebarsAPI.highlightPlayingPlaylistItem(cueId, null);
            }
        }
    });

    return sound;
} 