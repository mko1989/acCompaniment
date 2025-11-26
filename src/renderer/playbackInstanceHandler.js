/**
 * Creates a Howler sound instance and sets up its event handlers.
 * @param {string} filePath - Path to the audio file.
 * @param {string} cueId - The ID of the cue.
 * @param {object} mainCue - The main cue object.
 * @param {object} playingState - The specific playing state for this cue instance from currentlyPlaying.
 * @param {string} currentItemNameForEvents - Name of the current item, for events.
 * @param {number} actualItemIndexInOriginalList - Index of item in original list (for playlists).
 * @param {boolean} isResumeForSeekAndFade - If playback is resuming.
 * @param {object} audioControllerContext - Context object with refs from audioController.
 * @returns {Howl | null} The Howler sound instance or null on immediate error.
 */

import { 
    createOnloadHandler,
    createOnplayHandler,
    createOnpauseHandler
} from './playbackEventHandlersCore.js';

import { 
    createOnendHandler,
    createOnstopHandler,
    createOnfadeHandler
} from './playbackEventHandlersLifecycle.js';

import { 
    createOnloaderrorHandler,
    createOnplayerrorHandler
} from './playbackEventHandlersError.js';

export function createPlaybackInstance(
    filePath,
    cueId,
    mainCue,
    playingState,
    currentItemNameForEvents,
    actualItemIndexInOriginalList,
    isResumeForSeekAndFade,
    audioControllerContext,
    options = {}
) {
    const {
        currentlyPlaying,
        playbackIntervals,
        ipcBindings,
        cueGridAPI,
        sidebarsAPI,
        sendPlaybackTimeUpdate,
        _handlePlaylistEnd,
        _playTargetItem, // For error recovery
        _applyDucking,
        allSoundInstances
    } = audioControllerContext;

    const {
        forceHtml5 = false,
        allowHtml5Fallback = true
    } = options;

    const fallbackEnabled = allowHtml5Fallback && !forceHtml5;

    // Check if this is a crossfade situation
    const isCrossfadeMode = playingState.crossfadeInfo && playingState.crossfadeInfo.isCrossfadeIn;
    const initialVolume = isCrossfadeMode ? 0 : (mainCue.volume !== undefined ? mainCue.volume : 1);
    
    // Crossfade debug logging removed for cleaner console output

    // Check for preloaded sound first
    let sound = null;
    const preloadKey = playingState.isPlaylist ? `${cueId}_${actualItemIndexInOriginalList}` : cueId;
    
    // Try to get preloaded sound from audioController
    if (audioControllerContext.getPreloadedSound) {
        console.log(`🎵 Checking for preloaded sound with key: ${preloadKey}`);
        sound = audioControllerContext.getPreloadedSound(preloadKey);
        if (sound) {
            console.log(`🎵 Preloaded sound found for ${cueId} (${currentItemNameForEvents}), creating new instance with same source`);
            console.log(`🎵 Preloaded sound state: ${sound.state()}, playing: ${sound.playing()}`);
            // Don't use the preloaded sound directly, but create a new instance with the same file
            // This ensures we have a fresh instance for each playback
            sound = null; // Fall back to creating new instance, but we know the file is preloaded
        } else {
            console.log(`🎵 No preloaded sound found for key: ${preloadKey}`);
        }
    } else {
        console.log(`🎵 getPreloadedSound function not available in audioControllerContext`);
    }
    
    const useHtml5 = !!forceHtml5;

    // If no preloaded sound available, create new one
    if (!sound) {
        console.log(`🎵 Creating new sound instance for ${cueId} (${currentItemNameForEvents})`);
        
        // Create the sound instance
        console.log(`🎵 Creating Howl instance for ${cueId}: html5=${useHtml5}, filePath=${filePath}`);
        // For seamless looping: Disable Howler's loop if trim times are set, as scheduleTrimEndEnforcement handles it
        const hasTrimTimes = (mainCue.trimStartTime && mainCue.trimStartTime > 0) || (mainCue.trimEndTime && mainCue.trimEndTime > 0);
        const shouldUseHowlerLoop = !hasTrimTimes && (playingState.isPlaylist ? false : (mainCue.loop || false));
        sound = new Howl({
            src: [filePath],
            volume: initialVolume,
            loop: shouldUseHowlerLoop,
            html5: useHtml5,
            preload: true,
            format: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'],
            onload: () => {
                console.log(`[HOWL_ONLOAD ${cueId}] Direct onload event fired for: ${filePath}`);
            }
        });
    }

    // Set up event handlers after sound instance is created
    const onloadHandler = createOnloadHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, 
        actualItemIndexInOriginalList, isResumeForSeekAndFade, mainCue, audioControllerContext
    );
    sound.on('load', onloadHandler);
    
    // If sound is already loaded, manually trigger the onload handler
    // This happens when the sound loads before the handler is attached
    if (sound.state() === 'loaded') {
        console.log(`[AUDIO_INSTANCE ${cueId}] Sound already loaded, manually triggering onload handler for: ${filePath}`);
        // Use setTimeout to ensure the handler is fully attached first
        setTimeout(() => {
            onloadHandler();
        }, 0);
    }

    const onPlayHandler = createOnplayHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, 
        actualItemIndexInOriginalList, isResumeForSeekAndFade, mainCue, audioControllerContext
    );
    const onPauseHandler = createOnpauseHandler(
        cueId, sound, playingState, currentItemNameForEvents, audioControllerContext
    );
    const onEndHandler = createOnendHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext
    );
    const onStopHandler = createOnstopHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext
    );
    const onFadeHandler = createOnfadeHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext
    );

    sound.on('play', onPlayHandler);
    sound.on('pause', onPauseHandler);
    sound.on('end', onEndHandler);
    sound.on('stop', onStopHandler);
    sound.on('fade', onFadeHandler);

    const teardownAnalyser = () => teardownAnalyserForState(cueId, playingState, audioControllerContext);

    if (!useHtml5) {
        setupAnalyserForSound(cueId, sound, playingState, audioControllerContext);
    } else {
        teardownAnalyser();
    }

    const onloadErrorBase = createOnloaderrorHandler(
        cueId, filePath, currentItemNameForEvents, audioControllerContext
    );
    const onplayErrorBase = createOnplayerrorHandler(
        cueId, filePath, currentItemNameForEvents, audioControllerContext
    );

    let fallbackTriggered = false;

    const attemptHtml5Fallback = (error, source) => {
        if (!fallbackEnabled || fallbackTriggered) {
            return false;
        }
        fallbackTriggered = true;
        console.warn(`[AUDIO_FALLBACK ${cueId}] ${source} error encountered (${error}). Retrying with HTML5 audio for ${filePath}.`);

        try {
            sound.off();
        } catch (offError) {
            console.warn(`[AUDIO_FALLBACK ${cueId}] Error removing event listeners before fallback:`, offError);
        }

        try {
            sound.unload();
        } catch (unloadError) {
            console.warn(`[AUDIO_FALLBACK ${cueId}] Error unloading sound before fallback:`, unloadError);
        }

        teardownAnalyser();

        if (allSoundInstances && sound._acSoundId && allSoundInstances[sound._acSoundId]) {
            delete allSoundInstances[sound._acSoundId];
        }

        const fallbackSound = createPlaybackInstance(
            filePath,
            cueId,
            mainCue,
            playingState,
            currentItemNameForEvents,
            actualItemIndexInOriginalList,
            isResumeForSeekAndFade,
            audioControllerContext,
            { forceHtml5: true, allowHtml5Fallback: false }
        );

        if (fallbackSound) {
            playingState.sound = fallbackSound;
            if (currentlyPlaying && currentlyPlaying[cueId]) {
                currentlyPlaying[cueId].sound = fallbackSound;
            }
        }

        return true;
    };

    const handleLoadError = (id, err) => {
        if (attemptHtml5Fallback(err, 'load')) {
            return;
        }
        onloadErrorBase(id, err);
    };

    const handlePlayError = (id, err) => {
        if (attemptHtml5Fallback(err, 'play')) {
            return;
        }
        onplayErrorBase(id, err);
    };

    sound.on('loaderror', handleLoadError);
    sound.on('playerror', handlePlayError);
    
    // Immediately track all sound instances for stop all functionality
    const soundId = sound._id || `${cueId}_${Date.now()}_${Math.random()}`;
    sound._acSoundId = soundId; // Store our custom ID on the sound
    if (allSoundInstances) {
        allSoundInstances[soundId] = { sound, cueId, playingState };
        // Sound instance registration debug removed
    } else {
        console.error(`[STOP_ALL_DEBUG] allSoundInstances not available for ${cueId}`);
    }
    
    // Return the sound instance with event handlers
    console.log(`[AUDIO_INSTANCE ${cueId}] Creating Howl instance for: ${filePath}`);
    
    // Explicitly trigger loading if preload is true
    if (sound.state() === 'unloaded') {
        console.log(`[AUDIO_INSTANCE ${cueId}] Sound is unloaded, triggering load() for: ${filePath}`);
        sound.load();
    } else {
        console.log(`[AUDIO_INSTANCE ${cueId}] Sound state: ${sound.state()}`);
    }
    
    return sound;
}

function setupAnalyserForSound(cueId, sound, playingState, audioControllerContext) {
    if (!sound || !playingState) return;
    if (typeof Howler === 'undefined' || !Howler.ctx) {
        playingState.meterAnalyser = null;
        playingState.meterDataArray = null;
        playingState.meterAnalyserSourceNode = null;
        return;
    }

    try {
        const analyser = Howler.ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.7;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        playingState.meterAnalyser = analyser;
        playingState.meterDataArray = dataArray;
        playingState.meterAnalyserSourceNode = null;

        const connectAnalyser = (internalSound) => {
            if (!internalSound) return;
            const outputNode = internalSound._panner || internalSound._node;
            if (!outputNode || typeof outputNode.connect !== 'function') return;
            if (playingState.meterAnalyserSourceNode === outputNode) return;

            try {
                outputNode.connect(analyser);
                playingState.meterAnalyserSourceNode = outputNode;
                if (audioControllerContext?.cueGridAPI && typeof audioControllerContext.cueGridAPI.updateCueMeterLevel === 'function') {
                    audioControllerContext.cueGridAPI.updateCueMeterLevel(cueId, 0, { immediate: true });
                }
            } catch (connectionError) {
                console.warn(`[METER_DEBUG ${cueId}] Failed to connect analyser:`, connectionError);
            }
        };

        const disconnectAnalyser = () => {
            if (playingState.meterAnalyserSourceNode && analyser) {
                try {
                    playingState.meterAnalyserSourceNode.disconnect(analyser);
                } catch (disconnectError) {
                    console.warn(`[METER_DEBUG ${cueId}] Error disconnecting analyser:`, disconnectError);
                }
            }
            playingState.meterAnalyserSourceNode = null;
            if (audioControllerContext?.cueGridAPI && typeof audioControllerContext.cueGridAPI.resetCueMeter === 'function') {
                audioControllerContext.cueGridAPI.resetCueMeter(cueId, { immediate: true });
            }
        };

        sound.on('play', (soundId) => {
            const internalSound = typeof sound._soundById === 'function' ? sound._soundById(soundId) : null;
            connectAnalyser(internalSound);
            playingState.meterCalibrationMax = 0.25;
        });

        sound.on('stop', () => disconnectAnalyser());
        sound.on('end', () => disconnectAnalyser());
        sound.on('pause', () => {
            if (audioControllerContext?.cueGridAPI && typeof audioControllerContext.cueGridAPI.updateCueMeterLevel === 'function') {
                audioControllerContext.cueGridAPI.updateCueMeterLevel(cueId, 0, { immediate: false });
            }
        });
    } catch (analyserError) {
        console.warn(`[METER_DEBUG ${cueId}] Unable to initialize analyser:`, analyserError);
        playingState.meterAnalyser = null;
        playingState.meterDataArray = null;
        playingState.meterAnalyserSourceNode = null;
    }
}

function teardownAnalyserForState(cueId, playingState, audioControllerContext) {
    if (!playingState) return;

    if (playingState.meterAnalyserSourceNode && playingState.meterAnalyser) {
        try {
            playingState.meterAnalyserSourceNode.disconnect(playingState.meterAnalyser);
        } catch (disconnectError) {
            console.warn(`[METER_DEBUG ${cueId}] Error disconnecting analyser:`, disconnectError);
        }
    }

    playingState.meterAnalyserSourceNode = null;
    playingState.meterAnalyser = null;
    playingState.meterDataArray = null;

    if (audioControllerContext?.cueGridAPI && typeof audioControllerContext.cueGridAPI.resetCueMeter === 'function') {
        audioControllerContext.cueGridAPI.resetCueMeter(cueId, { immediate: true });
    }

    playingState.meterCalibrationMax = null;
}
