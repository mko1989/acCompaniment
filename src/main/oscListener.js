// Generic OSC listener deprecated. Kept as no-op module.
let oscServer = null;

// References to main window and cue manager - likely not needed here anymore
// let winRef = null;
// let cmRef = null;

// function setContext(mainWindow, cueManagerInstance) {
//     winRef = mainWindow;
//     cmRef = cueManagerInstance;
//     console.log('OSC Listener: Context set with mainWindow and cueManager.');
// }

// This function is called by appConfig.js when OSC settings change.
// If this listener is only for *mixer feedback that a mixer module ITSELF doesn't handle*,
// then its configuration might be tied to the mixer's config.
// For now, retain the ability to enable/disable it via general OSC settings.
function initializeOscListener() { /* no-op */ }

function stopOscListener() { /* no-op */ }

function updateOscSettings() { /* no-op */ }

// Learn mode and context for direct cue triggering removed.

/**
 * This function is intended to allow other modules (like a specific mixer integration
 * that doesn't manage its own OSC server) to route messages through this listener.
 * However, current WING integrations manage their own servers.
 */
function handleGenericOscMessage() { /* no-op */ }


module.exports = {
    initializeOscListener,
    stopOscListener,
    updateOscSettings,
    handleGenericOscMessage // Exporting this in case any module wants to use this as a central processing point
    // setContext, // Removed as cmRef and winRef are removed
    // enterLearnMode, // Removed
}; 