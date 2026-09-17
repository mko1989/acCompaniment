// Companion_soundboard/src/renderer/renderer.js
// Main entry point for the browser-based renderer process.
// Initializes and coordinates other renderer modules.
// Adapted from Electron version to use WebSocket instead of IPC.

// Import modules (some may not be ported yet - will be added as we port them)
import * as audioController from './audio/audioController.js';
import * as cueStore from './cueStore.js';
import * as dragDropHandler from './dragDropHandler.js';
import * as ui from './ui.js';
import * as appConfigUI from './ui/appConfigUI.js';
import * as waveformControls from './ui/waveformControls.js';
// import * as sidebars from './ui/propertiesSidebar.js'; // TODO: Port this

// WebSocket connection instance
let websocket = null;

// Callback for cue list updates
let _cueListUpdatedCallback = null;
let cuesUpdatedListenerRegistered = false;
let queuedCuesUpdate = null;

// Function to initialize WebSocket connection
async function initWebSocket() {
    return new Promise((resolve, reject) => {
        try {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}`;
            
            console.log('Renderer: Connecting to WebSocket server at:', wsUrl);
            websocket = new WebSocket(wsUrl);
            
            websocket.onopen = () => {
                console.log('Renderer: WebSocket connected successfully.');
                resolve(websocket);
            };
            
            websocket.onerror = (error) => {
                console.error('Renderer: WebSocket connection error:', error);
                reject(error);
            };
            
            websocket.onclose = () => {
                console.log('Renderer: WebSocket connection closed.');
                // Attempt to reconnect after 3 seconds
                setTimeout(() => {
                    console.log('Renderer: Attempting to reconnect WebSocket...');
                    initWebSocket().catch(err => {
                        console.error('Renderer: Failed to reconnect WebSocket:', err);
                    });
                }, 3000);
            };
            
            websocket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleWebSocketMessage(data);
                } catch (error) {
                    console.error('Renderer: Error parsing WebSocket message:', error);
                }
            };
            
        } catch (error) {
            console.error('Renderer: Error creating WebSocket connection:', error);
            reject(error);
        }
    });
}

// Shows a dismissible banner across the top of the app for audio-engine
// errors broadcast by the server (e.g. output device disconnected).
function showAudioEngineErrorBanner(message) {
    let banner = document.getElementById('audioEngineErrorBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'audioEngineErrorBanner';
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
            'background:#8c3c00', 'color:#fff', 'padding:10px 16px',
            'font-size:14px', 'display:flex', 'justify-content:space-between',
            'align-items:center', 'box-shadow:0 2px 6px rgba(0,0,0,0.4)'
        ].join(';');
        const text = document.createElement('span');
        text.id = 'audioEngineErrorBannerText';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:16px;cursor:pointer;margin-left:12px;';
        closeBtn.addEventListener('click', () => banner.remove());
        banner.appendChild(text);
        banner.appendChild(closeBtn);
        document.body.appendChild(banner);
    }
    document.getElementById('audioEngineErrorBannerText').textContent = `Audio engine error: ${message}`;
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(data) {
    console.log('Renderer: Received WebSocket message:', data.type);
    
    // Route messages to appropriate handlers
    switch (data.type) {
        case 'cues-updated':
        case 'cues-updated-from-main':
            // Handle cues update via registered callback
            const cues = data.payload?.cues || data.payload;
            if (typeof _cueListUpdatedCallback === 'function') {
                console.log(`Renderer: Invoking _cueListUpdatedCallback with ${cues ? cues.length : 'N/A'} cues.`);
                _cueListUpdatedCallback(cues);
            } else {
                console.warn('Renderer: cues-updated event received, but _cueListUpdatedCallback is not registered.');
                // Queue the update if callback not yet registered
                queuedCuesUpdate = cues;
            }
            break;
            
        case 'config-updated':
            // Handle config update
            const config = data.payload?.config || data.payload;
            if (window.ui && typeof window.ui.applyAppConfiguration === 'function') {
                window.ui.applyAppConfiguration(config);
            } else if (window.appConfigUI && typeof window.appConfigUI.populateConfigSidebar === 'function') {
                window.appConfigUI.populateConfigSidebar(config);
            }
            break;
            
        case 'workspace-updated':
            // Handle workspace update
            console.log('Renderer: Workspace updated:', data.payload);
            if (window.ui && typeof window.ui.handleWorkspaceChange === 'function') {
                window.ui.handleWorkspaceChange();
            }
            break;
            
        case 'playback-time-update':
            if (data.payload && window.ui && typeof window.ui.updateCueButtonTimeDisplay === 'function') {
                window.ui.updateCueButtonTimeDisplay(data.payload);
            }
            if (data.payload?.cueId && window.audioController?.updateServerPlaybackState) {
                window.audioController.updateServerPlaybackState({
                    cueId: data.payload.cueId,
                    status: data.payload.status,
                    currentTimeSec: data.payload.currentTimeSec,
                    totalTimeSec: data.payload.totalDurationSec,
                });
            }
            break;

        case 'cue_status':
            if (data.payload && window.ui && typeof window.ui.handleCueStatusUpdate === 'function') {
                window.ui.handleCueStatusUpdate(data.payload);
            }
            if (data.payload && window.audioController?.updateServerPlaybackState) {
                window.audioController.updateServerPlaybackState(data.payload);
            }
            break;

        case 'audio-engine-error':
            // Native audio engine problem (e.g. output device disconnected
            // mid-show). Playback may have silently stopped producing
            // sound - surface it instead of leaving the operator guessing.
            showAudioEngineErrorBanner(data.payload?.message || 'Unknown audio engine error');
            break;

        default:
            // Check if it's a response to an invoke call
            if (data.requestId && data.type && data.type.endsWith('_response')) {
                // This will be handled by the invoke promise handler
                return;
            }
            console.log('Renderer: Unhandled WebSocket message type:', data.type);
    }
}

// WebSocket-based IPC bindings (simplified version)
const websocketBindings = {
    send: (channel, payload) => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
                type: channel,
                payload: payload
            }));
        } else {
            console.warn(`Renderer: WebSocket not connected, cannot send message: ${channel}`);
        }
    },
    
    invoke: async (channel, ...args) => {
        return new Promise((resolve, reject) => {
            if (!websocket || websocket.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }
            
            const requestId = `req_${Date.now()}_${Math.random()}`;
            
            // Set up one-time listener for response
            const responseHandler = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    // Handle both response format and direct response
                    if ((data.type === `${channel}_response` || data.type === `response_${channel}`) && data.requestId === requestId) {
                        websocket.removeEventListener('message', responseHandler);
                        if (data.error) {
                            reject(new Error(data.error));
                        } else {
                            // Return payload if available, otherwise return the whole data
                            resolve(data.payload !== undefined ? data.payload : data);
                        }
                    } else if (data.requestId === requestId) {
                        // Handle direct response with requestId match
                        websocket.removeEventListener('message', responseHandler);
                        if (data.error) {
                            reject(new Error(data.error));
                        } else {
                            resolve(data.payload !== undefined ? data.payload : data);
                        }
                    }
                } catch (error) {
                    websocket.removeEventListener('message', responseHandler);
                    reject(error);
                }
            };
            
            websocket.addEventListener('message', responseHandler);
            
            // Send request - handle single argument vs multiple arguments
            const payload = args.length === 1 ? args[0] : args;
            websocket.send(JSON.stringify({
                type: channel,
                requestId: requestId,
                payload: payload
            }));
            
            // Timeout after 10 seconds
            setTimeout(() => {
                websocket.removeEventListener('message', responseHandler);
                reject(new Error(`Request timeout: ${channel}`));
            }, 10000);
        });
    },
    
    on: (channel, callback) => {
        // Store callback for later use
        if (!websocketBindings._listeners) {
            websocketBindings._listeners = {};
        }
        if (!websocketBindings._listeners[channel]) {
            websocketBindings._listeners[channel] = [];
        }
        websocketBindings._listeners[channel].push(callback);
    },
    
    // Register callback for cue list updates (similar to ipcRendererBindings)
    registerCueListUpdatedCallback: (callback) => {
        console.log('WebSocket Binding: registerCueListUpdatedCallback CALLED. Registering callback:', typeof callback === 'function' ? 'Function received' : 'NOT a function');
        if (typeof callback === 'function') {
            _cueListUpdatedCallback = callback; // Store the callback
            console.log('WebSocket Binding: _cueListUpdatedCallback has been SET.');
            
            // Set up the listener only if it hasn't been done already
            if (!cuesUpdatedListenerRegistered && websocket) {
                console.log(`WebSocket Binding: Setting up 'cues-updated' listener NOW.`);
                // The listener is already set up in handleWebSocketMessage, we just need to mark it as registered
                cuesUpdatedListenerRegistered = true;
                console.log('WebSocket Binding: cues-updated listener has been registered.');
            } else if (cuesUpdatedListenerRegistered) {
                console.log('WebSocket Binding: cues-updated listener was already registered.');
            } else {
                console.error('WebSocket Binding: Cannot register cues-updated listener - websocket not available.');
            }
            
            // Process any queued update immediately with the now registered callback
            if (queuedCuesUpdate) {
                console.log('WebSocket Binding: Found queued cues update. Processing it now with the new callback.');
                if (typeof _cueListUpdatedCallback === 'function') {
                    _cueListUpdatedCallback(queuedCuesUpdate);
                } else {
                    console.error('WebSocket Binding: Queued update exists, but _cueListUpdatedCallback is not callable even after assignment!');
                }
                queuedCuesUpdate = null; // Clear the queue
            }
        } else {
            console.error('WebSocket Binding: Attempted to register a non-function as cue list updated callback.');
        }
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Renderer process starting initialization...');

    try {
        // 1. Initialize WebSocket connection (replaces Electron API)
        console.log('Renderer: Initializing WebSocket connection...');
        await initWebSocket();
        console.log('Renderer: WebSocket connection initialized.');

        // 2. Initialize AppConfigUI (needs WebSocket)
        console.log('Renderer: Initializing AppConfigUI...');
        const initialAppConfig = await appConfigUI.init(websocketBindings);
        console.log('Renderer: AppConfigUI initialized. Received config:', initialAppConfig);

        // 3. Initialize Main UI module (which also initializes its sub-modules: cueGrid, sidebars, modals)
        console.log('Renderer: Initializing Main UI Module (ui.js)...');
        const uiHandles = await ui.init(
            cueStore,         // cueStore module (not yet fully initialized with UI refs, but object exists)
            audioController,  // audioController module (not yet fully initialized with UI refs, but object exists)
            websocketBindings, // WebSocket bindings instead of electronAPI
            dragDropHandler,  // Module object (init called later)
            appConfigUI,      // appConfigUI module (now ported)
            waveformControls, // waveformControls module (now ported)
            websocketBindings // Pass the actual WebSocket bindings (for uiCoreInterface)
        );
        console.log('Renderer: Main UI Module initialized. Received uiHandles:', uiHandles);

        // 4. Initialize CueStore (needs WebSocket and UI Handles for refreshes)
        console.log('Renderer: Initializing CueStore...');
        cueStore.init(websocketBindings, uiHandles); // Pass uiHandles
        console.log('Renderer: CueStore initialized.');

        // 5. Initialize AudioController (needs cueStore, WebSocket, and UI Handles)
        console.log('Renderer: Initializing AudioController...');
        await audioController.default.init(
            cueStore, // cueStore module
            websocket, // WebSocket instance instead of electronAPI
            uiHandles.cueGridModule, // cueGrid module from ui.init
            uiHandles.propertiesSidebarModule // Will be null until propertiesSidebar is ported
        );
        console.log('Renderer: AudioController initialized.');

        // Update AudioController with the configuration obtained from AppConfigUI BEFORE connecting
        if (initialAppConfig && audioController.default && typeof audioController.default.updateAppConfig === 'function') {
            console.log('Renderer: Passing initialAppConfig to audioController.default.updateAppConfig.');
            audioController.default.updateAppConfig(initialAppConfig);
        }
        
        // Set audioController reference in appConfigUI for device changes
        if (appConfigUI && typeof appConfigUI.setAudioControllerRef === 'function') {
            console.log('Renderer: Setting audioController reference in appConfigUI.');
            appConfigUI.setAudioControllerRef(audioController.default);
        }

        // AudioController reference already set above

        // 6. WaveformControls is initialized in ui.js during ui.init()
        // It's already set up with WebSocket bindings and onTrimChange callback

        // 7. Expose modules to window for global access (if needed)
        // Modules are already accessible through their respective exports and references

        // 8. Initialize DragDropHandler (now with ui and cueStore fully initialized)
        console.log('Renderer: Initializing DragDropHandler...');
        dragDropHandler.init(
            ui, // ui module
            cueStore, 
            appConfigUI, // appConfigUI module (now ported)
            uiHandles.modalsModule // modalsModule from ui.init (now ported)
        );
        console.log('Renderer: DragDropHandler initialized.');

        // 9. Update modules that might need specific UI handles from ui.init
        if (uiHandles.cueGridModule) {
            console.log('Renderer: Setting UI refs on AudioController...');
            audioController.default.setUIRefs(uiHandles.cueGridModule, uiHandles.propertiesSidebarModule);
        } else {
            console.warn('Renderer: cueGridModule not yet available. AudioController UI refs will be set later.');
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

        console.log('Renderer: All core modules initialized successfully.');

        // CRITICAL: Expose UI module to window for crossfade access
        window.ui = ui;
        window.audioController = audioController.default;
        console.log('Renderer: UI module exposed to window.ui for crossfade access');
        console.log('Renderer: UI.isCrossfadeEnabled available:', typeof ui.isCrossfadeEnabled);

        // Add keyboard shortcut for Easter Egg Game (Control+Alt+P).
        // The game is self-contained static assets (no backend round-trip
        // needed), so just open it in a new tab/window.
        window.addEventListener('keydown', (event) => {
            if (event.ctrlKey && event.altKey && (event.key === 'P' || event.key === 'p' || event.code === 'KeyP')) {
                event.preventDefault();
                console.log('Ctrl+Alt+P shortcut triggered. Opening Easter Egg game.');
                window.open('/easter_egg_game/game.html', 'accompanimentEasterEgg', 'width=680,height=560');
            }
        });

    } catch (error) {
        console.error('Renderer: Fatal error during initialization:', error);
        const body = document.querySelector('body');
        if (body) {
            body.innerHTML = '<div style="color: red; padding: 20px;"><h1>Error initializing application</h1><p>Failed to initialize. Please check console for details and try restarting.</p></div>';
        }
    }
});

// Export WebSocket instance for use by other modules
export { websocket, websocketBindings };

