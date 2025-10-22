// Companion_soundboard/src/renderer/audioPlaybackUtilities.js
// Utility functions for audio playback management

import { log } from './audioPlaybackLogger.js';
import { cleanupAllResources } from './audioPlaybackUtils.js';
import { _cuePlaylistAtPosition } from './audioPlaybackPlaylist.js';

export function seekInCue(cueId, positionSec, context) {
    const {
        currentlyPlaying,
        sendPlaybackTimeUpdateRef,
        getGlobalCueByIdRef
    } = context;

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

export function stopAllCues(options = { exceptCueId: null, useFade: true }, context) {
    const {
        currentlyPlaying,
        allSoundInstances,
        getAppConfigFuncRef,
        cueGridAPIRef,
        getGlobalCueByIdRef
    } = context;

    console.log('🛑 AudioPlaybackManager: stopAllCues called. Options:', options);
    console.log('🛑 Current currentlyPlaying:', Object.keys(currentlyPlaying));
    console.log('🛑 Current allSoundInstances:', Object.keys(allSoundInstances));

    // Remember which playlists had cued states for restoration after stop
    const playlistsToRestoreCued = [];
    Object.keys(currentlyPlaying).forEach(cueId => {
        const state = currentlyPlaying[cueId];
        const cue = getGlobalCueByIdRef && getGlobalCueByIdRef(cueId);
        
        // Check if this is a playlist in stop_and_cue_next mode that should be cued after stop
        if (state && state.isPlaylist && cue && cue.type === 'playlist' && 
            cue.playlistPlayMode === 'stop_and_cue_next') {
            playlistsToRestoreCued.push({
                cueId: cueId,
                cue: cue,
                currentIndex: state.currentPlaylistItemIndex || 0
            });
            console.log(`🛑 Will restore cued state for playlist ${cueId} at index ${state.currentPlaylistItemIndex}`);
        }
    });

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
    
    // Restore cued states for playlists in stop_and_cue_next mode after all sounds have stopped
    if (playlistsToRestoreCued.length > 0) {
        const appConfig = getAppConfigFuncRef ? getAppConfigFuncRef() : {};
        const fadeOutTime = useFadeForStop ? (appConfig.defaultStopAllFadeOutTime !== undefined ? appConfig.defaultStopAllFadeOutTime : 1500) : 0;
        const restoreDelay = fadeOutTime + 100; // Wait for fade to complete plus a small buffer
        
        setTimeout(() => {
            playlistsToRestoreCued.forEach(playlistInfo => {
                const { cueId, cue, currentIndex } = playlistInfo;
                console.log(`🛑 Restoring cued state for playlist ${cueId} at index ${currentIndex}`);
                
                // Use the helper function to restore cued state
                _cuePlaylistAtPosition(
                    cueId, 
                    currentIndex, 
                    context.currentlyPlaying, 
                    context.getGlobalCueByIdRef,
                    context._generateShuffleOrder,
                    context.sidebarsAPIRef,
                    context.cuePlayOrder || [],
                    context.sendPlaybackTimeUpdateRef
                );
            });
        }, restoreDelay);
    }
}
