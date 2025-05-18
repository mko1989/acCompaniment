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
let currentAppConfigRef; // Reference to the main app config from audioController

// State variables
let currentlyPlaying = {}; // cueId: { sound: Howl_instance, cue: cueData, isPaused: boolean, ... }
let playbackIntervals = {}; // For time updates
let pendingRestarts = {}; // For restart logic

function init(dependencies) {
    getGlobalCueByIdRef = dependencies.getGlobalCueById;
    getPlaybackTimesUtilRef = dependencies.getPlaybackTimesUtil;
    formatTimeMMSSRef = dependencies.formatTimeMMSS;
    createPlaybackInstanceRef = dependencies.createPlaybackInstance;
    sendPlaybackTimeUpdateRef = dependencies.sendPlaybackTimeUpdate;

    cueStoreRef = dependencies.cueStore;
    ipcBindingsRef = dependencies.ipcBindings;
    cueGridAPIRef = dependencies.cueGridAPI;
    sidebarsAPIRef = dependencies.sidebarsAPI;
    currentAppConfigRef = dependencies.currentAppConfig; // Store the reference

    // --- DEBUG LOG ---
    console.log(`AudioPlaybackManager: init - cueGridAPIRef type: ${typeof cueGridAPIRef}, sidebarsAPIRef type: ${typeof sidebarsAPIRef}`);
    console.log('AudioPlaybackManager initialized.');
}

// New function to set/update UI references after initial init
function setUIRefs(cgAPI, sbAPI) {
    cueGridAPIRef = cgAPI;
    sidebarsAPIRef = sbAPI;
    // --- DEBUG LOG ---
    console.log(`AudioPlaybackManager: setUIRefs called. cueGridAPIRef type: ${typeof cueGridAPIRef}, sidebarsAPIRef type: ${typeof sidebarsAPIRef}`);
    if (cueGridAPIRef) {
        console.log(`AudioPlaybackManager: setUIRefs - cueGridAPIRef.updateCueButtonTime type: ${typeof cueGridAPIRef.updateCueButtonTime}`);
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
            existingState.sound.play();
        } else if (existingState.isPlaylist) {
            console.warn('AudioPlaybackManager: Resuming playlist but sound object was missing. Restarting current item.');
            _playTargetItem(cueId, existingState.currentPlaylistItemIndex, true);
        }
        return;
    }

    if (existingState && !isResume) {
        console.warn(`AudioPlaybackManager: play() called for existing cue ${cueId} (not a resume). Forcing stop/restart.`);
        if (existingState.sound) {
            existingState.sound.stop();
        } else {
            delete currentlyPlaying[cueId];
        }
        setTimeout(() => {
            _initializeAndPlayNew(cue);
        }, 50);
        return;
    }
    
    if (isResume && (!existingState || !existingState.isPaused)) {
        console.warn(`AudioPlaybackManager: play(resume) called for ${cueId} but not in a resumable state. Playing fresh.`);
        if(existingState) {
            if(existingState.sound) existingState.sound.stop();
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

    if (cue.type === 'playlist') {
        if (!cue.playlistItems || cue.playlistItems.length === 0) {
            console.error('AudioPlaybackManager: Playlist cue has no items:', cueId);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'empty_playlist' } });
            return;
        }
        currentlyPlaying[cueId] = {
            sound: null, cue: cue, isPaused: false, isPlaylist: true,
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
        currentlyPlaying[cueId] = {
            sound: null, cue: cue, isPaused: false, isPlaylist: false
        };
        _playTargetItem(cueId, undefined, false);
    }
}

function _playTargetItem(cueId, playlistItemIndex, isResumeForSeekAndFade = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState) {
        console.error(`AudioPlaybackManager: No playing state found for cueId ${cueId} in _playTargetItem.`);
        return;
    }
    // --- DEBUG LOG ---
    console.log(`AudioPlaybackManager: _playTargetItem - cueGridAPIRef type: ${typeof cueGridAPIRef}, sidebarsAPIRef type: ${typeof sidebarsAPIRef}`);
    if (cueGridAPIRef) {
        console.log(`AudioPlaybackManager: _playTargetItem - cueGridAPIRef.updateCueButtonTime type: ${typeof cueGridAPIRef.updateCueButtonTime}`);
    }

    const mainCue = playingState.cue;
    let filePath;
    let currentItemName = mainCue.name;
    let actualItemIndexInOriginalList = playlistItemIndex;

    if (playingState.isPlaylist) {
        let playIndex = playlistItemIndex;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) {
            if (playlistItemIndex === undefined || playlistItemIndex < 0 || playlistItemIndex >= playingState.shufflePlaybackOrder.length) {
                console.error(`AudioPlaybackManager: Invalid shuffle order index ${playlistItemIndex} for cue ${cueId}.`);
                _handlePlaylistEnd(cueId, true);
                return;
            }
            actualItemIndexInOriginalList = playingState.shufflePlaybackOrder[playlistItemIndex];
            playIndex = actualItemIndexInOriginalList;
        } else {
            if (playlistItemIndex === undefined || playlistItemIndex < 0 || playlistItemIndex >= playingState.originalPlaylistItems.length) {
                console.error(`AudioPlaybackManager: Invalid playlistItemIndex ${playlistItemIndex} for cue ${cueId}.`);
                _handlePlaylistEnd(cueId, true);
                return;
            }
        }
        const item = playingState.originalPlaylistItems[playIndex]; 
        if (!item || !item.path) {
            console.error(`AudioPlaybackManager: Invalid playlist item at original index ${playIndex} for cue ${cueId}. Path: ${item ? item.path : 'undefined'}. Skipping.`);
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
        console.error(`AudioPlaybackManager: No filePath determined for cue ${cueId} (item: ${currentItemName}).`);
        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'resolved_no_file_path' } });
        if (playingState.isPlaylist) _handlePlaylistEnd(cueId, true);
        else delete currentlyPlaying[cueId];
        return;
    }

    if (playingState.sound && playingState.trimEndTimer) clearTimeout(playingState.trimEndTimer);
    playingState.trimEndTimer = null;
    if (playingState.timeUpdateInterval) clearInterval(playingState.timeUpdateInterval);
    playingState.timeUpdateInterval = null;
    if (playingState.sound) {
        playingState.sound.stop();
        playingState.sound.unload();
    }

    // Pass necessary refs to playbackInstanceHandler context
    const instanceHandlerContext = {
        currentlyPlaying, // Direct access to the state managed here
        playbackIntervals, // Direct access
        ipcBindings: ipcBindingsRef,
        cueGridAPI: cueGridAPIRef,
        sidebarsAPI: sidebarsAPIRef,
        sendPlaybackTimeUpdate: sendPlaybackTimeUpdateRef,
        _handlePlaylistEnd, // Local function
        _playTargetItem,    // Local function
        getGlobalCueById: getGlobalCueByIdRef, // Passed in ref
        cueStore: cueStoreRef // Pass cueStoreRef
    };
    
    playingState.sound = createPlaybackInstanceRef(
        filePath, cueId, mainCue, playingState, currentItemName, 
        actualItemIndexInOriginalList, isResumeForSeekAndFade, instanceHandlerContext
    );

    if (!playingState.sound) {
        console.error(`AudioPlaybackManager: Failed to create playback instance for ${filePath}.`);
        if (playingState.isPlaylist) {
            _handlePlaylistEnd(cueId, true);
        } else {
            delete currentlyPlaying[cueId];
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'playback_instance_creation_failed' } });
        }
    }
}

function _handlePlaylistEnd(cueId, errorOccurred = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist) {
        console.log(`AudioPlaybackManager: _handlePlaylistEnd called for ${cueId} but not a valid playlist state.`);
        return;
    }
    const mainCue = playingState.cue;
    console.log(`AudioPlaybackManager: Item ended in playlist ${cueId}. Error: ${errorOccurred}, Loop: ${mainCue.loop}, Mode: ${mainCue.playlistPlayMode}`);

    if (playingState.sound) {
        playingState.sound.unload();
        playingState.sound = null;
    }
    if (errorOccurred) {
        console.error(`AudioPlaybackManager: Error in playlist ${cueId}. Stopping.`);
        delete currentlyPlaying[cueId];
        if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
        if (ipcBindingsRef && typeof ipcBindingsRef.send === 'function') {
            ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'playlist_playback_error' } });
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
        } else {
            if (mainCue.loop) {
                if (mainCue.shuffle && listLen > 1) _generateShuffleOrder(cueId);
                playingState.currentPlaylistItemIndex = 0;
                cuedOK = true;
            } else {
                delete currentlyPlaying[cueId];
                if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, null);
                if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_ended_fully_no_loop_stop_mode' } });
                return;
            }
        }
        if (cuedOK) {
            playingState.isPaused = true; // Cued state
            playingState.isCuedNext = true; // Explicitly mark that it's cued for next
            let cuedOriginalIdx = playingState.currentPlaylistItemIndex;
            if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > playingState.currentPlaylistItemIndex) {
                cuedOriginalIdx = playingState.shufflePlaybackOrder[playingState.currentPlaylistItemIndex];
            }
            if (cuedOriginalIdx >= 0 && cuedOriginalIdx < listLen) {
                const item = playingState.originalPlaylistItems[cuedOriginalIdx];
                cuedName = item.name || item.path.split(/[\\\/]/).pop();
            }
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, `Next: ${cuedName || 'Item'}`, true);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_item_ended_cued_next', nextItem: cuedName } });
        }
        return;
    }

    playingState.currentPlaylistItemIndex++;
    const nextLogicalIdx = playingState.currentPlaylistItemIndex;
    const items = mainCue.shuffle && playingState.shufflePlaybackOrder ? playingState.shufflePlaybackOrder : playingState.originalPlaylistItems;
    const listLen = items.length;

    if (nextLogicalIdx < listLen) {
        playingState.isPaused = false;
        playingState.isCuedNext = false;
        setTimeout(() => _playTargetItem(cueId, nextLogicalIdx, false), 10);
    } else {
        if (mainCue.loop) {
            if (mainCue.shuffle && playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 1) _generateShuffleOrder(cueId);
            playingState.currentPlaylistItemIndex = 0;
            playingState.isPaused = false;
            playingState.isCuedNext = false;
            setTimeout(() => _playTargetItem(cueId, 0, false), 10);
        } else {
            delete currentlyPlaying[cueId];
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'playlist_ended_naturally_no_loop' } });
        }
    }
}

function stop(cueId, fromCompanion = false, useFade = false) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.sound) return;

    console.log(`AudioPlaybackManager: Stopping cue: ${cueId}, fromCompanion: ${fromCompanion}, useFade: ${useFade}`);
    playingState.isStopping = true;
    playingState.isPaused = false;
    playingState.isFadingOutToRestart = false;
    playingState.isCuedNext = false; // Clear cued next on stop

    if (pendingRestarts[cueId]) clearTimeout(pendingRestarts[cueId].timeoutId);
    
    const cue = playingState.cue || (cueStoreRef ? cueStoreRef.getCueById(cueId) : null);
    if (!cue) {
        console.error(`AudioPlaybackManager: Cue details not found for ${cueId} during stop.`);
        playingState.sound.stop(playingState.soundId);
        return;
    }

    const shouldFade = useFade && cue.fadeOutTime > 0 && playingState.sound.playing() && playingState.sound.volume() > 0;
    if (shouldFade) {
        const currentVolume = playingState.sound.volume();
        const fadeDuration = cue.fadeOutTime; 
        playingState.isFadingOut = true;
        playingState.sound.fade(currentVolume, 0, fadeDuration, playingState.soundId);
        setTimeout(() => {
            if (currentlyPlaying[cueId] && currentlyPlaying[cueId].isFadingOut) {
                if(currentlyPlaying[cueId].sound) currentlyPlaying[cueId].sound.stop(currentlyPlaying[cueId].soundId);
                currentlyPlaying[cueId].isFadingOut = false;
            }
        }, fadeDuration + 50);
    } else {
        playingState.sound.stop(playingState.soundId);
    }
}

function pause(cueId) {
    const current = currentlyPlaying[cueId];
    if (current && current.sound && current.sound.playing() && !current.isPaused) {
        console.log('AudioPlaybackManager: Pausing cue:', cueId);
        current.sound.pause(); // onpause event in handler updates current.isPaused
    }
}

function toggle(cue, fromCompanion = false, retriggerBehavior = 'restart') {
    if (!cue || !cue.id) {
        console.error('AudioPlaybackManager: Invalid cue object provided for toggle.');
        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cue ? cue.id : 'unknown', status: 'error', details: { details: 'invalid_cue_data_toggle' } });
        return;
    }
    const cueId = cue.id;
    const currentPlayingState = currentlyPlaying[cueId];
    console.log(`AudioPlaybackManager: toggle() for ${cueId}. Retrigger: ${retriggerBehavior}. Has state: ${!!currentPlayingState}`);

    if (currentPlayingState) {
        if (currentPlayingState.isPlaylist && currentPlayingState.isPaused && !currentPlayingState.sound && currentPlayingState.originalPlaylistItems && currentPlayingState.originalPlaylistItems.length > 0) {
            console.log(`AudioPlaybackManager: Toggle for cued playlist ${cueId}. Playing cued item.`);
             currentPlayingState.isCuedNext = false; // Clear cued next status before playing
            play(cue, true); 
            return;
        }
        currentPlayingState.isCuedNext = false; // Clear cued next if any other action is taken

        switch (retriggerBehavior) {
            case 'stop': stop(cueId, fromCompanion, false); break;
            case 'restart':
                if (currentPlayingState) {
                    console.log(`AudioPlaybackManager: Toggle/Restart - existing state for ${cueId}. Stopping old instance.`);
                    if (currentPlayingState.sound) {
                        currentPlayingState.sound.stop();
                        currentPlayingState.sound.unload();
                    }
                    delete currentlyPlaying[cueId];
                    if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                    if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { details: 'retriggered' } });
                } else {
                    console.log(`AudioPlaybackManager: Toggle/Restart - no existing state for ${cueId}. Will play new.`);
                }
                setTimeout(() => play(cue, false), 50);
                break;
            case 'fade_out_and_stop':
                if (!currentPlayingState.isStopping) stop(cueId, fromCompanion, true);
                break;
            case 'fade_stop_restart':
                if (currentPlayingState && currentPlayingState.sound && !currentPlayingState.isStopping) {
                    console.log(`AudioPlaybackManager: Toggle/FadeStopRestart - existing state for ${cueId}. Fading out old instance.`);
                    currentPlayingState.isFadingOutToRestart = true;
                    stop(cueId, fromCompanion, true);
                    const fadeTime = currentPlayingState.cue.fadeOutTime || (currentAppConfigRef ? currentAppConfigRef.defaultFadeOutTime : 0) || 0;
                    
                    setTimeout(() => {
                        console.log(`AudioPlaybackManager: Toggle/FadeStopRestart - timeout completed for ${cueId}. Calling play().`);
                        play(cue, false);
                    }, fadeTime + 100);
                } else if (currentPlayingState && !currentPlayingState.sound) {
                    console.log(`AudioPlaybackManager: Toggle/FadeStopRestart - existing state for ${cueId} but no sound. Deleting old, playing new.`);
                    delete currentlyPlaying[cueId];
                    if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                    if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { details: 'retriggered_no_sound' } });
                    setTimeout(() => play(cue, false), 50);
                } else if (!currentPlayingState) {
                    console.log(`AudioPlaybackManager: Toggle/FadeStopRestart - no existing state for ${cueId}. Playing new.`);
                    setTimeout(() => play(cue, false), 50);
                }
                break;
            case 'pause':
            case 'pause_resume':
                if (currentPlayingState.isPaused) play(cue, true);
                else if (currentPlayingState.sound && currentPlayingState.sound.playing()) pause(cueId);
                else {
                    if(currentPlayingState.sound) currentPlayingState.sound.stop();
                    delete currentlyPlaying[cueId];
                    setTimeout(() => play(cue, false), 50);
                }
                break;
            case 'do_nothing': break;
            default: // restart (also catches undefined retriggerBehavior if any)
                if (currentPlayingState) { 
                    console.log(`AudioPlaybackManager: Toggle/DefaultRestart - existing state for ${cueId}. Stopping old instance.`);
                    if (currentPlayingState.sound) {
                        currentPlayingState.sound.stop();
                        currentPlayingState.sound.unload();
                    }
                    delete currentlyPlaying[cueId]; 
                    if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                    if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { details: 'retriggered_default' } });
                } else {
                    console.log(`AudioPlaybackManager: Toggle/DefaultRestart - no existing state for ${cueId}. Will play new.`);
                }
                setTimeout(() => play(cue, false), 50);
                break;
        }
    } else {
        play(cue, false);
    }
}

function stopAll(options = {}) {
    console.log('AudioPlaybackManager: stopAll called with options:', options);
    const behavior = options.behavior || 'stop'; 
    const appCfg = currentAppConfigRef;

    const cueIdsToStop = Object.keys(currentlyPlaying);

    for (const cueId of cueIdsToStop) {
        if (currentlyPlaying.hasOwnProperty(cueId)) {
            const playingState = currentlyPlaying[cueId];
            if (playingState && playingState.sound) {
                playingState.isCuedNext = false;
                let soundIdToStop = playingState.soundId; // Capture for safety in async operations

                if (behavior === 'fade_out_and_stop') {
                    const cue = playingState.cue;
                    const fadeOutDuration = (cue.fadeOutTime !== undefined && cue.fadeOutTime > 0) 
                                            ? cue.fadeOutTime 
                                            : (appCfg.defaultFadeOutTime || 0);
                    if (fadeOutDuration > 0 && !playingState.isPaused && playingState.sound.playing(soundIdToStop)) {
                        console.log(`AudioPlaybackManager: Fading out ${cueId} over ${fadeOutDuration}ms then stopping.`);
                        playingState.isStopping = true;
                        // Ensure we stop the specific sound ID
                        playingState.sound.once('fade', (id) => {
                            if (id === soundIdToStop) {
                                if (playingState.sound) playingState.sound.stop(soundIdToStop);
                                console.log(`AudioPlaybackManager: Fade complete for ${cueId}, sound stopped.`);
                                if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                                if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'faded_out_all' } });
                                delete currentlyPlaying[cueId]; // Clean up after fade and stop
                            }
                        });
                        playingState.sound.fade(playingState.sound.volume(soundIdToStop), 0, fadeOutDuration, soundIdToStop);
                    } else {
                        console.log(`AudioPlaybackManager: Stopping ${cueId} immediately (no fade/not playing/paused).`);
                        playingState.sound.stop(soundIdToStop);
                        if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'stopped_all_no_fade' } });
                        delete currentlyPlaying[cueId]; // Clean up
                    }
                } else { // Default behavior 'stop'
                    console.log(`AudioPlaybackManager: Stopping ${cueId} immediately (default stopAll behavior).`);
                    playingState.sound.stop(soundIdToStop);
                    if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                    if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'stopped_all_direct' } });
                    delete currentlyPlaying[cueId]; // Clean up
                }
            } else if (playingState) {
                // No sound object, but entry exists. Clean it up.
                delete currentlyPlaying[cueId];
                 if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                 if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'stopped_all_no_sound_object' } });
            }
        }
    }
    
    // After attempting to stop all known sounds and update their UI,
    // call the global Howler.stop() to catch any untracked (ghost) sounds.
    console.log('AudioPlaybackManager: Calling global Howler.stop() as a final measure for stopAll.');
    if (typeof Howler !== 'undefined' && typeof Howler.stop === 'function') {
        Howler.stop();
    } else {
        console.warn('AudioPlaybackManager: Howler or Howler.stop() is not available to call globally.');
    }
}

// --- State Query Functions ---

function isPlaying(cueId) {
    const state = currentlyPlaying[cueId];
    if (!state) return false;
    if (state.isPlaylist) return !state.isPaused; // For playlist, active if not paused
    return !state.isPaused && state.sound && state.sound.playing();
}

function isPaused(cueId) {
    const playingState = currentlyPlaying[cueId];
    return !!(playingState && playingState.isPaused);
}

function isCued(cueId) {
    const state = currentlyPlaying[cueId];
    // Check isCuedNext explicitly
    return !!(state && state.isPlaylist && state.isPaused && state.isCuedNext && !state.sound && state.originalPlaylistItems && state.originalPlaylistItems.length > 0);
}

function getCurrentlyPlayingPlaylistItemName(cueId) {
    const current = currentlyPlaying[cueId];
    if (current && current.isPlaylist && current.sound && current.sound.playing() && !current.isPaused) {
        let itemDetailName = 'Unknown Item';
        if (current.originalPlaylistItems && current.originalPlaylistItems.length > 0) {
            let actualItemIndex = current.currentPlaylistItemIndex;
            if (current.cue.shuffle && current.shufflePlaybackOrder && current.shufflePlaybackOrder.length > current.currentPlaylistItemIndex) {
                actualItemIndex = current.shufflePlaybackOrder[current.currentPlaylistItemIndex];
            }
            if (actualItemIndex >= 0 && actualItemIndex < current.originalPlaylistItems.length) {
                const item = current.originalPlaylistItems[actualItemIndex];
                itemDetailName = item.name || item.path.split(/[\\\/]/).pop();
            }
        }
        return itemDetailName;
    }
    return null;
}

function getNextPlaylistItemName(cueId) {
    const playingState = currentlyPlaying[cueId];
    const cue = playingState ? playingState.cue : (cueStoreRef ? cueStoreRef.getCueById(cueId) : null);

    if (!cue || cue.type !== 'playlist' || !cue.playlistItems || cue.playlistItems.length === 0) return null;

    let nextItemLogIdx = 0;
    const items = playingState ? playingState.originalPlaylistItems : cue.playlistItems;
    const numItems = items.length;

    if (playingState && !playingState.isPaused) {
        nextItemLogIdx = playingState.currentPlaylistItemIndex + 1;
        const order = (cue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length === numItems) 
                      ? playingState.shufflePlaybackOrder : items.map((_,i) => i);
        if (nextItemLogIdx >= numItems) {
            if (cue.loop) nextItemLogIdx = 0;
            else return null;
        }
        const actualOriginalIdx = order[nextItemLogIdx];
        if (actualOriginalIdx >= 0 && actualOriginalIdx < items.length) {
            const item = items[actualOriginalIdx];
            return item.name || item.path.split(/[\\\/]/).pop();
        }
        return null;
    } else {
        let currentEffectiveLogIdx = 0;
        if (playingState && playingState.isPaused) {
            currentEffectiveLogIdx = playingState.currentPlaylistItemIndex;
        }
        const order = (cue.shuffle && (playingState?.shufflePlaybackOrder?.length === numItems || items.length === numItems)) 
                      ? (playingState ? playingState.shufflePlaybackOrder : _generateTemporaryShuffleOrder(items)) 
                      : items.map((_,i) => i);
        if (currentEffectiveLogIdx >= 0 && currentEffectiveLogIdx < order.length) {
            const actualOriginalIdx = order[currentEffectiveLogIdx];
             if (actualOriginalIdx >= 0 && actualOriginalIdx < items.length) {
                const item = items[actualOriginalIdx];
                return item.name || item.path.split(/[\\\/]/).pop();
            }
        }
        const firstItem = items[0];
        return firstItem.name || firstItem.path.split(/[\\\/]/).pop();
    }
}

function getPlaybackTimes(cueToGetTimesFor) {
    const mainCue = cueToGetTimesFor;
    const playingState = currentlyPlaying[mainCue.id];

    let rawTimes;

    if (!mainCue) {
        console.warn('AudioPlaybackManager (getPlaybackTimes): mainCue is null or undefined.');
        rawTimes = getPlaybackTimesUtilRef(null, 0, null, null, null, null, false, formatTimeMMSSRef);
    } else if (playingState && playingState.sound) {
        console.log(`AudioPlaybackManager (getPlaybackTimes - ACTIVE branch): Cue ID: ${mainCue.id}, playingState.duration: ${playingState.duration}`); // LOG FOR ACTIVE
        let itemBaseDuration = 0;
        let playlistOriginalItems = null;
        let currentPlaylistItemLogicalIndex = null;
        let playlistShuffleOrder = null;
        
        if (mainCue.type === 'playlist') {
            playlistOriginalItems = playingState.originalPlaylistItems;
            currentPlaylistItemLogicalIndex = playingState.currentPlaylistItemIndex;
            playlistShuffleOrder = playingState.shufflePlaybackOrder;
            let actualItemIndex = currentPlaylistItemLogicalIndex;
            if (mainCue.shuffle && playlistShuffleOrder && playlistShuffleOrder.length > currentPlaylistItemLogicalIndex) {
                actualItemIndex = playlistShuffleOrder[currentPlaylistItemLogicalIndex];
            }
            // Ensure actualItemIndex is valid before accessing playlistOriginalItems
            if (playlistOriginalItems && actualItemIndex >= 0 && actualItemIndex < playlistOriginalItems.length) {
                itemBaseDuration = playlistOriginalItems[actualItemIndex]?.knownDuration || 0;
            } else if (playlistOriginalItems && playlistOriginalItems.length > 0) {
                 // Fallback if actualItemIndex is out of bounds (e.g. empty shuffle order, index mismatch)
                itemBaseDuration = playlistOriginalItems[0]?.knownDuration || 0;
            } else {
                itemBaseDuration = 0; // No items or invalid index
            }
        } else {
            itemBaseDuration = mainCue.knownDuration || 0;
        }
        rawTimes = getPlaybackTimesUtilRef(
            playingState.sound, itemBaseDuration, playlistOriginalItems, currentPlaylistItemLogicalIndex, 
            mainCue, playlistShuffleOrder, playingState.isCuedNext || false
        );
    } else { // Idle state or cue just stopped (no active sound object in playingState)
        console.log(`AudioPlaybackManager (getPlaybackTimes - IDLE branch entry): Cue ID: ${mainCue.id}, Type: ${mainCue.type}`); // LOG FOR IDLE ENTRY
        let itemBaseDuration = 0;
        let playlistOriginalItems = null;
        // For idle, currentPlaylistItemLogicalIndex usually refers to the *next* item to be played.
        // If a playingState exists (e.g., cue just stopped), use its index. Otherwise, default to 0.
        let currentPlaylistItemLogicalIndex = (playingState && playingState.currentPlaylistItemIndex !== undefined) ? playingState.currentPlaylistItemIndex : 0;
        let playlistShuffleOrder = (playingState && playingState.shufflePlaybackOrder) ? playingState.shufflePlaybackOrder : null;
        let isCuedNextState = (playingState && playingState.isCuedNext) ? playingState.isCuedNext : false;

        if (mainCue.type === 'playlist') {
            playlistOriginalItems = mainCue.playlistItems; 
            if (!playlistOriginalItems || playlistOriginalItems.length === 0) {
                itemBaseDuration = 0; 
            } else {
                 // If no playingState (completely idle) and shuffle is on, generate a temporary shuffle order
                if (!playingState && mainCue.shuffle) {
                    playlistShuffleOrder = _generateTemporaryShuffleOrder(playlistOriginalItems); 
                }

                let actualItemIndex = currentPlaylistItemLogicalIndex;
                if (mainCue.shuffle && playlistShuffleOrder && playlistShuffleOrder.length > currentPlaylistItemLogicalIndex) {
                     actualItemIndex = playlistShuffleOrder[currentPlaylistItemLogicalIndex];
                } else if (!mainCue.shuffle && currentPlaylistItemLogicalIndex >= playlistOriginalItems.length) {
                    // If not shuffle and index is out of bounds (e.g. playlist ended), default to first item.
                    actualItemIndex = 0;
                }


                if (actualItemIndex >= 0 && actualItemIndex < playlistOriginalItems.length) {
                    itemBaseDuration = playlistOriginalItems[actualItemIndex]?.knownDuration || 0;
                } else if (playlistOriginalItems.length > 0) { 
                     itemBaseDuration = playlistOriginalItems[0]?.knownDuration || 0; // Fallback
                } else {
                    itemBaseDuration = 0; // No items
                }
            }
            playlistShuffleOrder = mainCue.playlist?.shuffleOrder || null;
            currentPlaylistItemLogicalIndex = playingState?.currentPlaylistItemLogicalIndex ?? 0; // Default to 0 if no playingState
            isCuedNextState = playingState?.isCuedNext || false;
            console.log(`AudioPlaybackManager (getPlaybackTimes - IDLE playlist): Cue ID: ${mainCue.id}, calculated itemBaseDuration: ${itemBaseDuration}`);
        } else { // Single file cue
            itemBaseDuration = mainCue.knownDuration || 0;
            console.log(`AudioPlaybackManager (getPlaybackTimes - IDLE single cue): Cue ID: ${mainCue.id}, mainCue.knownDuration: ${mainCue.knownDuration}, SET itemBaseDuration: ${itemBaseDuration}`);
        }
        rawTimes = getPlaybackTimesUtilRef(
            null, // No sound object for idle state
            itemBaseDuration, 
            playlistOriginalItems, 
            currentPlaylistItemLogicalIndex,
            mainCue, 
            playlistShuffleOrder, 
            isCuedNextState
        );
    }

    if (!formatTimeMMSSRef) {
        console.error("AudioPlaybackManager: formatTimeMMSSRef is not initialized!");
        // Return raw times with placeholder formatted strings to prevent crashes
        return {
            ...rawTimes,
            currentTimeFormatted: '0:00.0',
            totalPlaylistDurationFormatted: '0:00.0',
            currentItemDurationFormatted: '0:00.0',
            currentItemRemainingTimeFormatted: '0:00.0'
        };
    }
    
    return {
        ...rawTimes,
        currentTimeFormatted: formatTimeMMSSRef(rawTimes.currentTime),
        totalPlaylistDurationFormatted: formatTimeMMSSRef(rawTimes.totalPlaylistDuration),
        currentItemDurationFormatted: formatTimeMMSSRef(rawTimes.currentItemDuration),
        currentItemRemainingTimeFormatted: formatTimeMMSSRef(rawTimes.currentItemRemainingTime)
    };
}

// --- Helper Functions (Internal to this module) ---

function _generateShuffleOrder(cueId) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.originalPlaylistItems || playingState.originalPlaylistItems.length <= 1) {
        playingState.shufflePlaybackOrder = playingState.originalPlaylistItems ? playingState.originalPlaylistItems.map((_, index) => index) : [];
        return;
    }
    const order = playingState.originalPlaylistItems.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    playingState.shufflePlaybackOrder = order;
    console.log(`AudioPlaybackManager: Shuffle order for ${cueId}:`, playingState.shufflePlaybackOrder);
}

function _generateTemporaryShuffleOrder(items) {
    if (!items || items.length <= 1) {
        return items ? items.map((_, index) => index) : [];
    }
    const order = items.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

export {
    init,
    setUIRefs,
    play,
    stop,
    pause,
    toggle,
    stopAll,
    isPlaying,
    isPaused,
    isCued,
    getCurrentlyPlayingPlaylistItemName,
    getNextPlaylistItemName,
    getPlaybackTimes
    // Not exporting _initializeAndPlayNew, _playTargetItem, _handlePlaylistEnd, _generateShuffleOrder, _generateTemporaryShuffleOrder
    // as they are internal helpers.
}; 