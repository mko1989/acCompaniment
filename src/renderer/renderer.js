// Companion_soundboard/src/renderer/renderer.js
// Main entry point for the renderer process.
// Initializes and coordinates other renderer modules.

import * as ipcRendererBindings from './ipcRendererBindings.js';
import * as cueStore from './cueStore.js';
import * as audioController from './audioController.js';
import * as ui from './ui.js';
import * as dragDropHandler from './dragDropHandler.js';

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Renderer process starting initialization...');

    // Initialize modules in an order that respects dependencies for their init functions.

    // Order note: ipcRendererBindings.initialize takes other modules as arguments.
    // This implies it might register IPC handlers that call functions on these modules.
    // Ideally, modules should be fully initialized *before* being passed to something that might call them.
    // This is a potential area for future refactoring to ensure robustness.
    // For now, we assume IPC handlers are not called *during* this initial setup sequence.

    // 1. cueStore: Needs ipcRendererBindings (which is problematic if ipcRendererBindings isn't fully ready)
    //    Let's assume ipcRendererBindings can be initialized first without its dependencies fully ready, 
    //    and it stores them for later use by its event handlers.
    //    A more robust pattern might be for ipcRendererBindings to provide an API that modules call to register themselves.
    // cueStore.init(ipcRendererBindings); // Old call

    // 2. dragDropHandler: Needs ui (main module for now) and cueStore.
    //    This is also problematic if 'ui' isn't fully initted. 
    //    Let's assume dragDropHandler.init only sets up its internal state and listeners,
    //    and calls on 'ui' happen later.
    dragDropHandler.init(ui, cueStore); 

    // 3. ui: Initialize UI and its sub-modules. This returns handles to specific sub-modules.
    // It needs cueStore, audioController (the module object itself for now), ipcRendererBindings, dragDropHandler.
    // Passing audioController (module object) here before audioController.init is called might be an issue if ui.init
    // immediately calls functions on audioController that require it to be initialized. Let's assume not for now.
    const uiHandles = await ui.init(cueStore, audioController, ipcRendererBindings, dragDropHandler);

    // Update cueStore init to include sidebarsAPI from uiHandles
    // This needs to happen after ui.init() but before cueStore is heavily used by others or loads data that might trigger updates.
    // Given ipcRendererBindings.initialize uses cueStore, and cueStore might get updates from IPC soon after,
    // initializing cueStore fully here is important.
    cueStore.init(ipcRendererBindings, uiHandles.sidebarsModule, ui);

    // 4. audioController: Needs ipcRendererBindings and specific UI handles from ui.init().
    audioController.init(ipcRendererBindings, uiHandles.cueGridModule, uiHandles.sidebarsModule);
    
    // 5. ipcRendererBindings: Initialize with references to other modules.
    //    This is deferred to last to ensure other modules are as ready as possible.
    //    However, modules initialized earlier (cueStore) already received ipcRendererBindings.
    //    This circular dependency in initialization is tricky.
    //    A more robust DI or event-based system would be better long-term.
    ipcRendererBindings.initialize(
        audioController, // Now audioController is more initialized
        dragDropHandler, 
        cueStore,
        ui // Main ui module (might still be needed by some generic IPC handlers)
    );

    // After all modules are initialized, load initial data and render the UI.
    try {
        // loadAndRenderCues is part of the main ui module
        await ui.loadAndRenderCues(); 
        console.log('Cues loaded and UI rendered.');
    } catch (error) {
        console.error('Error during initial cue load and render:', error);
        const body = document.querySelector('body');
        if (body) {
            body.innerHTML = '<div style="color: red; padding: 20px;"><h1>Error initializing application</h1><p>Could not load cue data. Please check console for details and try restarting.</p></div>';
        }
    }

    console.log('All renderer modules initialized.');
}); 