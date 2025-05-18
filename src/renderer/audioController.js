// Companion_soundboard/src/renderer/audioController.js
// Manages audio playback using Howler.js - now acts as a higher-level orchestrator.

import { getGlobalCueById } from './ui/utils.js';
import { getPlaybackTimesUtil, formatTimeMMSS } from './audioTimeUtils.js';
import { init as initEmitter, sendPlaybackTimeUpdate } from './audioPlaybackIPCEmitter.js';
import { createPlaybackInstance } from './playbackInstanceHandler.js';

// Import the new playback manager
import * as audioPlaybackManager from './audioPlaybackManager.js';

// State variables that REMAIN in audioController.js:
let ipcBindings; // To send status updates
let cueStoreRef; // To store cueStore reference
let currentAppConfigRef = {}; // To store current app configuration
// cueGridAPI and sidebarsAPI are passed into init and then to audioPlaybackManager

// Call this function to initialize the module with dependencies
function init(cs, ipcRendererBindingsInstance, cgAPI, sbAPI) {
    console.log('AudioController initialized. Waiting for UI to set initial audio device.');
    cueStoreRef = cs;
    ipcBindings = ipcRendererBindingsInstance; // This is the electronAPI from preload
    
    // --- DEBUG LOG --- 
    console.log(`AudioController: init received cgAPI. Type: ${typeof cgAPI}, Is valid object: ${cgAPI && typeof cgAPI === 'object'}, Has updateCueButtonTime: ${typeof cgAPI?.updateCueButtonTime}`);

    // Initialize the audio playback emitter (for sending updates to main)
    initEmitter(ipcBindings, formatTimeMMSS);
    console.log('AudioController: AudioPlaybackIPCEmitter initialized.');

    // Initialize the new audioPlaybackManager
    audioPlaybackManager.init({
        getGlobalCueById: getGlobalCueById,
        getPlaybackTimesUtil: getPlaybackTimesUtil,
        formatTimeMMSS: formatTimeMMSS,
        createPlaybackInstance: createPlaybackInstance,
        sendPlaybackTimeUpdate: sendPlaybackTimeUpdate,
        cueStore: cueStoreRef,
        ipcBindings: ipcBindings,
        cueGridAPI: cgAPI, 
        sidebarsAPI: sbAPI,
        currentAppConfig: currentAppConfigRef // Pass the reference
    });
    console.log('AudioController: AudioPlaybackManager initialized.');

    // Setup listeners using the generic .on method from ipcBindings (electronAPI)
    if (ipcBindings && typeof ipcBindings.on === 'function') {
        ipcBindings.on('toggle-audio-by-id', (cueId) => {
            console.log(`AudioController: Received toggle-audio-by-id for cueId: ${cueId} (from OSC/Main)`);
            if (!cueStoreRef) {
                console.error('AudioController: cueStoreRef is not available. Cannot process toggle-audio-by-id.');
                return;
            }
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) {
                console.log(`AudioController: Calling audioPlaybackManager.toggle for cue "${cue.name}"`);
                audioPlaybackManager.toggle(cue, true); // fromCompanion = true
            } else {
                console.warn(`AudioController: Cue with ID ${cueId} not found in cueStore. Cannot toggle.`);
            }
        });
        console.log('AudioController: Listener for "toggle-audio-by-id" registered via ipcBindings.on().');

        ipcBindings.on('play-audio-by-id', (cueId) => {
            console.log(`AudioController: Received play-audio-by-id for cueId: ${cueId} (from OSC/Main)`);
            if (!cueStoreRef) {
                console.error('AudioController: cueStoreRef is not available. Cannot process play-audio-by-id.');
                return;
            }
            const cue = cueStoreRef.getCueById(cueId);
            if (cue) {
                console.log(`AudioController: Calling audioPlaybackManager.play for cue "${cue.name}"`);
                audioPlaybackManager.play(cue);
            } else {
                console.warn(`AudioController: Cue with ID ${cueId} not found. Cannot play.`);
            }
        });
        console.log('AudioController: Listener for "play-audio-by-id" registered via ipcBindings.on().');

        ipcBindings.on('stop-audio-by-id', (cueId) => {
            console.log(`AudioController: Received stop-audio-by-id for cueId: ${cueId} (from OSC/Main)`);
            // audioPlaybackManager.stop expects cueId
            if (cueStoreRef.getCueById(cueId)) { // Check if cue exists before stopping
                console.log(`AudioController: Calling audioPlaybackManager.stop for cueId "${cueId}"`);
                audioPlaybackManager.stop(cueId, true, true); // fromCompanion = true, useFade = true
            } else {
                 console.warn(`AudioController: Cue with ID ${cueId} not found in cueStore. Cannot stop.`);
            }
        });
        console.log('AudioController: Listener for "stop-audio-by-id" registered via ipcBindings.on().');

        ipcBindings.on('stop-all-audio', () => {
            console.log('AudioController: Received stop-all-audio (from OSC/Main)');
            audioPlaybackManager.stopAll({ fromCompanion: true, useFade: true });
        });
        console.log('AudioController: Listener for "stop-all-audio" registered via ipcBindings.on().');

    } else {
        console.error('AudioController: ipcBindings.on is not available. OSC/MIDI triggers will not work.');
    }
}

// Function to set UI references if they weren't available at initial init
function setUIRefs(cgAPI, sbAPI) {
    console.log(`AudioController: setUIRefs called with cgAPI: ${!!cgAPI}, sbAPI: ${!!sbAPI}`);
    if (cgAPI) {
        console.log(`AudioController: setUIRefs - cgAPI.updateCueButtonTime type: ${typeof cgAPI.updateCueButtonTime}`);
    }
    // Pass these to audioPlaybackManager if it also needs late initialization of these
    if (audioPlaybackManager && typeof audioPlaybackManager.setUIRefs === 'function') {
        audioPlaybackManager.setUIRefs(cgAPI, sbAPI);
    } else {
        console.warn('AudioController: audioPlaybackManager.setUIRefs is not available.');
    }
}

// New function to update the internal app config reference
function updateAppConfig(newConfig) {
    currentAppConfigRef = { ...currentAppConfigRef, ...newConfig };
    console.log('AudioController: App config updated:', currentAppConfigRef);
    // audioPlaybackManager already holds a reference to currentAppConfigRef, so it will see changes.
    // If audioPlaybackManager needed to *react* to a change (e.g. re-evaluate something),
    // an explicit update function could be added to it and called here.
}

// New function to set the audio output device for Howler
async function setAudioOutputDevice(deviceId) {
    console.log(`AudioController: Attempting to set audio output device to: ${deviceId}`);
    if (Howler.ctx && typeof Howler.ctx.setSinkId === 'function') {
        try {
            await Howler.ctx.setSinkId(deviceId);
            console.log(`AudioController: Successfully set audio output device to ${deviceId}`);
        } catch (error) {
            console.error(`AudioController: Error setting audio output device ${deviceId}:`, error);
            if (error.name === 'NotFoundError') {
                alert(`Audio device ${deviceId} not found. Please select another device.`);
            }
        }
    } else {
        console.warn('AudioController: AudioContext.setSinkId is not available. Cannot change audio output device.');
    }
}

// --- Re-export functions from audioPlaybackManager for other UI modules to use ---
// Playback control functions
const play = (cue, isResume = false) => audioPlaybackManager.play(cue, isResume);
const stop = (cueId, fromCompanion = false, useFade = false) => audioPlaybackManager.stop(cueId, fromCompanion, useFade);
const toggle = (cue, fromCompanion = false, retriggerBehavior = 'restart') => audioPlaybackManager.toggle(cue, fromCompanion, retriggerBehavior);
const stopAll = (options = {}) => audioPlaybackManager.stopAll(options);
const pause = (cueId) => audioPlaybackManager.pause(cueId); // Though not directly used by cueGrid, good to expose

// Status checking functions
const isPlaying = (cueId) => audioPlaybackManager.isPlaying(cueId);
const isPaused = (cueId) => audioPlaybackManager.isPaused(cueId);
const isCued = (cueId) => audioPlaybackManager.isCued(cueId);

// Information retrieval functions
const getPlaybackTimes = (cueId) => audioPlaybackManager.getPlaybackTimes(cueId);
const getCurrentlyPlayingPlaylistItemName = (cueId) => audioPlaybackManager.getCurrentlyPlayingPlaylistItemName(cueId);
const getNextPlaylistItemName = (cueId) => audioPlaybackManager.getNextPlaylistItemName(cueId);

export {
    init,
    setUIRefs,
    updateAppConfig,
    setAudioOutputDevice,
    // Playback control
    play,
    stop,
    toggle,
    stopAll,
    pause,
    // Status checking
    isPlaying,
    isPaused,
    isCued,
    // Information retrieval
    getPlaybackTimes,
    getCurrentlyPlayingPlaylistItemName,
    getNextPlaylistItemName
};