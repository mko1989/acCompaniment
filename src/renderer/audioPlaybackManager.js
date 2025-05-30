console.log('AudioPlaybackManager.js: TOP LEVEL EXECUTION START');

// Companion_soundboard/src/renderer/audioPlaybackManager.js
// Manages core audio playback logic, state, and interactions with Howler instances.

// External dependencies (will be passed in via init)
let getGlobalCueByIdRef;
let getPlaybackTimesUtilRef; // from audioTimeUtils.js
let formatTimeMMSSRef; // Added for formatting time
let createPlaybackInstanceRef; // from playbackInstanceHandler.js
let sendPlaybackTimeUpdateRef; // from audioPlaybackIPCEmitter.js

// Module-level references (will be passed in via init)
let cueStoreRef;
let ipcBindingsRef;
let cueGridAPIRef;
let sidebarsAPIRef;
let getAppConfigFuncRef; // Changed from currentAppConfigRef

// State variables
let currentlyPlaying = {}; // cueId: { sound: Howl_instance, cue: cueData, isPaused: boolean, ... }
let playbackIntervals = {}; // For time updates
let pendingRestarts = {}; // For restart logic

let publicAPIManagerInstance; // Defined at module level

function init(dependencies) {
    getGlobalCueByIdRef = dependencies.getGlobalCueById;
    getPlaybackTimesUtilRef = dependencies.getPlaybackTimesUtil;
    formatTimeMMSSRef = dependencies.formatTimeMMSS;
    createPlaybackInstanceRef = dependencies.createPlaybackInstance;
    sendPlaybackTimeUpdateRef = dependencies.sendPlaybackTimeUpdate;

    cueStoreRef = dependencies.cueStore;
    ipcBindingsRef = dependencies.ipcBindings;
    // cueGridAPIRef and sidebarsAPIRef are set via setUIRefs
    getAppConfigFuncRef = dependencies.getAppConfigFunc; // Store the getter function

    console.log('AudioPlaybackManager: Full init function executed.');
}

// New function to set/update UI references after initial init
function setUIRefs(cgAPI, sbAPI) {
    cueGridAPIRef = cgAPI;
    sidebarsAPIRef = sbAPI;
    console.log(`AudioPlaybackManager: setUIRefs called. cueGridAPIRef type: ${typeof cueGridAPIRef}, sidebarsAPIRef type: ${typeof sidebarsAPIRef}`);
    if (cueGridAPIRef) {
        console.log(`AudioPlaybackManager: setUIRefs - cueGridAPIRef.updateCueButtonTime type: ${typeof cueGridAPIRef.updateCueButtonTime}`);
    }
}

// --- Ducking Logic ---
const DUCKING_FADE_DURATION = 1000; // 1 second for ducking fades

function _applyDucking(triggerCueId) {
    console.log(`AudioPlaybackManager: Applying ducking triggered by ${triggerCueId}`);
    const triggerCue = getGlobalCueByIdRef(triggerCueId);
    if (!triggerCue || !triggerCue.isDuckingTrigger) return;

    const duckingLevelPercentage = triggerCue.duckingLevel !== undefined ? triggerCue.duckingLevel : 20; // Default 20%
    const targetVolumeMultiplier = 1 - (duckingLevelPercentage / 100);

    for (const cueId in currentlyPlaying) {
        if (cueId === triggerCueId) continue; // Don't duck the trigger itself

        const playingState = currentlyPlaying[cueId];
        const affectedCue = getGlobalCueByIdRef(cueId); // Get full cue data

        if (affectedCue && affectedCue.enableDucking && playingState.sound && !playingState.isDucked) {
            console.log(`AudioPlaybackManager: Ducking cue ${cueId} to ${duckingLevelPercentage}% (${targetVolumeMultiplier}x) due to trigger ${triggerCueId}`);
            playingState.originalVolumeBeforeDuck = playingState.sound.volume(); // Store current volume
            playingState.isDucked = true;
            playingState.activeDuckingTriggerId = triggerCueId;
            // Fade to ducked volume
            playingState.sound.fade(playingState.originalVolumeBeforeDuck, playingState.originalVolume * targetVolumeMultiplier, DUCKING_FADE_DURATION);
        }
    }
}

function _revertDucking(triggerCueIdStop) {
    console.log(`AudioPlaybackManager: Reverting ducking for trigger ${triggerCueIdStop}`);
    for (const cueId in currentlyPlaying) {
        const playingState = currentlyPlaying[cueId];
        // Only revert if this specific trigger caused the ducking
        if (playingState.isDucked && playingState.activeDuckingTriggerId === triggerCueIdStop && playingState.sound) {
            console.log(`AudioPlaybackManager: Reverting duck for cue ${cueId} from trigger ${triggerCueIdStop}. Original volume: ${playingState.originalVolumeBeforeDuck}`);
            // Fade back to original volume (or current originalVolume if it changed)
            const cueConfiguredVolume = playingState.cue.volume !== undefined ? playingState.cue.volume : 1.0;
            playingState.sound.fade(playingState.sound.volume(), cueConfiguredVolume, DUCKING_FADE_DURATION);
            playingState.isDucked = false;
            playingState.activeDuckingTriggerId = null;
            playingState.originalVolumeBeforeDuck = null; 
        }
    }
}


// --- Core Playback Functions ---

function play(cue, isResume = false) {
    if (!cue || !cue.id) {
        console.error('AudioPlaybackManager: Invalid cue object provided for play.');
        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cue ? cue.id : 'unknown', status: 'error', details: { details: 'invalid_cue_data' } });
        return;
    }
    const cueId = cue.id;
    const existingState = currentlyPlaying[cueId];

    console.log(`AudioPlaybackManager: play() called for ${cueId}. isResume: ${isResume}. existingState: ${!!existingState}`);

    if (isResume && existingState && existingState.isPaused) {
        console.log('AudioPlaybackManager: Resuming paused cue:', cueId);
        existingState.isPaused = false;
        if (existingState.sound) {
            // If ducked, ensure it resumes at ducked volume, otherwise original
            const targetVolume = existingState.isDucked ? 
                                (existingState.originalVolume * (1 - ((getGlobalCueByIdRef(existingState.activeDuckingTriggerId)?.duckingLevel || 20) / 100))) :
                                existingState.originalVolume;
            existingState.sound.volume(targetVolume); // Set volume before play if needed
            existingState.sound.play();

            // If this cue itself is a trigger, re-apply ducking to others.
            const fullCueData = getGlobalCueByIdRef(cueId);
            if (fullCueData && fullCueData.isDuckingTrigger) {
                 _applyDucking(cueId);
            }

        } else if (existingState.isPlaylist) {
            console.warn('AudioPlaybackManager: Resuming playlist but sound object was missing. Restarting current item.');
            _playTargetItem(cueId, existingState.currentPlaylistItemIndex, true);
        }
        return;
    }

    if (existingState && !isResume) {
        console.warn(`AudioPlaybackManager: play() called for existing cue ${cueId} (not a resume). Forcing stop/restart.`);
        if (existingState.sound) {
            existingState.sound.stop(); // This should trigger onstop, which should handle _revertDucking if it was a trigger
        } else {
            delete currentlyPlaying[cueId]; // Should be cleaned up by onstop, but as a fallback
        }
        // Add a slight delay to ensure stop processing (including potential revertDucking) completes
        setTimeout(() => {
            _initializeAndPlayNew(cue);
        }, 50);
        return;
    }
    
    if (isResume && (!existingState || !existingState.isPaused)) {
        console.warn(`AudioPlaybackManager: play(resume) called for ${cueId} but not in a resumable state. Playing fresh.`);
        if(existingState) {
            if(existingState.sound) existingState.sound.stop(); // Triggers onstop for cleanup
            delete currentlyPlaying[cueId];
        }
        _initializeAndPlayNew(cue);
        return;
    }
    _initializeAndPlayNew(cue);
}

function _initializeAndPlayNew(cue) {
    const cueId = cue.id;
    console.log(`AudioPlaybackManager: _initializeAndPlayNew for ${cueId}`);

    if (currentlyPlaying[cueId]) {
        console.warn(`_initializeAndPlayNew: Lingering state for ${cueId} found. Stopping and Clearing.`);
        if (currentlyPlaying[cueId].sound) {
            currentlyPlaying[cueId].sound.stop();
            currentlyPlaying[cueId].sound.unload();
        }
        delete currentlyPlaying[cueId];
    }

    const fadeInTime = cue.fadeInTime || 0;
    const initialPlayingState = {
        sound: null, 
        cue: cue, 
        isPaused: false, 
        isPlaylist: cue.type === 'playlist',
        isFadingIn: fadeInTime > 0,
        isFadingOut: false,
        fadeTotalDurationMs: fadeInTime > 0 ? fadeInTime : 0,
        fadeStartTime: fadeInTime > 0 ? Date.now() : 0,
        originalVolume: cue.volume !== undefined ? cue.volume : 1.0,
        originalVolumeBeforeDuck: null, 
        isDucked: false,
        activeDuckingTriggerId: null,
    };

    if (cue.type === 'playlist') {
        console.log(`AudioPlaybackManager (_initializeAndPlayNew): Received playlist cue ${cueId}. Items:`, JSON.stringify(cue.playlistItems.map(item => ({id: item.id, name: item.name, path: item.path}))));
        if (!cue.playlistItems || cue.playlistItems.length === 0) {
            console.error('AudioPlaybackManager: Playlist cue has no items:', cueId);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'empty_playlist' } });
            return;
        }
        currentlyPlaying[cueId] = {
            ...initialPlayingState,
            playlistItems: cue.playlistItems, 
            currentPlaylistItemIndex: 0,
            originalPlaylistItems: cue.playlistItems.slice(),
            shufflePlaybackOrder: []
        };
        if (cue.shuffle && currentlyPlaying[cueId].originalPlaylistItems.length > 1) {
            _generateShuffleOrder(cueId);
            _playTargetItem(cueId, 0, false);
        } else {
            _playTargetItem(cueId, 0, false);
        }
    } else {
        if (!cue.filePath) {
            console.error('AudioPlaybackManager: No file path for single cue:', cueId);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'no_file_path' } });
            return;
        }
        currentlyPlaying[cueId] = initialPlayingState;
        _playTargetItem(cueId, undefined, false);
    }
}

function _playTargetItem(cueId, playlistItemIndex, isResumeForSeekAndFade = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState) {
        console.error(`AudioPlaybackManager: No playing state found for cueId ${cueId} in _playTargetItem.`);
        return;
    }

    const mainCue = playingState.cue;
    let filePath;
    let currentItemName = mainCue.name;
    let actualItemIndexInOriginalList = playlistItemIndex;

    if (playingState.isPlaylist) {
        let playIndexToUseFromOriginalItems = playlistItemIndex; 

        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) {
            if (playlistItemIndex === undefined || playlistItemIndex < 0 || playlistItemIndex >= playingState.shufflePlaybackOrder.length) {
                console.error(`AudioPlaybackManager: Invalid shuffle order index ${playlistItemIndex} for cue ${cueId}. Playlist length: ${playingState.shufflePlaybackOrder.length}`);
                _handlePlaylistEnd(cueId, true);
                return;
            }
            playIndexToUseFromOriginalItems = playingState.shufflePlaybackOrder[playlistItemIndex];
            actualItemIndexInOriginalList = playIndexToUseFromOriginalItems; 
        } else {
            if (playlistItemIndex === undefined || playlistItemIndex < 0 || playlistItemIndex >= playingState.originalPlaylistItems.length) {
                console.error(`AudioPlaybackManager: Invalid direct playlistItemIndex ${playlistItemIndex} for non-shuffled cue ${cueId}. Playlist length: ${playingState.originalPlaylistItems.length}`);
                _handlePlaylistEnd(cueId, true);
                return;
            }
        }
        
        const item = playingState.originalPlaylistItems[playIndexToUseFromOriginalItems]; 
        if (!item || !item.path) {
            console.error(`AudioPlaybackManager: Invalid playlist item at original index ${playIndexToUseFromOriginalItems} (derived from logical index ${playlistItemIndex}) for cue ${cueId}. Item:`, item);
            playingState.currentPlaylistItemIndex++; 
            const nextLogicalIdxToPlay = playingState.currentPlaylistItemIndex;
            const currentEffectiveListLength = (mainCue.shuffle && playingState.shufflePlaybackOrder) ? playingState.shufflePlaybackOrder.length : playingState.originalPlaylistItems.length;

            if (nextLogicalIdxToPlay < currentEffectiveListLength) {
                _playTargetItem(cueId, nextLogicalIdxToPlay, false);
            } else {
                _handlePlaylistEnd(cueId, false); 
            }
            return;
        }
        filePath = item.path;
        currentItemName = item.name || filePath.split(/[\\\/]/).pop();
        playingState.currentPlaylistItemIndex = playlistItemIndex; 
    } else {
        filePath = mainCue.filePath;
        actualItemIndexInOriginalList = undefined; 
    }

    if (!filePath) {
        console.error(`AudioPlaybackManager: No filePath determined for cue ${cueId} (item: ${currentItemName}).`);
        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'resolved_no_file_path_targetitem' } });
        
        if (playingState.isPlaylist) {
            _handlePlaylistEnd(cueId, true); 
        } else {
            if (currentlyPlaying[cueId]) {
                if (currentlyPlaying[cueId].sound) {
                    currentlyPlaying[cueId].sound.unload(); 
                }
                delete currentlyPlaying[cueId];
            }
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, null, false, true); 
        }
        return;
    }

    if (playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
    playingState.trimEndTimer = null;
    if (playingState.timeUpdateInterval) clearInterval(playingState.timeUpdateInterval);
    playingState.timeUpdateInterval = null;

    if (playingState.sound) {
        playingState.sound.stop();
        playingState.sound.unload();
        playingState.sound = null; 
    }

    const instanceHandlerContext = {
        currentlyPlaying, 
        playbackIntervals, 
        ipcBindings: ipcBindingsRef,
        cueGridAPI: cueGridAPIRef,
        sidebarsAPI: sidebarsAPIRef,
        sendPlaybackTimeUpdate: sendPlaybackTimeUpdateRef,
        _handlePlaylistEnd, 
        _playTargetItem,    
        getGlobalCueById: getGlobalCueByIdRef, 
        _applyDucking, 
        _revertDucking 
    };
    
    const soundInstance = createPlaybackInstanceRef(
        filePath, 
        mainCue.id, 
        mainCue, 
        playingState, 
        currentItemName, 
        actualItemIndexInOriginalList, 
        isResumeForSeekAndFade,
        instanceHandlerContext
    );
}

function _handlePlaylistEnd(cueId, errorOccurred = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist) {
        console.log(`AudioPlaybackManager: _handlePlaylistEnd called for ${cueId} but not a valid playlist state.`);
        return;
    }
    const mainCue = playingState.cue;
    console.log(`AudioPlaybackManager: Item ended in playlist ${cueId}. Error: ${errorOccurred}, Loop: ${mainCue.loop}, Mode: ${mainCue.playlistPlayMode}`);

    if (playingState.sound) { // Sound from the item that just ended
        playingState.sound.unload();
        playingState.sound = null; // Clear it for the next item
    }
    if (errorOccurred) {
        console.error(`AudioPlaybackManager: Error in playlist ${cueId}. Stopping playlist.`);
        // No need to call stop() here, just clean up state and inform UI
        delete currentlyPlaying[cueId];
        if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
        if (ipcBindingsRef && typeof ipcBindingsRef.send === 'function') {
            ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'playlist_playback_error' } });
        }
        // If the playlist itself was a trigger, revert ducking.
        const fullCueData = getGlobalCueByIdRef(cueId);
        if (fullCueData && fullCueData.isDuckingTrigger) {
            console.log(`AudioPlaybackManager: Playlist trigger cue ${cueId} ended with error. Reverting ducking.`);
            _revertDucking(cueId); // Revert based on the playlist's ID
        }
        return;
    }

    if (mainCue.playlistPlayMode === 'stop_and_cue_next') {
        let nextLogicalIdx = playingState.currentPlaylistItemIndex + 1;
        const listLen = playingState.originalPlaylistItems.length;
        let cuedName = null;
        let cuedOK = false;
        const currentOrderLen = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                                ? playingState.shufflePlaybackOrder.length 
                                : listLen;

        if (nextLogicalIdx < currentOrderLen) {
            playingState.currentPlaylistItemIndex = nextLogicalIdx;
            cuedOK = true;
        } else { // Reached end of playlist order
            if (mainCue.loop) {
                if (mainCue.shuffle && listLen > 1) _generateShuffleOrder(cueId);
                playingState.currentPlaylistItemIndex = 0; // Loop back to start
                cuedOK = true;
            } else { // No loop, playlist ends
                delete currentlyPlaying[cueId];
                if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, null);
                if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_ended_fully_no_loop_stop_mode' } });
                const fullCueData = getGlobalCueByIdRef(cueId);
                if (fullCueData && fullCueData.isDuckingTrigger) {
                    console.log(`AudioPlaybackManager: Non-looping playlist trigger cue ${cueId} ended. Reverting ducking.`);
                    _revertDucking(cueId);
                }
                return;
            }
        }
        if (cuedOK) {
            playingState.isPaused = true; // Cued state implies paused until next explicit play
            playingState.isCuedNext = true; // Explicitly mark that it's cued for next
            let cuedOriginalIdx = playingState.currentPlaylistItemIndex; // This is the logical index in current order
            if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > playingState.currentPlaylistItemIndex) {
                cuedOriginalIdx = playingState.shufflePlaybackOrder[playingState.currentPlaylistItemIndex]; // Get original index from shuffle map
            }
            if (cuedOriginalIdx >= 0 && cuedOriginalIdx < listLen) {
                const item = playingState.originalPlaylistItems[cuedOriginalIdx];
                cuedName = item.name || item.path.split(/[\\\/]/).pop();
            }
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, `Next: ${cuedName || 'Item'}`, true); // true for isPaused (cued)
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_item_ended_cued_next', nextItem: cuedName } });
        }
        // Ducking state for the *playlist as a whole* is managed when it starts/stops, not between items unless the playlist itself stops.
        return;
    }

    // Default: play_through or other modes (if any introduced)
    playingState.currentPlaylistItemIndex++;
    const nextLogicalIdx = playingState.currentPlaylistItemIndex;
    
    // Determine the effective list of items and its length based on shuffle state
    const itemsToConsider = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                            ? playingState.shufflePlaybackOrder 
                            : playingState.originalPlaylistItems;
    const effectiveListLength = itemsToConsider.length;

    if (nextLogicalIdx < effectiveListLength) {
        playingState.isPaused = false;
        playingState.isCuedNext = false;
        setTimeout(() => _playTargetItem(cueId, nextLogicalIdx, false), 10); // Play next item in the current order
    } else { // Reached end of current playback order
        if (mainCue.loop) {
            if (mainCue.shuffle && playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 1) {
                _generateShuffleOrder(cueId); // Re-shuffle if looping and shuffle is on
            }
            playingState.currentPlaylistItemIndex = 0; // Reset to start of (potentially new shuffled) order
            playingState.isPaused = false;
            playingState.isCuedNext = false;
            setTimeout(() => _playTargetItem(cueId, 0, false), 10);
        } else { // No loop, playlist truly ends
            delete currentlyPlaying[cueId];
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_ended_naturally_no_loop' } });
            
            const fullCueData = getGlobalCueByIdRef(cueId);
            if (fullCueData && fullCueData.isDuckingTrigger) {
                console.log(`AudioPlaybackManager: Non-looping playlist trigger cue ${cueId} ended. Reverting ducking.`);
                _revertDucking(cueId);
            }
        }
    }
}

function stop(cueId, useFade = true, fromCompanion = false, isRetriggerStop = false) {
    console.log(`AudioPlaybackManager: stop() called for cueId: ${cueId}, useFade: ${useFade}, fromCompanion: ${fromCompanion}, isRetriggerStop: ${isRetriggerStop}`);
    const playingState = currentlyPlaying[cueId];

    if (playingState && playingState.sound) {
        const cue = getGlobalCueByIdRef(cueId); // Get full cue data for fade times etc.
        const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
        const defaultFadeOutTimeFromConfig = appConfig.defaultFadeOutTime !== undefined ? appConfig.defaultFadeOutTime : 0;
        const fadeOutTime = (cue && cue.fadeOutTime !== undefined) ? cue.fadeOutTime : defaultFadeOutTimeFromConfig;
        
        playingState.acIsStoppingWithFade = useFade && fadeOutTime > 0;
        playingState.acStopSource = isRetriggerStop ? (cue ? cue.retriggerAction : 'unknown_retrigger') : (fromCompanion ? 'companion_stop' : 'manual_stop');

        if (playingState.acIsStoppingWithFade) {
            playingState.isFadingOut = true;
            playingState.isFadingIn = false; 
            playingState.fadeTotalDurationMs = fadeOutTime;
            playingState.fadeStartTime = Date.now();
        } else {
            playingState.isFadingIn = false;
            playingState.isFadingOut = false;
            playingState.fadeTotalDurationMs = 0;
            playingState.fadeStartTime = 0;
        }

        if (playingState.acIsStoppingWithFade) {
            const currentVolume = playingState.sound.volume();
            console.log(`AudioPlaybackManager: Fading out cue ${cueId} over ${fadeOutTime}ms from volume ${currentVolume}`);
            playingState.sound.fade(currentVolume, 0, fadeOutTime); // Howler's fade handles its own soundId
        } else {
            console.log(`AudioPlaybackManager: Stopping cue ${cueId} immediately.`);
            playingState.sound.stop(); // Howler's stop handles its own soundId
        }
        // Note: _revertDucking for trigger cues is now handled in the `onstop` event in playbackInstanceHandler.js
        // This ensures it happens *after* the sound has fully stopped, including after a fade.
    } else {
        console.warn(`AudioPlaybackManager: stop() called for cueId ${cueId}, but no playing sound found.`);
        // If it was a trigger and somehow state is inconsistent, try to revert ducking as a fallback.
        const fullCueData = getGlobalCueByIdRef(cueId);
        if (fullCueData && fullCueData.isDuckingTrigger) {
            console.warn(`AudioPlaybackManager: Trigger cue ${cueId} stop called with no sound, attempting fallback revert ducking.`);
            _revertDucking(cueId);
        }
        // Clean up any lingering state if no sound
        if (playingState) {
            delete currentlyPlaying[cueId];
             if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
             if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'stop_called_no_sound' } });
        }
    }
}

function pause(cueId) {
    const current = currentlyPlaying[cueId];
    if (current && current.sound && current.sound.playing() && !current.isPaused) {
        console.log('AudioPlaybackManager: Pausing cue:', cueId);
        current.sound.pause(); 
        // If this cue itself is a trigger, ducking should remain active while paused.
        // Reverting ducking only happens when the trigger cue STOPS.
    }
}

function stopAllCues(options = { exceptCueId: null, useFade: true }) {
    console.log('AudioPlaybackManager: stopAllCues called. Options:', options);
    for (const cueId in currentlyPlaying) {
        if (options.exceptCueId && cueId === options.exceptCueId) {
            continue;
        }
        // Use the individual stop method to ensure proper fade and state handling
        stop(cueId, options.useFade !== undefined ? options.useFade : true);
    }
}

function seekInCue(cueId, positionSec) {
    const playingState = currentlyPlaying[cueId];
    if (playingState && playingState.sound) {
        console.log(`AudioPlaybackManager: Seeking in cue ${cueId} to ${positionSec}s.`);
        if (playingState.isPlaylist) {
            // For playlists, seeking might mean restarting the current item at a new position
            // or even changing items, which is complex.
            // Current implementation: seek the currently playing item of the playlist.
            // This might need more sophisticated handling if cross-item playlist seek is desired.
            const currentItemSound = playingState.sound;
            if (currentItemSound) {
                currentItemSound.seek(positionSec);
                // If paused, it remains paused at new position. If playing, it continues from new position.
                // Update time immediately for UI.
                if (sendPlaybackTimeUpdateRef && getGlobalCueByIdRef) {
                     const mainCue = playingState.cue;
                     let currentItemName = mainCue.name;
                     if(playingState.isPlaylist && playingState.originalPlaylistItems[playingState.currentPlaylistItemIndex]) {
                        currentItemName = playingState.originalPlaylistItems[playingState.currentPlaylistItemIndex].name || currentItemName;
                     }
                    sendPlaybackTimeUpdateRef(cueId, currentItemSound, playingState, currentItemName, currentItemSound.playing() ? 'playing' : 'paused_seek');
                }
            }
        } else {
            // Single file cue
            playingState.sound.seek(positionSec);
            if (sendPlaybackTimeUpdateRef) {
                sendPlaybackTimeUpdateRef(cueId, playingState.sound, playingState, playingState.cue.name, playingState.sound.playing() ? 'playing' : 'paused_seek');
            }
        }
    } else {
        console.warn(`AudioPlaybackManager: seekInCue called for ${cueId}, but no playing sound found.`);
    }
}


function toggleCue(cueIdToToggle, fromCompanion = false, retriggerBehaviorOverride = null) {
    const cue = getGlobalCueByIdRef(cueIdToToggle);
    if (!cue) {
        console.error(`AudioPlaybackManager: toggleCue - Cue with ID ${cueIdToToggle} not found.`);
        return;
    }
    
    const currentPlayingState = currentlyPlaying[cueIdToToggle];
    const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
    const defaultRetrigger = appConfig.defaultRetriggerBehavior || 'restart'; // Default for UI clicks
    const defaultRetriggerCompanion = appConfig.defaultRetriggerBehaviorCompanion || 'restart'; // Default for Companion triggers

    let retriggerBehavior = retriggerBehaviorOverride;
    if (!retriggerBehavior) {
        retriggerBehavior = fromCompanion ? 
            (cue.retriggerActionCompanion || defaultRetriggerCompanion) : 
            (cue.retriggerAction || defaultRetrigger);
    }
    
    console.log(`AudioPlaybackManager: toggleCue for ${cueIdToToggle}. FromCompanion: ${fromCompanion}. Retrigger: ${retriggerBehavior}. State: ${currentPlayingState ? 'Playing/Paused' : 'Not Playing'}`);

    if (currentPlayingState) { // Cue is currently in playing, paused, or cued_next state
        if (currentPlayingState.isPaused) {
            // If playlist is in 'stop_and_cue_next' mode and is cued, then 'toggle' should play the cued item.
            if (currentPlayingState.isPlaylist && cue.playlistPlayMode === 'stop_and_cue_next' && currentPlayingState.isCuedNext) {
                console.log(`AudioPlaybackManager: Toggle - Resuming cued playlist item for ${cueIdToToggle}.`);
                currentPlayingState.isPaused = false; // Transition from cued to playing
                currentPlayingState.isCuedNext = false;
                _playTargetItem(cueIdToToggle, currentPlayingState.currentPlaylistItemIndex, true); // true for isResume (from cued state)
            } else { // Standard pause: retrigger behavior applies
                console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} is PAUSED. Applying retrigger: ${retriggerBehavior}`);
            switch (retriggerBehavior) {
                    case 'restart':
                        stop(cueIdToToggle, false, fromCompanion, true); // Stop immediately (isRetriggerStop=true)
                        // Add a slight delay for stop to process before playing fresh
                        if (pendingRestarts[cueIdToToggle]) clearTimeout(pendingRestarts[cueIdToToggle]);
                        pendingRestarts[cueIdToToggle] = setTimeout(() => { play(cue, false); delete pendingRestarts[cueIdToToggle];}, 50);
                        break;
                case 'stop':
                        stop(cueIdToToggle, false, fromCompanion, true); // Stop immediately
                    break;
                case 'fade_out_and_stop':
                         stop(cueIdToToggle, true, fromCompanion, true); // Fade out and stop
                    break;
                    case 'toggle_pause_play': // If paused, play
                    default: // Default is resume
                    play(cue, true); // Resume
                    break;
            }
            }
        } else { // Cue is actively PLAYING
            console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} is PLAYING. Applying retrigger: ${retriggerBehavior}`);
            switch (retriggerBehavior) {
                case 'restart':
                    stop(cueIdToToggle, false, fromCompanion, true); // Stop immediately
                    if (pendingRestarts[cueIdToToggle]) clearTimeout(pendingRestarts[cueIdToToggle]);
                    pendingRestarts[cueIdToToggle] = setTimeout(() => { play(cue, false); delete pendingRestarts[cueIdToToggle]; }, 50);
                    break;
                case 'stop':
                    stop(cueIdToToggle, false, fromCompanion, true);
                    break;
                case 'fade_out_and_stop':
                    stop(cueIdToToggle, true, fromCompanion, true);
                    break;
                case 'toggle_pause_play': // If playing, pause
                default: // Default is pause
                    pause(cueIdToToggle);
                    break;
            }
        }
    } else { // Cue is NOT currently playing
        console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} not currently playing. Starting fresh.`);
        play(cue, false); // Start fresh
            }
        }


function getPlaybackState(cueId) {
    const playingState = currentlyPlaying[cueId];

    // --- START DIAGNOSTIC LOGGING ---
    console.log(`[AudioPlaybackManager getPlaybackState] For cueId: ${cueId}. currentlyPlaying[cueId] exists: ${!!playingState}`);
    if (playingState) {
        console.log(`[AudioPlaybackManager getPlaybackState] playingState.sound exists: ${!!playingState.sound}, sound current volume: ${playingState.sound ? playingState.sound.volume() : 'N/A'}`);
        if (playingState.sound && typeof playingState.sound.seek === 'function') {
            const seekVal = playingState.sound.seek();
            console.log(`[AudioPlaybackManager getPlaybackState] sound.seek() returned: ${seekVal} (type: ${typeof seekVal})`);
        }
    }
    // --- END DIAGNOSTIC LOGGING ---

    if (playingState && playingState.sound) {
        const sound = playingState.sound;
        const mainCueFromState = playingState.cue; // This is the mainCue object

        // Ensure getPlaybackTimesUtilRef and formatTimeMMSSRef are available
        if (!getPlaybackTimesUtilRef || !formatTimeMMSSRef) {
            console.error('AudioPlaybackManager: getPlaybackState - Missing critical time utility refs!');
            return {
                isPlaying: sound ? sound.playing() : false,
                isPaused: playingState.isPaused,
                currentTime: 0,
                duration: mainCueFromState?.knownDuration || 0, // Fallback to knownDuration
                currentTimeFormatted: '00:00',
                durationFormatted: formatTimeMMSSRef ? formatTimeMMSSRef(mainCueFromState?.knownDuration || 0) : '00:00',
                isPlaylist: mainCueFromState?.type === 'playlist',
                volume: sound ? sound.volume() : (mainCueFromState?.volume !== undefined ? mainCueFromState.volume : 1.0), // Provide default volume if sound not available
                itemBaseDuration: playingState.duration || 0, // from playingState.duration
            };
        }
        
        const itemBaseDuration = playingState.duration; // This is the Howler sound.duration(), raw for current item
        
        // console.log(`AudioPlaybackManager (getPlaybackState for ${cueId}): playingState.cue before passing:`, mainCueFromState ? JSON.parse(JSON.stringify(mainCueFromState)) : mainCueFromState);
        // console.log(`AudioPlaybackManager (getPlaybackState for ${cueId}): itemBaseDuration before passing: ${itemBaseDuration}`);
        
        const times = getPlaybackTimesUtilRef(
            sound, // Arg 1
            itemBaseDuration, // Arg 2
            playingState.isPlaylist ? playingState.originalPlaylistItems : null, // Arg 3: playlistOriginalItems
            playingState.isPlaylist ? playingState.currentPlaylistItemIndex : null, // Arg 4: currentPlaylistItemLogicalIndex
            mainCueFromState, // Arg 5: mainCue (this is the actual main cue object)
            playingState.isPlaylist ? playingState.shufflePlaybackOrder : null, // Arg 6: playlistShuffleOrder
            playingState.isPlaylist ? (playingState.isCuedNext || false) : false // Arg 7: isCurrentlyCuedNext
        );
        // console.log(`AudioPlaybackManager: times from getPlaybackTimesUtilRef for ${cueId}:`, times ? JSON.parse(JSON.stringify(times)) : null);

        const currentTimeFormatted = formatTimeMMSSRef(times.currentTime);
        // IMPORTANT: Use times.currentItemAdjustedDuration for the duration displayed if available,
        // otherwise fall back to times.currentItemDuration.
        // times.currentItemAdjustedDuration considers trims.
        const displayDuration = times.currentItemAdjustedDuration !== undefined ? times.currentItemAdjustedDuration : times.currentItemDuration;
        const durationFormatted = formatTimeMMSSRef(displayDuration);

        // --- START DETAILED DIAGNOSTIC LOG ---
        console.log(`[AudioPlaybackManager getPlaybackState DEBUG for ${cueId}]`);
        console.log(`  >>> times object from getPlaybackTimesUtilRef:`, JSON.stringify(times));
        console.log(`  >>> mainCueFromState.knownDuration: ${mainCueFromState?.knownDuration}`);
        console.log(`  >>> itemBaseDuration (playingState.duration): ${itemBaseDuration}`);
        console.log(`  >>> displayDuration (for formatting): ${displayDuration}`);
        console.log(`  >>> calculated currentTimeFormatted: ${currentTimeFormatted}`);
        console.log(`  >>> calculated durationFormatted: ${durationFormatted}`);
        // --- END DETAILED DIAGNOSTIC LOG ---

        return {
            isPlaying: sound.playing(),
            isPaused: playingState.isPaused,
            isPlaylist: mainCueFromState.type === 'playlist',
            volume: sound.volume(),
            currentTime: times.currentTime,
            currentTimeFormatted: currentTimeFormatted,
            duration: displayDuration,
            durationFormatted: durationFormatted,
            isFadingIn: playingState.isFadingIn || false,
            isFadingOut: playingState.isFadingOut || false,
            isDucked: playingState.isDucked || false,
            activeDuckingTriggerId: playingState.activeDuckingTriggerId || null,
            isCuedNext: playingState.isCuedNext || false,
            isCued: playingState.isCued || false,
            itemBaseDuration: itemBaseDuration
        };
    } else {
        // This is a normal occurrence when a cue is idle or has just stopped.
        console.log(`AudioPlaybackManager: getPlaybackState called for ${cueId}, but no active sound instance found (e.g., cue is idle or stopped).`);
        return null;
    }
}


function _generateShuffleOrder(cueId) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist || !playingState.originalPlaylistItems) {
        console.error(`AudioPlaybackManager: _generateShuffleOrder called for ${cueId} but not a valid playlist state.`);
        playingState.shufflePlaybackOrder = []; // Ensure it's at least an empty array
        return;
    }
    const originalIndices = playingState.originalPlaylistItems.map((_, index) => index);
    
    // Fisher-Yates shuffle algorithm
    for (let i = originalIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [originalIndices[i], originalIndices[j]] = [originalIndices[j], originalIndices[i]];
    }
    playingState.shufflePlaybackOrder = originalIndices; // This now stores indices, not items
    console.log(`AudioPlaybackManager: Generated shuffle order (indices) for ${cueId}:`, playingState.shufflePlaybackOrder);
}


publicAPIManagerInstance = {
    init,
    setUIRefs,
    playCue: play, // Renaming for clarity in public API
    stopCue: stop,
    pauseCue: pause,
    toggleCue, // Keep as toggleCue as it's the primary interaction method
    stopAllCues,
    seekInCue,
    getPlaybackState, // To get current time, duration, playing status etc.
    // Ducking functions are internal, triggered by playback events, not directly exposed in public API for audioController
};

export default publicAPIManagerInstance;
// Replace individual exports with a single default export
// export {
//     init,
//     setUIRefs,
//     play,
//     stop,
//     pause,
//     toggleCue,
//     stopAllCues,
//     seekInCue,
//     getPlaybackState
// };