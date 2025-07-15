// Companion_soundboard/src/renderer/audioController.js
// Manages audio playback using Howler.js - now acts as a higher-level orchestrator.

import { getGlobalCueById } from './ui/utils.js';
import { getPlaybackTimesUtil, formatTimeMMSS } from './audioTimeUtils.js';
import { init as initEmitter, sendPlaybackTimeUpdate } from './audioPlaybackIPCEmitter.js';
import { createPlaybackInstance } from './playbackInstanceHandler.js';

// Static import removed: import * as audioPlaybackManager from './audioPlaybackManager.js';

// State variables that REMAIN in audioController.js:
let ipcBindings; // To send status updates
let cueStoreRef; // To store cueStore reference
let internalAppConfigState = {}; // Renamed from currentAppConfigRef, stores the actual config state
let playbackManagerModule = null; // Module-scoped variable for the dynamically imported module
let appConfigInitialized = false;

// Store UI refs locally until playbackManagerModule is ready
let localCueGridAPI = null;
let localSidebarsAPI = null;

let audioControllerInitialized = false;

// Store the current audio output device ID
let currentAudioOutputDeviceId = 'default';

// Call this function to initialize the module with dependencies
async function init(cs, ipcRendererBindingsInstance, cgAPI, sbAPI) {
    console.log('AudioController: init sequence started.');
    cueStoreRef = cs;
    ipcBindings = ipcRendererBindingsInstance; // This is the electronAPI from preload
    
    // --- DEBUG LOG --- 
    console.log(`AudioController: init received cgAPI. Type: ${typeof cgAPI}, Is valid object: ${cgAPI && typeof cgAPI === 'object'}, Has updateCueButtonTime: ${typeof cgAPI?.updateCueButtonTime}`);

    // Initialize the audio playback emitter (for sending updates to main)
    initEmitter(ipcBindings, formatTimeMMSS);
    console.log('AudioController: AudioPlaybackIPCEmitter initialized.');

    // Dynamically import audioPlaybackManager
    console.log('AudioController: Attempting to dynamically import audioPlaybackManager.js...');
    playbackManagerModule = (await import('./audioPlaybackManager.js')).default; 
    console.log('AudioController: Dynamically imported playbackManagerModule:', playbackManagerModule);

    if (playbackManagerModule && typeof playbackManagerModule.init === 'function') {
        playbackManagerModule.init({
            getGlobalCueById: getGlobalCueById,
            getPlaybackTimesUtil: getPlaybackTimesUtil,
            formatTimeMMSS: formatTimeMMSS,
            createPlaybackInstance: createPlaybackInstance,
            sendPlaybackTimeUpdate: sendPlaybackTimeUpdate,
            cueStore: cueStoreRef,
            ipcBindings: ipcBindings,
            cueGridAPI: cgAPI, 
            sidebarsAPI: sbAPI,
            getAppConfigFunc: getAppConfig, // Pass the local getter
            audioController: { getCurrentAudioOutputDeviceId } // Pass audioController functions
        });
        console.log('AudioController: playbackManagerModule.init() called successfully.');

        // Now that playbackManagerModule is initialized, pass the UI refs if they were set beforehand
        if (localCueGridAPI && localSidebarsAPI && typeof playbackManagerModule.setUIRefs === 'function') {
            console.log('AudioController: Forwarding stored UI refs to playbackManagerModule.');
            playbackManagerModule.setUIRefs(localCueGridAPI, localSidebarsAPI);
        } else {
            console.log('AudioController: UI refs not yet available or playbackManagerModule.setUIRefs is not a function when attempting to forward.');
        }

    } else {
        console.error('AudioController FATAL: playbackManagerModule.js did not load correctly or has no init function.');
        return; 
    }

    // Setup IPC listeners that might rely on audioPlaybackManager being ready
    setupIPCListeners();
    audioControllerInitialized = true;
    console.log('AudioController: Main initialization complete.');
}

function setUIRefs(cgAPI, sbAPI) {
    localCueGridAPI = cgAPI;
    localSidebarsAPI = sbAPI;
    console.log(`AudioController: setUIRefs called. Stored localCueGridAPI: ${!!localCueGridAPI}, localSidebarsAPI: ${!!localSidebarsAPI}`);

    // If playbackManagerModule is already initialized, pass the refs immediately
    if (playbackManagerModule && typeof playbackManagerModule.setUIRefs === 'function' && audioControllerInitialized) {
        console.log('AudioController: playbackManagerModule already initialized, calling setUIRefs on it directly.');
        playbackManagerModule.setUIRefs(localCueGridAPI, localSidebarsAPI);
    } else {
        console.log('AudioController: playbackManagerModule not yet ready, UI refs stored. Will be passed after playbackManager init.');
    }
}

function getAppConfig() {
    if (!appConfigInitialized) {
        console.warn("AudioController: getAppConfig called before appConfig was fully initialized from AppConfigUI. Returning potentially empty/default state.");
    }
    return internalAppConfigState;
}

function _updateInternalAppConfig(newConfig) {
    internalAppConfigState = { ...newConfig };
    
    // Update the current audio output device ID if it changed
    if (newConfig.audioOutputDeviceId !== undefined) {
        currentAudioOutputDeviceId = newConfig.audioOutputDeviceId;
        console.log(`AudioController: Updated current audio output device ID to: ${currentAudioOutputDeviceId}`);
    }
    
    appConfigInitialized = true;
    console.log("AudioController: Internal app config updated and marked as initialized.", internalAppConfigState);
    // No need to propagate to playbackManager here; it uses getAppConfigFuncRef when needed
}

function setupIPCListeners() {
    if (!ipcBindings) {
        console.error("AudioController: setupIPCListeners - ipcBindings not available.");
        return;
    }
    console.log("AudioController: Setting up IPC listeners...");

    ipcBindings.on('toggle-audio-by-id', (event, { cueId, fromCompanion, retriggerBehaviorOverride }) => {
        console.log(`AudioController: IPC 'toggle-audio-by-id' received for ${cueId}`);
        if (playbackManagerModule && playbackManagerModule.toggleCue) {
            playbackManagerModule.toggleCue(cueId, fromCompanion, retriggerBehaviorOverride);
        } else {
            console.error('AudioController: playbackManagerModule or toggleCue not available for toggle-audio-by-id');
        }
    });
    console.log("AudioController: Listener for 'toggle-audio-by-id' registered.");

    ipcBindings.on('play-audio-by-id', (event, { cueId }) => {
        console.log(`AudioController: IPC 'play-audio-by-id' received for ${cueId}`);
        const cue = cueStoreRef ? cueStoreRef.getCueById(cueId) : getGlobalCueById(cueId); // Fallback if cueStoreRef not ready
        if (cue && playbackManagerModule && playbackManagerModule.playCue) {
            playbackManagerModule.playCue(cue, false); // false for isResume
        } else {
            console.error('AudioController: playbackManagerModule, playCue or cue not available for play-audio-by-id', {cueExists: !!cue});
        }
    });
    console.log("AudioController: Listener for 'play-audio-by-id' registered.");

    ipcBindings.on('stop-audio-by-id', (event, { cueId, useFade }) => {
        console.log(`AudioController: IPC 'stop-audio-by-id' received for ${cueId}`);
        if (playbackManagerModule && playbackManagerModule.stopCue) {
            playbackManagerModule.stopCue(cueId, useFade);
        } else {
            console.error('AudioController: playbackManagerModule or stopCue not available for stop-audio-by-id');
        }
    });
    console.log("AudioController: Listener for 'stop-audio-by-id' registered.");

    ipcBindings.on('stop-all-audio', (event, options) => {
        console.log("AudioController: IPC 'stop-all-audio' received.");
        if (playbackManagerModule && playbackManagerModule.stopAllCues) {
            playbackManagerModule.stopAllCues(options);
        } else {
            console.error('AudioController: playbackManagerModule or stopAllCues not available for stop-all-audio');
        }
    });
    console.log("AudioController: Listener for 'stop-all-audio' registered.");
}

// Public interface for audioController
function toggle(cueId, fromCompanion = false, retriggerBehaviorOverride = null) {
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.toggleCue) {
        console.error(`AudioController: toggle called for ${cueId} before full initialization or playbackManager not ready.`);
        return;
    }
    console.log(`AudioController: Public toggle called for cueId: ${cueId}`);
    playbackManagerModule.toggleCue(cueId, fromCompanion, retriggerBehaviorOverride);
}

function stopAll(options = { exceptCueId: null, useFade: true }) {
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.stopAllCues) {
        console.error("AudioController: stopAll called before full initialization or playbackManager not ready.");
        return;
    }
    console.log("AudioController: Public stopAll called.");
    playbackManagerModule.stopAllCues(options);
}

function seek(cueId, positionSec) {
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.seekInCue) {
        console.error(`AudioController: seek called for ${cueId} before full initialization or playbackManager not ready.`);
        return;
    }
    playbackManagerModule.seekInCue(cueId, positionSec);
}

function getPlaybackTimes(cueId) {
    console.log(`AudioController: getPlaybackTimes called for cueId: ${cueId}. Initialized: ${audioControllerInitialized}`);

    if (!audioControllerInitialized || !playbackManagerModule || typeof playbackManagerModule.getPlaybackState !== 'function') {
        console.warn(`AudioController: getPlaybackTimes prerequisites not met for cueId: ${cueId}. Module ready: ${!!playbackManagerModule}, getPlaybackState is function: ${typeof playbackManagerModule?.getPlaybackState === 'function'}. Returning default idle times.`);
        if (cueStoreRef) {
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) {
                const originalKnownDuration = cue.knownDuration || 0;
                const trimStartTime = cue.trimStartTime || 0;
                const trimEndTime = cue.trimEndTime;
                let effectiveDuration;
                if (trimEndTime && trimEndTime > trimStartTime) {
                    effectiveDuration = trimEndTime - trimStartTime;
                } else if (trimEndTime && trimEndTime <= trimStartTime && trimEndTime > 0) {
                    effectiveDuration = 0;
                    console.warn(`AudioController: Cue ${cue.id} has invalid trim (end <= start). Duration set to 0.`);
                } else if (trimStartTime > 0) {
                    effectiveDuration = originalKnownDuration - trimStartTime;
                } else if (trimEndTime && trimEndTime > 0 && trimEndTime < originalKnownDuration) {
                    effectiveDuration = trimEndTime;
                } else {
                    effectiveDuration = originalKnownDuration;
                }
                effectiveDuration = Math.max(0, effectiveDuration);
                let nextItemName = null;
                if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                    nextItemName = cue.playlistItems[0]?.name || 'Item 1';
                }

                return {
                    currentTime: 0,
                    duration: effectiveDuration,
                    currentTimeFormatted: formatTimeMMSS(0),
                    durationFormatted: formatTimeMMSS(effectiveDuration),
                    remainingTime: effectiveDuration,
                    remainingTimeFormatted: formatTimeMMSS(effectiveDuration),
                    isPlaying: false,
                    isPaused: false,
                    isCued: cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0, // Only cued if it's a playlist with items
                    currentPlaylistItemName: null,
                    nextPlaylistItemName: nextItemName, // For idle playlist, show first item as next
                    isPlaylist: cue.type === 'playlist'
                };
            }
        }
        return { // Absolute fallback
            currentTime: 0, duration: 0, currentTimeFormatted: '00:00', durationFormatted: '00:00', remainingTime: 0, remainingTimeFormatted: '00:00',
            isPlaying: false, isPaused: false, isCued: false, currentPlaylistItemName: null, nextPlaylistItemName: null, isPlaylist: false
        };
    }

    const state = playbackManagerModule.getPlaybackState(cueId);
    
    if (state) { 
        console.log(`[AudioController getPlaybackTimes] CueID: ${cueId} - Received state from playbackManager:`, JSON.stringify(state));
        // Pass through all relevant state, including names and status flags
        return {
            currentTime: state.currentTime,
            duration: state.duration,
            currentTimeFormatted: state.currentTimeFormatted,
            durationFormatted: state.durationFormatted,
            remainingTime: Math.max(0, state.duration - state.currentTime),
            remainingTimeFormatted: formatTimeMMSS(Math.max(0, state.duration - state.currentTime)),
            isPlaying: state.isPlaying,
            isPaused: state.isPaused,
            isCued: state.isCued || state.isCuedNext, // Combine cued flags for general UI use
            currentPlaylistItemName: state.currentPlaylistItemName,
            nextPlaylistItemName: state.nextPlaylistItemName,
            isPlaylist: state.isPlaylist,
            isFadingIn: state.isFadingIn,
            isFadingOut: state.isFadingOut,
            isDucked: state.isDucked
            // Add other relevant fields from 'state' if cueGrid needs them directly
        };
    } else { // Cue is idle (and not found by playbackManagerModule.getPlaybackState, e.g. truly empty)
        console.warn(`AudioController: getPlaybackTimes - playbackManagerModule.getPlaybackState returned null for cueId: ${cueId}. Using fallback idle state.`);
        if (cueStoreRef) { // Try cueStore again as a last resort for some basic info
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) {
                // CRITICAL FIX: Apply trim calculations in second fallback too
                const originalKnownDuration = cue.knownDuration || 0;
                const trimStartTime = cue.trimStartTime || 0;
                const trimEndTime = cue.trimEndTime;
                let effectiveDuration;
                
                if (trimEndTime && trimEndTime > trimStartTime) {
                    effectiveDuration = trimEndTime - trimStartTime;
                } else if (trimEndTime && trimEndTime <= trimStartTime && trimEndTime > 0) {
                    effectiveDuration = 0;
                    console.warn(`AudioController: Cue ${cue.id} has invalid trim (end <= start) in fallback. Duration set to 0.`);
                } else if (trimStartTime > 0) {
                    effectiveDuration = originalKnownDuration - trimStartTime;
                } else if (trimEndTime && trimEndTime > 0 && trimEndTime < originalKnownDuration) {
                    effectiveDuration = trimEndTime;
                } else {
                    effectiveDuration = originalKnownDuration;
                }
                effectiveDuration = Math.max(0, effectiveDuration);
                
                 let nextItemNameFallback = null;
                if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                    nextItemNameFallback = cue.playlistItems[0]?.name || 'Item 1';
                }
                
                console.log(`AudioController: Second fallback calculated duration for cue ${cueId}: original=${originalKnownDuration}, trimmed=${effectiveDuration}, trimStart=${trimStartTime}, trimEnd=${trimEndTime}`);
                
                return {
                    currentTime: 0, duration: effectiveDuration, currentTimeFormatted: '00:00', 
                    durationFormatted: formatTimeMMSS(effectiveDuration), 
                    remainingTime: effectiveDuration, remainingTimeFormatted: formatTimeMMSS(effectiveDuration),
                    isPlaying: false, isPaused: false, 
                    isCued: cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0, // Only cued if it's a playlist with items
                    currentPlaylistItemName: null, nextPlaylistItemName: nextItemNameFallback, 
                    isPlaylist: cue.type === 'playlist'
                };
            }
        }
        return { // Absolute fallback for truly unknown/empty cue
            currentTime: 0, duration: 0, currentTimeFormatted: '00:00', durationFormatted: '00:00', remainingTime: 0, remainingTimeFormatted: '00:00',
            isPlaying: false, isPaused: false, isCued: false, currentPlaylistItemName: null, nextPlaylistItemName: null, isPlaylist: false
        };
    }
}

// --- Status Checking Functions ---
function isPlaying(cueId) {
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.getPlaybackState) {
        // console.warn(`AudioController: isPlaying called for ${cueId} - playbackManager not ready. Returning false.`);
        return false;
    }
    const state = playbackManagerModule.getPlaybackState(cueId);
    return state ? state.isPlaying : false;
}

function isPaused(cueId) {
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.getPlaybackState) {
        // console.warn(`AudioController: isPaused called for ${cueId} - playbackManager not ready. Returning false.`);
        return false;
    }
    const state = playbackManagerModule.getPlaybackState(cueId);
    return state ? state.isPaused : false;
}

// isCued might need specific logic if playbackManagerModule.getPlaybackState doesn't directly provide it
// For now, assuming it might be part of the state or needs a dedicated method in playbackManager if complex.
// Let's assume for now that `isCued` is also part of the state object from `getPlaybackState` or can be inferred.
// If not, playbackManager would need an `isCued(cueId)` method.
function isCued(cueId) {
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.getPlaybackState) {
        // console.warn(`AudioController: isCued called for ${cueId} - playbackManager not ready. Returning false.`);
        return false;
    }
    const state = playbackManagerModule.getPlaybackState(cueId);
    // Example: Inferring 'cued' if it's a playlist, paused, and has a next item specific flag.
    // This might need adjustment based on how 'cued' state is actually managed in playbackManager
    if (state && state.isPlaylist && state.isPaused && state.isCuedNext) { // isCuedNext is from an earlier version, check if still valid in playbackManager
        return true;
    }
    return state ? (state.isCued || false) : false; // Check for an explicit isCued property
}

// New function to update the internal app config reference
function updateAppConfig(newConfig) {
    console.log('AudioController: Config update received:', newConfig);
    if (newConfig) {
        internalAppConfigState = { ...newConfig };
        console.log('AudioController: App config updated:', internalAppConfigState);
    }
}

// New function to set the audio output device for Howler
async function setAudioOutputDevice(deviceId) {
    console.log(`AudioController: Attempting to set audio output device to: ${deviceId}`);
    
    // Map 'default' to empty string for Web Audio API
    const sinkId = (deviceId === 'default') ? '' : deviceId;
    
    let success = false;
    let errorMessage = null;
    let successfulSwitches = 0;
    let failedSwitches = 0;
    
    // Store the current state of all playing/paused sounds before switching
    const soundStates = {};
    if (playbackManagerModule && playbackManagerModule.getCurrentlyPlayingInstances) {
        const currentlyPlaying = playbackManagerModule.getCurrentlyPlayingInstances();
        for (const [cueId, playingState] of Object.entries(currentlyPlaying)) {
            if (playingState.sound) {
                soundStates[cueId] = {
                    isPlaying: playingState.sound.playing(),
                    isPaused: playingState.isPaused,
                    currentTime: playingState.sound.seek(),
                    volume: playingState.sound.volume(),
                    cue: getGlobalCueById(cueId)
                };
            }
        }
    }
    
    // For HTML5 Audio (which is used by default in this app), we need to set the device 
    // on each individual audio element, not the global AudioContext
    if (Object.keys(soundStates).length > 0) {
        console.log(`AudioController: Setting audio output device on ${Object.keys(soundStates).length} active sounds`);
        
        for (const [cueId, state] of Object.entries(soundStates)) {
            if (playbackManagerModule && playbackManagerModule.getCurrentlyPlayingInstances) {
                const currentlyPlaying = playbackManagerModule.getCurrentlyPlayingInstances();
                const playingState = currentlyPlaying[cueId];
                
                if (playingState && playingState.sound) {
                    try {
                        // Get the underlying HTML5 Audio element from Howler
                        const sound = playingState.sound;
                        
                        // Howler.js exposes the underlying audio nodes
                        // For HTML5 Audio, we need to access the audio element
                        if (sound._sounds && sound._sounds.length > 0) {
                            const audioNode = sound._sounds[0]._node;
                            if (audioNode && typeof audioNode.setSinkId === 'function') {
                                console.log(`AudioController: Setting sink ID on HTML5 Audio element for cue ${cueId}`);
                                await audioNode.setSinkId(sinkId);
                                successfulSwitches++;
                                console.log(`AudioController: Successfully set device for cue ${cueId}`);
                            } else {
                                console.warn(`AudioController: setSinkId not available on audio element for cue ${cueId}`);
                                failedSwitches++;
                            }
                        } else {
                            console.warn(`AudioController: No audio nodes found for cue ${cueId}`);
                            failedSwitches++;
                        }
                    } catch (error) {
                        console.error(`AudioController: Failed to set device for cue ${cueId}:`, error);
                        failedSwitches++;
                        
                        // Handle specific error types
                        if (error.name === 'NotFoundError') {
                            errorMessage = `Audio device not found: ${deviceId}`;
                        } else if (error.name === 'NotAllowedError') {
                            errorMessage = `Permission denied for audio device: ${deviceId}`;
                        } else {
                            errorMessage = error.message;
                        }
                    }
                }
            }
        }
        
        success = successfulSwitches > 0;
        
        if (successfulSwitches > 0) {
            console.log(`AudioController: Successfully switched ${successfulSwitches} sounds to device ${deviceId}`);
        }
        if (failedSwitches > 0) {
            console.warn(`AudioController: Failed to switch ${failedSwitches} sounds to device ${deviceId}`);
        }
    } else {
        // No active sounds, but we can still try to set the global context for future sounds
        console.log(`AudioController: No active sounds, setting global Howler AudioContext for future sounds`);
        
        if (Howler.ctx && typeof Howler.ctx.setSinkId === 'function') {
            try {
                await Howler.ctx.setSinkId(sinkId);
                console.log(`AudioController: Successfully set global Howler AudioContext to device ${deviceId}`);
                success = true;
            } catch (error) {
                console.error(`AudioController: Failed to set global Howler AudioContext to device ${deviceId}:`, error);
                errorMessage = error.message;
                
                // Handle specific error types
                if (error.name === 'NotFoundError') {
                    errorMessage = `Audio device not found: ${deviceId}`;
                } else if (error.name === 'NotAllowedError') {
                    errorMessage = `Permission denied for audio device: ${deviceId}`;
                }
            }
        } else {
            console.warn('AudioController: setSinkId not supported on AudioContext or Howler.ctx not available');
            // For future sounds, we'll need to handle this when they're created
            success = true; // Don't fail if there are no active sounds
        }
    }
    
    if (success) {
        // Store the current device ID for future sounds
        currentAudioOutputDeviceId = deviceId;
        console.log(`AudioController: Successfully set audio output device to ${deviceId}`);
        return { success: true, message: `Audio output switched to device: ${deviceId}` };
    } else {
        console.error(`AudioController: Failed to set audio output device to ${deviceId}: ${errorMessage}`);
        return { success: false, error: errorMessage || 'Audio device switching failed' };
    }
}

// --- Re-export functions from audioPlaybackManager for other UI modules to use ---
// These will now use playbackManagerModule and need to handle it being potentially null
const play = (cue, isResume = false) => playbackManagerModule?.play(cue, isResume);
const stop = (cueId, fromCompanion = false, useFade = false) => playbackManagerModule?.stop(cueId, fromCompanion, useFade);
const pause = (cueId) => playbackManagerModule?.pause(cueId);

function playCueByIdFromMain(cueId, source = 'unknown') {
    console.log(`AudioController: playCueByIdFromMain called for cueId: ${cueId}, source: ${source}`);
    if (!cueStoreRef) {
        console.error('AudioController: cueStoreRef is not available. Cannot process playCueByIdFromMain.');
        return;
    }
    const cue = cueStoreRef.getCueById(cueId);
    if (cue) {
        console.log(`AudioController: Triggering cue "${cue.name}" via playCueByIdFromMain (source: ${source}).`);
        let determinedRetrigger = source === 'companion' ? (cue.retriggerActionCompanion || cue.retriggerAction || 'restart') : (cue.retriggerAction || 'restart');
        console.log(`AudioController: Determined retriggerBehavior: '${determinedRetrigger}' for cue '${cue.name}' from source '${source}'`);
        const isFromCompanionFlag = source === 'companion';
        
        // Call the audioController's own toggle method
        if (typeof toggle === 'function') { // Check if the local toggle is available
            toggle(cue.id, isFromCompanionFlag, determinedRetrigger); // Pass cue.id instead of cue
        } else {
            console.error('AudioController: Internal toggle function is not available for playCueByIdFromMain!');
        }
    } else {
        console.warn(`AudioController: Cue with ID ${cueId} not found in cueStoreRef.`);
    }
}

// Function to get the current audio output device ID
function getCurrentAudioOutputDeviceId() {
    return currentAudioOutputDeviceId;
}

export default {
    init,
    setUIRefs,
    toggle,
    stopAll,
    // Play, Stop, Pause are now primarily internal or for very specific direct calls if needed.
    // The main interaction point is toggle().
    // play: (cue, isResume = false) => playbackManagerModule?.playCue(cue, isResume), // Expose playCue from manager
    // stop: (cueId, useFade = true, fromCompanion = false) => playbackManagerModule?.stopCue(cueId, useFade, fromCompanion), // Expose stopCue from manager
    // pause: (cueId) => playbackManagerModule?.pauseCue(cueId), // Expose pauseCue from manager
    seek,
    getPlaybackTimes, // This now includes more comprehensive state
    isPlaying,
    isPaused,
    isCued,
    updateAppConfig: _updateInternalAppConfig, // Expose the internal updater
    setAudioOutputDevice,
    getCurrentAudioOutputDeviceId,
    playCueByIdFromMain // Make sure this is exported if called from IPC
    // getCurrentlyPlayingPlaylistItemName, // REMOVED
    // getNextPlaylistItemName, // REMOVED
};