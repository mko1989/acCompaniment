// Companion_soundboard/src/renderer/ui/utils.js

// Keep a reference to cueStore, will be set by an init function if needed by getGlobalCueById
let cueStoreModule;

function initUtils(cs) {
    cueStoreModule = cs;
}

// Helper function to format seconds into MM:SS
function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) {
        return '--:--';
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Function to allow audioController to get cue data
function getGlobalCueById(cueId) {
    if (cueStoreModule && typeof cueStoreModule.getCueById === 'function') {
        return cueStoreModule.getCueById(cueId);
    }
    console.warn(`UI.utils.getGlobalCueById: cueStoreModule or getCueById is not available. Cue ID: ${cueId}`);
    return null;
}

export {
    initUtils,
    formatTime,
    getGlobalCueById
}; 