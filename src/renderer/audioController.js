// Companion_soundboard/src/renderer/audioController.js
// Manages audio playback using Howler.js - now acts as a higher-level orchestrator.

// import { getGlobalCueById } from './ui/utils.js'; // Removed - using cueStore directly instead
import { getPlaybackTimesUtil, formatTimeMMSS } from './audioTimeUtils.js';
import { init as initEmitter, sendPlaybackTimeUpdate } from './audioPlaybackIPCEmitter.js';
import { createPlaybackInstance } from './playbackInstanceHandler.js';

// Local function to get cue by ID using cueStore directly
function getGlobalCueById(cueId) {
    if (cueStoreRef && typeof cueStoreRef.getCueById === 'function') {
        return cueStoreRef.getCueById(cueId);
    }
    console.warn(`AudioController.getGlobalCueById: cueStoreRef or getCueById is not available. Cue ID: ${cueId}.`);
    return null;
}


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
            audioController: { getCurrentAudioOutputDeviceId }, // Pass audioController functions
            getPreloadedSound: getPreloadedSound // Pass preloaded sound accessor
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
    
    // Start preloading audio files for faster first play
    console.log('AudioController: Starting audio preloading...');
    setTimeout(() => preloadAudioFiles(), 1000); // Delay to ensure UI is ready
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
        console.log("AudioController: getAppConfig called during initialization. Returning default state.");
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
        const cue = getGlobalCueById(cueId); // Use local function
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
    // console.log(`AudioController: getPlaybackTimes called for cueId: ${cueId}. Initialized: ${audioControllerInitialized}`);

    if (!audioControllerInitialized || !playbackManagerModule || typeof playbackManagerModule.getPlaybackState !== 'function') {
        // This is normal during initialization - reduce log verbosity
        // console.log(`AudioController: getPlaybackTimes prerequisites not met for cueId: ${cueId}. Module ready: ${!!playbackManagerModule}, getPlaybackState is function: ${typeof playbackManagerModule?.getPlaybackState === 'function'}. Returning default idle times.`);
        if (cueStoreRef) {
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) {
                const originalKnownDuration = cue.knownDuration || 0;
                const trimStartTime = cue.trimStartTime || 0;
                const trimEndTime = (cue.trimEndTime !== undefined && cue.trimEndTime !== null) ? cue.trimEndTime : undefined;
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
                let totalPlaylistDuration = 0;
                let nextItemDuration = 0;
                
                if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                    nextItemName = cue.playlistItems[0]?.name || 'Item 1';
                    nextItemDuration = cue.playlistItems[0]?.knownDuration || 0;
                    
                    // Calculate total playlist duration
                    const itemsWithValidDurations = cue.playlistItems.filter(item => item.knownDuration && item.knownDuration > 0);
                    if (itemsWithValidDurations.length === cue.playlistItems.length) {
                        // All items have valid durations, calculate total
                        totalPlaylistDuration = cue.playlistItems.reduce((total, item) => total + (item.knownDuration || 0), 0);
                    } else {
                        // Some items missing durations, use first item duration as fallback
                        totalPlaylistDuration = nextItemDuration;
                        console.log(`AudioController: Playlist ${cueId} has ${cue.playlistItems.length - itemsWithValidDurations.length} items without durations, using first item duration as fallback for total`);
                    }
                } else {
                    totalPlaylistDuration = effectiveDuration; // For single files, use the trimmed duration
                    nextItemDuration = effectiveDuration;
                }

                return {
                    currentTime: 0,
                    duration: totalPlaylistDuration,
                    currentTimeFormatted: formatTimeMMSS(0),
                    durationFormatted: formatTimeMMSS(totalPlaylistDuration),
                    remainingTime: totalPlaylistDuration,
                    remainingTimeFormatted: formatTimeMMSS(totalPlaylistDuration),
                    isPlaying: false,
                    isPaused: false,
                    isCued: cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0, // Only cued if it's a playlist with items
                    currentPlaylistItemName: null,
                    nextPlaylistItemName: nextItemName, // For idle playlist, show first item as next
                    nextPlaylistItemDuration: nextItemDuration, // Add next item duration for display
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
        // console.log(`[AudioController getPlaybackTimes] CueID: ${cueId} - Received state from playbackManager:`, JSON.stringify(state));
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
        // This is normal for idle cues - no need to log as warning
        // console.log(`AudioController: getPlaybackTimes - playbackManagerModule.getPlaybackState returned null for cueId: ${cueId}. Using fallback idle state.`);
        if (cueStoreRef) { // Try cueStore again as a last resort for some basic info
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) {
                // CRITICAL FIX: Apply trim calculations in second fallback too
                const originalKnownDuration = cue.knownDuration || 0;
                const trimStartTime = cue.trimStartTime || 0;
                const trimEndTime = (cue.trimEndTime !== undefined && cue.trimEndTime !== null) ? cue.trimEndTime : undefined;
                let effectiveDuration;
                
                // FIX: Don't calculate trimmed duration if original duration is 0
                if (originalKnownDuration <= 0) {
                    effectiveDuration = 0;
                } else if (trimEndTime && trimEndTime > trimStartTime) {
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
                let totalPlaylistDuration = 0;
                let nextItemDuration = 0;
                
                if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                    nextItemNameFallback = cue.playlistItems[0]?.name || 'Item 1';
                    nextItemDuration = cue.playlistItems[0]?.knownDuration || 0;
                    
                    // Calculate total playlist duration
                    const itemsWithValidDurations = cue.playlistItems.filter(item => item.knownDuration && item.knownDuration > 0);
                    if (itemsWithValidDurations.length === cue.playlistItems.length) {
                        // All items have valid durations, calculate total
                        totalPlaylistDuration = cue.playlistItems.reduce((total, item) => total + (item.knownDuration || 0), 0);
                    } else {
                        // Some items missing durations, use first item duration as fallback
                        totalPlaylistDuration = nextItemDuration;
                        console.log(`AudioController: Playlist ${cueId} has ${cue.playlistItems.length - itemsWithValidDurations.length} items without durations, using first item duration as fallback for total`);
                    }
                } else {
                    totalPlaylistDuration = effectiveDuration; // For single files, use the trimmed duration
                    nextItemDuration = effectiveDuration;
                }
                
                // console.log(`AudioController: Second fallback calculated duration for cue ${cueId}: original=${originalKnownDuration}, trimmed=${effectiveDuration}, totalPlaylist=${totalPlaylistDuration}, nextItem=${nextItemDuration}, trimStart=${trimStartTime}, trimEnd=${trimEndTime}`);
                
                return {
                    currentTime: 0, duration: totalPlaylistDuration, currentTimeFormatted: '00:00', 
                    durationFormatted: formatTimeMMSS(totalPlaylistDuration), 
                    remainingTime: totalPlaylistDuration, remainingTimeFormatted: formatTimeMMSS(totalPlaylistDuration),
                    isPlaying: false, isPaused: false, 
                    isCued: cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0, // Only cued if it's a playlist with items
                    currentPlaylistItemName: null, nextPlaylistItemName: nextItemNameFallback, 
                    nextPlaylistItemDuration: nextItemDuration, // Add next item duration for display
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
                        
                        // Handle specific error types and try fallback
                        if (error.name === 'NotFoundError' || error.message.includes('not found')) {
                            console.log(`AudioController: Device not found, trying fallback to default for cue ${cueId}`);
                            try {
                                // Try to fall back to default device
                                if (sound._sounds && sound._sounds.length > 0) {
                                    const audioNode = sound._sounds[0]._node;
                                    if (audioNode && typeof audioNode.setSinkId === 'function') {
                                        await audioNode.setSinkId(''); // Empty string for default device
                                        console.log(`AudioController: Successfully set default device for cue ${cueId}`);
                                        failedSwitches--; // Reduce failed count since fallback succeeded
                                        successfulSwitches++;
                                    }
                                }
                            } catch (fallbackError) {
                                console.error(`AudioController: Fallback to default device also failed for cue ${cueId}:`, fallbackError);
                                errorMessage = `Audio device not found and fallback failed: ${deviceId}`;
                            }
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
    
    console.log(`AudioController: Looking up cue with ID: ${cueId}`);
    const cue = cueStoreRef.getCueById(cueId);
    
    if (!cue) {
        console.warn(`AudioController: Cue with ID ${cueId} not found in cueStoreRef.`);
        return;
    }
    
    console.log(`AudioController: Found cue "${cue.name}" (ID: ${cueId}) for source: ${source}`);
    
    let determinedRetrigger = source === 'companion' ? (cue.retriggerActionCompanion || cue.retriggerAction || 'restart') : (cue.retriggerAction || 'restart');
    console.log(`AudioController: Determined retriggerBehavior: '${determinedRetrigger}' for cue '${cue.name}' from source '${source}'`);
    
    const isFromCompanionFlag = source === 'companion';
    console.log(`AudioController: isFromCompanionFlag: ${isFromCompanionFlag}`);
    
    // Call the audioController's own toggle method
    if (typeof toggle === 'function') {
        console.log(`AudioController: Calling toggle function for cue ID: ${cue.id}`);
        try {
            toggle(cue.id, isFromCompanionFlag, determinedRetrigger);
            console.log(`AudioController: Successfully called toggle for cue: ${cue.name} (ID: ${cue.id})`);
        } catch (error) {
            console.error(`AudioController: Error calling toggle for cue: ${cue.name} (ID: ${cue.id}):`, error);
        }
    } else {
        console.error('AudioController: Internal toggle function is not available for playCueByIdFromMain!');
        console.error('AudioController: typeof toggle:', typeof toggle);
    }
}

// Function to get the current audio output device ID
function getCurrentAudioOutputDeviceId() {
    return currentAudioOutputDeviceId;
}

// --- Playlist Navigation Functions ---

function playlistNavigateNext(cueId, fromExternal = false) {
    console.log(`AudioController: playlistNavigateNext for cue ${cueId}, fromExternal=${fromExternal}`);
    console.log(`AudioController: audioControllerInitialized=${audioControllerInitialized}, playbackManagerModule=${!!playbackManagerModule}`);
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.playlistNavigateNext) {
        console.warn(`AudioController: playlistNavigateNext called for ${cueId} - playbackManager not ready`);
        return false;
    }
    const result = playbackManagerModule.playlistNavigateNext(cueId, fromExternal);
    console.log(`AudioController: playlistNavigateNext result for ${cueId}: ${result}`);
    return result;
}

function playlistNavigatePrevious(cueId, fromExternal = false) {
    console.log(`AudioController: playlistNavigatePrevious for cue ${cueId}, fromExternal=${fromExternal}`);
    if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.playlistNavigatePrevious) {
        console.warn(`AudioController: playlistNavigatePrevious called for ${cueId} - playbackManager not ready`);
        return false;
    }
    return playbackManagerModule.playlistNavigatePrevious(cueId, fromExternal);
}

// Preload audio files for instant playback
const preloadedSounds = new Map(); // Store preloaded Howl instances

async function preloadAudioFiles() {
    console.log('🎵 AudioController: Starting audio preloading...');
    
    if (!cueStoreRef || !cueStoreRef.getAllCues) {
        console.warn('🎵 AudioController: CueStore not ready for preloading');
        return;
    }
    
    const allCues = cueStoreRef.getAllCues();
    console.log(`🎵 AudioController: Preloading ${allCues.length} cues...`);
    
    let preloadedCount = 0;
    let errorCount = 0;
    
    for (const cue of allCues) {
        try {
            if (cue.type === 'single_file' && cue.filePath) {
                await preloadSingleFile(cue);
                preloadedCount++;
            } else if (cue.type === 'playlist' && cue.playlistItems) {
                // Preload first few playlist items (not all to avoid memory issues)
                const itemsToPreload = cue.playlistItems.slice(0, 3);
                for (const item of itemsToPreload) {
                    if (item.filePath) {
                        await preloadPlaylistItem(cue.id, item);
                        preloadedCount++;
                    }
                }
            }
        } catch (error) {
            console.warn(`🎵 AudioController: Error preloading cue ${cue.id}:`, error);
            errorCount++;
        }
    }
    
    console.log(`🎵 AudioController: Preloading complete! Loaded: ${preloadedCount}, Errors: ${errorCount}`);
}

async function preloadSingleFile(cue) {
    return new Promise((resolve, reject) => {
        console.log(`🎵 Preloading: ${cue.name} (${cue.filePath})`);
        
        // Use html5 for .m4a and .mp3 files for better compatibility
        // WAV files should use Web Audio API (html5: false) for reliable playback
        const useHtml5 = cue.filePath.toLowerCase().endsWith('.m4a') || 
                        cue.filePath.toLowerCase().endsWith('.mp3');
        
        const sound = new Howl({
            src: [cue.filePath],
            preload: true,
            volume: 0, // Silent preload
            html5: useHtml5,
            format: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'],
            onload: () => {
                preloadedSounds.set(cue.id, sound);
                console.log(`🎵 Preloaded: ${cue.name}`);
                resolve();
            },
            onloaderror: (soundId, error) => {
                console.warn(`🎵 Preload failed: ${cue.name} -`, error);
                const fileExt = cue.filePath.toLowerCase().split('.').pop();
                if (useHtml5) {
                    if (fileExt === 'm4a') {
                        console.warn(`🎵 .m4a file failed to preload. Consider converting to .mp3 for better compatibility.`);
                    } else if (fileExt === 'mp3') {
                        console.warn(`🎵 .mp3 file failed to preload. Consider re-encoding or converting to .wav for better compatibility.`);
                    }
                } else if (fileExt === 'wav') {
                    console.warn(`🎵 .wav file failed to preload. This might be due to file corruption, unsupported sample rate, or bit depth. WAV files use Web Audio API. Check file integrity.`);
                }
                reject(error);
            }
        });
    });
}

async function preloadPlaylistItem(cueId, item) {
    return new Promise((resolve, reject) => {
        console.log(`🎵 Preloading playlist item: ${item.name} (${item.filePath})`);
        
        // Use html5 for .m4a and .mp3 files for better compatibility (consistent with main playback)
        // WAV files should use Web Audio API (html5: false) for reliable playback
        const useHtml5 = item.filePath.toLowerCase().endsWith('.m4a') || 
                        item.filePath.toLowerCase().endsWith('.mp3');
        
        const sound = new Howl({
            src: [item.filePath],
            preload: true,
            volume: 0, // Silent preload
            html5: useHtml5,
            format: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'],
            onload: () => {
                preloadedSounds.set(`${cueId}_${item.id}`, sound);
                console.log(`🎵 Preloaded playlist item: ${item.name}`);
                resolve();
            },
            onloaderror: (soundId, error) => {
                console.warn(`🎵 Preload failed for playlist item: ${item.name} -`, error);
                const fileExt = item.filePath.toLowerCase().split('.').pop();
                if (useHtml5) {
                    if (fileExt === 'm4a') {
                        console.warn(`🎵 .m4a playlist item failed to preload. Consider converting to .mp3 for better compatibility.`);
                    } else if (fileExt === 'mp3') {
                        console.warn(`🎵 .mp3 playlist item failed to preload. Consider re-encoding or converting to .wav for better compatibility.`);
                    }
                } else if (fileExt === 'wav') {
                    console.warn(`🎵 .wav playlist item failed to preload. This might be due to file corruption, unsupported sample rate, or bit depth. WAV files use Web Audio API. Check file integrity.`);
                }
                reject(error);
            }
        });
    });
}

// Function to get preloaded sound by key
function getPreloadedSound(key) {
    const sound = preloadedSounds.get(key) || null;
    console.log(`🎵 getPreloadedSound called with key: ${key}, found: ${!!sound}`);
    if (sound) {
        console.log(`🎵 Preloaded sound state: ${sound.state()}`);
    }
    return sound;
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
    playCueByIdFromMain, // Make sure this is exported if called from IPC
    playlistNavigateNext,
    playlistNavigatePrevious,
    handleCrossfadeToggle: (cueId) => {
        if (!audioControllerInitialized || !playbackManagerModule || !playbackManagerModule.handleCrossfadeToggle) {
            console.error(`AudioController: handleCrossfadeToggle called for ${cueId} before full initialization or playbackManager not ready.`);
            return;
        }
        console.log(`AudioController: Public handleCrossfadeToggle called for cueId: ${cueId}`);
        playbackManagerModule.handleCrossfadeToggle(cueId);
    },
    // Ducking functions - exposed for internal use by playbackInstanceHandler
    _applyDucking: (triggerCueId) => playbackManagerModule?._applyDucking(triggerCueId),
    _revertDucking: (triggerCueIdStop) => playbackManagerModule?._revertDucking(triggerCueIdStop),
    getGlobalCueById: (cueId) => cueStoreRef?.getCueById(cueId),
    getPreloadedSound,
    preloadAudioFiles
    // getCurrentlyPlayingPlaylistItemName, // REMOVED
    // getNextPlaylistItemName, // REMOVED
};