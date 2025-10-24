/**
 * Error event handlers for Howler sound instances (onloaderror, onplayerror)
 */

/**
 * Create onloaderror event handler
 * @param {string} cueId - The cue ID
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onloaderror event handler
 */
export function createOnloaderrorHandler(cueId, filePath, currentItemNameForEvents, audioControllerContext) {
    return (id, err) => {
        const errorDetails = err || 'Unknown error';
        const fileExtension = filePath.split('.').pop()?.toLowerCase();
        
        console.error(`[ONLOADERROR_DEBUG ${cueId}] onloaderror: Failed to load ${filePath}: ${errorDetails} (Sound ID: ${id})`);
        console.error(`[ONLOADERROR_DEBUG ${cueId}] File extension: ${fileExtension}, Full error:`, err);
        
        // Provide specific guidance for problematic file types
        if (fileExtension === 'm4a') {
            console.warn(`[ERROR_HANDLER ${cueId}] .m4a file failed to load. This might be due to codec issues. Consider converting to .mp3 or .wav for better compatibility.`);
        } else if (fileExtension === 'mp3') {
            console.warn(`[ERROR_HANDLER ${cueId}] .mp3 file failed to load. This might be due to codec issues or file corruption. Consider re-encoding the file or converting to .wav for better compatibility.`);
        } else if (fileExtension === 'wav') {
            console.warn(`[ERROR_HANDLER ${cueId}] .wav file failed to load. This might be due to file corruption, unsupported sample rate, or bit depth. WAV files should use Web Audio API (not HTML5). Check file integrity.`);
        }
        
        // Simplified error cleanup
        if (audioControllerContext && audioControllerContext.currentlyPlaying) {
            // Don't delete if preserved for navigation
            if (audioControllerContext.currentlyPlaying[cueId]?.preservedForNavigation) {
                console.log(`[ERROR_HANDLER ${cueId}] State preserved for navigation, skipping cleanup`);
            } else {
                delete audioControllerContext.currentlyPlaying[cueId];
            }
            
            // Update UI
            if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            }
            
            // Send error notification via IPC
            if (audioControllerContext.ipcBindings && audioControllerContext.ipcBindings.send) {
                audioControllerContext.ipcBindings.send('cue-status-update', { 
                    cueId: cueId, 
                    status: 'error', 
                    details: { 
                        error: err,
                        itemName: currentItemNameForEvents,
                        reason: 'audio_load_error'
                    } 
                });
            }
        }
    };
}

/**
 * Create onplayerror event handler
 * @param {string} cueId - The cue ID
 * @param {string} filePath - The file path
 * @param {string} currentItemNameForEvents - Current item name for events
 * @param {object} audioControllerContext - Audio controller context
 * @returns {function} The onplayerror event handler
 */
export function createOnplayerrorHandler(cueId, filePath, currentItemNameForEvents, audioControllerContext) {
    return (id, err) => {
        console.error(`[ERROR_HANDLER ${cueId}] onplayerror: Failed to play ${filePath}:`, err, `(Sound ID: ${id})`);
        
        // Simplified error cleanup  
        if (audioControllerContext && audioControllerContext.currentlyPlaying) {
            delete audioControllerContext.currentlyPlaying[cueId];
            
            // Update UI
            if (audioControllerContext.cueGridAPI && audioControllerContext.cueGridAPI.updateButtonPlayingState) {
                audioControllerContext.cueGridAPI.updateButtonPlayingState(cueId, false);
            }
            
            // Send error notification via IPC
            if (audioControllerContext.ipcBindings && audioControllerContext.ipcBindings.send) {
                audioControllerContext.ipcBindings.send('cue-status-update', { 
                    cueId: cueId, 
                    status: 'error', 
                    details: { 
                        error: err,
                        itemName: currentItemNameForEvents,
                        reason: 'audio_play_error'
                    } 
                });
            }
        }
    };
}
