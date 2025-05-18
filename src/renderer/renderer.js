// Companion_soundboard/src/renderer/renderer.js
// Main entry point for the renderer process.
// Initializes and coordinates other renderer modules.

import * as ipcRendererBindings from './ipcRendererBindings.js';
import * as cueStore from './cueStore.js';
import * as audioController from './audioController.js';
import * as ui from './ui.js';
import * as dragDropHandler from './dragDropHandler.js';
import * as appConfigUI from './ui/appConfigUI.js';
import * as waveformControls from './ui/waveformControls.js';
import * as sidebars from './ui/sidebars.js'; // Import sidebars module

// Function to wait for electronAPI and its methods to be ready
async function ensureElectronApiReady() {
  return new Promise(resolve => {
    const checkInterval = setInterval(() => {
      if (window.electronAPI && typeof window.electronAPI.whenMainReady === 'function') {
        clearInterval(checkInterval);
        console.log('Renderer: window.electronAPI.whenMainReady is available.');
        resolve(window.electronAPI);
      } else {
        console.log('Renderer: Waiting for window.electronAPI.whenMainReady to become available...');
      }
    }, 50); // Check every 50ms
  });
}

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Renderer process starting initialization...');

    const electronAPI = await ensureElectronApiReady();

    // 1. Initialize IPC Bindings (sets up listeners but refs are null initially)
    ipcRendererBindings.initialize(electronAPI);

    // 2. Initialize AppConfigUI (loads config from main)
    appConfigUI.init(electronAPI); // Assuming it needs electronAPI for getAppConfig etc.

    // 3. Initialize CueStore (needs electronAPI for initial cue load)
    //    Pass `ui` module later if needed for specific refresh calls after ui.init
    cueStore.init(electronAPI, null /* sidebarsAPI placeholder for now */, ui /* main ui module for refreshCueGrid */);

    // 4. Initialize AudioController (needs cueStore and electronAPI)
    //    UI handles (cueGridAPI, sidebarsAPI) will be passed later if needed, or init signature adapted.
    //    For now, its init signature is: init(cs, ipcRendererBindings, cgAPI, sbAPI)
    //    Let's pass electronAPI for ipcRendererBindings arg, and null for cgAPI, sbAPI for now.
    audioController.init(cueStore, electronAPI, null /* cueGridAPI placeholder */, null /* sidebarsAPI placeholder */);

    // 5. Initialize WaveformControls (needs electronAPI for IPC, audioController for playback)
    console.log('Renderer (DEBUG): Inspecting sidebars module before waveformControls.init:', sidebars);
    console.log('Renderer (DEBUG): typeof sidebars.handleCuePropertyChangeFromWaveform:', typeof sidebars.handleCuePropertyChangeFromWaveform);
    waveformControls.init({
        ipcRendererBindings: electronAPI, // Pass electronAPI as ipcRendererBindings
        onTrimChange: sidebars.handleCuePropertyChangeFromWaveform // ADDED new way
    });

    // 6. Initialize Main UI module, which also initializes its sub-modules (cueGrid, sidebars, modals)
    //    It needs references to the already created module *instances* or *module objects*.
    const uiHandles = await ui.init(
        cueStore,         // Initialized module
        audioController,  // Initialized module
        electronAPI,      // electronAPI instance from preload
        dragDropHandler,  // Module object (init called later)
        appConfigUI,      // Initialized module
        waveformControls  // Initialized module
    );

    // 7. Initialize DragDropHandler (now with a more initialized ui module and cueStore)
    dragDropHandler.init(ui, cueStore, appConfigUI, uiHandles.modals);

    // 8. NOW, set the module references in ipcRendererBindings so its listeners can act fully.
    ipcRendererBindings.setModuleRefs({
        audioCtrl: audioController,
        dragDropCtrl: dragDropHandler,
        cueStoreMod: cueStore,
        uiMod: ui, // Main ui module
        appConfigUIMod: appConfigUI,
        cueGridAPI: uiHandles.cueGridModule,
        sidebarsAPI: uiHandles.sidebarsModule,
        modals: uiHandles.modals
    });

    // 9. Update modules that might need specific UI handles from ui.init
    //    Example: If audioController's init was partial due to missing UI handles.
    //    The current audioController.init expects cgAPI and sbAPI.
    //    Let's refine its init or add setters. For now, re-calling or using setters if they exist.
    //    If audioController.init can be called again or has setters for these:
    if (uiHandles.cueGridModule && uiHandles.sidebarsModule) {
         // This is a bit awkward. Ideally, audioController.init takes what it needs upfront,
         // or ui.init doesn't need a fully initialized audioController if audioController needs ui sub-modules.
         // For now, let's assume audioController can handle nulls for cgAPI/sbAPI or we call a setter.
         // Call the new setter function in audioController
         console.log('Renderer: Calling audioController.setUIRefs with uiHandles.');
         audioController.setUIRefs(uiHandles.cueGridModule, uiHandles.sidebarsModule);
    }
    if (uiHandles.sidebarsModule && typeof cueStore.setSidebarsModule === 'function') {
        cueStore.setSidebarsModule(uiHandles.sidebarsModule);
    }

    // 10. Load initial data and render UI
    try {
        await ui.loadAndRenderCues(); 
        console.log('Cues loaded and UI rendered.');
    } catch (error) {
        console.error('Error during initial cue load and render:', error);
        const body = document.querySelector('body');
        if (body) {
            body.innerHTML = '<div style="color: red; padding: 20px;"><h1>Error initializing application</h1><p>Could not load cue data. Please check console for details and try restarting.</p></div>';
        }
    }

    console.log('Renderer: All renderer modules initialized.');

    // Listen for user activity to reset inactivity timer for Easter Egg
    const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
    let activityTimeout = null;
    const debounceActivityReset = () => {
        clearTimeout(activityTimeout);
        activityTimeout = setTimeout(() => {
            if (window.electronAPI && typeof window.electronAPI.resetInactivityTimer === 'function') {
                console.log('Renderer: User activity detected, resetting inactivity timer via IPC.');
                window.electronAPI.resetInactivityTimer();
            }
        }, 300); // Debounce for 300ms
    };

    activityEvents.forEach(eventType => {
        document.addEventListener(eventType, debounceActivityReset, true); // Use capture phase
    });

    // Add listener for the Dev Easter Egg Button
    const devEasterEggButton = document.getElementById('devEasterEggButton');
    if (devEasterEggButton && electronAPI && typeof electronAPI.openEasterEggGame === 'function') {
        devEasterEggButton.addEventListener('click', () => {
            console.log('Dev Easter Egg Button clicked. Sending IPC to open game.');
            electronAPI.openEasterEggGame();
        });
    } else {
        if (!devEasterEggButton) console.warn('Dev Easter Egg Button not found.');
        if (!electronAPI || typeof electronAPI.openEasterEggGame !== 'function') console.warn('electronAPI.openEasterEggGame not available.');
    }
}); 