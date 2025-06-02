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
        console.log(`AudioPlaybackManager: _handlePlaylistEnd (error path) for ${cueId}. Attempting to check for ducking trigger.`);
        const fullCueDataError = getGlobalCueByIdRef(cueId);
        const initialCueDataError = playingState.cue; 

        console.log(`AudioPlaybackManager: _handlePlaylistEnd (error path) for ${cueId}. Fresh fullCueData:`, fullCueDataError ? JSON.stringify(fullCueDataError) : 'null');
        console.log(`AudioPlaybackManager: _handlePlaylistEnd (error path) for ${cueId}. Initial playingState.cue:`, initialCueDataError ? JSON.stringify(initialCueDataError) : 'null');

        const isTriggerFreshError = fullCueDataError && fullCueDataError.isDuckingTrigger;
        const isTriggerInitialError = initialCueDataError && initialCueDataError.isDuckingTrigger;

        console.log(`AudioPlaybackManager: _handlePlaylistEnd (error path) for ${cueId}. isTriggerFresh: ${isTriggerFreshError}, isTriggerInitial: ${isTriggerInitialError}`);
        
        if (isTriggerFreshError || isTriggerInitialError) {
            console.log(`AudioPlaybackManager: Playlist trigger cue ${cueId} ended with error. isDuckingTrigger (fresh/initial): ${isTriggerFreshError}/${isTriggerInitialError}. Reverting ducking.`);
            _revertDucking(cueId);
        } else {
            console.log(`AudioPlaybackManager: Playlist cue ${cueId} ended with error but was NOT identified as a ducking trigger (fresh: ${isTriggerFreshError}, initial: ${isTriggerInitialError}). No ducking reversion.`);
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
                if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, null, false); // Ensure isCuedOverride is false
                if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_ended_fully_no_loop_stop_mode' } });
                
                console.log(`AudioPlaybackManager: _handlePlaylistEnd (stop_and_cue_next) for ${cueId}. Attempting to check for ducking trigger.`);
                const fullCueDataStopMode = getGlobalCueByIdRef(cueId);
                const initialCueDataStopMode = playingState.cue;

                console.log(`AudioPlaybackManager: _handlePlaylistEnd (stop_and_cue_next) for ${cueId}. Fresh fullCueData:`, fullCueDataStopMode ? JSON.stringify(fullCueDataStopMode) : 'null');
                console.log(`AudioPlaybackManager: _handlePlaylistEnd (stop_and_cue_next) for ${cueId}. Initial playingState.cue:`, initialCueDataStopMode ? JSON.stringify(initialCueDataStopMode) : 'null');

                const isTriggerFreshStopMode = fullCueDataStopMode && fullCueDataStopMode.isDuckingTrigger;
                const isTriggerInitialStopMode = initialCueDataStopMode && initialCueDataStopMode.isDuckingTrigger;

                console.log(`AudioPlaybackManager: _handlePlaylistEnd (stop_and_cue_next) for ${cueId}. isTriggerFresh: ${isTriggerFreshStopMode}, isTriggerInitial: ${isTriggerInitialStopMode}`);

                if (isTriggerFreshStopMode || isTriggerInitialStopMode) {
                    console.log(`AudioPlaybackManager: Non-looping playlist trigger cue ${cueId} (stop_and_cue_next mode) ended. isDuckingTrigger (fresh/initial): ${isTriggerFreshStopMode}/${isTriggerInitialStopMode}. Reverting ducking.`);
                    _revertDucking(cueId);
                } else {
                    console.log(`AudioPlaybackManager: Playlist cue ${cueId} (stop_and_cue_next mode) ended but was NOT identified as a ducking trigger (fresh: ${isTriggerFreshStopMode}, initial: ${isTriggerInitialStopMode}). No ducking reversion.`);
                }
                return;
            }
        }
        if (cuedOK) {
            playingState.isPaused = true; // Explicitly set to paused
            playingState.isCuedNext = true; // Explicitly mark that it's cued for next
            playingState.isCued = true; // General cued flag
            playingState.sound = null; // Ensure no sound object from previous item lingers in this cued state

            console.log(`AudioPlaybackManager: _handlePlaylistEnd - stop_and_cue_next - Set playingState for ${cueId}: isPaused=${playingState.isPaused}, isCuedNext=${playingState.isCuedNext}, isCued=${playingState.isCued}`); // DEBUG LOG

            // If this playlist, which is now paused and cued, was a ducking trigger, revert ducking.
            const playlistCueData = getGlobalCueByIdRef(cueId); // cueId is the playlist's ID
            if (playlistCueData && playlistCueData.isDuckingTrigger) {
                console.log(`AudioPlaybackManager: Playlist trigger ${cueId} (stop_and_cue_next mode) is now cued/paused. Reverting ducking.`);
                _revertDucking(cueId);
            }

            let cuedOriginalIdx = playingState.currentPlaylistItemIndex; // This is the logical index in current order
            if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > playingState.currentPlaylistItemIndex) {
                cuedOriginalIdx = playingState.shufflePlaybackOrder[playingState.currentPlaylistItemIndex];
            }
            if (cuedOriginalIdx >= 0 && cuedOriginalIdx < listLen) {
                const item = playingState.originalPlaylistItems[cuedOriginalIdx];
                cuedName = item.name || item.path.split(/[\\\/]/).pop();
            }
            // Update button state: not playing (false), provide next item name, IS cued (true)
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, `Next: ${cuedName || 'Item'}`, true);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'cued_next', details: { reason: 'playlist_item_ended_cued_next', nextItem: cuedName } });
        }
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
            
            console.log(`AudioPlaybackManager: _handlePlaylistEnd (play_through) for ${cueId}. Attempting to check for ducking trigger.`);
            const fullCueDataPlayThrough = getGlobalCueByIdRef(cueId);
            const initialCueDataPlayThrough = playingState.cue;

            console.log(`AudioPlaybackManager: _handlePlaylistEnd (play_through) for ${cueId}. Fresh fullCueData:`, fullCueDataPlayThrough ? JSON.stringify(fullCueDataPlayThrough) : 'null');
            console.log(`AudioPlaybackManager: _handlePlaylistEnd (play_through) for ${cueId}. Initial playingState.cue:`, initialCueDataPlayThrough ? JSON.stringify(initialCueDataPlayThrough) : 'null');

            const isTriggerFreshPlayThrough = fullCueDataPlayThrough && fullCueDataPlayThrough.isDuckingTrigger;
            const isTriggerInitialPlayThrough = initialCueDataPlayThrough && initialCueDataPlayThrough.isDuckingTrigger;

            console.log(`AudioPlaybackManager: _handlePlaylistEnd (play_through) for ${cueId}. isTriggerFresh: ${isTriggerFreshPlayThrough}, isTriggerInitial: ${isTriggerInitialPlayThrough}`);

            if (isTriggerFreshPlayThrough || isTriggerInitialPlayThrough) {
                console.log(`AudioPlaybackManager: Non-looping playlist trigger cue ${cueId} (play_through mode) ended. isDuckingTrigger (fresh/initial): ${isTriggerFreshPlayThrough}/${isTriggerInitialPlayThrough}. Reverting ducking.`);
                _revertDucking(cueId);
            } else {
                 console.log(`AudioPlaybackManager: Playlist cue ${cueId} (play_through mode) ended but was NOT identified as a ducking trigger (fresh: ${isTriggerFreshPlayThrough}, initial: ${isTriggerInitialPlayThrough}). No ducking reversion.`);
            }
        }
    }
}

function stop(cueId, useFade = true, fromCompanion = false, isRetriggerStop = false, stopReason = null) {
    console.log(`AudioPlaybackManager: stop() called for cueId: ${cueId}, useFade: ${useFade}, fromCompanion: ${fromCompanion}, isRetriggerStop: ${isRetriggerStop}, stopReason: ${stopReason}`);
    const playingState = currentlyPlaying[cueId];

    if (playingState && playingState.sound) {
        const cue = getGlobalCueByIdRef(cueId); // Get full cue data for fade times etc.
        const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
        const defaultFadeOutTimeFromConfig = appConfig.defaultFadeOutTime !== undefined ? appConfig.defaultFadeOutTime : 0;
        const fadeOutTime = (cue && cue.fadeOutTime !== undefined) ? cue.fadeOutTime : defaultFadeOutTimeFromConfig;
        
        playingState.acIsStoppingWithFade = useFade && fadeOutTime > 0;
        playingState.acStopSource = isRetriggerStop ? (cue ? cue.retriggerAction : 'unknown_retrigger') : (fromCompanion ? 'companion_stop' : 'manual_stop');
        playingState.explicitStopReason = stopReason; // Store the explicit stop reason

        if (playingState.sound) { // Ensure sound exists before attaching property
            playingState.sound.acExplicitStopReason = stopReason; // Attach to sound instance
        }

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
        current.isPaused = true; // Ensure isPaused state is accurately set

        // If this cue itself is a trigger and is being paused, revert ducking for others.
        const cueData = getGlobalCueByIdRef(cueId);
        if (cueData && cueData.isDuckingTrigger) {
            console.log(`AudioPlaybackManager: Paused cue ${cueId} is a ducking trigger. Reverting ducking.`);
            _revertDucking(cueId);
        }
    }
}

function stopAllCues(options = { exceptCueId: null, useFade: true }) {
    console.log('AudioPlaybackManager: stopAllCues called. Options:', options);

    let useFadeForStop = options.useFade; // Default to options.useFade if present

    if (options && options.behavior) {
        // If behavior is specified (likely from Companion), it takes precedence
        useFadeForStop = options.behavior === 'fade_out_and_stop';
        console.log(`AudioPlaybackManager: stopAllCues - behavior specified: '${options.behavior}', setting useFadeForStop to: ${useFadeForStop}`);
    } else if (options && options.useFade !== undefined) {
        // If behavior is not specified, but useFade is, use that.
        useFadeForStop = options.useFade;
        console.log(`AudioPlaybackManager: stopAllCues - behavior NOT specified, using options.useFade: ${useFadeForStop}`);
    } else {
        // Fallback if neither behavior nor options.useFade is explicitly set
        // This maintains the original default of 'true' if options itself is minimal or undefined.
        useFadeForStop = true; 
        console.log(`AudioPlaybackManager: stopAllCues - behavior and options.useFade NOT specified, defaulting useFadeForStop to: ${useFadeForStop}`);
    }

    for (const cueId in currentlyPlaying) {
        if (options && options.exceptCueId && cueId === options.exceptCueId) {
            continue;
        }
        // Use the individual stop method to ensure proper fade and state handling
        stop(cueId, useFadeForStop, false, false, 'stop_all');
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
            // If playlist is in 'stop_and_cue_next' mode and is cued (isPaused AND isCuedNext are true), then 'toggle' should play the cued item.
            if (currentPlayingState.isPlaylist && cue.playlistPlayMode === 'stop_and_cue_next' && currentPlayingState.isCuedNext && currentPlayingState.isCued) {
                console.log(`AudioPlaybackManager: Toggle - Playing cued playlist item for ${cueIdToToggle}.`);
                currentPlayingState.isPaused = false;
                currentPlayingState.isCuedNext = false;
                currentPlayingState.isCued = false;
                _playTargetItem(cueIdToToggle, currentPlayingState.currentPlaylistItemIndex, false); // Play the cued item (isResumeForSeekAndFade = false for fresh play)
            } else { // Standard pause (not a cued playlist item) or other playlist modes: retrigger behavior applies
                console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} is PAUSED (or not a specifically cued playlist item). Applying retrigger: ${retriggerBehavior}`);
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
                currentPlaylistItemName: null,
                nextPlaylistItemName: null,
            };
        }
        
        const itemBaseDuration = playingState.duration; // This is the Howler sound.duration(), raw for current item
        
        const times = getPlaybackTimesUtilRef(
            sound, // Arg 1
            itemBaseDuration, // Arg 2
            playingState.isPlaylist ? playingState.originalPlaylistItems : null, // Arg 3: playlistOriginalItems
            playingState.isPlaylist ? playingState.currentPlaylistItemIndex : null, // Arg 4: currentPlaylistItemLogicalIndex
            mainCueFromState, // Arg 5: mainCue (this is the actual main cue object)
            playingState.isPlaylist ? playingState.shufflePlaybackOrder : null, // Arg 6: playlistShuffleOrder
            playingState.isPlaylist ? (playingState.isCuedNext || false) : false // Arg 7: isCurrentlyCuedNext
        );

        const currentTimeFormatted = formatTimeMMSSRef(times.currentTime);
        const displayDuration = times.currentItemAdjustedDuration !== undefined ? times.currentItemAdjustedDuration : times.currentItemDuration;
        const durationFormatted = formatTimeMMSSRef(displayDuration);

        let currentPlaylistItemName = null;
        let nextPlaylistItemName = null;

        if (mainCueFromState.type === 'playlist' && playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 0) {
            const currentLogicalIndex = playingState.currentPlaylistItemIndex;
            let currentOriginalIndex = currentLogicalIndex;
            if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > currentLogicalIndex) {
                currentOriginalIndex = playingState.shufflePlaybackOrder[currentLogicalIndex];
            }

            if (currentOriginalIndex >= 0 && currentOriginalIndex < playingState.originalPlaylistItems.length) {
                currentPlaylistItemName = playingState.originalPlaylistItems[currentOriginalIndex]?.name || `Item ${currentOriginalIndex + 1}`;
            }

            if (playingState.isCuedNext) {
                // If explicitly cued (stop_and_cue_next mode), currentPlaylistItemIndex already points to the cued item
                let cuedOriginalIndex = currentLogicalIndex; // currentPlaylistItemIndex is the *next* item to play
                 if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > currentLogicalIndex) {
                    cuedOriginalIndex = playingState.shufflePlaybackOrder[currentLogicalIndex];
                }
                if (cuedOriginalIndex >= 0 && cuedOriginalIndex < playingState.originalPlaylistItems.length) {
                    nextPlaylistItemName = playingState.originalPlaylistItems[cuedOriginalIndex]?.name || `Item ${cuedOriginalIndex + 1}`;
                }
                 // When cued, the "current" item is effectively none, as it just finished.
                // Or, we could display the one that *was* playing. For simplicity, if cued, current is less relevant than next.
                // For now, if cued, currentPlaylistItemName will reflect the *upcoming* cued item if sound.playing() is false.
                // If sound is still playing (e.g. fade out of previous), it might be ambiguous.
                // Let's refine: if cued, current name is the one about to play, next is null or after that.
                // For 'stop_and_cue_next', when an item *ends*, `isCuedNext` becomes true, `currentPlaylistItemIndex` is updated.
                // So, `currentPlaylistItemName` derived from `currentPlaylistItemIndex` *is* the "next" item.
                // So we can set `nextPlaylistItemName = currentPlaylistItemName` and perhaps clear `currentPlaylistItemName` if truly stopped.
                // However, cueGrid logic uses "Next: " when cued. So let's ensure nextPlaylistItemName is the cued one.
                if (sound && !sound.playing() && playingState.isPaused) { // Truly cued and waiting
                    currentPlaylistItemName = null; // The previous one finished.
                    // nextPlaylistItemName is already set above from currentPlaylistItemIndex which *is* the cued one.
                }

            } else if (sound && sound.playing()) { // Actively playing a playlist item
                let nextLogicalIndex = currentLogicalIndex + 1;
                const effectiveListLength = (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0)
                                          ? playingState.shufflePlaybackOrder.length
                                          : playingState.originalPlaylistItems.length;

                if (nextLogicalIndex < effectiveListLength) {
                    let nextOriginalIndex = nextLogicalIndex;
                    if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > nextLogicalIndex) {
                        nextOriginalIndex = playingState.shufflePlaybackOrder[nextLogicalIndex];
                    }
                    if (nextOriginalIndex >= 0 && nextOriginalIndex < playingState.originalPlaylistItems.length) {
                        nextPlaylistItemName = playingState.originalPlaylistItems[nextOriginalIndex]?.name || `Item ${nextOriginalIndex + 1}`;
                    }
                } else if (mainCueFromState.loop) { // Reached end, will loop
                    let nextOriginalIndex = 0; // Loops to first item in logical order
                    if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) {
                         // If shuffle is on, next after loop is the first item in the *current* shuffleOrder (index 0 of shuffleOrder maps to an original index)
                        nextOriginalIndex = playingState.shufflePlaybackOrder[0];
                    }
                     if (nextOriginalIndex >= 0 && nextOriginalIndex < playingState.originalPlaylistItems.length) {
                        nextPlaylistItemName = playingState.originalPlaylistItems[nextOriginalIndex]?.name || `Item ${nextOriginalIndex + 1}`;
                    }
                }
            }
        }


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
            isCued: playingState.isCued || false, // isCued should reflect the explicit cued state
            itemBaseDuration: itemBaseDuration,
            currentPlaylistItemName: currentPlaylistItemName,
            nextPlaylistItemName: nextPlaylistItemName
        };
    } else if (playingState) { // Sound is null, but playingState exists (e.g. cued playlist)
        console.log(`[AudioPlaybackManager getPlaybackState DEBUG - Sound NULL] CueID: ${cueId}, isPaused: ${playingState.isPaused}, isCued: ${playingState.isCued}, isCuedNext: ${playingState.isCuedNext}`);
        const mainCueFromState = playingState.cue;

        // PRIORITIZE THIS CHECK: For a playlist that is explicitly paused AND cued (e.g., "stop_and_cue_next" mode after item finishes)
        if (mainCueFromState && mainCueFromState.type === 'playlist' && 
            playingState.isPaused && (playingState.isCuedNext || playingState.isCued)) {
            
            let nextItemName = null;
            let nextItemDuration = 0;
            if (playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 0) {
                let nextLogicalIdx = playingState.currentPlaylistItemIndex; // This index IS the cued item
                let nextOriginalIdx = nextLogicalIdx;
                if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > nextLogicalIdx) {
                    nextOriginalIdx = playingState.shufflePlaybackOrder[nextLogicalIdx];
                }
                if (nextOriginalIdx >= 0 && nextOriginalIdx < playingState.originalPlaylistItems.length) {
                    const nextItem = playingState.originalPlaylistItems[nextOriginalIdx];
                    nextItemName = nextItem?.name || `Item ${nextOriginalIdx + 1}`;
                    nextItemDuration = nextItem?.knownDuration || 0;
                }
            }
            return {
                isPlaying: false,
                isPaused: true, // CRITICAL: This cue is paused and waiting
                isPlaylist: true,
                volume: mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0,
                currentTime: 0,
                currentTimeFormatted: '00:00',
                duration: nextItemDuration, 
                durationFormatted: formatTimeMMSSRef ? formatTimeMMSSRef(nextItemDuration) : '00:00',
                isFadingIn: false, isFadingOut: false, isDucked: false, activeDuckingTriggerId: null,
                isCuedNext: playingState.isCuedNext || false,
                isCued: playingState.isCued || true, // Ensure isCued is true as it's a cued state
                itemBaseDuration: nextItemDuration,
                currentPlaylistItemName: null, 
                nextPlaylistItemName: nextItemName
            };
        } 
        // FALLBACK CHECK: For other cases where sound is null but playingState exists 
        // (e.g., a playlist that's generally idle but has some state, not specifically paused+cued)
        else if (mainCueFromState && mainCueFromState.type === 'playlist' && mainCueFromState.playlistItems && mainCueFromState.playlistItems.length > 0) {
            const firstItemName = mainCueFromState.playlistItems[0]?.name || `Item 1`;
            return {
                isPlaying: false,
                isPaused: false, // Generic idle playlist is not considered paused
                isPlaylist: true,
                volume: mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0,
                currentTime: 0, currentTimeFormatted: '00:00', duration: mainCueFromState.playlistItems[0]?.knownDuration || 0,
                durationFormatted: formatTimeMMSSRef ? formatTimeMMSSRef(mainCueFromState.playlistItems[0]?.knownDuration || 0) : '00:00',
                isFadingIn: false, isFadingOut: false, isDucked: false, activeDuckingTriggerId: null,
                isCuedNext: false, 
                isCued: false, 
                itemBaseDuration: mainCueFromState.playlistItems[0]?.knownDuration || 0,
                currentPlaylistItemName: null, nextPlaylistItemName: firstItemName
            };
        }
        // If it's not a playlist or doesn't fit the above conditions when sound is null
        return null;
    }
    // Default fallback if playingState does not exist (truly idle or error)
    return null;
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