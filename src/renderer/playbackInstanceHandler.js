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
    audioControllerContext
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
    
    // If no preloaded sound available, create new one
    if (!sound) {
        console.log(`🎵 Creating new sound instance for ${cueId} (${currentItemNameForEvents})`);
        
        // Use html5 for .m4a, .mp3, and .wav files for better compatibility and replay capability
        const useHtml5 = filePath.toLowerCase().endsWith('.m4a') || 
                        filePath.toLowerCase().endsWith('.mp3') || 
                        filePath.toLowerCase().endsWith('.wav');
        
        // Create the sound instance
        console.log(`🎵 Creating Howl instance for ${cueId}: html5=${useHtml5}, filePath=${filePath}`);
        sound = new Howl({
            src: [filePath],
            volume: initialVolume,
            loop: playingState.isPlaylist ? false : (mainCue.loop || false),
            html5: useHtml5, // Use HTML5 for .m4a and .mp3 files, Web Audio API for others
            preload: true, // Preload for better loop performance
            format: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'], // Specify supported formats
            onload: () => {
                console.log(`[HOWL_ONLOAD ${cueId}] Direct onload event fired for: ${filePath}`);
            },
            onloaderror: createOnloaderrorHandler(
                cueId, filePath, currentItemNameForEvents, audioControllerContext
            ),
            onplayerror: createOnplayerrorHandler(
                cueId, filePath, currentItemNameForEvents, audioControllerContext
            )
        });
    }

    // Set up event handlers after sound instance is created
    sound.on('load', createOnloadHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, 
        actualItemIndexInOriginalList, isResumeForSeekAndFade, mainCue, audioControllerContext
    ));
    sound.on('play', createOnplayHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, 
        actualItemIndexInOriginalList, isResumeForSeekAndFade, mainCue, audioControllerContext
    ));
    sound.on('pause', createOnpauseHandler(
        cueId, sound, playingState, currentItemNameForEvents, audioControllerContext
    ));
    sound.on('end', createOnendHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext
    ));
    sound.on('stop', createOnstopHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext
    ));
    sound.on('fade', createOnfadeHandler(
        cueId, sound, playingState, filePath, currentItemNameForEvents, mainCue, audioControllerContext
    ));
    
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
