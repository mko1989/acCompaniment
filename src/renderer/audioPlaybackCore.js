// Companion_soundboard/src/renderer/audioPlaybackCore.js
// Core playback functions for audio playback management

import { log } from './audioPlaybackLogger.js';
import { _applyDucking, _revertDucking } from './audioPlaybackDucking.js';
import { _generateShuffleOrder } from './audioPlaybackUtils.js';
import { _addToPlayOrder, _removeFromPlayOrder, _updateCurrentCueForCompanion, _cleanupSoundInstance } from './audioPlaybackStateManagement.js';
import { _handlePlaylistEnd } from './audioPlaybackPlaylistHandling.js';

// Core playback functions
export function play(cue, isResume = false, context) {
    const {
        currentlyPlaying,
        getGlobalCueByIdRef,
        ipcBindingsRef,
        cueGridAPIRef,
        _initializeAndPlayNew,
        _playTargetItem,
        _cleanupSoundInstance,
        pendingRestarts
    } = context;

    if (!cue || !cue.id) {
        log.error('Invalid cue object provided for play');
        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cue ? cue.id : 'unknown', status: 'error', details: { details: 'invalid_cue_data' } });
        return;
    }
    const cueId = cue.id;
    const existingState = currentlyPlaying[cueId];

    log.debug(`play() called for ${cueId}. isResume: ${isResume}. existingState: ${!!existingState}`);

    if (isResume && existingState && existingState.isPaused) {
        log.info(`Resuming paused cue: ${cueId}`);
        existingState.isPaused = false;
        if (existingState.sound) {
            // If ducked, ensure it resumes at ducked volume, otherwise original
            const targetVolume = existingState.isDucked ? 
                                (existingState.originalVolume * (1 - ((getGlobalCueByIdRef(existingState.activeDuckingTriggerId)?.duckingLevel || 80) / 100))) :
                                existingState.originalVolume;
            existingState.sound.volume(targetVolume); // Set volume before play if needed
            existingState.sound.play();

            // If this cue itself is a trigger, re-apply ducking to others.
            const fullCueData = getGlobalCueByIdRef(cueId);
            if (fullCueData && fullCueData.isDuckingTrigger) {
                 _applyDucking(cueId, currentlyPlaying, getGlobalCueByIdRef);
            }

            // CRITICAL FIX: Ensure UI is updated when resuming from pause
            if (cueGridAPIRef && cueGridAPIRef.updateButtonPlayingState) {
                console.log(`AudioPlaybackManager: Explicitly updating UI for resumed cue ${cueId}`);
                cueGridAPIRef.updateButtonPlayingState(cueId, true);
            }

        } else if (existingState.isPlaylist) {
            log.warn('Resuming playlist but sound object was missing. Restarting current item');
            _playTargetItem(cueId, existingState.currentPlaylistItemIndex, true);
        }
        return;
    }

    if (existingState && !isResume) {
        log.warn(`play() called for existing cue ${cueId} (not a resume). Forcing stop/restart`);
        
        // Clear any pending restart operations to prevent conflicts
        if (pendingRestarts[cueId]) {
            clearTimeout(pendingRestarts[cueId]);
            delete pendingRestarts[cueId];
        }
        
        if (existingState.sound) {
            existingState.sound.off(); // Remove event listeners to prevent ghost events
            existingState.sound.stop(); // This should trigger onstop, which should handle _revertDucking if it was a trigger
        } else {
            delete currentlyPlaying[cueId]; // Should be cleaned up by onstop, but as a fallback
        }
        
        // Increased delay to ensure stop processing (including potential revertDucking) completes
        setTimeout(() => {
            _initializeAndPlayNew(cue, false, context);
        }, 150); // Increased from 50ms to 150ms for better state cleanup
        return;
    }
    
    if (isResume && (!existingState || !existingState.isPaused)) {
        log.warn(`play(resume) called for ${cueId} but not in a resumable state. Playing fresh`);
        if(existingState) {
            if(existingState.sound) {
                existingState.sound.off(); // Remove event listeners to prevent ghost events
                existingState.sound.stop(); // Triggers onstop for cleanup
            }
            delete currentlyPlaying[cueId];
        }
        _initializeAndPlayNew(cue, false, context);
        return;
    }
    _initializeAndPlayNew(cue, false, context);
}

export function _initializeAndPlayNew(cue, allowMultipleInstances = false, context) {
    const {
        currentlyPlaying,
        getGlobalCueByIdRef,
        ipcBindingsRef,
        _playTargetItem,
        _addToPlayOrder
    } = context;

    const cueId = cue.id;
    log.debug(`_initializeAndPlayNew for ${cueId}, allowMultipleInstances: ${allowMultipleInstances}`);

    // Enhanced cleanup using the new utility function (skip for multiple instances)
    if (currentlyPlaying[cueId] && !allowMultipleInstances) {
        log.warn(`Lingering state for ${cueId} found. Performing comprehensive cleanup`);
        _cleanupSoundInstance(cueId, currentlyPlaying[cueId], { 
            forceUnload: false, 
            source: '_initializeAndPlayNew' 
        });
    }

    // Get the latest cue data from store to ensure we have current trim values
    const latestCue = getGlobalCueByIdRef ? getGlobalCueByIdRef(cueId) : cue;
    const cueToUse = latestCue || cue; // Fallback to original if store lookup fails
    
    const fadeInTime = cueToUse.fadeInTime || 0;
    const initialPlayingState = {
        sound: null, 
        cue: cueToUse, 
        isPaused: false, 
        isPlaylist: cueToUse.type === 'playlist',
        isFadingIn: fadeInTime > 0,
        isFadingOut: false,
        fadeTotalDurationMs: fadeInTime > 0 ? fadeInTime : 0,
        fadeStartTime: fadeInTime > 0 ? Date.now() : 0,
        originalVolume: cueToUse.volume !== undefined ? cueToUse.volume : 1.0,
        originalVolumeBeforeDuck: null, 
        isDucked: false,
        activeDuckingTriggerId: null,
        // Enhanced state tracking
        timeUpdateInterval: null,
        trimEndTimer: null,
        acIsStoppingWithFade: false,
        acStopSource: null,
        explicitStopReason: null
    };

    if (allowMultipleInstances) {
        // For multiple instance mode, create a sound directly without state management
        log.debug(`Creating independent sound instance for ${cueId} (multiple instances mode)`);
        if (!cueToUse.filePath) {
            log.error(`No file path for single cue: ${cueId}`);
            return;
        }
        
        // Create a minimal playing state for the instance handler
        const independentPlayingState = {
            ...initialPlayingState,
            cue: cueToUse,
            isIndependentInstance: true // Mark as independent
        };
        
        // Create sound instance directly without adding to currentlyPlaying
        _proceedWithPlayback(cueId, independentPlayingState, cueToUse.filePath, cueToUse.name, undefined, false, context);
        return;
    }

    if (cueToUse.type === 'playlist') {
        log.verbose(`Received playlist cue ${cueId}. Items: ${cueToUse.playlistItems?.length || 0}`);
        if (!cueToUse.playlistItems || cueToUse.playlistItems.length === 0) {
            log.error(`Playlist cue has no items: ${cueId}`);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'empty_playlist' } });
            return;
        }
        // Preserve any existing crossfade info when creating new playing state
        const existingCrossfadeInfo = currentlyPlaying[cueId]?.crossfadeInfo;
        currentlyPlaying[cueId] = {
            ...initialPlayingState,
            playlistItems: cueToUse.playlistItems, 
            currentPlaylistItemIndex: 0,
            originalPlaylistItems: cueToUse.playlistItems.slice(),
            shufflePlaybackOrder: [],
            ...(existingCrossfadeInfo && { crossfadeInfo: existingCrossfadeInfo })
        };
        if (cueToUse.shuffle && currentlyPlaying[cueId].originalPlaylistItems.length > 1) {
            _generateShuffleOrder(cueId, currentlyPlaying);
            _playTargetItem(cueId, 0, false, context);
        } else {
            _playTargetItem(cueId, 0, false, context);
        }
    } else {
        if (!cueToUse.filePath) {
            log.error(`No file path for single cue: ${cueId}`);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'no_file_path' } });
            return;
        }
        // Preserve any existing crossfade info when creating new playing state
        const existingCrossfadeInfo = currentlyPlaying[cueId]?.crossfadeInfo;
        currentlyPlaying[cueId] = {
            ...initialPlayingState,
            ...(existingCrossfadeInfo && { crossfadeInfo: existingCrossfadeInfo })
        };
        _playTargetItem(cueId, undefined, false, context);
    }
    
    // Add to play order for current cue tracking
    context.cuePlayOrder = _addToPlayOrder(cueId, context.cuePlayOrder);
}

export function _playTargetItem(cueId, playlistItemIndex, isResumeForSeekAndFade = false, context) {
    const {
        currentlyPlaying,
        getGlobalCueByIdRef,
        ipcBindingsRef,
        cueGridAPIRef,
        sidebarsAPIRef,
        createPlaybackInstanceRef,
        sendPlaybackTimeUpdateRef,
        getAppConfigFuncRef,
        audioControllerRef,
        allSoundInstances,
        _handlePlaylistEnd,
        _applyDucking,
        _revertDucking,
        _updateCurrentCueForCompanion
    } = context;

    const playingState = currentlyPlaying[cueId];
    if (!playingState) {
        log.error(`No playing state found for cueId ${cueId} in _playTargetItem`);
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
                log.error(`Invalid shuffle order index ${playlistItemIndex} for cue ${cueId}. Playlist length: ${playingState.shufflePlaybackOrder.length}`);
                _handlePlaylistEnd(cueId, true, context);
                return;
            }
            playIndexToUseFromOriginalItems = playingState.shufflePlaybackOrder[playlistItemIndex];
        }

        if (playIndexToUseFromOriginalItems === undefined || playIndexToUseFromOriginalItems < 0 || playIndexToUseFromOriginalItems >= playingState.originalPlaylistItems.length) {
            log.error(`Invalid original item index ${playIndexToUseFromOriginalItems} for cue ${cueId}. Original playlist length: ${playingState.originalPlaylistItems.length}`);
                _handlePlaylistEnd(cueId, true, context);
                return;
        }
        
        const playlistItem = playingState.originalPlaylistItems[playIndexToUseFromOriginalItems];
        if (!playlistItem) {
            log.error(`Playlist item not found at index ${playIndexToUseFromOriginalItems} for cue ${cueId}`);
            _handlePlaylistEnd(cueId, true, context);
            return;
        }
        
        // Debug playlist item structure
        log.debug(`[PLAYLIST_DEBUG ${cueId}] Playlist item at index ${playIndexToUseFromOriginalItems}:`, {
            id: playlistItem.id,
            name: playlistItem.name,
            path: playlistItem.path,
            filePath: playlistItem.filePath,
            knownDuration: playlistItem.knownDuration
        });
        
        // Playlist items store file path in 'path' field, not 'filePath'
        filePath = playlistItem.path || playlistItem.filePath; // Support both for backward compatibility
        currentItemName = playlistItem.name || playlistItem.path?.split(/[\\\/]/).pop() || `Item ${playIndexToUseFromOriginalItems + 1}`;
        actualItemIndexInOriginalList = playIndexToUseFromOriginalItems;
        playingState.currentPlaylistItemIndex = playlistItemIndex; 
    } else {
        filePath = mainCue.filePath;
        actualItemIndexInOriginalList = undefined; 
    }

    // Enhanced file path validation
    if (!filePath) {
        log.error(`No filePath determined for cue ${cueId} (item: ${currentItemName})`);
        _handleFilePathError(cueId, playingState, 'no_file_path', null, context);
        return;
    }

    // Validate file path format
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        log.error(`Invalid filePath format for cue ${cueId}: ${filePath}`);
        _handleFilePathError(cueId, playingState, 'invalid_file_path', filePath, context);
        return;
    }

    // Check for potentially problematic characters in file path
    const problematicChars = /[<>:"|?*\x00-\x1f]/;
    if (problematicChars.test(filePath)) {
        log.warn(`Potentially problematic characters in file path for cue ${cueId}: ${filePath}`);
        // Don't fail immediately, but log the warning
    }

    // Pre-validate file existence if possible
    if (typeof electronAPIForPreload !== 'undefined' && electronAPIForPreload.checkFileExists) {
        electronAPIForPreload.checkFileExists(filePath)
            .then((exists) => {
                if (!exists) {
                    log.error(`File does not exist: ${filePath}`);
                    _handleFilePathError(cueId, playingState, 'file_not_found', filePath, context);
                    return;
                }
                // File exists, proceed with playback
                _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade, context);
            })
            .catch((error) => {
                log.warn(`Unable to check file existence for ${filePath}, proceeding anyway:`, error);
                // Proceed with playback even if we can't check existence
                _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade, context);
            });
    } else {
        // If we can't check file existence, proceed with playback
        _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade, context);
    }
}

// Helper function to handle file path errors
function _handleFilePathError(cueId, playingState, errorType, filePath, context) {
    const {
        currentlyPlaying,
        ipcBindingsRef,
        cueGridAPIRef,
        _handlePlaylistEnd
    } = context;

    log.error(`File path error for cue ${cueId}: ${errorType}`);
    
    if (ipcBindingsRef) {
        ipcBindingsRef.send('cue-status-update', { 
            cueId: cueId, 
            status: 'error', 
            details: { 
                error: errorType,
                filePath: filePath,
                details: 'resolved_no_file_path_targetitem' 
            } 
        });
    }
        
        if (playingState.isPlaylist) {
            _handlePlaylistEnd(cueId, true, context); 
        } else {
            if (currentlyPlaying[cueId]) {
            _cleanupSoundInstance(cueId, currentlyPlaying[cueId], {
                forceUnload: false,
                source: 'file_path_error'
            }, context);
        }
        if (cueGridAPIRef) {
            cueGridAPIRef.updateButtonPlayingState(cueId, false, null, false, true); 
        }
    }
}

// Helper function to proceed with playback after validation
function _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade, context) {
    const {
        currentlyPlaying,
        playbackIntervals,
        ipcBindingsRef,
        cueGridAPIRef,
        sidebarsAPIRef,
        sendPlaybackTimeUpdateRef,
        getGlobalCueByIdRef,
        _handlePlaylistEnd,
        _playTargetItem,
        _applyDucking,
        _revertDucking,
        getAppConfigFuncRef,
        _updateCurrentCueForCompanion,
        audioControllerRef,
        allSoundInstances,
        createPlaybackInstanceRef,
        getPreloadedSound
    } = context;

    try {
        // Clear any existing timers and intervals
        if (playingState.trimEndTimer) {
            clearTimeout(playingState.trimEndTimer);
        playingState.trimEndTimer = null;
        }
        if (playingState.timeUpdateInterval) {
            clearInterval(playingState.timeUpdateInterval);
        playingState.timeUpdateInterval = null;
        }

        // Clean up existing sound instance
    if (playingState.sound) {
            try {
                const soundToCleanup = playingState.sound;
                soundToCleanup.off(); // Remove all event listeners to prevent ghost events
                soundToCleanup.stop();
                // Don't unload to allow reuse via preloading system
                // soundToCleanup.unload(); // Removed to allow sound reuse
            } catch (cleanupError) {
                log.warn(`Error cleaning up existing sound for ${cueId}:`, cleanupError);
            }
        playingState.sound = null; 
    }

                // Prepare context for instance handler
        const instanceHandlerContext = {
            currentlyPlaying, 
            playbackIntervals, 
            ipcBindings: ipcBindingsRef,
            cueGridAPI: cueGridAPIRef,
            sidebarsAPI: sidebarsAPIRef,
            sendPlaybackTimeUpdate: sendPlaybackTimeUpdateRef,
            sendPlaybackTimeUpdateRef: sendPlaybackTimeUpdateRef, // Add with correct key name for _handlePlaylistEnd
            _handlePlaylistEnd, 
            _playTargetItem,    
            getGlobalCueById: getGlobalCueByIdRef, 
            _applyDucking, 
            _revertDucking,
            _cleanupSoundInstance: _cleanupSoundInstance, // Add the cleanup utility to the context
            getAppConfigFunc: getAppConfigFuncRef, // Add app config function for performance optimizations
            _updateCurrentCueForCompanion, // Add current cue priority function
            audioControllerRef: audioControllerRef, // Add audioController reference for device switching
            allSoundInstances: allSoundInstances, // Add sound instance tracking for stop all
            getPreloadedSound: getPreloadedSound // Add preloaded sound accessor from context
        };
    
        log.debug(`Creating playback instance for ${cueId} with file: ${filePath}`);
        
        // Create the sound instance
        playingState.sound = createPlaybackInstanceRef(
        filePath, 
            cueId,
            playingState.cue,
        playingState, 
        currentItemName, 
        actualItemIndexInOriginalList, 
        isResumeForSeekAndFade,
        instanceHandlerContext
    );

        if (!playingState.sound) {
            log.error(`Failed to create sound instance for ${cueId}`);
            _handleFilePathError(cueId, playingState, 'sound_creation_failed', filePath, context);
            return;
        }

        log.debug(`Successfully created sound instance for ${cueId}`);
        
    } catch (error) {
        log.error(`Exception during playback setup for ${cueId}:`, error);
        _handleFilePathError(cueId, playingState, 'playback_setup_exception', filePath, context);
    }
}

export function stop(cueId, useFade = true, fromCompanion = false, isRetriggerStop = false, stopReason = null, context) {
    const {
        currentlyPlaying,
        getGlobalCueByIdRef,
        getAppConfigFuncRef,
        _revertDucking,
        _removeFromPlayOrder,
        _updateCurrentCueForCompanion,
        sidebarsAPIRef,
        cueGridAPIRef,
        ipcBindingsRef
    } = context;

    log.debug(`stop() called for cueId: ${cueId}, useFade: ${useFade}, fromCompanion: ${fromCompanion}, isRetriggerStop: ${isRetriggerStop}, stopReason: ${stopReason}`);
    const playingState = currentlyPlaying[cueId];

    if (playingState && playingState.sound) {
        const cue = getGlobalCueByIdRef(cueId); // Get full cue data for fade times etc.
        const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
        
        let fadeOutTime;
        if (stopReason === 'stop_all') {
            // For stop all, use the global stop all fade out time, not individual cue fade out times
            fadeOutTime = appConfig.defaultStopAllFadeOutTime !== undefined ? appConfig.defaultStopAllFadeOutTime : 1500;
            console.log(`AudioPlaybackManager: Using stop all fade out time: ${fadeOutTime}ms for cue ${cueId}`);
        } else {
            // For individual stops, use the cue's fade out time or default
            const defaultFadeOutTimeFromConfig = appConfig.defaultFadeOutTime !== undefined ? appConfig.defaultFadeOutTime : 0;
            fadeOutTime = (cue && cue.fadeOutTime !== undefined) ? cue.fadeOutTime : defaultFadeOutTimeFromConfig;
        }
        
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
            log.debug(`Fading out cue ${cueId} over ${fadeOutTime}ms from volume ${currentVolume}`);
            playingState.sound.fade(currentVolume, 0, fadeOutTime); // Howler's fade handles its own soundId
        } else {
            log.debug(`Stopping cue ${cueId} immediately`);
            // Note: We don't call .off() here because we want the onstop handler to fire for cleanup
            playingState.sound.stop(); // Howler's stop handles its own soundId
        }
        // Note: _revertDucking for trigger cues is now handled in the `onstop` event in playbackInstanceHandler.js
        // This ensures it happens *after* the sound has fully stopped, including after a fade.
    } else {
        log.warn(`stop() called for cueId ${cueId}, but no playing sound found`);
        // If it was a trigger and somehow state is inconsistent, try to revert ducking as a fallback.
        const fullCueData = getGlobalCueByIdRef(cueId);
        if (fullCueData && fullCueData.isDuckingTrigger) {
            log.warn(`Trigger cue ${cueId} stop called with no sound, attempting fallback revert ducking`);
            _revertDucking(cueId, currentlyPlaying);
        }
        // Clean up any lingering state if no sound
        if (playingState) {
            // For playlists in stop_and_cue_next mode, don't immediately delete state and update UI
            // as the playlist might need to transition to cued state
            const isStopAndCueNextPlaylist = playingState.isPlaylist && fullCueData && fullCueData.playlistPlayMode === 'stop_and_cue_next';
            
            if (!isStopAndCueNextPlaylist) {
                delete currentlyPlaying[cueId];
                // Remove from play order and update current cue
                context.cuePlayOrder = _removeFromPlayOrder(cueId, context.cuePlayOrder);
                context.lastCurrentCueId = _updateCurrentCueForCompanion(context.cuePlayOrder, currentlyPlaying, context.lastCurrentCueId, context.sendPlaybackTimeUpdateRef);
                
                // Clear playlist highlighting
                if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
                    sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, null);
                }
                
                 if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
                 if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'stopped', details: { reason: 'stop_called_no_sound' } });
            } else {
                // For stop_and_cue_next playlists, let _handlePlaylistEnd handle the state transition
                console.log(`AudioPlaybackManager: stop() called for stop_and_cue_next playlist ${cueId} with no sound. Preserving state for proper cued transition.`);
            }
        }
    }
}

export function pause(cueId, context) {
    const {
        currentlyPlaying,
        getGlobalCueByIdRef,
        _revertDucking,
        cueGridAPIRef,
        ipcBindingsRef
    } = context;

    const current = currentlyPlaying[cueId];
    if (current && current.sound && current.sound.playing() && !current.isPaused) {
        console.log('AudioPlaybackManager: Pausing cue:', cueId);
        current.sound.pause();
        current.isPaused = true; // Ensure isPaused state is accurately set

        // If this cue itself is a trigger and is being paused, revert ducking for others.
        const cueData = getGlobalCueByIdRef(cueId);
        if (cueData && cueData.isDuckingTrigger) {
            console.log(`AudioPlaybackManager: Paused cue ${cueId} is a ducking trigger. Reverting ducking.`);
            _revertDucking(cueId, currentlyPlaying);
        }

        // CRITICAL FIX: Ensure UI is updated even if onpause handler doesn't fire
        if (cueGridAPIRef && cueGridAPIRef.updateButtonPlayingState) {
            console.log(`AudioPlaybackManager: Explicitly updating UI for paused cue ${cueId}`);
            cueGridAPIRef.updateButtonPlayingState(cueId, false);
        }
        
        // Send IPC status update for paused state
        if (ipcBindingsRef && typeof ipcBindingsRef.send === 'function') {
            ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'paused', details: {} });
        }
    }
}
