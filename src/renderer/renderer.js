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
import * as sidebars from './ui/propertiesSidebar.js'; // Import propertiesSidebar module as 'sidebars'

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

    console.log('Renderer: Ensuring Electron API is ready...');
    await ensureElectronApiReady(); // Wait for window.electronAPI
    const electronAPI = window.electronAPI;
    console.log('Renderer: Electron API is ready.');

    // 1. Initialize IPC Renderer Bindings (needs electronAPI)
    console.log('Renderer: Initializing IPC Renderer Bindings...');
    ipcRendererBindings.initialize(electronAPI);
    console.log('Renderer: IPC Renderer Bindings initialized.');

    // 2. Initialize AppConfigUI (needs electronAPI)
    // This should return the initial config for AudioController
    console.log('Renderer: Initializing AppConfigUI...');
    const initialAppConfig = await appConfigUI.init(electronAPI);
    if (!initialAppConfig || Object.keys(initialAppConfig).length === 0) {
        console.warn('Renderer: AppConfigUI.init did not return a valid config. AudioController will use defaults or its own loaded config initially.');
    }
    console.log('Renderer: AppConfigUI initialized. Received config:', initialAppConfig);

    // 3. Initialize Main UI module (which also initializes its sub-modules: cueGrid, sidebars, modals)
    // This needs to happen before CueStore and AudioController if they depend on UI handles directly.
    console.log('Renderer: Initializing Main UI Module (ui.js)...');
    const uiHandles = await ui.init(
        cueStore,         // cueStore module (not yet fully initialized with UI refs, but object exists)
        audioController,  // audioController module (not yet fully initialized with UI refs, but object exists)
        electronAPI,      // electronAPI instance from preload
        dragDropHandler,  // Module object (init called later)
        appConfigUI,      // Initialized module
        waveformControls, // Initialized module (init called right before or during ui.init ideally)
        ipcRendererBindings // Pass the actual imported module (for uiCoreInterface)
    );
    console.log('Renderer: Main UI Module initialized. Received uiHandles:', uiHandles);

    // 4. Initialize CueStore (needs electronAPI and UI Handles for refreshes)
    console.log('Renderer: Initializing CueStore...');
    cueStore.init(ipcRendererBindings, uiHandles); // Pass uiHandles
    console.log('Renderer: CueStore initialized.');

    // 5. Initialize AudioController (needs cueStore, electronAPI, and UI Handles)
    console.log('Renderer: Initializing AudioController...');
    await audioController.default.init(cueStore, electronAPI, uiHandles.cueGridModule, uiHandles.propertiesSidebarModule);
    console.log('Renderer: AudioController initialized.');

    // Update AudioController with the configuration obtained from AppConfigUI BEFORE connecting
    if (initialAppConfig && audioController.default && typeof audioController.default.updateAppConfig === 'function') {
        console.log('Renderer: Passing initialAppConfig to audioController.default.updateAppConfig.');
        audioController.default.updateAppConfig(initialAppConfig);
    } else {
        console.warn('Renderer: initialAppConfig not available or audioController.default.updateAppConfig is not a function. AC will use its own loaded config or defaults.');
    }

    // Connect AudioController to AppConfigUI for device changes
    console.log('Renderer: Connecting AudioController to AppConfigUI...');
    appConfigUI.setAudioControllerRef(audioController.default);
    console.log('Renderer: AudioController connected to AppConfigUI.');

    // 6. Initialize WaveformControls (needs electronAPI for IPC, audioController for playback)
    // 'sidebars' here is the imported propertiesSidebar.js aliased as sidebars.
    // Ensure propertiesSidebar.js exports handleCuePropertyChangeFromWaveform correctly.
    console.log('Renderer: Checking sidebars module:', sidebars);
    console.log('Renderer: sidebars keys:', sidebars ? Object.keys(sidebars) : 'null');
    console.log('Renderer: handleCuePropertyChangeFromWaveform type:', typeof sidebars.handleCuePropertyChangeFromWaveform);
    
    if (sidebars && typeof sidebars.handleCuePropertyChangeFromWaveform === 'function') {
        console.log('Renderer: Found handleCuePropertyChangeFromWaveform, initializing waveformControls with callback');
        waveformControls.init({
            ipcRendererBindings: electronAPI, // Pass electronAPI for IPC communication
            onTrimChange: sidebars.handleCuePropertyChangeFromWaveform
        });
    } else {
        console.error('Renderer: sidebars.handleCuePropertyChangeFromWaveform is not available for WaveformControls init.');
        console.log('Renderer: Available sidebars methods:', sidebars ? Object.keys(sidebars).filter(key => typeof sidebars[key] === 'function') : 'none');
        // Fallback initialization for waveformControls if the callback is missing
        waveformControls.init({ 
            ipcRendererBindings: electronAPI, 
            onTrimChange: () => {
                console.warn('Renderer: Fallback onTrimChange called - no sidebar integration');
            } 
        });
    }

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
         audioController.default.setUIRefs(uiHandles.cueGridModule, uiHandles.propertiesSidebarModule);
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
    
    // CRITICAL: Expose UI module to window for crossfade access
    window.ui = ui;
    console.log('Renderer: UI module exposed to window.ui for crossfade access');
    console.log('Renderer: UI.isCrossfadeEnabled available:', typeof ui.isCrossfadeEnabled);


    // Add keyboard shortcut for Easter Egg Game (Control+Alt+P)
    window.addEventListener('keydown', (event) => {
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