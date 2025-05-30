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
import * as sidebars from './ui/propertiesSidebar.js'; // Import and alias propertiesSidebar as sidebars

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
    appConfigUI.init(electronAPI);

    // After AppConfigUI is initialized, get the config and provide it to AudioController
    const currentAppConfig = appConfigUI.getCurrentAppConfig();
    if (currentAppConfig && Object.keys(currentAppConfig).length > 0) {
        if (typeof audioController.updateAppConfig === 'function') {
            audioController.updateAppConfig(currentAppConfig);
            console.log('Renderer: App config passed to AudioController.');
        } else {
            console.error('Renderer: audioController.updateAppConfig is not a function.');
        }
    } else {
        console.warn('Renderer: AppConfigUI did not return a valid config to pass to AudioController.');
    }

    // 3. Initialize CueStore (needs electronAPI for initial cue load)
    // Pass ui module directly for refreshCueGrid. Sidebars placeholder remains for now.
    cueStore.init(electronAPI, null /* sidebarsAPI placeholder */, ui /* main ui module for refreshCueGrid */);

    // 4. Initialize AudioController (needs cueStore and electronAPI)
    // No direct UI handles passed here initially; they'll be set later via setUIRefs.
    await audioController.init(cueStore, electronAPI, null /* cueGridAPI placeholder */, null /* sidebarsAPI placeholder */);

    // 5. Initialize WaveformControls (needs electronAPI for IPC, audioController for playback)
    // 'sidebars' here is the imported propertiesSidebar.js aliased as sidebars.
    // Ensure propertiesSidebar.js exports handleCuePropertyChangeFromWaveform correctly.
    if (sidebars && typeof sidebars.handleCuePropertyChangeFromWaveform === 'function') {
        waveformControls.init({
            ipcRendererBindings: electronAPI, // Pass electronAPI as ipcRendererBindings
            onTrimChange: sidebars.handleCuePropertyChangeFromWaveform
        });
    } else {
        console.error('Renderer: sidebars.handleCuePropertyChangeFromWaveform is not available for WaveformControls init.');
        // Fallback initialization for waveformControls if the callback is missing, or handle error appropriately
        waveformControls.init({ ipcRendererBindings: electronAPI, onTrimChange: () => {} });
    }

    // 6. Initialize Main UI module, which also initializes its sub-modules (cueGrid, sidebars, modals)
    const uiHandles = await ui.init(
        cueStore,         // Initialized module
        audioController,  // Initialized module
        electronAPI,      // electronAPI instance from preload
        dragDropHandler,  // Module object (init called later)
        appConfigUI,      // Initialized module
        waveformControls, // Initialized module
        ipcRendererBindings // Pass the actual imported module (for uiCoreInterface)
    );

    // 7. Set Module References for IPC Bindings AFTER core modules and UI are initialized
    // This allows IPC messages to be correctly routed to initialized modules.
    ipcRendererBindings.setModuleRefs({
        audioCtrl: audioController,
        dragDropCtrl: dragDropHandler, // dragDropHandler is not fully initialized yet, but its module object can be passed
        cueStoreMod: cueStore,
        uiMod: ui, // The main ui module, now initialized
        appConfigUIMod: appConfigUI,
        cueGridAPI: uiHandles.cueGridModule, // API/module from ui.init
        sidebarsAPI: uiHandles.propertiesSidebarModule, // API/module from ui.init (this is propertiesSidebar)
        modals: uiHandles.modalsModule // API/module from ui.init
    });

    // 8. Initialize DragDropHandler (now with ui and cueStore fully initialized)
    // Pass uiHandles.modalsModule, which is the modals module itself from ui.init return.
    dragDropHandler.init(ui, cueStore, appConfigUI, uiHandles.modalsModule);

    // 9. Update modules that might need specific UI handles from ui.init
    if (uiHandles.cueGridModule && uiHandles.propertiesSidebarModule) {
         audioController.setUIRefs(uiHandles.cueGridModule, uiHandles.propertiesSidebarModule);
    }
    // Pass the propertiesSidebar module to cueStore if it has a setter for it.
    if (uiHandles.propertiesSidebarModule && typeof cueStore.setSidebarsModule === 'function') {
        cueStore.setSidebarsModule(uiHandles.propertiesSidebarModule);
    }

    // 10. Load initial data and render UI (triggers cueGrid.renderCues via ui.js)
    try {
        await ui.loadAndRenderCues(); 
        console.log('Renderer: Cues loaded and UI rendered after all initializations.');
    } catch (error) {
        console.error('Renderer: Error during final cue load and render:', error);
        const body = document.querySelector('body');
        if (body) {
            body.innerHTML = '<div style="color: red; padding: 20px;"><h1>Error initializing application</h1><p>Could not load cue data. Please check console for details and try restarting.</p></div>';
        }
    }

    console.log('Renderer: All renderer modules initialized.');

    // Remove listener for the Dev Easter Egg Button
    // const devEasterEggButton = document.getElementById('devEasterEggButton');
    // if (devEasterEggButton && electronAPI && typeof electronAPI.openEasterEggGame === 'function') {
    //     devEasterEggButton.addEventListener('click', () => {
    //         console.log('Dev Easter Egg Button clicked. Sending IPC to open game.');
    //         electronAPI.openEasterEggGame();
    //     });
    // } else {
    //     if (!devEasterEggButton) console.warn('Renderer: Dev Easter Egg Button not found.');
    //     if (!electronAPI || typeof electronAPI.openEasterEggGame !== 'function') console.warn('Renderer: electronAPI.openEasterEggGame not available.');
    // }

    // Add keyboard shortcut for Easter Egg Game (Control+Alt+P)
    window.addEventListener('keydown', (event) => {
        // console.log(`Keydown: Ctrl: ${event.ctrlKey}, Alt: ${event.altKey}, Shift: ${event.shiftKey}, Meta: ${event.metaKey}, Key: ${event.key}, Code: ${event.code}`); // Debug log
        if (event.ctrlKey && event.altKey && (event.key === 'P' || event.key === 'p' || event.code === 'KeyP')) {
            event.preventDefault(); 
            console.log('Ctrl+Alt+P shortcut triggered. Sending IPC to open Easter Egg game.');
            if (electronAPI && typeof electronAPI.openEasterEggGame === 'function') {
                electronAPI.openEasterEggGame();
            } else {
                console.warn('Renderer: electronAPI.openEasterEggGame not available for shortcut.');
            }
        }
    });
}); 