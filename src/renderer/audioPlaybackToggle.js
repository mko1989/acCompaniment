// Companion_soundboard/src/renderer/audioPlaybackToggle.js
// Toggle and retrigger behavior logic for audio playback management

import { log } from './audioPlaybackLogger.js';
import { _handleCrossfadeStart } from './audioPlaybackCrossfade.js';
import { playlistNavigateNext } from './audioPlaybackPlaylist.js';
import { _generateShuffleOrder } from './audioPlaybackUtils.js';

export function toggleCue(cueIdToToggle, fromCompanion = false, retriggerBehaviorOverride = null, context) {
    const {
        currentlyPlaying,
        getGlobalCueByIdRef,
        getAppConfigFuncRef,
        pendingRestarts,
        _initializeAndPlayNew,
        _playTargetItem,
        play,
        stop,
        pause
    } = context;

    const cue = getGlobalCueByIdRef(cueIdToToggle);
    if (!cue) {
        console.error(`AudioPlaybackManager: toggleCue() called for non-existent cue ${cueIdToToggle}`);
        return;
    }
    
    // Check if crossfade mode is enabled and this is a new cue (not currently playing)
    const isCrossfadeMode = window.ui && window.ui.isCrossfadeEnabled && window.ui.isCrossfadeEnabled();
    let playingState = currentlyPlaying[cueIdToToggle];
    
    // Debug logging removed for cleaner console output
    
    if (isCrossfadeMode && !playingState) {
        // Crossfade mode: stop all other playing cues and start this one
        console.log(`🎵 AudioPlaybackManager: CROSSFADE MODE ACTIVATED - starting crossfade to cue ${cueIdToToggle}`);
        _handleCrossfadeStart(cueIdToToggle, cue, currentlyPlaying, getAppConfigFuncRef, context.cueGridAPIRef, stop, play, _playTargetItem);
        return;
    } else if (isCrossfadeMode && playingState) {
        console.log(`AudioPlaybackManager: Crossfade mode enabled but cue ${cueIdToToggle} is already playing - using normal retrigger behavior`);
    } else if (!isCrossfadeMode) {
        console.log(`AudioPlaybackManager: Crossfade mode DISABLED - using normal toggle behavior`);
    }
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
            _playTargetItem(cueIdToToggle, playingState.currentPlaylistItemIndex, false, context);
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
                    
                    stop(cueIdToToggle, false, fromCompanion, true, null, context); // Stop immediately (isRetriggerStop=true)
                    // Increased delay for better state cleanup
                    pendingRestarts[cueIdToToggle] = setTimeout(() => { 
                        play(cue, false, context); 
                        delete pendingRestarts[cueIdToToggle];
                    }, 150); // Increased from 50ms to 150ms
                    break;
                case 'stop':
                    stop(cueIdToToggle, false, fromCompanion, true, null, context); // Stop immediately
                    break;
                case 'fade_out_and_stop':
                    stop(cueIdToToggle, true, fromCompanion, true, null, context); // Fade out and stop
                    break;
                case 'do_nothing':
                case 'do_nothing_if_playing':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} retrigger behavior is '${retriggerBehavior}'. No action taken.`);
                    break; // Do nothing
                case 'play_new_instance':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} starting new instance while current is paused.`);
                    // Create new instance without affecting existing state
                    _initializeAndPlayNew(cue, true, context);
                    break;
                case 'replay_current_item':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} replay current item (paused state). Restarting from beginning.`);
                    // For replay, always start from the beginning
                    if (playingState.sound) {
                        playingState.sound.stop();
                    }
                    _initializeAndPlayNew(cue, false, context);
                    break;
                case 'pause':
                case 'toggle_pause_play': // If paused, play
                default: // Default is resume
                    play(cue, true, context); // Resume
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
                    
                    stop(cueIdToToggle, false, fromCompanion, true, null, context); // Stop immediately
                    // Increased delay for better state cleanup
                    pendingRestarts[cueIdToToggle] = setTimeout(() => { 
                        play(cue, false, context); 
                        delete pendingRestarts[cueIdToToggle]; 
                    }, 150); // Increased from 50ms to 150ms
                    break;
                case 'stop':
                    stop(cueIdToToggle, false, fromCompanion, true, null, context);
                    break;
                case 'fade_out_and_stop':
                    stop(cueIdToToggle, true, fromCompanion, true, null, context);
                    break;
                case 'do_nothing':
                case 'do_nothing_if_playing':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} retrigger behavior is '${retriggerBehavior}'. No action taken.`);
                    break; // Do nothing
                case 'play_new_instance':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} starting new instance while current is playing.`);
                    // Create new instance without affecting existing state
                    _initializeAndPlayNew(cue, true, context);
                    break;
                case 'replay_current_item':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} replay current item (playing state). Stopping and preparing to replay.`);
                    // Stop the current instance and prepare for replay
                    stop(cueIdToToggle, false, fromCompanion, true, null, context); // Stop immediately without fade
                    // The cue is now ready to be played again
                    break;
                case 'play_next_item':
                    console.log(`AudioPlaybackManager: Toggle - Cue ${cueIdToToggle} play next item (playlist navigation).`);
                    // Check if this is a playlist cue
                    if (cue.type === 'playlist') {
                        // Use the existing playlist navigation function, passing fromCompanion as fromExternal
                        playlistNavigateNext(cueIdToToggle, fromCompanion, currentlyPlaying, getGlobalCueByIdRef, _playTargetItem, context._generateShuffleOrder, context.startPlaylistAtPosition, context.sidebarsAPIRef, context.cuePlayOrder);
                    } else {
                        console.warn(`AudioPlaybackManager: 'play_next_item' retrigger behavior used on non-playlist cue ${cueIdToToggle}. Defaulting to restart.`);
                        // Fall back to restart for non-playlist cues
                        stop(cueIdToToggle, false, fromCompanion, true, null, context);
                        setTimeout(() => { play(cue, false, context); }, 150);
                    }
                    break;
                case 'pause':
                case 'toggle_pause_play': // If playing, pause
                default: // Default is pause
                    pause(cueIdToToggle, context);
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
        
        play(cue, false, context); // Start fresh
    }
}
