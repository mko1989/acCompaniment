console.log('AudioPlaybackManager.js: TOP LEVEL EXECUTION START');

// Companion_soundboard/src/renderer/audioPlaybackManager.js
// Manages core audio playback logic, state, and interactions with Howler instances.

// Import extracted modules
import { LogLevel, setLogLevel, log, initializeLogging } from './audioPlaybackLogger.js';
import { _applyDucking, _revertDucking, DUCKING_FADE_DURATION } from './audioPlaybackDucking.js';
import { startPlaylistAtPosition, playlistNavigateNext, playlistNavigatePrevious, navigationBlocked, lastPlaylistPositions } from './audioPlaybackPlaylist.js';
import { handleCrossfadeToggle, _handleCrossfadeStart } from './audioPlaybackCrossfade.js';
import { PERFORMANCE_CACHE, THROTTLE_CACHE, throttle, _generateShuffleOrder, cleanupAllResources, clearPerformanceCache } from './audioPlaybackUtils.js';

// Import new extracted modules
import { play, stop, pause, _initializeAndPlayNew, _playTargetItem } from './audioPlaybackCore.js';
import { _handlePlaylistEnd } from './audioPlaybackPlaylistHandling.js';
import { toggleCue } from './audioPlaybackToggle.js';
import { _addToPlayOrder, _removeFromPlayOrder, _getCurrentPriorityCue, _updateCurrentCueForCompanion, _cleanupSoundInstance, getPlaybackState } from './audioPlaybackStateManagement.js';
import { seekInCue, stopAllCues } from './audioPlaybackUtilities.js';
import { clearTimeUpdateIntervals } from './playbackTimeManager.js';

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
let getPreloadedSoundRef; // Store the getPreloadedSound function

// State variables
let currentlyPlaying = {}; // cueId: { sound: Howl_instance, cue: cueData, isPaused: boolean, ... }
let playbackIntervals = {}; // For time updates
let pendingRestarts = {}; // For restart logic
let allSoundInstances = {}; // Maps unique sound IDs to sound instances for stop all functionality

// Current cue priority system for Companion variables
let cuePlayOrder = []; // Array of cueIds in order they were started (most recent first)
let lastCurrentCueId = null; // Track the last cue that was considered "current"

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
    audioControllerRef = dependencies.audioController; // Store the audioController reference
    getPreloadedSoundRef = dependencies.getPreloadedSound; // Store the getPreloadedSound function directly

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
// Ducking functions are now imported from audioPlaybackDucking.js


// --- Core Playback Functions ---
// Core playback functions are now imported from audioPlaybackCore.js

// _initializeAndPlayNew function is now imported from audioPlaybackCore.js

// _playTargetItem function is now imported from audioPlaybackCore.js

// Helper functions are now part of audioPlaybackCore.js

// _handlePlaylistEnd function is now imported from audioPlaybackPlaylistHandling.js

// stop and pause functions are now imported from audioPlaybackCore.js

// Current cue priority management functions are now imported from audioPlaybackStateManagement.js

// _cleanupSoundInstance function is now imported from audioPlaybackStateManagement.js

// --- Playlist Navigation Functions ---
// Playlist navigation functions are now imported from audioPlaybackPlaylist.js

// stopAllCues function is now imported from audioPlaybackUtilities.js

// seekInCue function is now imported from audioPlaybackUtilities.js


// toggleCue function is now imported from audioPlaybackToggle.js


// Performance optimization and utility functions are now imported from audioPlaybackUtils.js

// Throttle function is now imported from audioPlaybackUtils.js

// getPlaybackState function is now imported from audioPlaybackStateManagement.js


// _generateShuffleOrder function is now imported from audioPlaybackUtils.js

// cleanupAllResources function is now imported from audioPlaybackUtils.js


// Create context object for passing to extracted functions
function createContext() {
    return {
        currentlyPlaying,
        playbackIntervals,
        pendingRestarts,
        allSoundInstances,
        cuePlayOrder,
        lastCurrentCueId,
        getGlobalCueByIdRef,
        getPlaybackTimesUtilRef,
        formatTimeMMSSRef,
        createPlaybackInstanceRef,
        sendPlaybackTimeUpdateRef,
        cueStoreRef,
        ipcBindingsRef,
        cueGridAPIRef,
        sidebarsAPIRef,
        getAppConfigFuncRef,
        audioControllerRef,
        _generateShuffleOrder,
        startPlaylistAtPosition,
        _addToPlayOrder,
        _removeFromPlayOrder,
        _playTargetItem,
        _handlePlaylistEnd,
        _applyDucking: (triggerCueId) => _applyDucking(triggerCueId, currentlyPlaying, getGlobalCueByIdRef),
        _revertDucking: (triggerCueIdStop) => _revertDucking(triggerCueIdStop, currentlyPlaying),
        _cleanupSoundInstance: (cueId, state, options = {}) => _cleanupSoundInstance(cueId, state, options, createContext()),
        _updateCurrentCueForCompanion,
        getPreloadedSound: getPreloadedSoundRef,
        clearTimeUpdateIntervals
    };
}

publicAPIManagerInstance = {
    init,
    setUIRefs,
    playCue: (cue, isResume = false) => play(cue, isResume, createContext()),
    stopCue: (cueId, useFade = true, fromCompanion = false, isRetriggerStop = false, stopReason = null) => stop(cueId, useFade, fromCompanion, isRetriggerStop, stopReason, createContext()),
    pauseCue: (cueId) => pause(cueId, createContext()),
    toggleCue: (cueIdToToggle, fromCompanion = false, retriggerBehaviorOverride = null) => {
        const context = createContext();
        // Add the missing functions to the context
        context.play = (cue, isResume) => play(cue, isResume, context);
        context.stop = (cueId, useFade, fromCompanion, isRetriggerStop, stopReason) => stop(cueId, useFade, fromCompanion, isRetriggerStop, stopReason, context);
        context.pause = (cueId) => pause(cueId, context);
        context._initializeAndPlayNew = (cue, isResume) => _initializeAndPlayNew(cue, isResume, context);
        context._playTargetItem = (cueId, index, isResume) => _playTargetItem(cueId, index, isResume, context);
        return toggleCue(cueIdToToggle, fromCompanion, retriggerBehaviorOverride, context);
    },
    stopAllCues: (options = { exceptCueId: null, useFade: true }) => stopAllCues(options, createContext()),
    seekInCue: (cueId, positionSec) => seekInCue(cueId, positionSec, createContext()),
    getPlaybackState: (cueId) => getPlaybackState(cueId, createContext()),
    playlistNavigateNext: (cueId, fromExternal) => playlistNavigateNext(cueId, fromExternal, currentlyPlaying, getGlobalCueByIdRef, (cueId, index, isResume) => _playTargetItem(cueId, index, isResume, createContext()), _generateShuffleOrder, startPlaylistAtPosition, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef),
    playlistNavigatePrevious: (cueId, fromExternal) => playlistNavigatePrevious(cueId, fromExternal, currentlyPlaying, getGlobalCueByIdRef, (cueId, index, isResume) => _playTargetItem(cueId, index, isResume, createContext()), _generateShuffleOrder, startPlaylistAtPosition, sidebarsAPIRef, cuePlayOrder, sendPlaybackTimeUpdateRef),
    handleCrossfadeToggle: (cueId) => handleCrossfadeToggle(cueId, getGlobalCueByIdRef, currentlyPlaying, (cueIdToToggle, fromCompanion, retriggerBehaviorOverride) => toggleCue(cueIdToToggle, fromCompanion, retriggerBehaviorOverride, createContext()), (newCueId, newCue) => _handleCrossfadeStart(newCueId, newCue, currentlyPlaying, getAppConfigFuncRef, cueGridAPIRef, (cueId, useFade, fromCompanion, isRetriggerStop, stopReason) => stop(cueId, useFade, fromCompanion, isRetriggerStop, stopReason, createContext()), (cue, isResume) => play(cue, isResume, createContext()), (cueId, index, isResume) => _playTargetItem(cueId, index, isResume, createContext()))),
    getCurrentlyPlayingInstances: () => currentlyPlaying, // Expose currently playing instances for device switching
    // Ducking functions - exposed for internal use by playbackInstanceHandler
    _applyDucking: (triggerCueId) => _applyDucking(triggerCueId, currentlyPlaying, getGlobalCueByIdRef),
    _revertDucking: (triggerCueIdStop) => _revertDucking(triggerCueIdStop, currentlyPlaying),
    _cleanupSoundInstance: (cueId, state, options = {}) => _cleanupSoundInstance(cueId, state, options, createContext()),
    cleanupAllResources: (options) => cleanupAllResources(options, currentlyPlaying, pendingRestarts, playbackIntervals, allSoundInstances, (cueId, state, options) => _cleanupSoundInstance(cueId, state, options, createContext())),
    // Logging utilities
    setLogLevel,
    LogLevel,
    // Performance utilities
    throttle,
    clearPerformanceCache
};

// Crossfade functionality is now imported from audioPlaybackCrossfade.js

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