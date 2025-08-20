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
let audioControllerRef; // Reference to audioController for device switching

// State variables
let currentlyPlaying = {}; // cueId: { sound: Howl_instance, cue: cueData, isPaused: boolean, ... }
let playbackIntervals = {}; // For time updates
let pendingRestarts = {}; // For restart logic
let allSoundInstances = {}; // Maps unique sound IDs to sound instances for stop all functionality

// Current cue priority system for Companion variables
let cuePlayOrder = []; // Array of cueIds in order they were started (most recent first)
let lastCurrentCueId = null; // Track the last cue that was considered "current"

let publicAPIManagerInstance; // Defined at module level

// Enhanced logging utility for better performance and configurability
const LogLevel = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    VERBOSE: 5
};

// Configuration for logging levels - can be adjusted based on environment
let currentLogLevel = LogLevel.INFO; // Default to INFO level

// Set log level based on environment or configuration
function setLogLevel(level) {
    currentLogLevel = level;
    console.log(`AudioPlaybackManager: Log level set to ${Object.keys(LogLevel)[level]}`);
}

// Optimized logging functions that check level before processing
const log = {
    error: (...args) => {
        if (currentLogLevel >= LogLevel.ERROR) {
            console.error('🔴 AudioPlaybackManager:', ...args);
        }
    },
    warn: (...args) => {
        if (currentLogLevel >= LogLevel.WARN) {
            console.warn('🟡 AudioPlaybackManager:', ...args);
        }
    },
    info: (...args) => {
        if (currentLogLevel >= LogLevel.INFO) {
            console.log('🔵 AudioPlaybackManager:', ...args);
        }
    },
    debug: (...args) => {
        if (currentLogLevel >= LogLevel.DEBUG) {
            console.log('🟢 AudioPlaybackManager [DEBUG]:', ...args);
        }
    },
    verbose: (...args) => {
        if (currentLogLevel >= LogLevel.VERBOSE) {
            console.log('⚪ AudioPlaybackManager [VERBOSE]:', ...args);
        }
    }
};

// Initialize log level based on app configuration
function initializeLogging(appConfig) {
    if (appConfig && appConfig.logLevel !== undefined) {
        setLogLevel(appConfig.logLevel);
    } else if (appConfig && appConfig.isProduction) {
        setLogLevel(LogLevel.WARN); // Only warnings and errors in production
    } else {
        setLogLevel(LogLevel.INFO); // Default development level
    }
}

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
    audioControllerRef = dependencies.audioController; // Store the audioController reference

    // Initialize logging system
    const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
    initializeLogging(appConfig);

    log.info('Full init function executed');
}

// New function to set/update UI references after initial init
function setUIRefs(cgAPI, sbAPI) {
    cueGridAPIRef = cgAPI;
    sidebarsAPIRef = sbAPI;
    log.debug('UI references set');
}

// --- Ducking Logic ---
const DUCKING_FADE_DURATION = 1000; // 1 second for ducking fades

function _applyDucking(triggerCueId) {
    log.debug(`Applying ducking triggered by ${triggerCueId}`);
    const triggerCue = getGlobalCueByIdRef(triggerCueId);
    if (!triggerCue || !triggerCue.isDuckingTrigger) return;

    const duckingLevelPercentage = triggerCue.duckingLevel !== undefined ? triggerCue.duckingLevel : 80; // Default 80%
    const targetVolumeMultiplier = 1 - (duckingLevelPercentage / 100);

    for (const cueId in currentlyPlaying) {
        if (cueId === triggerCueId) continue; // Don't duck the trigger itself

        const playingState = currentlyPlaying[cueId];
        const affectedCue = getGlobalCueByIdRef(cueId); // Get full cue data

        if (affectedCue && affectedCue.enableDucking && playingState.sound && !playingState.isDucked) {
            log.debug(`Ducking cue ${cueId} to ${duckingLevelPercentage}% due to trigger ${triggerCueId}`);
            playingState.originalVolumeBeforeDuck = playingState.sound.volume(); // Store current volume
            playingState.isDucked = true;
            playingState.activeDuckingTriggerId = triggerCueId;
            // Fade to ducked volume
            playingState.sound.fade(playingState.originalVolumeBeforeDuck, playingState.originalVolume * targetVolumeMultiplier, DUCKING_FADE_DURATION);
        }
    }
}

function _revertDucking(triggerCueIdStop) {
    log.debug(`Reverting ducking for trigger ${triggerCueIdStop}`);
    for (const cueId in currentlyPlaying) {
        const playingState = currentlyPlaying[cueId];
        // Only revert if this specific trigger caused the ducking
        if (playingState.isDucked && playingState.activeDuckingTriggerId === triggerCueIdStop && playingState.sound) {
            log.debug(`Reverting duck for cue ${cueId} from trigger ${triggerCueIdStop}. Original volume: ${playingState.originalVolumeBeforeDuck}`);
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
                 _applyDucking(cueId);
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
            existingState.sound.stop(); // This should trigger onstop, which should handle _revertDucking if it was a trigger
        } else {
            delete currentlyPlaying[cueId]; // Should be cleaned up by onstop, but as a fallback
        }
        
        // Increased delay to ensure stop processing (including potential revertDucking) completes
        setTimeout(() => {
            _initializeAndPlayNew(cue);
        }, 150); // Increased from 50ms to 150ms for better state cleanup
        return;
    }
    
    if (isResume && (!existingState || !existingState.isPaused)) {
        log.warn(`play(resume) called for ${cueId} but not in a resumable state. Playing fresh`);
        if(existingState) {
            if(existingState.sound) existingState.sound.stop(); // Triggers onstop for cleanup
            delete currentlyPlaying[cueId];
        }
        _initializeAndPlayNew(cue);
        return;
    }
    _initializeAndPlayNew(cue);
}

function _initializeAndPlayNew(cue, allowMultipleInstances = false) {
    const cueId = cue.id;
    log.debug(`_initializeAndPlayNew for ${cueId}, allowMultipleInstances: ${allowMultipleInstances}`);

    // Enhanced cleanup using the new utility function (skip for multiple instances)
    if (currentlyPlaying[cueId] && !allowMultipleInstances) {
        log.warn(`Lingering state for ${cueId} found. Performing comprehensive cleanup`);
        _cleanupSoundInstance(cueId, currentlyPlaying[cueId], { 
            forceUnload: true, 
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
        _proceedWithPlayback(cueId, independentPlayingState, cueToUse.filePath, cueToUse.name, undefined, false);
        return;
    }

    if (cueToUse.type === 'playlist') {
        log.verbose(`Received playlist cue ${cueId}. Items: ${cueToUse.playlistItems?.length || 0}`);
        if (!cueToUse.playlistItems || cueToUse.playlistItems.length === 0) {
            log.error(`Playlist cue has no items: ${cueId}`);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'empty_playlist' } });
            return;
        }
        currentlyPlaying[cueId] = {
            ...initialPlayingState,
            playlistItems: cueToUse.playlistItems, 
            currentPlaylistItemIndex: 0,
            originalPlaylistItems: cueToUse.playlistItems.slice(),
            shufflePlaybackOrder: []
        };
        if (cueToUse.shuffle && currentlyPlaying[cueId].originalPlaylistItems.length > 1) {
            _generateShuffleOrder(cueId);
            _playTargetItem(cueId, 0, false);
        } else {
            _playTargetItem(cueId, 0, false);
        }
    } else {
        if (!cueToUse.filePath) {
            log.error(`No file path for single cue: ${cueId}`);
            if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'no_file_path' } });
            return;
        }
        currentlyPlaying[cueId] = initialPlayingState;
        _playTargetItem(cueId, undefined, false);
    }
    
    // Add to play order for current cue tracking
    _addToPlayOrder(cueId);
}

function _playTargetItem(cueId, playlistItemIndex, isResumeForSeekAndFade = false) {
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
                _handlePlaylistEnd(cueId, true);
                return;
            }
            playIndexToUseFromOriginalItems = playingState.shufflePlaybackOrder[playlistItemIndex];
        }

        if (playIndexToUseFromOriginalItems === undefined || playIndexToUseFromOriginalItems < 0 || playIndexToUseFromOriginalItems >= playingState.originalPlaylistItems.length) {
            log.error(`Invalid original item index ${playIndexToUseFromOriginalItems} for cue ${cueId}. Original playlist length: ${playingState.originalPlaylistItems.length}`);
                _handlePlaylistEnd(cueId, true);
                return;
        }
        
        const playlistItem = playingState.originalPlaylistItems[playIndexToUseFromOriginalItems];
        if (!playlistItem) {
            log.error(`Playlist item not found at index ${playIndexToUseFromOriginalItems} for cue ${cueId}`);
            _handlePlaylistEnd(cueId, true);
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
        _handleFilePathError(cueId, playingState, 'no_file_path', null);
        return;
    }

    // Validate file path format
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        log.error(`Invalid filePath format for cue ${cueId}: ${filePath}`);
        _handleFilePathError(cueId, playingState, 'invalid_file_path', filePath);
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
                    _handleFilePathError(cueId, playingState, 'file_not_found', filePath);
                    return;
                }
                // File exists, proceed with playback
                _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade);
            })
            .catch((error) => {
                log.warn(`Unable to check file existence for ${filePath}, proceeding anyway:`, error);
                // Proceed with playback even if we can't check existence
                _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade);
            });
    } else {
        // If we can't check file existence, proceed with playback
        _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade);
    }
}

// Helper function to handle file path errors
function _handleFilePathError(cueId, playingState, errorType, filePath) {
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
            _handlePlaylistEnd(cueId, true); 
        } else {
            if (currentlyPlaying[cueId]) {
            _cleanupSoundInstance(cueId, currentlyPlaying[cueId], {
                forceUnload: true,
                source: 'file_path_error'
            });
        }
        if (cueGridAPIRef) {
            cueGridAPIRef.updateButtonPlayingState(cueId, false, null, false, true); 
        }
    }
}

// Helper function to proceed with playback after validation
function _proceedWithPlayback(cueId, playingState, filePath, currentItemName, actualItemIndexInOriginalList, isResumeForSeekAndFade) {
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
        playingState.sound.stop();
        playingState.sound.unload();
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
            _handlePlaylistEnd, 
            _playTargetItem,    
            getGlobalCueById: getGlobalCueByIdRef, 
            _applyDucking, 
            _revertDucking,
            _cleanupSoundInstance, // Add the cleanup utility to the context
            getAppConfigFunc: getAppConfigFuncRef, // Add app config function for performance optimizations
            _updateCurrentCueForCompanion, // Add current cue priority function
            audioControllerRef: audioControllerRef, // Add audioController reference for device switching
            allSoundInstances: allSoundInstances // Add sound instance tracking for stop all
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
            _handleFilePathError(cueId, playingState, 'sound_creation_failed', filePath);
            return;
        }

        log.debug(`Successfully created sound instance for ${cueId}`);
        
    } catch (error) {
        log.error(`Exception during playback setup for ${cueId}:`, error);
        _handleFilePathError(cueId, playingState, 'playback_setup_exception', filePath);
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

    // Enhanced cleanup for the ended item
    if (playingState.sound) {
        console.log(`AudioPlaybackManager: Cleaning up sound for ended playlist item in ${cueId}`);
        try {
            if (playingState.sound.playing()) {
                playingState.sound.stop();
            }
        playingState.sound.unload();
        } catch (error) {
            console.warn(`_handlePlaylistEnd: Error during sound cleanup for ${cueId}:`, error);
        }
        playingState.sound = null;
    }

    // Clear any timers for the ended item
    if (playingState.trimEndTimer) {
        clearTimeout(playingState.trimEndTimer);
        playingState.trimEndTimer = null;
    }

    if (errorOccurred) {
        console.error(`AudioPlaybackManager: Error in playlist ${cueId}. Stopping playlist.`);
        // Use comprehensive cleanup for error cases
        _cleanupSoundInstance(cueId, playingState, { 
            forceUnload: true, 
            source: '_handlePlaylistEnd_error' 
        });
        
        if (ipcBindingsRef && typeof ipcBindingsRef.send === 'function') {
            ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'error', details: { details: 'playlist_playback_error' } });
        }
        return;
    }

    // If configured to repeat the current item, stop and cue the SAME item (do not loop-play it)
    if (mainCue.repeatOne) {
        const sameLogicalIdx = playingState.currentPlaylistItemIndex;
        playingState.isPaused = true; // Explicitly paused
        playingState.isCuedNext = true; // Mark that next trigger should play this item again
        playingState.isCued = true; // General cued flag
        playingState.sound = null; // Clear sound instance

        // If this playlist was a ducking trigger, revert ducking now that it ended and is cued
        const playlistCueDataRepeatOne = getGlobalCueByIdRef(cueId);
        if (playlistCueDataRepeatOne && playlistCueDataRepeatOne.isDuckingTrigger) {
            console.log(`AudioPlaybackManager: Playlist trigger ${cueId} (repeat_one mode) ended and is cued. Reverting ducking.`);
            _revertDucking(cueId);
        }

        // Determine the original index and name of the cued (same) item
        const listLenRepeat = playingState.originalPlaylistItems.length;
        let cuedOriginalIdxRepeat = sameLogicalIdx;
        if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > sameLogicalIdx) {
            cuedOriginalIdxRepeat = playingState.shufflePlaybackOrder[sameLogicalIdx];
        }
        let cuedNameRepeat = null;
        if (cuedOriginalIdxRepeat >= 0 && cuedOriginalIdxRepeat < listLenRepeat) {
            const itemRepeat = playingState.originalPlaylistItems[cuedOriginalIdxRepeat];
            cuedNameRepeat = itemRepeat.name || itemRepeat.path.split(/[\\\/]/).pop();
        }

        // Update UI to indicate it's cued to the same item
        if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false, `Next: ${cuedNameRepeat || 'Item'}`, true);
        if (ipcBindingsRef) ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'cued_next', details: { reason: 'repeat_one_cued_same_item', nextItem: cuedNameRepeat } });

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
            // Remove from play order and update current cue
            _removeFromPlayOrder(cueId);
            _updateCurrentCueForCompanion();
            
            if (cueGridAPIRef) cueGridAPIRef.updateButtonPlayingState(cueId, false);
            // Clear playlist highlighting in properties sidebar
            if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
                sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, null);
            }
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
            _revertDucking(cueId);
        }
        // Clean up any lingering state if no sound
        if (playingState) {
            delete currentlyPlaying[cueId];
            // Remove from play order and update current cue
            _removeFromPlayOrder(cueId);
            _updateCurrentCueForCompanion();
            
            // Clear playlist highlighting
            if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
                sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, null);
            }
            
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

// Current cue priority management functions
function _addToPlayOrder(cueId) {
    // Remove cueId if it already exists in the array
    cuePlayOrder = cuePlayOrder.filter(id => id !== cueId);
    // Add to the beginning (most recent)
    cuePlayOrder.unshift(cueId);
    console.log(`AudioPlaybackManager: Updated play order - current: ${cueId}, order: [${cuePlayOrder.join(', ')}]`);
}

function _removeFromPlayOrder(cueId) {
    cuePlayOrder = cuePlayOrder.filter(id => id !== cueId);
    console.log(`AudioPlaybackManager: Removed ${cueId} from play order - remaining: [${cuePlayOrder.join(', ')}]`);
}

function _getCurrentPriorityCue() {
    // Find the first cue in play order that is actually still playing
    for (const cueId of cuePlayOrder) {
        const playingState = currentlyPlaying[cueId];
        if (playingState && playingState.sound && (playingState.sound.playing() || playingState.isPaused)) {
            return cueId;
        }
    }
    return null;
}

function _updateCurrentCueForCompanion() {
    const newCurrentCueId = _getCurrentPriorityCue();
    
    if (newCurrentCueId !== lastCurrentCueId) {
        console.log(`AudioPlaybackManager: Current cue changed from ${lastCurrentCueId} to ${newCurrentCueId}`);
        lastCurrentCueId = newCurrentCueId;
        
        // Send current cue update to companion
        if (sendPlaybackTimeUpdateRef && newCurrentCueId) {
            const playingState = currentlyPlaying[newCurrentCueId];
            if (playingState && playingState.sound) {
                const currentItemName = playingState.isPlaylist ? 
                    playingState.originalPlaylistItems[playingState.currentPlaylistItemIndex]?.name || null : 
                    null;
                
                // Send special update with "current_cue" prefix for companion variables
                sendPlaybackTimeUpdateRef(
                    `current_cue_${newCurrentCueId}`, 
                    playingState.sound, 
                    playingState, 
                    currentItemName, 
                    playingState.sound.playing() ? 'playing' : 'paused'
                );
            }
        }
    }
}

// Enhanced memory management utility
function _cleanupSoundInstance(cueId, state, options = {}) {
    const { 
        forceUnload = false, 
        clearIntervals = true, 
        clearTimers = true,
        clearState = true,
        source = 'unknown'
    } = options;
    
    log.debug(`_cleanupSoundInstance for ${cueId}. Source: ${source}, forceUnload: ${forceUnload}`);
    
    if (!state) {
        log.warn(`_cleanupSoundInstance: No state provided for ${cueId}`);
        return;
    }
    
    // Clear intervals first to prevent memory leaks
    if (clearIntervals) {
        if (state.timeUpdateInterval) {
            clearInterval(state.timeUpdateInterval);
            state.timeUpdateInterval = null;
            log.verbose(`_cleanupSoundInstance: Cleared state interval for ${cueId}`);
        }
        
        if (playbackIntervals[cueId]) {
            clearInterval(playbackIntervals[cueId]);
            delete playbackIntervals[cueId];
            log.verbose(`_cleanupSoundInstance: Cleared global interval for ${cueId}`);
        }
    }
    
    // Clear timers
    if (clearTimers) {
        if (state.trimEndTimer) {
            clearTimeout(state.trimEndTimer);
            state.trimEndTimer = null;
            log.verbose(`_cleanupSoundInstance: Cleared trimEndTimer for ${cueId}`);
        }
        
        // Clear any pending restart operations
        if (pendingRestarts[cueId]) {
            clearTimeout(pendingRestarts[cueId]);
            delete pendingRestarts[cueId];
            log.verbose(`_cleanupSoundInstance: Cleared pending restart for ${cueId}`);
        }
    }
    
    // Handle sound instance cleanup
    if (state.sound) {
        const sound = state.sound;
        
        try {
            // Stop the sound if it's playing
            if (sound.playing()) {
                log.verbose(`_cleanupSoundInstance: Stopping playing sound for ${cueId}`);
                sound.stop();
            }
            
            // Always unload to free memory, unless explicitly prevented
            if (forceUnload || !sound.playing()) {
                log.verbose(`_cleanupSoundInstance: Unloading sound for ${cueId}`);
                sound.unload();
            }
            
        } catch (error) {
            log.error(`_cleanupSoundInstance: Error during sound cleanup for ${cueId}:`, error);
            
            // Force unload even if there was an error
            try {
                sound.unload();
            } catch (unloadError) {
                log.error(`_cleanupSoundInstance: Error during force unload for ${cueId}:`, unloadError);
            }
        }
        
        // Clear the sound reference
        state.sound = null;
    }
    
    // Clear fade-related state
    state.isFadingIn = false;
    state.isFadingOut = false;
    state.fadeTotalDurationMs = 0;
    state.fadeStartTime = 0;
    state.acIsStoppingWithFade = false;
    state.acStopSource = null;
    state.explicitStopReason = null;
    
    // Clear ducking state
    state.isDucked = false;
    state.activeDuckingTriggerId = null;
    state.originalVolumeBeforeDuck = null;
    
    // Clear the state from global tracking if requested
    if (clearState && currentlyPlaying[cueId] === state) {
        delete currentlyPlaying[cueId];
        // Remove from play order and update current cue
        _removeFromPlayOrder(cueId);
        _updateCurrentCueForCompanion();
        
        // Clear playlist highlighting
        if (sidebarsAPIRef && typeof sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar === 'function') {
            sidebarsAPIRef.highlightPlayingPlaylistItemInSidebar(cueId, null);
        }
        
        log.verbose(`_cleanupSoundInstance: Cleared global state for ${cueId}`);
    }
    
    log.debug(`_cleanupSoundInstance: Cleanup complete for ${cueId}`);
}

// Enhanced stopAll function with better memory management
function stopAllCues(options = { exceptCueId: null, useFade: true }) {
    console.log('AudioPlaybackManager: stopAllCues called. Options:', options);

    let useFadeForStop = options.useFade;

    if (options && options.behavior) {
        useFadeForStop = options.behavior === 'fade_out_and_stop';
        console.log(`AudioPlaybackManager: stopAllCues - behavior specified: '${options.behavior}', setting useFadeForStop to: ${useFadeForStop}`);
    } else if (options && options.useFade !== undefined) {
        useFadeForStop = options.useFade;
        console.log(`AudioPlaybackManager: stopAllCues - behavior NOT specified, using options.useFade: ${useFadeForStop}`);
    } else {
        useFadeForStop = true; 
        console.log(`AudioPlaybackManager: stopAllCues - behavior and options.useFade NOT specified, defaulting useFadeForStop to: ${useFadeForStop}`);
    }

    // Get all sound instances (both managed and independent) to stop
    const soundInstancesToStop = Object.keys(allSoundInstances).filter(soundId => {
        const instance = allSoundInstances[soundId];
        return !options.exceptCueId || instance.cueId !== options.exceptCueId;
    });

    console.log(`AudioPlaybackManager: stopAllCues - Stopping ${soundInstancesToStop.length} sound instances (managed + independent)`);
    
    // Stop all sound instances directly
    soundInstancesToStop.forEach(soundId => {
        const instance = allSoundInstances[soundId];
        if (instance && instance.sound) {
            const { sound, cueId, playingState } = instance;
            
            console.log(`[STOP_ALL_DEBUG] Stopping sound instance ${soundId} for cue ${cueId}. IsIndependent: ${playingState.isIndependentInstance}`);
            
            // Mark as stop_all for proper cleanup
            playingState.explicitStopReason = 'stop_all';
            if (sound) {
                sound.acExplicitStopReason = 'stop_all';
            }
            
            // Apply fade if requested
            if (useFadeForStop) {
                const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
                const fadeOutTime = appConfig.defaultStopAllFadeOutTime !== undefined ? appConfig.defaultStopAllFadeOutTime : 1500;
                
                if (fadeOutTime > 0) {
                    console.log(`[STOP_ALL_DEBUG] Applying ${fadeOutTime}ms fade to sound ${soundId}`);
                    // Only visualize fade if this is the active state and the sound is actually playing (audible)
                    const isActiveState = currentlyPlaying[cueId] && currentlyPlaying[cueId] === playingState;
                    const isAudible = typeof sound.playing === 'function' && sound.playing() && sound.volume() > 0.0001;
                    if (isActiveState && isAudible) {
                        // Mark fading state for UI
                        playingState.isFadingOut = true;
                        playingState.isFadingIn = false;
                        playingState.fadeTotalDurationMs = fadeOutTime;
                        playingState.fadeStartTime = Date.now();
                        // Prime UI update to reflect fade immediately
                        if (cueGridAPIRef && cueGridAPIRef.updateCueButtonTime) {
                            cueGridAPIRef.updateCueButtonTime(cueId, null, false, true, fadeOutTime);
                        }
                    }
                    sound.fade(sound.volume(), 0, fadeOutTime);
                    setTimeout(() => {
                        if (sound.playing()) {
                            sound.stop();
                        }
                    }, fadeOutTime + 50); // Small buffer
                } else {
                    sound.stop();
                }
            } else {
                sound.stop();
            }
        }
    });
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
        console.error(`AudioPlaybackManager: toggleCue() called for non-existent cue ${cueIdToToggle}`);
        return;
    }
    
    const playingState = currentlyPlaying[cueIdToToggle];
    const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
    const retriggerBehavior = retriggerBehaviorOverride || cue.retriggerBehavior || appConfig.defaultRetriggerBehavior || 'toggle_pause_play';
    
    console.log(`AudioPlaybackManager: Toggle for cue ${cueIdToToggle}. Retrigger behavior: ${retriggerBehavior}. fromCompanion: ${fromCompanion}`);
    
    if (playingState) {
        if (playingState.isPlaylist && playingState.isPaused && playingState.isCuedNext) {
            // Special case: This is a playlist that's cued to the next item. Resume from cued position.
            console.log(`AudioPlaybackManager: Toggle - Playlist ${cueIdToToggle} is cued to next item. Resuming from cued position.`);
            playingState.isPaused = false;
            playingState.isCuedNext = false;
            playingState.isCued = false;
            _playTargetItem(cueIdToToggle, playingState.currentPlaylistItemIndex, false);
        } else if (playingState.isPaused) {
            // Standard pause (not a cued playlist item) or other playlist modes: retrigger behavior applies
            console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} is PAUSED (or not a specifically cued playlist item). Applying retrigger: ${retriggerBehavior}`);
            switch (retriggerBehavior) {
                case 'restart':
                    // Clear any existing pending restart to prevent conflicts
                    if (pendingRestarts[cueIdToToggle]) {
                        clearTimeout(pendingRestarts[cueIdToToggle]);
                        delete pendingRestarts[cueIdToToggle];
                    }
                    
                    stop(cueIdToToggle, false, fromCompanion, true); // Stop immediately (isRetriggerStop=true)
                    // Increased delay for better state cleanup
                    pendingRestarts[cueIdToToggle] = setTimeout(() => { 
                        play(cue, false); 
                        delete pendingRestarts[cueIdToToggle];
                    }, 150); // Increased from 50ms to 150ms
                    break;
                case 'stop':
                    stop(cueIdToToggle, false, fromCompanion, true); // Stop immediately
                    break;
                case 'fade_out_and_stop':
                    stop(cueIdToToggle, true, fromCompanion, true); // Fade out and stop
                    break;
                case 'do_nothing':
                case 'do_nothing_if_playing':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} retrigger behavior is '${retriggerBehavior}'. No action taken.`);
                    break; // Do nothing
                case 'play_new_instance':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} starting new instance while current is paused.`);
                    // Create new instance without affecting existing state
                    _initializeAndPlayNew(cue, true);
                    break;
                case 'pause':
                case 'toggle_pause_play': // If paused, play
                default: // Default is resume
                    play(cue, true); // Resume
                    break;
            }
        } else {
            // Cue is playing
            console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} is PLAYING. Applying retrigger: ${retriggerBehavior}`);
            switch (retriggerBehavior) {
                case 'restart':
                    // Clear any existing pending restart to prevent conflicts
                    if (pendingRestarts[cueIdToToggle]) {
                        clearTimeout(pendingRestarts[cueIdToToggle]);
                        delete pendingRestarts[cueIdToToggle];
                    }
                    
                    stop(cueIdToToggle, false, fromCompanion, true); // Stop immediately
                    // Increased delay for better state cleanup
                    pendingRestarts[cueIdToToggle] = setTimeout(() => { 
                        play(cue, false); 
                        delete pendingRestarts[cueIdToToggle]; 
                    }, 150); // Increased from 50ms to 150ms
                    break;
                case 'stop':
                    stop(cueIdToToggle, false, fromCompanion, true);
                    break;
                case 'fade_out_and_stop':
                    stop(cueIdToToggle, true, fromCompanion, true);
                    break;
                case 'do_nothing':
                case 'do_nothing_if_playing':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} retrigger behavior is '${retriggerBehavior}'. No action taken.`);
                    break; // Do nothing
                case 'play_new_instance':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} starting new instance while current is playing.`);
                    // Create new instance without affecting existing state
                    _initializeAndPlayNew(cue, true);
                    break;
                case 'pause':
                case 'toggle_pause_play': // If playing, pause
                default: // Default is pause
                    pause(cueIdToToggle);
                    break;
            }
        }
    } else {
        // Cue is NOT currently playing
        console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} not currently playing. Starting fresh.`);
        
        // Clear any lingering pending restart before starting fresh
        if (pendingRestarts[cueIdToToggle]) {
            clearTimeout(pendingRestarts[cueIdToToggle]);
            delete pendingRestarts[cueIdToToggle];
        }
        
        play(cue, false); // Start fresh
    }
}


// Performance optimization: Pre-allocated objects to reduce garbage collection
const PERFORMANCE_CACHE = {
    // Reusable objects for getPlaybackState to reduce allocations
    playbackStateResponse: {
        isPlaying: false,
        isPaused: false,
        isPlaylist: false,
        volume: 1.0,
                currentTime: 0,
                currentTimeFormatted: '00:00',
        duration: 0,
        durationFormatted: '00:00',
        isFadingIn: false,
        isFadingOut: false,
        isDucked: false,
        activeDuckingTriggerId: null,
        isCuedNext: false,
        isCued: false,
        itemBaseDuration: 0,
                currentPlaylistItemName: null,
        nextPlaylistItemName: null
    },
    // Reusable time calculation cache
    timeCalculationCache: {
        currentTime: 0,
        duration: 0,
        totalPlaylistDuration: 0,
        currentItemDuration: 0,
        currentItemRemainingTime: 0,
        rawDuration: 0
    }
};

// Performance optimization: Throttle frequently called functions
const THROTTLE_CACHE = new Map();

function throttle(func, delay, key) {
    if (THROTTLE_CACHE.has(key)) {
        return THROTTLE_CACHE.get(key);
    }
    
    let timeoutId;
    let lastExecTime = 0;
    
    const throttledFunc = function(...args) {
        const currentTime = Date.now();
        
        if (currentTime - lastExecTime > delay) {
            lastExecTime = currentTime;
            return func.apply(this, args);
        } else {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                lastExecTime = Date.now();
                func.apply(this, args);
            }, delay - (currentTime - lastExecTime));
        }
    };
    
    THROTTLE_CACHE.set(key, throttledFunc);
    return throttledFunc;
}

// Performance-optimized version of getPlaybackState
function getPlaybackState(cueId) {
    const playingState = currentlyPlaying[cueId];
    if (!playingState) {
        return null;
    }

    const sound = playingState.sound;
    const mainCueFromState = playingState.cue;
    
    // Reuse the cached response object to reduce allocations
    const response = PERFORMANCE_CACHE.playbackStateResponse;
    
    if (sound && sound.playing && typeof sound.playing === 'function' && sound.playing()) {
        // Cache time calculations to avoid repeated calls
        const times = getPlaybackTimesUtilRef ? getPlaybackTimesUtilRef(
            sound, 
            playingState.duration, 
            playingState.originalPlaylistItems, 
            playingState.currentPlaylistItemIndex, 
            mainCueFromState,
            playingState.shufflePlaybackOrder,
            playingState.isCuedNext
        ) : PERFORMANCE_CACHE.timeCalculationCache;

        // Optimize duration calculations
        const itemBaseDuration = playingState.isPlaylist ? 
            (playingState.originalPlaylistItems && playingState.originalPlaylistItems[playingState.currentPlaylistItemIndex]?.knownDuration) || 0 :
            (mainCueFromState.knownDuration || 0);
        
        const displayDuration = playingState.isPlaylist ? times.totalPlaylistDuration : itemBaseDuration;
        
        // Optimize time formatting - only format when values change
        let currentTimeFormatted = '00:00';
        let durationFormatted = '00:00';
        
        if (formatTimeMMSSRef) {
            if (times.currentTime !== PERFORMANCE_CACHE.lastCurrentTime) {
                PERFORMANCE_CACHE.lastCurrentTime = times.currentTime;
                currentTimeFormatted = formatTimeMMSSRef(times.currentTime);
                PERFORMANCE_CACHE.lastCurrentTimeFormatted = currentTimeFormatted;
            } else {
                currentTimeFormatted = PERFORMANCE_CACHE.lastCurrentTimeFormatted;
            }
            
            if (displayDuration !== PERFORMANCE_CACHE.lastDuration) {
                PERFORMANCE_CACHE.lastDuration = displayDuration;
                durationFormatted = formatTimeMMSSRef(displayDuration);
                PERFORMANCE_CACHE.lastDurationFormatted = durationFormatted;
            } else {
                durationFormatted = PERFORMANCE_CACHE.lastDurationFormatted;
            }
        }

        // Get playlist item names efficiently
        let currentPlaylistItemName = null;
        let nextPlaylistItemName = null;
        
        if (playingState.isPlaylist) {
            // Get current item name - use shuffle order if shuffled
            const currentLogicalIndex = playingState.currentPlaylistItemIndex;
            let currentOriginalIndex = currentLogicalIndex;
            
            if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > currentLogicalIndex) {
                currentOriginalIndex = playingState.shufflePlaybackOrder[currentLogicalIndex];
            }
            
            if (currentOriginalIndex >= 0 && currentOriginalIndex < playingState.originalPlaylistItems.length) {
                const currentItem = playingState.originalPlaylistItems[currentOriginalIndex];
                currentPlaylistItemName = currentItem?.name || currentItem?.path?.split(/[\\\/]/).pop() || `Item ${currentOriginalIndex + 1}`;
            }
            
            // Calculate next item name - use shuffle order if shuffled
            let nextLogicalIndex = currentLogicalIndex + 1;
            let nextOriginalIndex = nextLogicalIndex;
            
            if (mainCueFromState.shuffle && playingState.shufflePlaybackOrder) {
                if (nextLogicalIndex < playingState.shufflePlaybackOrder.length) {
                    nextOriginalIndex = playingState.shufflePlaybackOrder[nextLogicalIndex];
                } else if (mainCueFromState.loop && playingState.shufflePlaybackOrder.length > 0) {
                    // Loop back to first item in shuffle order
                    nextOriginalIndex = playingState.shufflePlaybackOrder[0];
                } else {
                    nextOriginalIndex = -1; // No next item
                }
            } else {
                if (nextLogicalIndex >= playingState.originalPlaylistItems.length) {
                    if (mainCueFromState.loop) {
                        nextOriginalIndex = 0; // Loop back to first item
                    } else {
                        nextOriginalIndex = -1; // No next item
                    }
                }
            }
            
            if (nextOriginalIndex >= 0 && nextOriginalIndex < playingState.originalPlaylistItems.length) {
                const nextItem = playingState.originalPlaylistItems[nextOriginalIndex];
                nextPlaylistItemName = nextItem?.name || nextItem?.path?.split(/[\\\/]/).pop() || `Item ${nextOriginalIndex + 1}`;
            }
        }

        // Update response object properties (reusing same object)
        response.isPlaying = true;
        response.isPaused = playingState.isPaused;
        response.isPlaylist = mainCueFromState.type === 'playlist';
        response.volume = sound.volume();
        response.currentTime = times.currentTime;
        response.currentTimeFormatted = currentTimeFormatted;
        response.duration = displayDuration;
        response.durationFormatted = durationFormatted;
        response.isFadingIn = playingState.isFadingIn || false;
        response.isFadingOut = playingState.isFadingOut || false;
        response.isDucked = playingState.isDucked || false;
        response.activeDuckingTriggerId = playingState.activeDuckingTriggerId || null;
        response.isCuedNext = playingState.isCuedNext || false;
        response.isCued = playingState.isCued || false;
        response.itemBaseDuration = itemBaseDuration;
        response.currentPlaylistItemName = currentPlaylistItemName;
        response.nextPlaylistItemName = nextPlaylistItemName;
        
        return response;
    } else if (playingState) {
        // Handle non-playing states efficiently
        const mainCueFromState = playingState.cue;

        // For cued playlists, optimize the response
        if (mainCueFromState && mainCueFromState.type === 'playlist' && 
            playingState.isPaused && (playingState.isCuedNext || playingState.isCued)) {
            
            let nextItemName = null;
            let nextItemDuration = 0;
            
            // Optimize next item lookup
            if (playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 0) {
                const nextLogicalIdx = playingState.currentPlaylistItemIndex;
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
            
            // Update response object
            response.isPlaying = false;
            response.isPaused = true;
            response.isPlaylist = true;
            response.volume = mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0;
            response.currentTime = 0;
            response.currentTimeFormatted = '00:00';
            response.duration = nextItemDuration;
            response.durationFormatted = formatTimeMMSSRef ? formatTimeMMSSRef(nextItemDuration) : '00:00';
            response.isFadingIn = false;
            response.isFadingOut = false;
            response.isDucked = false;
            response.activeDuckingTriggerId = null;
            response.isCuedNext = playingState.isCuedNext || false;
            response.isCued = playingState.isCued || true;
            response.itemBaseDuration = nextItemDuration;
            response.currentPlaylistItemName = null;
            response.nextPlaylistItemName = nextItemName;
            
            return response;
        }
        
        // Handle other playlist states
        if (mainCueFromState && mainCueFromState.type === 'playlist' && mainCueFromState.playlistItems && mainCueFromState.playlistItems.length > 0) {
            const firstItemName = mainCueFromState.playlistItems[0]?.name || 'Item 1';
            const firstItemDuration = mainCueFromState.playlistItems[0]?.knownDuration || 0;
            
            response.isPlaying = false;
            response.isPaused = false;
            response.isPlaylist = true;
            response.volume = mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0;
            response.currentTime = 0;
            response.currentTimeFormatted = '00:00';
            response.duration = firstItemDuration;
            response.durationFormatted = formatTimeMMSSRef ? formatTimeMMSSRef(firstItemDuration) : '00:00';
            response.isFadingIn = false;
            response.isFadingOut = false;
            response.isDucked = false;
            response.activeDuckingTriggerId = null;
            response.isCuedNext = false;
            response.isCued = false;
            response.itemBaseDuration = firstItemDuration;
            response.currentPlaylistItemName = null;
            response.nextPlaylistItemName = firstItemName;
            
            return response;
        }
        
        // Handle other non-playing states (like paused single files)
        response.isPlaying = false;
        response.isPaused = playingState.isPaused;
        response.isPlaylist = false;
        response.volume = mainCueFromState.volume !== undefined ? mainCueFromState.volume : 1.0;
        response.currentTime = 0;
        response.currentTimeFormatted = '00:00';
        response.duration = mainCueFromState.knownDuration || 0;
        response.durationFormatted = formatTimeMMSSRef ? formatTimeMMSSRef(mainCueFromState.knownDuration || 0) : '00:00';
        response.isFadingIn = false;
        response.isFadingOut = false;
        response.isDucked = false;
        response.activeDuckingTriggerId = null;
        response.isCuedNext = false;
        response.isCued = false;
        response.itemBaseDuration = mainCueFromState.knownDuration || 0;
        response.currentPlaylistItemName = null;
        response.nextPlaylistItemName = null;
        
        return response;
    }
    
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

// Comprehensive cleanup for application shutdown or workspace changes
function cleanupAllResources(options = {}) {
    const { source = 'cleanupAllResources', forceUnload = true } = options;
    
    console.log(`AudioPlaybackManager: cleanupAllResources called. Source: ${source}`);
    
    // Get all active cues
    const activeCues = Object.keys(currentlyPlaying);
    console.log(`AudioPlaybackManager: Cleaning up ${activeCues.length} active cues`);
    
    // Clean up each active cue
    activeCues.forEach(cueId => {
        const state = currentlyPlaying[cueId];
        if (state) {
            console.log(`AudioPlaybackManager: Cleaning up cue ${cueId}`);
            _cleanupSoundInstance(cueId, state, { 
                forceUnload, 
                source: `${source}_cue_${cueId}` 
            });
        }
    });
    
    // Clear all pending restart operations
    Object.keys(pendingRestarts).forEach(cueId => {
        clearTimeout(pendingRestarts[cueId]);
        delete pendingRestarts[cueId];
        console.log(`AudioPlaybackManager: Cleared pending restart for ${cueId}`);
    });
    
    // Clear all remaining intervals (should be empty by now, but just in case)
    Object.keys(playbackIntervals).forEach(cueId => {
        clearInterval(playbackIntervals[cueId]);
        delete playbackIntervals[cueId];
        console.log(`AudioPlaybackManager: Cleared remaining interval for ${cueId}`);
    });
    
    // Clear state objects
    currentlyPlaying = {};
    playbackIntervals = {};
    pendingRestarts = {};
    allSoundInstances = {}; // Clear all sound instances tracking
    
    console.log(`AudioPlaybackManager: cleanupAllResources complete. ${activeCues.length} cues cleaned up.`);
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
    getCurrentlyPlayingInstances: () => currentlyPlaying, // Expose currently playing instances for device switching
    // Ducking functions are internal, triggered by playback events, not directly exposed in public API for audioController
    _cleanupSoundInstance, // Export the cleanup utility function
    cleanupAllResources, // Export the comprehensive cleanup function
    // Logging utilities
    setLogLevel,
    LogLevel,
    // Performance utilities
    throttle,
    clearPerformanceCache: () => {
        THROTTLE_CACHE.clear();
        // Reset cached response objects
        Object.keys(PERFORMANCE_CACHE.playbackStateResponse).forEach(key => {
            PERFORMANCE_CACHE.playbackStateResponse[key] = 
                typeof PERFORMANCE_CACHE.playbackStateResponse[key] === 'boolean' ? false :
                typeof PERFORMANCE_CACHE.playbackStateResponse[key] === 'number' ? 0 :
                typeof PERFORMANCE_CACHE.playbackStateResponse[key] === 'string' ? '' : null;
        });
        log.info('Performance cache cleared');
    }
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