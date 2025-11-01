// Companion_soundboard/src/renderer/audioPlaybackPlaylistHandling.js
// Playlist-specific handling functions for audio playback management

import { log } from './audioPlaybackLogger.js';
import { _revertDucking } from './audioPlaybackDucking.js';
import { _generateShuffleOrder } from './audioPlaybackUtils.js';
import { _removeFromPlayOrder, _updateCurrentCueForCompanion, _cleanupSoundInstance } from './audioPlaybackStateManagement.js';

export function _handlePlaylistEnd(cueId, errorOccurred = false, context) {
    const {
        currentlyPlaying,
        getGlobalCueById: getGlobalCueByIdRef,
        _revertDucking,
        _cleanupSoundInstance,
        _updateCurrentCueForCompanion,
        ipcBindingsRef,
        cueGridAPIRef,
        sidebarsAPIRef,
        _playTargetItem,
        sendPlaybackTimeUpdateRef
    } = context;

    const playingState = currentlyPlaying[cueId];
    if (!playingState || !playingState.isPlaylist) {
        console.log(`AudioPlaybackManager: _handlePlaylistEnd called for ${cueId} but not a valid playlist state.`);
        return;
    }
    const mainCue = playingState.cue;
    console.log(`AudioPlaybackManager: Item ended in playlist ${cueId}. Error: ${errorOccurred}, Loop: ${mainCue.loop}, Mode: ${mainCue.playlistPlayMode}`);

    // Time update intervals are now cleared immediately in the onend handler to prevent race conditions

    // Enhanced cleanup for the ended item
    if (playingState.sound) {
        console.log(`AudioPlaybackManager: Cleaning up sound for ended playlist item in ${cueId}`);
        try {
            const soundToCleanup = playingState.sound;
            // Remove all event listeners first to prevent ghost events
            soundToCleanup.off();
            if (soundToCleanup.playing()) {
                soundToCleanup.stop();
            }
            soundToCleanup.unload();
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
        // Use the imported base function directly with the existing context
        if (context) {
            try {
                _cleanupSoundInstance(cueId, playingState, { 
                    forceUnload: true, 
                    source: '_handlePlaylistEnd_error' 
                }, context);
            } catch (cleanupError) {
                console.error(`AudioPlaybackManager: Error during cleanup for ${cueId}:`, cleanupError);
                // Fallback: just delete the state without cleanup
                delete currentlyPlaying[cueId];
            }
        } else {
            console.error(`AudioPlaybackManager: Context is undefined for ${cueId}, deleting state directly`);
            delete currentlyPlaying[cueId];
        }
        
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

        // Time update intervals already cleared at the start of this function

        // If this playlist was a ducking trigger, revert ducking now that it ended and is cued
        const playlistCueDataRepeatOne = getGlobalCueByIdRef(cueId);
        if (playlistCueDataRepeatOne && playlistCueDataRepeatOne.isDuckingTrigger) {
            console.log(`AudioPlaybackManager: Playlist trigger ${cueId} (repeat_one mode) ended and is cued. Reverting ducking.`);
            _revertDucking(cueId, currentlyPlaying);
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

        // CRITICAL FIX: Update UI to indicate it's cued to the same item IMMEDIATELY
        if (cueGridAPIRef) {
            cueGridAPIRef.updateButtonPlayingState(cueId, false, `Next: ${cuedNameRepeat || 'Item'}`, true);
        }
        if (ipcBindingsRef) {
            ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'cued_next', details: { reason: 'repeat_one_cued_same_item', nextItem: cuedNameRepeat } });
        }

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
                // When looping in stop_and_cue_next mode, cue the first item
                if (mainCue.shuffle && listLen > 1) _generateShuffleOrder(cueId, currentlyPlaying);
                playingState.currentPlaylistItemIndex = 0; // Loop back to start
                cuedOK = true;
                console.log(`AudioPlaybackManager: Looping playlist ${cueId} - will cue first item`);
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
                    _revertDucking(cueId, currentlyPlaying);
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

            // Time update intervals already cleared at the start of this function

            // If this playlist, which is now paused and cued, was a ducking trigger, revert ducking.
            const playlistCueData = getGlobalCueByIdRef(cueId); // cueId is the playlist's ID
            if (playlistCueData && playlistCueData.isDuckingTrigger) {
                console.log(`AudioPlaybackManager: Playlist trigger ${cueId} (stop_and_cue_next mode) is now cued/paused. Reverting ducking.`);
                _revertDucking(cueId, currentlyPlaying);
            }

            let cuedOriginalIdx = playingState.currentPlaylistItemIndex; // This is the logical index in current order
            if (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > playingState.currentPlaylistItemIndex) {
                cuedOriginalIdx = playingState.shufflePlaybackOrder[playingState.currentPlaylistItemIndex];
            }
            if (cuedOriginalIdx >= 0 && cuedOriginalIdx < listLen) {
                const item = playingState.originalPlaylistItems[cuedOriginalIdx];
                cuedName = item.name || item.path.split(/[\\\/]/).pop();
            }
            
            // CRITICAL FIX: Update UI state IMMEDIATELY and synchronously, not with a delay
            if (cueGridAPIRef) {
                console.log(`AudioPlaybackManager: Updating UI state for cued playlist ${cueId} with next item: ${cuedName}`);
                cueGridAPIRef.updateButtonPlayingState(cueId, false, `Next: ${cuedName || 'Item'}`, true);
            } else {
                console.log(`AudioPlaybackManager: cueGridAPIRef not yet available for UI update of cued playlist ${cueId}, trying fallback`);
                
                // Try to get UI refs from audioController as fallback
                try {
                    // Access the UI modules through the global window object
                    if (typeof window !== 'undefined' && window.uiModules && window.uiModules.cueGrid && typeof window.uiModules.cueGrid.updateButtonPlayingState === 'function') {
                        console.log(`AudioPlaybackManager: Using fallback UI ref from window.uiModules.cueGrid for ${cueId}`);
                        window.uiModules.cueGrid.updateButtonPlayingState(cueId, false, `Next: ${cuedName || 'Item'}`, true);
                    } else {
                        console.warn(`AudioPlaybackManager: No fallback UI ref available for ${cueId}. window.uiModules:`, !!window.uiModules, 'cueGrid:', !!window.uiModules?.cueGrid, 'updateButtonPlayingState:', typeof window.uiModules?.cueGrid?.updateButtonPlayingState);
                    }
                } catch (error) {
                    console.error(`AudioPlaybackManager: Error accessing fallback UI ref for ${cueId}:`, error);
                }
            }
            
            // Send IPC status update immediately
            if (ipcBindingsRef) {
                ipcBindingsRef.send('cue-status-update', { cueId: cueId, status: 'cued_next', details: { reason: 'playlist_item_ended_cued_next', nextItem: cuedName } });
            }
            
            // CRITICAL FIX: Send playback time update to companion module for cued state
            // Even though there's no sound instance, we need to inform the companion about the cued status
            console.log(`[COMPANION_UPDATE_DEBUG] About to send cued state. sendPlaybackTimeUpdateRef exists: ${!!sendPlaybackTimeUpdateRef}, playingState exists: ${!!playingState}, cuedName: ${cuedName}`);
            if (sendPlaybackTimeUpdateRef && playingState) {
                console.log(`[COMPANION_UPDATE_DEBUG] Sending cued state update to companion for ${cueId} with item: ${cuedName}`);
                // Pass null for sound since it's cued, and override status to 'paused' (cued is a type of paused state)
                sendPlaybackTimeUpdateRef(cueId, null, playingState, cuedName, 'paused');
                console.log(`[COMPANION_UPDATE_DEBUG] Cued state update sent successfully`);
            } else {
                console.warn(`[COMPANION_UPDATE_DEBUG] FAILED to send cued state - sendPlaybackTimeUpdateRef: ${!!sendPlaybackTimeUpdateRef}, playingState: ${!!playingState}`);
            }
        }
        return;
    }

    // Default: play_through or other modes (if any introduced)
    // BUT: Don't auto-advance if we're in the middle of manual navigation
    if (playingState.isNavigating) {
        console.log(`🔵 AudioPlaybackManager: _handlePlaylistEnd - Skipping auto-advance during manual navigation`);
        return; // Don't auto-advance during manual navigation
    }
    
    playingState.currentPlaylistItemIndex++;
    const nextLogicalIdx = playingState.currentPlaylistItemIndex;
    console.log(`🔵 AudioPlaybackManager: _handlePlaylistEnd - Auto-advancing to index ${nextLogicalIdx}`);
    
    // Determine the effective list of items and its length based on shuffle state
    const itemsToConsider = (mainCue.shuffle && playingState.shufflePlaybackOrder && playingState.shufflePlaybackOrder.length > 0) 
                            ? playingState.shufflePlaybackOrder 
                            : playingState.originalPlaylistItems;
    const effectiveListLength = itemsToConsider.length;

    if (nextLogicalIdx < effectiveListLength) {
        playingState.isPaused = false;
        playingState.isCuedNext = false;
        setTimeout(() => _playTargetItem(cueId, nextLogicalIdx, false, context), 10); // Play next item in the current order
    } else { // Reached end of current playback order
        if (mainCue.loop) {
            if (mainCue.shuffle && playingState.originalPlaylistItems && playingState.originalPlaylistItems.length > 1) {
                _generateShuffleOrder(cueId, currentlyPlaying); // Re-shuffle if looping and shuffle is on
            }
            playingState.currentPlaylistItemIndex = 0; // Reset to start of (potentially new shuffled) order
            playingState.isPaused = false;
            playingState.isCuedNext = false;
            setTimeout(() => _playTargetItem(cueId, 0, false, context), 10);
        } else { // No loop, playlist truly ends
            delete currentlyPlaying[cueId];
            // Remove from play order and update current cue (using imported function directly)
            // Ensure cuePlayOrder exists before using it
            const currentCuePlayOrder = context.cuePlayOrder || [];
            context.cuePlayOrder = _removeFromPlayOrder(cueId, currentCuePlayOrder);
            context.lastCurrentCueId = _updateCurrentCueForCompanion(context.cuePlayOrder, currentlyPlaying, context.lastCurrentCueId, context.sendPlaybackTimeUpdateRef);
            
            // CRITICAL FIX: Ensure UI is updated to show the playlist is stopped
            // Update button state to false (not playing), with no cued override
            if (cueGridAPIRef) {
                cueGridAPIRef.updateButtonPlayingState(cueId, false, null, false);
            } else {
                // Fallback to window.uiModules if cueGridAPIRef is not available
                try {
                    if (typeof window !== 'undefined' && window.uiModules && window.uiModules.cueGrid && typeof window.uiModules.cueGrid.updateButtonPlayingState === 'function') {
                        window.uiModules.cueGrid.updateButtonPlayingState(cueId, false, null, false);
                    }
                } catch (error) {
                    console.error(`AudioPlaybackManager: Error accessing fallback UI ref for ${cueId}:`, error);
                }
            }
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
                _revertDucking(cueId, currentlyPlaying);
            } else {
                 console.log(`AudioPlaybackManager: Playlist cue ${cueId} (play_through mode) ended but was NOT identified as a ducking trigger (fresh: ${isTriggerFreshPlayThrough}, initial: ${isTriggerInitialPlayThrough}). No ducking reversion.`);
            }
        }
    }
}
