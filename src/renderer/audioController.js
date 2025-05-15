// Companion_soundboard/src/renderer/audioController.js
// Manages audio playback using Howler.js.

import { getGlobalCueById } from './ui/utils.js'; // Import the function

// import { Howl } from 'howler'; // Removed: Howler.js is now loaded globally via CDN

let currentlyPlaying = {}; // cueId: { sound: Howl_instance, cue: cueData, isPaused: boolean, trimEndTimer?: number, isPlaylist?: boolean, playlistItems?: [], currentPlaylistItemIndex?: number, isStopping?: boolean, originalPlaylistItems?: [], shufflePlaybackOrder?: number[] }
let ipcBindings; // To send status updates
let cueGridAPI; // Reference to cueGrid.js module (or its relevant functions)
let sidebarsAPI; // Reference to sidebars.js module (or its relevant functions)
let playbackIntervals = {}; // To manage playback intervals
let pendingRestarts = {}; // To manage pending restarts
let currentAppConfigRef = {}; // To store current app configuration

// Call this function to initialize the module with dependencies
function init(ipcRendererBindings, cgAPI, sbAPI) {
    ipcBindings = ipcRendererBindings;
    cueGridAPI = cgAPI; // Store cueGrid API reference
    sidebarsAPI = sbAPI; // Store sidebars API reference
    // Initial audio output device will be set by ui.js after it loads config
    console.log('AudioController initialized. Waiting for UI to set initial audio device.');
}

// New function to update the internal app config reference
function updateAppConfig(newConfig) {
    currentAppConfigRef = { ...currentAppConfigRef, ...newConfig };
    console.log('AudioController: App config updated:', currentAppConfigRef);
}

// New function to set the audio output device for Howler
async function setAudioOutputDevice(deviceId) {
    console.log(`AudioController: Attempting to set audio output device to: ${deviceId}`);
    if (Howler.ctx && typeof Howler.ctx.setSinkId === 'function') {
        try {
            await Howler.ctx.setSinkId(deviceId);
            console.log(`AudioController: Successfully set audio output device to ${deviceId}`);
            // Optionally, could re-play currently playing sounds if setSinkId doesn't affect them, 
            // but MDN suggests it should redirect existing audio.
        } catch (error) {
            console.error(`AudioController: Error setting audio output device ${deviceId}:`, error);
            if (error.name === 'NotFoundError') {
                alert(`Audio device ${deviceId} not found. Please select another device.`);
            }
            // If it fails, it might revert to default or previous. Behavior can be browser/system dependent.
        }
    } else {
        console.warn('AudioController: AudioContext.setSinkId is not available. Cannot change audio output device.');
        // Potentially show a warning to the user if this is critical
    }
}

// Plays a new instance of the sound or resumes if paused.
// Handles both single file cues and playlist cues.
function play(cue, isResume = false) {
    if (!cue || !cue.id) {
        console.error('AudioController: Invalid cue object provided for play.');
        if (ipcBindings) ipcBindings.sendCueStatusUpdate(cue ? cue.id : 'unknown', 'error', { details: 'invalid_cue_data' });
        return;
    }
    const cueId = cue.id;
    const existingState = currentlyPlaying[cueId];

    // Resume if paused (applies to current sound, whether single or playlist item)
    if (isResume && existingState && existingState.isPaused) {
        console.log('AudioController: Resuming paused cue:', cueId);
        existingState.isPaused = false;
        if (existingState.sound) {
            existingState.sound.play();
        } else if (existingState.isPlaylist) {
            // If sound was somehow cleared but we want to resume playlist, restart current item
            console.warn('AudioController: Resuming playlist but sound object was missing. Restarting current item.');
            _playTargetItem(cueId, existingState.currentPlaylistItemIndex, true);
        }
        // onplay event of the sound should handle UI and IPC status update for 'playing'
        return;
    }

    // If already playing and not a resume, behavior depends on toggle/retrigger logic which should have called stop first.
    // For a direct play call that's not a resume, we'll stop the current and restart.
    if (existingState && !isResume) {
        console.warn(`AudioController: Play called for active cue ${cueId} (not a resume). Stopping current and restarting.`);
        if (existingState.sound) {
            existingState.sound.stop(); // Stop current sound
        }
        if (existingState.trimEndTimer) {
            clearTimeout(existingState.trimEndTimer);
        }
        delete currentlyPlaying[cueId]; // Clear old state
    }


    if (cue.type === 'playlist') {
        if (!cue.playlistItems || cue.playlistItems.length === 0) {
            console.error('AudioController: Playlist cue has no items:', cueId);
            if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'error', { details: 'empty_playlist' });
            return;
        }
        currentlyPlaying[cueId] = {
            sound: null, // Will be set by _playTargetItem
            cue: cue,
            isPaused: false,
            isPlaylist: true,
            playlistItems: cue.playlistItems,
            currentPlaylistItemIndex: 0,
            originalPlaylistItems: cue.playlistItems.slice(),
            shufflePlaybackOrder: []
        };
        if (cue.shuffle && currentlyPlaying[cueId].playlistItems.length > 1) {
            _generateShuffleOrder(cueId);
            _playTargetItem(cueId, 0, isResume); // Play the item at the 0th position in shufflePlaybackOrder
        } else {
            _playTargetItem(cueId, 0, isResume); // Start with the first item (original order)
        }
    } else { // Single file cue
        if (!cue.filePath) {
            console.error('AudioController: No file path for single cue:', cueId);
            if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'error', { details: 'no_file_path' });
            return;
        }
        currentlyPlaying[cueId] = {
            sound: null, // Will be set by _playTargetItem
            cue: cue,
            isPaused: false,
            isPlaylist: false
        };
        _playTargetItem(cueId, undefined, isResume); // No playlist index needed
    }
}


// Internal function to play a specific item (either a single cue's file or a playlist item)
// isResumeForSeekAndFade: if true, means we are resuming playback after a pause for this item,
// or starting this item as part of a playlist resume.
function _playTargetItem(cueId, playlistItemIndex, isResumeForSeekAndFade = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState) {
        console.error(`AudioController: No playing state found for cueId ${cueId} in _playTargetItem.`);
        return;
    }

    const mainCue = playingState.cue;
    let filePath;
    let currentItemName = mainCue.name;
    let actualItemIndexInOriginalList = playlistItemIndex; // Used to get the item ID for highlighting

    if (playingState.isPlaylist) {
        let playIndex = playlistItemIndex;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) {
            if (playlistItemIndex === undefined || playlistItemIndex < 0 || playlistItemIndex >= playingState.shufflePlaybackOrder.length) {
                console.error(`AudioController: Invalid shuffle order index ${playlistItemIndex} for cue ${cueId}.`);
                _handlePlaylistEnd(cueId, true);
                return;
            }
            actualItemIndexInOriginalList = playingState.shufflePlaybackOrder[playlistItemIndex];
            playIndex = actualItemIndexInOriginalList;
        } else {
            if (playlistItemIndex === undefined || playlistItemIndex < 0 || playlistItemIndex >= playingState.originalPlaylistItems.length) {
                console.error(`AudioController: Invalid playlistItemIndex ${playlistItemIndex} for cue ${cueId}.`);
                _handlePlaylistEnd(cueId, true);
                return;
            }
            // actualItemIndexInOriginalList remains playlistItemIndex
        }

        const item = playingState.originalPlaylistItems[playIndex]; 
        if (!item || !item.path) {
            console.error(`AudioController: Invalid playlist item at original index ${playIndex} (shuffle index ${playlistItemIndex}) for cue ${cueId}. Path: ${item ? item.path : 'undefined'}. Skipping item.`);
            playingState.currentPlaylistItemIndex++; 
            const nextIdxToPlay = playingState.currentPlaylistItemIndex;
            const listLength = mainCue.shuffle ? playingState.shufflePlaybackOrder.length : playingState.originalPlaylistItems.length;
            if (nextIdxToPlay < listLength) {
                _playTargetItem(cueId, nextIdxToPlay, false);
            } else {
                _handlePlaylistEnd(cueId, !mainCue.loop);
            }
            return;
        }
        filePath = item.path;
        currentItemName = item.name || filePath.split(/[\\\/]/).pop();
        playingState.currentPlaylistItemIndex = playlistItemIndex; 
    } else {
        filePath = mainCue.filePath;
    }

    if (!filePath) {
        console.error(`AudioController: No filePath determined for cue ${cueId} (item: ${currentItemName}).`);
        if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'error', { details: 'resolved_no_file_path' });
        if (playingState.isPlaylist) _handlePlaylistEnd(cueId, true); // Error for playlist
        else delete currentlyPlaying[cueId]; // Error for single cue
        return;
    }

    // Clean up previous sound's timer if any (e.g., if _playTargetItem is called directly to skip)
    if (playingState.sound && playingState.trimEndTimer) {
        clearTimeout(playingState.trimEndTimer);
        playingState.trimEndTimer = null;
    }
    // Also clear time update interval from previous item if any
    if (playingState.timeUpdateInterval) {
        clearInterval(playingState.timeUpdateInterval);
        playingState.timeUpdateInterval = null;
    }
    // If there was a previous sound for this cueId (e.g. previous playlist item), ensure it's stopped.
    if (playingState.sound) {
        playingState.sound.stop(); // Stop previous item sound
        playingState.sound.unload(); // Unload to free resources
    }


    const sound = new Howl({
        src: [filePath],
        volume: mainCue.volume !== undefined ? mainCue.volume : 1,
        loop: playingState.isPlaylist ? false : (mainCue.loop || false),
        html5: true,
        onload: () => {
            console.log(`AudioController: Audio loaded: ${filePath} for cue: ${cueId} (item: ${currentItemName})`);
            const soundDuration = sound.duration();
            playingState.duration = soundDuration; // Store duration for potential quick access

            // Inform UI/CueStore about the discovered duration for persistence
            if (ipcBindings && typeof ipcBindings.sendCueDurationUpdate === 'function') {
                if (playingState.isPlaylist) {
                    const currentItem = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                    if (currentItem && currentItem.id) {
                        ipcBindings.sendCueDurationUpdate(mainCue.id, soundDuration, currentItem.id);
                    } else {
                        console.warn('AudioController: Could not send duration update for playlist item, ID or item missing.', actualItemIndexInOriginalList, currentItem);
                    }
                } else {
                    ipcBindings.sendCueDurationUpdate(mainCue.id, soundDuration); // For single cues, no playlistItemId
                }
            } else {
                console.warn('ipcBindings or sendCueDurationUpdate not available for sending duration.');
            }

            // Apply trimStart only if not resuming this specific item (or it's a fresh play)
            if (mainCue.trimStartTime > 0 && !isResumeForSeekAndFade) {
                sound.seek(mainCue.trimStartTime);
            }
            // Apply fadeIn only if not resuming and volume is > 0
            if (mainCue.fadeInTime > 0 && sound.volume() > 0 && !isResumeForSeekAndFade) {
                sound.volume(0); // Start at 0 volume
                console.log(`AudioController: Fading in sound for ${cueId} over ${mainCue.fadeInTime}ms`);
                sound.fade(0, mainCue.volume, mainCue.fadeInTime); // Use directly as ms
            } else if (isResumeForSeekAndFade) { // Ensure volume is restored on resume
                 sound.volume(mainCue.volume !== undefined ? mainCue.volume : 1);
            }
            sound.play();
        },
        onplay: () => {
            console.log(`AudioController: Playing: ${cueId} (item: ${filePath}), isResume: ${isResumeForSeekAndFade}`);
            playingState.sound = sound; 
            playingState.isPaused = false;

            if (playingState.timeUpdateInterval) {
                clearInterval(playingState.timeUpdateInterval);
                playingState.timeUpdateInterval = null; // Clear old reference
            }

            if (cueGridAPI) {
                cueGridAPI.updateButtonPlayingState(cueId, true, playingState.isPlaylist ? currentItemName : null);
                if (playingState.isPlaylist && sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function') {
                    const currentItemForHighlight = playingState.originalPlaylistItems[actualItemIndexInOriginalList];
                    console.log(`AudioController/onplay: Attempting to highlight item. CueID: ${cueId}, Item for highlight:`, currentItemForHighlight);
                    if (currentItemForHighlight && currentItemForHighlight.id) {
                         sidebarsAPI.highlightPlayingPlaylistItem(cueId, currentItemForHighlight.id);
                    } else {
                        console.warn("AudioController: Cannot highlight playlist item, ID missing for item at actualItemIndexInOriginalList:", actualItemIndexInOriginalList, currentItemForHighlight);
                         sidebarsAPI.highlightPlayingPlaylistItem(cueId, null); // Clear if item not found
                    }
                }
                cueGridAPI.updateCueButtonTime(cueId); // Corrected initial time update
            }

            const globalCueId = mainCue.id || cueId;
            if (playbackIntervals[globalCueId]) {
                clearInterval(playbackIntervals[globalCueId]);
            }
            const newInterval = setInterval(() => {
                if (sound && sound.playing() && 
                    currentlyPlaying[globalCueId] && 
                    currentlyPlaying[globalCueId].sound === sound &&  // Ensure this interval belongs to the active sound
                    !currentlyPlaying[globalCueId].isPaused) {
                    if (cueGridAPI && typeof cueGridAPI.updateCueButtonTime === 'function') {
                        cueGridAPI.updateCueButtonTime(globalCueId);
                    }
                }
            }, 250);
            playbackIntervals[globalCueId] = newInterval;
            playingState.timeUpdateInterval = newInterval; // Sync playingState reference

            if (ipcBindings) {
                let statusData = {};
                if (playingState.isPlaylist) {
                    statusData = {
                        playlistItemPath: filePath,
                        playlistItemName: currentItemName
                    };
                }
                ipcBindings.sendCueStatusUpdate(cueId, 'playing', statusData);
            }

            // Handle trimEnd for the current item
            if (mainCue.trimEndTime > 0 && mainCue.trimEndTime > (mainCue.trimStartTime || 0)) {
                const currentSeek = sound.seek() || 0; // Default to 0 if seek returns undefined (e.g., before play)
                const effectiveTrimStart = mainCue.trimStartTime || 0;
                // Duration for trimEnd is from the effective start of playback for this item
                const remainingDuration = (mainCue.trimEndTime - Math.max(currentSeek, effectiveTrimStart)) * 1000;

                if (remainingDuration > 0) {
                    if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                    playingState.trimEndTimer = setTimeout(() => {
                        if (currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound) { // Check if still the same sound
                            console.log(`AudioController: Reached trimEnd for cue: ${cueId} (item: ${filePath})`);
                            sound.stop(); // This will trigger onend or onstop
                            // onend will then handle next playlist item or playlist loop/end
                        }
                    }, remainingDuration);
                } else if (currentSeek >= mainCue.trimEndTime) {
                    // Already past trimEnd, stop immediately
                     console.log(`AudioController: Current seek ${currentSeek} is past trimEnd ${mainCue.trimEndTime} for cue: ${cueId}. Stopping.`);
                     sound.stop();
                }
            }
        },
        onpause: () => {
            console.log(`AudioController: Paused: ${mainCue.id || cueId}`);
            if (playbackIntervals[mainCue.id || cueId]) {
                clearInterval(playbackIntervals[mainCue.id || cueId]);
                // Do not delete playbackIntervals[cueId] here, so resume knows it was a live interval
            }
            if (currentlyPlaying[mainCue.id || cueId]) {
                currentlyPlaying[mainCue.id || cueId].isPaused = true;
            }
            if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                cueGridAPI.updateButtonPlayingState(mainCue.id || cueId, false,
                    (currentlyPlaying[mainCue.id || cueId] && currentlyPlaying[mainCue.id || cueId].isPlaylist) ? currentItemName : null
                );
            }
            if (ipcBindings && typeof ipcBindings.sendCueStatusUpdate === 'function') {
                ipcBindings.sendCueStatusUpdate(mainCue.id || cueId, 'paused');
            }
        },
        onend: () => {
            const cueIdOnEnd = mainCue.id || cueId;
            console.log(`AudioController: Cue item ended naturally (onend event): ${filePath} for cue ${cueIdOnEnd}`);

            if (playbackIntervals[cueIdOnEnd]) {
                clearInterval(playbackIntervals[cueIdOnEnd]);
                delete playbackIntervals[cueIdOnEnd];
            }
            // Use a local var for playingState as it might be deleted by other logic paths
            const endedPlayingState = currentlyPlaying[cueIdOnEnd]; 
            if (endedPlayingState && endedPlayingState.timeUpdateInterval) {
                clearInterval(endedPlayingState.timeUpdateInterval);
                endedPlayingState.timeUpdateInterval = null;
            }

            let handledByLoopOrPlaylist = false;

            if (endedPlayingState) {
                endedPlayingState.isPaused = false;

                if (endedPlayingState.isPlaylist) {
                    // Clear highlight for the item that just ended before handling playlist logic
                    if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function') {
                        sidebarsAPI.highlightPlayingPlaylistItem(cueIdOnEnd, null);
                    }
                    _handlePlaylistEnd(cueIdOnEnd, false); // Pass false for errorOccurred as this is natural end
                    handledByLoopOrPlaylist = true;
                } else if (mainCue.loop && !endedPlayingState.isStopping) { 
                    console.log(`AudioController: Looping single cue ${cueIdOnEnd}`);
                    const trimStart = mainCue.trimStartTime || 0;
                    if(endedPlayingState.sound) { // Ensure sound object still exists
                        endedPlayingState.sound.seek(trimStart);
                        endedPlayingState.sound.play(endedPlayingState.soundId); // Re-play the same sound instance

                        // Restart interval
                        playbackIntervals[cueIdOnEnd] = setInterval(() => {
                            if (endedPlayingState.sound && endedPlayingState.sound.playing() && currentlyPlaying[cueIdOnEnd] && !currentlyPlaying[cueIdOnEnd].isPaused) {
                                if (cueGridAPI && typeof cueGridAPI.updateCueButtonTime === 'function') {
                                    cueGridAPI.updateCueButtonTime(cueIdOnEnd);
                                }
                            }
                        }, 250);
                        if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                             cueGridAPI.updateButtonPlayingState(cueIdOnEnd, true, null);
                        }
                    } else {
                         console.warn(`AudioController: Sound object missing for loop on cue ${cueIdOnEnd}`);
                         delete currentlyPlaying[cueIdOnEnd]; // Clean up if sound is gone
                    }
                    handledByLoopOrPlaylist = true;
                }
            }

            if (!handledByLoopOrPlaylist) {
                // If not handled by playlist or loop, it's a genuine stop for a single cue.
                if (endedPlayingState) {
                    delete currentlyPlaying[cueIdOnEnd];
                    console.log(`AudioController: Cleared currentlyPlaying state for ${cueIdOnEnd} in onend (natural end).`);
                }
                if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                    cueGridAPI.updateButtonPlayingState(cueIdOnEnd, false, null);
                }
                if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && endedPlayingState && endedPlayingState.isPlaylist) {
                     sidebarsAPI.highlightPlayingPlaylistItem(cueIdOnEnd, null);
                }
                if (ipcBindings && typeof ipcBindings.sendCueStatusUpdate === 'function') {
                    ipcBindings.sendCueStatusUpdate(cueIdOnEnd, 'stopped');
                }
            }
        },
        onstop: () => {
            const cueIdToStop = mainCue.id || cueId;
            console.log(`AudioController: Cue item stopped (onstop event): ${filePath} for cue ${cueIdToStop}`);

            if (playbackIntervals[cueIdToStop]) {
                clearInterval(playbackIntervals[cueIdToStop]);
                delete playbackIntervals[cueIdToStop];
            }
            const stoppedPlayingState = currentlyPlaying[cueIdToStop];
            if (stoppedPlayingState && stoppedPlayingState.timeUpdateInterval) {
                clearInterval(stoppedPlayingState.timeUpdateInterval);
                stoppedPlayingState.timeUpdateInterval = null;
            }

            if (stoppedPlayingState && !stoppedPlayingState.isFadingOutToRestart) {
                delete currentlyPlaying[cueIdToStop];
            } else if (stoppedPlayingState && stoppedPlayingState.isFadingOutToRestart) {
                console.log(`AudioController: onstop for ${cueIdToStop}, but it's marked for restart. State not deleted yet.`);
                // The restart logic in toggle() will handle cleaning up isFadingOutToRestart and potentially re-populating currentlyPlaying.
            }

            if (cueGridAPI && cueGridAPI.updateButtonPlayingState) {
                cueGridAPI.updateButtonPlayingState(cueIdToStop, false, null);
            }
            if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && stoppedPlayingState && stoppedPlayingState.isPlaylist) {
                sidebarsAPI.highlightPlayingPlaylistItem(cueIdToStop, null);
            }
            if (ipcBindings && typeof ipcBindings.sendCueStatusUpdate === 'function') {
                ipcBindings.sendCueStatusUpdate(cueIdToStop, 'stopped');
            }
        },
        onfade: () => {
            const playingState = currentlyPlaying[cueId]; // Get current state, might have been changed by other ops
            if (playingState && playingState.sound === sound && sound.volume() === 0) {
                console.log(`AudioController: Fade out complete for cue: ${cueId} (item: ${filePath})`);
                // Only call sound.stop() if this is part of a deliberate stop sequence.
                // If isStopping is not true, the fade might be for something else (though currently not used for other purposes).
                if (playingState.isStopping) {
                    sound.stop(); // This should trigger onstop, which will handle cleanup.
                } else {
                    console.warn(`AudioController: onfade for ${cueId} but isStopping is false. Investigate if fade was intended.`);
                    // If fade was not for a stop, what should happen? For now, just log.
                    // If it was a crossfade, sound.stop() might be wrong here.
                }
            } else if (playingState && playingState.sound === sound && sound.volume() > 0) {
                // Fade reached a non-zero volume (e.g. fade-in completed)
                // console.log(`AudioController: Fade to ${sound.volume()} complete for ${cueId}`);
            }
        },
        onloaderror: (loadErrSoundId, error) => {
            console.error(`AudioController: Error loading audio: ${filePath} for cue ${cueId}:`, error);
            if (currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound) { // Check if it's still the one we tried to load
                if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                // If playlist, try to skip to next or end it.
                if (playingState.isPlaylist) {
                    const nextItemIndex = playingState.currentPlaylistItemIndex + 1;
                    if (nextItemIndex < playingState.playlistItems.length) {
                         console.log(`AudioController: Error loading playlist item ${filePath}, trying next.`);
                        _playTargetItem(cueId, nextItemIndex, false);
                    } else {
                        _handlePlaylistEnd(cueId, true); // Error, end of playlist
                    }
                } else {
                    delete currentlyPlaying[cueId]; // Single file error
                    if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
                }
            } else if (currentlyPlaying[cueId] && !playingState.sound && playingState.isPlaylist) {
                // This case means sound was never set, e.g. error in _playTargetItem before Howl was assigned.
                // Attempt recovery for playlist.
                console.error(`AudioController: Error before sound assignment for playlist item ${filePath}. Trying next.`);
                const nextItemIndex = playingState.currentPlaylistItemIndex + 1; // Assume index wasn't updated if sound didn't load
                if (nextItemIndex < playingState.playlistItems.length) {
                    _playTargetItem(cueId, nextItemIndex, false);
                } else {
                    _handlePlaylistEnd(cueId, true); // Error, end of playlist
                }
            }

            if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'error', { details: `load_error: ${String(error)} on ${filePath}` });
            sound.unload(); // Unload the problematic sound object
            if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && playingState && playingState.isPlaylist) {
                sidebarsAPI.highlightPlayingPlaylistItem(cueId, null); // Clear highlight on load error for playlist
            }
        },
        onplayerror: (playErrSoundId, error) => {
            console.error(`AudioController: Error playing audio: ${filePath} for cue ${cueId}:`, error);
            if (currentlyPlaying[cueId] && currentlyPlaying[cueId].sound === sound) {
                if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
                // Similar recovery for playlist
                if (playingState.isPlaylist) {
                     const nextItemIndex = playingState.currentPlaylistItemIndex + 1;
                    if (nextItemIndex < playingState.playlistItems.length) {
                        console.log(`AudioController: Error playing playlist item ${filePath}, trying next.`);
                        _playTargetItem(cueId, nextItemIndex, false);
                    } else {
                        _handlePlaylistEnd(cueId, true); // Error, end of playlist
                    }
                } else {
                    delete currentlyPlaying[cueId];
                     if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
                }
            }
            if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'error', { details: `play_error: ${String(error)} on ${filePath}` });
            sound.unload();
            if (sidebarsAPI && typeof sidebarsAPI.highlightPlayingPlaylistItem === 'function' && playingState && playingState.isPlaylist) {
                sidebarsAPI.highlightPlayingPlaylistItem(cueId, null); // Clear highlight on play error for playlist
            }
        }
    });
}

function _handlePlaylistEnd(cueId, errorOccurred = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist) {
        console.log(`AudioController: _handlePlaylistEnd called for ${cueId} but not a valid playlist state.`);
        return;
    }

    const mainCue = playingState.cue;
    console.log(`AudioController: Item ended in playlist ${cueId}. Error: ${errorOccurred}, LoopPlaylist: ${mainCue.loop}, PlayMode: ${mainCue.playlistPlayMode}, CurrentItemIdx: ${playingState.currentPlaylistItemIndex}`);

    if (playingState.sound) {
        playingState.sound.unload(); // Unload the last item's sound
        playingState.sound = null; // Clear the sound object from state
    }

    if (errorOccurred) {
        console.error(`AudioController: Error occurred during playlist ${cueId}. Stopping.`);
        delete currentlyPlaying[cueId];
        if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
        if (ipcBindings) {
            ipcBindings.sendCueStatusUpdate(cueId, 'error', { details: 'playlist_playback_error' });
        }
        return;
    }

    // No error occurred, proceed based on play mode
    if (mainCue.playlistPlayMode === 'stop_and_cue_next') {
        console.log(`AudioController: Playlist mode 'stop_and_cue_next' for ${cueId}. Current index before advancing: ${playingState.currentPlaylistItemIndex}`);
        
        let nextItemLogicalIndexToCue = playingState.currentPlaylistItemIndex + 1;
        // Use playingState.originalPlaylistItems for length consistency before potential shuffle regeneration
        const listLength = playingState.originalPlaylistItems.length; 
        let cuedItemName = null;
        let successfullyCued = false;

        // Determine the actual list of items to consider for indexing (shuffled or original order)
        // This is for determining if nextItemLogicalIndexToCue is valid within the *current* playback sequence length
        const currentPlaybackOrderLength = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                                        ? playingState.shufflePlaybackOrder.length 
                                        : playingState.originalPlaylistItems.length;

        if (nextItemLogicalIndexToCue < currentPlaybackOrderLength) {
            // There's a next item to cue in the current sequence
            playingState.currentPlaylistItemIndex = nextItemLogicalIndexToCue; // Update index to the cued item
            successfullyCued = true;
            console.log(`AudioController: Cued next item at logical index ${nextItemLogicalIndexToCue} for playlist ${cueId}.`);
        } else { // Reached end of the current sequence
            if (mainCue.loop) { // Playlist is set to loop
                console.log(`AudioController: Playlist mode 'stop_and_cue_next', end of list, looping. Cueing first item for ${cueId}`);
                if (mainCue.shuffle && playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 1) {
                    _generateShuffleOrder(cueId); // Regenerate shuffle order for the new loop
                }
                playingState.currentPlaylistItemIndex = 0; // Cue the first item of the new/current order
                successfullyCued = true;
            } else { // End of list and not looping playlist - fully stop
                console.log(`AudioController: Playlist mode 'stop_and_cue_next', end of list, not looping. Fully stopping playlist ${cueId}`);
                delete currentlyPlaying[cueId];
                if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false, null); 
                if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'stopped', { reason: 'playlist_ended_fully_no_loop_stop_mode' });
                return; // Fully stopped, no longer cued.
            }
        }

        if (successfullyCued) {
            playingState.isPaused = true; // Mark as "paused" to indicate it's not actively playing but state is preserved
            // playingState.sound is already null as the previous item ended and was unloaded.

            // Get the name of the actually cued item for UI update
            // currentPlaylistItemIndex now holds the logical index of the *cued* item in its respective order (shuffled or original)
            let cuedItemOriginalListIndex = playingState.currentPlaylistItemIndex; 
            if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > playingState.currentPlaylistItemIndex) {
                cuedItemOriginalListIndex = playingState.shufflePlaybackOrder[playingState.currentPlaylistItemIndex];
            }
            // Ensure this original list index is valid
            if (cuedItemOriginalListIndex >= 0 && cuedItemOriginalListIndex < playingState.originalPlaylistItems.length) {
                const cuedItem = playingState.originalPlaylistItems[cuedItemOriginalListIndex];
                cuedItemName = cuedItem.name || cuedItem.path.split(/[\\\/]/).pop();
            } else {
                console.warn(`AudioController: Could not determine cued item name. Cued logical index: ${playingState.currentPlaylistItemIndex}, Resolved original index: ${cuedItemOriginalListIndex}`);
            }
            
            console.log(`AudioController: Successfully cued item: ${cuedItemName || 'Unknown'} at logical index ${playingState.currentPlaylistItemIndex}`);
            if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false, `Next: ${cuedItemName || 'Item'}`, true);
            if (ipcBindings) ipcBindings.sendCueStatusUpdate(cueId, 'stopped', { reason: 'playlist_item_ended_cued_next', nextItem: cuedItemName });
        }
        return; // Handled the 'stop_and_cue_next' mode
    }

    // Defaulting to 'continue' mode (this was the old 'else' block or the path if not looping)
    playingState.currentPlaylistItemIndex++; // Advance to the next item's logical index
    const nextItemLogicalIndex = playingState.currentPlaylistItemIndex;
    
    const itemsList = mainCue.shuffle && playingState.shufflePlaybackOrder ? playingState.shufflePlaybackOrder : playingState.originalPlaylistItems;
    const listLength = itemsList.length;

    if (nextItemLogicalIndex < listLength) {
        // There is a next item in the current sequence
        console.log(`AudioController: Playlist mode 'continue', playing next item at logical index ${nextItemLogicalIndex} for cue ${cueId}`);
        playingState.isPaused = false;
        // _playTargetItem expects the logical index for the current playback order (shuffled or sequential)
        setTimeout(() => _playTargetItem(cueId, nextItemLogicalIndex, false), 10);
    } else {
        // Reached end of the current sequence (shuffled or sequential)
        if (mainCue.loop) {
            console.log(`AudioController: Playlist mode 'continue', end of list, looping playlist ${cueId}`);
            if (mainCue.shuffle && playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 1) {
                _generateShuffleOrder(cueId); // Regenerate shuffle order for the new loop
            }
            playingState.currentPlaylistItemIndex = 0; // Reset to the start of the new/current order
            playingState.isPaused = false;
            setTimeout(() => _playTargetItem(cueId, 0, false), 10); // Play first item (index 0 of new/current order)
        } else {
            // End of list and not looping playlist
            console.log(`AudioController: Playlist mode 'continue', end of list, not looping. Stopping playlist ${cueId}`);
            delete currentlyPlaying[cueId];
            if (cueGridAPI) cueGridAPI.updateButtonPlayingState(cueId, false);
            if (ipcBindings) {
                ipcBindings.sendCueStatusUpdate(cueId, 'stopped', { reason: 'playlist_ended_naturally_no_loop' });
            }
        }
    }
}


function stop(cueId, fromCompanion = false, useFade = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.sound) {
        // console.log(`AudioController: Stop called for inactive/invalid cue: ${cueId}`);
        return;
    }

    console.log(`AudioController: Stopping cue: ${cueId}, fromCompanion: ${fromCompanion}, useFade: ${useFade}`);

    playingState.isStopping = true; // Mark that an explicit stop is in progress
    playingState.isPaused = false; // Not paused if explicitly stopping
    playingState.isFadingOutToRestart = false; // Default, toggle() will override for fade_stop_restart

    // Clear any pending restart for this cue if a new stop command comes in
    if (pendingRestarts[cueId]) {
        clearTimeout(pendingRestarts[cueId].timeoutId);
    }
    
    const cue = playingState.cue || cueStore.getCueById(cueId); // Get full cue details for fade times
    if (!cue) {
        console.error(`AudioController: Cue details not found for ${cueId} during stop.`);
        playingState.sound.stop(playingState.soundId); // Stop immediately if no cue data
        // onstop will handle cleanup of currentlyPlaying[cueId] and playbackIntervals
        return;
    }

    const shouldFade = useFade && cue.fadeOutTime > 0 && playingState.sound.playing() && playingState.sound.volume() > 0;
    console.log(`AudioController: Stop evaluating shouldFade for ${cueId}: useFade=${useFade}, cue.fadeOutTime=${cue.fadeOutTime}, sound.playing()=${playingState.sound.playing()}, sound.volume()=${playingState.sound.volume()}, result=${shouldFade}`);

    if (shouldFade) {
        const currentVolume = playingState.sound.volume();
        // Ensure fadeOutTime is in milliseconds for Howler
        const fadeDuration = cue.fadeOutTime; 
        console.log(`AudioController: Initiating fade out for ${cueId}. cue.fadeOutTime: ${fadeDuration}ms, calculated duration: ${fadeDuration}ms, current volume: ${currentVolume}`);
        
        playingState.isFadingOut = true; // Indicate fade out is in progress
        // The soundId here refers to the specific playback instance.
        playingState.sound.fade(currentVolume, 0, fadeDuration, playingState.soundId);
        
        // The 'onfade' event in Howler is for the sound instance.
        // We need to rely on the 'onstop' event that fires after fade to 0 is complete IF fade makes it stop.
        // Or, if Howler's fade doesn't auto-stop, we might need a timeout.
        // Howler's .fade() to 0 volume DOES NOT automatically call .stop(). It just sets volume to 0.
        // So, we need to explicitly stop it after the fade.

        // If fade is to 0, Howler doesn't auto-stop. We must do it.
        // The 'onfade' event can be used to know when the fade to 0 is complete.
        // This is already handled in the onfade event of the sound instance if configured, OR:
        // We need to ensure stop is called when fade is done.
        // For simplicity and direct control:
        setTimeout(() => {
            if (currentlyPlaying[cueId] && currentlyPlaying[cueId].isFadingOut) { // Check if still relevant
                console.log(`AudioController: Fade to 0 complete for ${cueId}, now stopping sound.`);
                if(currentlyPlaying[cueId].sound) currentlyPlaying[cueId].sound.stop(currentlyPlaying[cueId].soundId);
                // The onstop event will handle UI updates and clearing currentlyPlaying[cueId]
                currentlyPlaying[cueId].isFadingOut = false; // Reset flag
            }
        }, fadeDuration + 50); // Add a small buffer

    } else {
        console.log(`AudioController: Stopping ${cueId} immediately (no fade).`);
        playingState.sound.stop(playingState.soundId);
        // onstop will handle cleanup of currentlyPlaying[cueId] and playbackIntervals
    }
    // DO NOT delete currentlyPlaying[cueId] or clear interval here.
    // Let the 'onstop' event handler do the final cleanup.
}

function pause(cueId) {
    const current = currentlyPlaying[cueId];
    // Check current.sound as an item might have failed to load in a playlist
    if (current && current.sound && current.sound.playing() && !current.isPaused) {
        console.log('AudioController: Pausing cue:', cueId);
        current.sound.pause(); // This should trigger the onpause event on the sound
        // The onpause handler updates current.isPaused and sends IPC/UI updates
    } else if (current && current.isPaused) {
        console.log('AudioController: Cue already paused:', cueId);
    } else {
        console.log('AudioController: Cue not playing, not found, or no sound to pause:', cueId);
    }
}

function toggle(cue, fromCompanion = false, retriggerBehavior = 'restart') {
    if (!cue || !cue.id) {
        console.error('AudioController: Invalid cue object provided for toggle.');
        if (ipcBindings) ipcBindings.sendCueStatusUpdate(cue ? cue.id : 'unknown', 'error', { details: 'invalid_cue_data_toggle' });
        return;
    }
    const cueId = cue.id;
    const current = currentlyPlaying[cueId];

    // Special handling for a "cued" playlist (paused, no sound object, ready for next item)
    if (current && current.isPlaylist && current.isPaused && !current.sound && current.originalPlaylistItems && current.originalPlaylistItems.length > 0) {
        console.log(`AudioController: Toggle for cued playlist ${cueId}. Playing cued item.`);
        play(cue, true); // isResume = true will pick up the cued item
        return;
    }

    if (current && ( (current.sound && current.sound.playing()) || current.isPaused) ) {
        console.log(`AudioController: Cue ${cueId} is active (playing/paused). Retrigger: ${retriggerBehavior}`);
        // If cue has shuffle, re-evaluate shuffle order on restart/fade_stop_restart if it's a playlist
        const needsShuffleReevaluation = current.isPlaylist && current.cue.shuffle && current.originalPlaylistItems.length > 1 &&
                                       (retriggerBehavior === 'restart' || retriggerBehavior === 'fade_stop_restart');

        switch (retriggerBehavior) {
            case 'stop': // Immediate stop
                console.log(`AudioController: Retrigger behavior 'stop' for ${cueId}.`);
                stop(cueId, fromCompanion, false); // useFade = false
                break;
            case 'restart':
                console.log(`AudioController: Retrigger behavior 'restart' for ${cueId}.`);
                if (current.timeUpdateInterval) clearInterval(current.timeUpdateInterval); // Clear before stop/delete
                if(current.sound) current.sound.stop();
                if(current.trimEndTimer) clearTimeout(current.trimEndTimer);
                // Preserve original playlist items if shuffling, then regenerate order
                const originalItemsForRestart = current.isPlaylist ? current.originalPlaylistItems.slice() : null;
                delete currentlyPlaying[cueId];
                if (needsShuffleReevaluation && originalItemsForRestart) {
                    cue.playlistItems = originalItemsForRestart; // Ensure play() gets original items for shuffle setup
                }
                play(cue, false);
                break;
            case 'fade_out_and_stop': // New behavior: Fade out and stop, no restart
                console.log(`AudioController: Retrigger behavior 'fade_out_and_stop' for ${cueId}.`);
                if (current && !current.isStopping) { // Ensure not already in a stopping process
                     // isStopping will be set within the stop function if a fade is initiated.
                    stop(cueId, fromCompanion, true); // useFade = true
                } else if (!current) { // Should not happen if we are in this block, but good for robustness
                    console.warn(`AudioController: 'fade_out_and_stop' called for ${cueId} but no 'current' state found.`);
                }
                break;
            case 'fade_stop_restart':
                console.log(`AudioController: Retrigger behavior 'fade_stop_restart' for ${cueId}.`);
                if (current && !current.isStopping) { // Ensure not already in a stopping process
                    current.isStopping = true; // Mark as stopping FOR THE RESTART LOGIC
                    const originalItemsForFadeRestart = current.isPlaylist ? current.originalPlaylistItems.slice() : null;
                    const cueForRestart = { ...current.cue }; // Clone cue to ensure original items for shuffle are on it if needed

                    stop(cueId, fromCompanion, true); // useFade = true

                    const fadeOutDuration = (current.cue.fadeOutTime || 0);
                    console.log(`AudioController: fade_stop_restart - Scheduling restart after fade. Cue fadeOutTime: ${current.cue.fadeOutTime}ms, Timeout duration: ${fadeOutDuration + 100}ms`);
                    
                    setTimeout(() => {
                        const currentStateAfterFade = currentlyPlaying[cueId];
                        console.log(`AudioController: fade_stop_restart timeout for ${cueId}. Initial existingState before stop:`, current, `Current state after fade:`, currentStateAfterFade);

                        if (current.isStopping) { 
                            if (currentStateAfterFade) { 
                                currentStateAfterFade.isStopping = false; 
                            }
                            console.log(`AudioController: fade_stop_restart proceeding to play original cue: ${cueForRestart.id}`);
                            if (needsShuffleReevaluation && originalItemsForFadeRestart) {
                                cueForRestart.playlistItems = originalItemsForFadeRestart;
                            }
                            play(cueForRestart, false); 

                        } else {
                            console.warn(`AudioController: fade_stop_restart for ${cueId} - existingState.isStopping was unexpectedly false. Aborting restart. Initial existingState.isStopping: ${current.isStopping}, Current state:`, currentStateAfterFade);
                            if (currentStateAfterFade) {
                                currentStateAfterFade.isStopping = false; 
                            }
                        }
                    }, fadeOutDuration + 100); 
                } else if (!current) {
                    play(cue, false); 
                }
                break;
            case 'pause':
            case 'pause_resume': // Allow current UI value, but recommend changing to 'pause'
                console.log(`AudioController: Retrigger behavior '${retriggerBehavior}' for ${cueId}.`);
                if (current && current.isPaused) {
                    console.log(`AudioController: Cue ${cueId} is paused. Resuming.`);
                    play(cue, true); // isResume = true
                } else {
                    console.log(`AudioController: Cue ${cueId} is playing. Pausing.`);
                    pause(cueId);
                }
                break;
            case 'do_nothing':
                console.log(`AudioController: Retrigger behavior 'do_nothing' for ${cueId}. No action taken.`);
                // Explicitly do nothing
                break;
            default:
                console.warn(`AudioController: Unknown retrigger behavior: '${retriggerBehavior}' for cue ${cueId}. Defaulting to restart.`);
                // Fallback to restart for safety, or choose another default like 'do_nothing'
                if(current.sound) current.sound.stop();
                if(current.trimEndTimer) clearTimeout(current.trimEndTimer);
                delete currentlyPlaying[cueId];
                play(cue, false);
                break;
        }
    } else {
        // Not currently playing or doesn't exist in currentlyPlaying, so just play it
        console.log('AudioController: Cue not active, playing cue:', cueId);
        play(cue, false); // Not a resume
    }
}

// Stops all currently playing sounds, optionally with fade based on behavior.
function stopAll(options = {}) {
    console.log('AudioController: stopAll called with options:', options);
    const behavior = options.behavior || 'stop'; // Default to immediate stop
    console.log('[AudioController - stopAll] Resolved behavior:', behavior);
    console.log('[AudioController - stopAll] currentAppConfigRef at time of call:', JSON.stringify(currentAppConfigRef));

    for (const cueId in currentlyPlaying) {
        if (currentlyPlaying.hasOwnProperty(cueId)) {
            const playingState = currentlyPlaying[cueId];
            if (playingState && playingState.sound) {
                console.log(`AudioController: Stopping cue ${cueId} with behavior: ${behavior}`);
                if (behavior === 'fade_out_and_stop') {
                    const cue = playingState.cue;
                    // Use cue's specific fadeOutTime if available, otherwise app default, fallback to 0
                    const fadeOutDuration = (cue.fadeOutTime !== undefined && cue.fadeOutTime > 0) 
                                            ? cue.fadeOutTime 
                                            : (currentAppConfigRef.defaultFadeOutTime || 0);

                    console.log(`[AudioController - stopAll] Cue ${cueId}: cue.fadeOutTime = ${cue.fadeOutTime}, appConfig.defaultFadeOutTime = ${currentAppConfigRef.defaultFadeOutTime}, Resolved fadeOutDuration = ${fadeOutDuration}`);

                    if (fadeOutDuration > 0 && !playingState.isPaused) { // Only fade if duration > 0 and actually playing
                        console.log(`AudioController: Fading out ${cueId} over ${fadeOutDuration}ms`);
                        playingState.isStopping = true; // Prevent onend auto-actions during fade
                        playingState.sound.once('fade', () => {
                            console.log(`AudioController: Fade complete for ${cueId}, stopping sound.`);
                            if (playingState.sound) {
                                playingState.sound.stop(); 
                            }
                            // The onstop event should then trigger cleanup
                        });
                        playingState.sound.fade(playingState.sound.volume(), 0, fadeOutDuration);
                    } else {
                        console.log(`AudioController: Immediate stop for ${cueId} (no fade or already paused).`);
                        playingState.sound.stop(); // Stop immediately if no fade time or paused
                    }
                } else { // Immediate stop
                    console.log(`AudioController: Immediate stop for ${cueId}.`);
                    playingState.sound.stop();
                }
            } else {
                console.log(`AudioController: No sound instance to stop for cueId: ${cueId} in stopAll.`);
            }
        }
    }
    // The onstop handlers for each sound will manage cleanup from currentlyPlaying.
}

// Checks if a cue is actively playing (not paused, sound exists and is playing).
function isPlaying(cueId) {
    const state = currentlyPlaying[cueId];
    if (!state) return false;

    if (state.isPlaylist) {
        // For a playlist, consider it "playing" if it's in the currentlyPlaying map 
        // and not explicitly marked as paused. The actual sound object might be changing.
        return !state.isPaused;
    } else {
        // For a single cue, it must have a sound object that is currently playing.
        return !state.isPaused && state.sound && state.sound.playing();
    }
}

// Checks if a cue is currently paused.
function isPaused(cueId) {
    const playingState = currentlyPlaying[cueId];
    return !!(playingState && playingState.isPaused);
}

// New function to check if a playlist cue is in the "cued" state
function isCued(cueId) {
    const state = currentlyPlaying[cueId];
    return !!(state && state.isPlaylist && state.isPaused && !state.sound && state.originalPlaylistItems && state.originalPlaylistItems.length > 0);
}

// New function to get the name of the currently playing item in a playlist
function getCurrentlyPlayingPlaylistItemName(cueId) {
    const current = currentlyPlaying[cueId];
    if (current && current.isPlaylist && current.sound && current.sound.playing() && !current.isPaused) {
        let itemDetailName = 'Unknown Item';
        // Ensure originalPlaylistItems exists and currentPlaylistItemIndex is valid
        if (current.originalPlaylistItems && current.originalPlaylistItems.length > 0) {
            let actualItemIndex = current.currentPlaylistItemIndex;
            if (current.cue.shuffle && current.shufflePlaybackOrder && current.shufflePlaybackOrder.length > current.currentPlaylistItemIndex) {
                actualItemIndex = current.shufflePlaybackOrder[current.currentPlaylistItemIndex];
            }
            // Check bounds for actualItemIndex against originalPlaylistItems
            if (actualItemIndex >= 0 && actualItemIndex < current.originalPlaylistItems.length) {
                const item = current.originalPlaylistItems[actualItemIndex];
                itemDetailName = item.name || item.path.split(/[\\\/]/).pop();
            }
        }
        return itemDetailName;
    }
    return null;
}

// New function to get the name of the next playlist item to be played
function getNextPlaylistItemName(cueId) {
    const playingState = currentlyPlaying[cueId];
    const cue = playingState ? playingState.cue : getGlobalCueById(cueId);

    if (!cue || cue.type !== 'playlist' || !cue.playlistItems || cue.playlistItems.length === 0) {
        return null;
    }

    let nextItemIndex = 0; // Default to the first item
    const items = playingState ? playingState.originalPlaylistItems : cue.playlistItems;
    const numItems = items.length;

    if (playingState && !playingState.isPaused) { // If actively playing or just finished an item (before advancing index for next)
        // Determine next based on current playing index, shuffle, and loop
        let currentIndexInPlaybackOrder = playingState.currentPlaylistItemIndex;
        nextItemIndex = currentIndexInPlaybackOrder + 1;

        const orderToFollow = (cue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length === numItems) 
                            ? playingState.shufflePlaybackOrder 
                            : items.map((_,i) => i); // Sequential order

        if (nextItemIndex >= numItems) {
            if (cue.loop) {
                nextItemIndex = 0; // Loop back to the start
            } else {
                return null; // Playlist will end, no "next" item
            }
        }
        // Resolve the actual index in the original list if using a playback order array
        const actualNextItemOriginalIndex = orderToFollow[nextItemIndex];
        if (actualNextItemOriginalIndex >= 0 && actualNextItemOriginalIndex < items.length) {
            const nextItem = items[actualNextItemOriginalIndex];
            return nextItem.name || nextItem.path.split(/[\\\/]/).pop();
        }
        return null; // Should not happen if logic is correct

    } else { // Playlist is stopped, paused, or cued (for future manual mode)
        // If paused, next is the current one. If stopped, next is the first one.
        // For now, if stopped or paused, let's assume "next" means from the beginning or current cued item.
        // If paused, next item is current item. If stopped, it's the first item.
        let currentEffectiveIndex = 0; // Start of playlist if fully stopped
        if (playingState && playingState.isPaused) { // If paused, the current item is effectively "next" if resumed
             currentEffectiveIndex = playingState.currentPlaylistItemIndex;
        }
        
        const orderToFollow = (cue.shuffle && (playingState?.shufflePlaybackOrder?.length === numItems || cue.playlistItems?.length === numItems)) 
                            ? (playingState ? playingState.shufflePlaybackOrder : _generateTemporaryShuffleOrder(items)) 
                            : items.map((_,i) => i); // Sequential order

        if (currentEffectiveIndex >= 0 && currentEffectiveIndex < orderToFollow.length) {
            const actualNextItemOriginalIndex = orderToFollow[currentEffectiveIndex];
             if (actualNextItemOriginalIndex >= 0 && actualNextItemOriginalIndex < items.length) {
                const nextItem = items[actualNextItemOriginalIndex];
                return nextItem.name || nextItem.path.split(/[\\\/]/).pop();
            }
        }
        // Fallback to the very first item if other logic fails or playlist isn't active
        const firstItem = items[0];
        return firstItem.name || firstItem.path.split(/[\\\/]/).pop();
    }
}

// Helper for getNextPlaylistItemName when playlist is not in currentlyPlaying state
function _generateTemporaryShuffleOrder(items) {
    const order = Array.from(Array(items.length).keys());
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

// New function to get current playback times for a cue
function getPlaybackTimes(cueId) {
    const playingState = currentlyPlaying[cueId];
    if (playingState && playingState.sound) {
        const sound = playingState.sound;
        const cue = playingState.cue; // This is mainCue
        let currentTime = sound.seek();
        let playlistTotalDuration = 0;
        let currentItemDuration = sound.duration(); // Duration of the specific playing Howl instance

        if (playingState.isPlaylist) {
            if (playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 0) {
                playlistTotalDuration = playingState.originalPlaylistItems.reduce((total, item) => total + (item.knownDuration || 0), 0);
                // If repeatOne is active for the playlist, the concept of "total duration" for display might be just the current item's duration.
                // However, for now, let's keep playlistTotalDuration as the sum of all unique items.
                // The currentItemDuration is already sound.duration().
            } else {
                playlistTotalDuration = currentItemDuration; // Fallback if no original items (should be rare)
            }
        } else {
            // For single cues, playlistTotalDuration is effectively its own duration.
            playlistTotalDuration = (cue.knownDuration && cue.knownDuration > 0) ? cue.knownDuration : currentItemDuration;
            // currentItemDuration is already correct from sound.duration() or overridden by knownDuration if more accurate
            if (cue.knownDuration && cue.knownDuration > 0) {
                currentItemDuration = cue.knownDuration;
            }
        }

        let displayTotalDuration = playingState.isPlaylist ? playlistTotalDuration : currentItemDuration;
        let displayItemRemainingTime = Math.max(0, currentItemDuration - currentTime);

        // Adjust for trim times
        if (cue.trimStartTime && cue.trimStartTime > 0) {
            const originalCurrentTime = currentTime + cue.trimStartTime; // Time as if trim wasn't applied to source
            currentTime = Math.max(0, sound.seek() - cue.trimStartTime); // currentTime for display starts from 0 after trim
            
            let itemEffectiveDuration = currentItemDuration;
            if (playingState.isPlaylist) {
                // For playlists, currentItemDuration is from the Howl instance. 
                // If the item itself has trim settings, those are not directly handled here yet (assumed to be part of filePath if pre-trimmed)
                // If mainCue trim settings apply to *each* playlist item, then:
                itemEffectiveDuration = currentItemDuration - cue.trimStartTime;
                if (cue.trimEndTime && cue.trimEndTime > cue.trimStartTime) {
                    itemEffectiveDuration = Math.min(itemEffectiveDuration, cue.trimEndTime - cue.trimStartTime);
                }
            } else {
                 // Single cue trim logic for item's duration
                itemEffectiveDuration = (cue.knownDuration || currentItemDuration) - cue.trimStartTime;
                if (cue.trimEndTime && cue.trimEndTime > cue.trimStartTime) {
                    itemEffectiveDuration = Math.min(itemEffectiveDuration, cue.trimEndTime - cue.trimStartTime);
                }
            }
            currentItemDuration = Math.max(0, itemEffectiveDuration);
            displayItemRemainingTime = Math.max(0, currentItemDuration - currentTime);

            // displayTotalDuration for playlists should ideally not be affected by trim of individual items, 
            // unless trim applies to the *whole playlist block*, which is not current model.
            // For single cues, displayTotalDuration is currentItemDuration after trim.
            if (!playingState.isPlaylist) {
                displayTotalDuration = currentItemDuration;
            }
        } else if (cue.trimEndTime && cue.trimEndTime > 0 && cue.trimEndTime < (cue.knownDuration || currentItemDuration)) {
            // Only trimEndTime is set (for single cue, or if applied to each playlist item)
            let itemEffectiveDuration = cue.trimEndTime;
            if (playingState.isPlaylist) {
                // If trimEndTime applies to each item in playlist from mainCue settings:
                itemEffectiveDuration = Math.min(currentItemDuration, cue.trimEndTime);
            }
            currentItemDuration = itemEffectiveDuration;
            displayItemRemainingTime = Math.max(0, currentItemDuration - currentTime);
            if (!playingState.isPlaylist) {
                displayTotalDuration = currentItemDuration;
            }
        }

        return {
            currentTime: typeof currentTime === 'number' ? currentTime : 0,
            totalPlaylistDuration: typeof displayTotalDuration === 'number' && isFinite(displayTotalDuration) ? displayTotalDuration : 0,
            currentItemDuration: typeof currentItemDuration === 'number' && isFinite(currentItemDuration) ? currentItemDuration : 0,
            currentItemRemainingTime: typeof displayItemRemainingTime === 'number' && isFinite(displayItemRemainingTime) ? displayItemRemainingTime : 0,
            rawDuration: sound.duration() 
        };
    }
    // Idle state / Cue not actively playing with a sound object
    const cueFromStore = getGlobalCueById(cueId);
    if (cueFromStore) {
        let calculatedTotalDuration = 0;
        let calculatedItemDuration = 0; // For the "next up" item in manual mode, or first item

        if (cueFromStore.type === 'playlist') {
            if (cueFromStore.playlistItems && cueFromStore.playlistItems.length > 0) {
                calculatedTotalDuration = cueFromStore.playlistItems.reduce((total, item) => total + (item.knownDuration || 0), 0);
                // For idle state, itemDuration could be the first item or the "next cued" item.
                // For now, let's assume for autoplay mode, it's the first item if we need an item-specific duration.
                // If playlistMode is manual_next, this would be the cued item's duration.
                const firstItem = cueFromStore.playlistItems[0];
                calculatedItemDuration = firstItem && typeof firstItem.knownDuration === 'number' ? firstItem.knownDuration : 0;
                 // If repeatOne is active, total duration for display might be just the first item.
                if (cueFromStore.repeatOne) {
                    calculatedTotalDuration = calculatedItemDuration;
                }
            } // else, durations remain 0 if no items
        } else {
            calculatedTotalDuration = cueFromStore.knownDuration || 0;
            calculatedItemDuration = calculatedTotalDuration; // For single cue, item is the cue itself
        }
        
        // Apply trim to the representative item/cue for idle display
        // This is a simplified application of trim for the idle display of total/item duration.
        let effectiveDisplayDuration = calculatedTotalDuration; // Default to total for autoplay
        let effectiveItemDisplayDuration = calculatedItemDuration;

        if (cueFromStore.trimStartTime && cueFromStore.trimStartTime > 0) {
            effectiveItemDisplayDuration = Math.max(0, calculatedItemDuration - cueFromStore.trimStartTime);
            if (cueFromStore.trimEndTime && cueFromStore.trimEndTime > cueFromStore.trimStartTime) {
                effectiveItemDisplayDuration = Math.min(effectiveItemDisplayDuration, cueFromStore.trimEndTime - cueFromStore.trimStartTime);
            }
            if (!cueFromStore.isPlaylist) { // For single cues, total is the item
                 effectiveDisplayDuration = effectiveItemDisplayDuration;
            } else {
                // For playlists in idle, if we show total duration, it should be sum of trimmed items - complex to calculate here accurately.
                // For now, total playlist duration remains sum of knownDurations, item is first/cued (trimmed).
            }
        } else if (cueFromStore.trimEndTime && cueFromStore.trimEndTime > 0 && cueFromStore.trimEndTime < calculatedItemDuration) {
            effectiveItemDisplayDuration = cueFromStore.trimEndTime;
            if (!cueFromStore.isPlaylist) {
                effectiveDisplayDuration = effectiveItemDisplayDuration;
            }
        }

        return {
            currentTime: 0,
            totalPlaylistDuration: effectiveDisplayDuration,
            currentItemDuration: effectiveItemDisplayDuration, 
            currentItemRemainingTime: effectiveItemDisplayDuration, // In idle, remaining is full item duration
            rawDuration: 0
        };
    }
    return { currentTime: 0, totalPlaylistDuration: 0, currentItemDuration: 0, currentItemRemainingTime: 0, rawDuration: 0 };
}

// Helper function to generate a Fisher-Yates shuffle order for playlist items
function _generateShuffleOrder(cueId) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist || !playingState.originalPlaylistItems || playingState.originalPlaylistItems.length === 0) {
        console.warn(`AudioController: Cannot generate shuffle order for cue ${cueId}, invalid state or empty original playlist.`);
        playingState.shufflePlaybackOrder = playingState.originalPlaylistItems.map((_, i) => i); // Fallback to sequential
        return;
    }

    const order = Array.from(Array(playingState.originalPlaylistItems.length).keys());
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]]; // Swap
    }

    // Ensure the first shuffled item is not the same as the last item of the previous play-through, if applicable
    // This is more relevant if the playlist looped and then shuffle was toggled on, or for subsequent shuffles.
    // For now, we'll keep it simple. A more complex check could be added here if needed.
    
    playingState.shufflePlaybackOrder = order;
    console.log(`AudioController: Generated shuffle order for ${cueId}:`, order.map(idx => playingState.originalPlaylistItems[idx].name || idx));
}

export {
    init,
    play,
    stop,
    pause,
    toggle,
    stopAll,
    isPlaying,
    isPaused,
    setAudioOutputDevice, // Export the new function
    getCurrentlyPlayingPlaylistItemName, // Export new helper
    getNextPlaylistItemName, // Export new function
    getPlaybackTimes, // Export new helper
    updateAppConfig, // Export new function
    isCued // Export new function
}; 