const { ipcMain, session, app } = require('electron');
// const { generateUUID } = require('./cueManager'); // Assuming generateUUID is still relevant here or in cueManager
const appConfigManager = require('./appConfig'); // Import the new app config manager
const fs = require('fs').promises; // Make sure fs.promises is available
const { Worker } = require('worker_threads');
const nodePath = require('path'); // To distinguish from browser path module if any
const workspaceManager = require('./workspaceManager');
const cueManager = require('./cueManager');
// const { generateWaveformPeaks } = require('./waveform-generator.js'); // REMOVE THIS LINE
const { v4: uuidv4 } = require('uuid');
const oscListener = require('./oscListener'); // Import oscListener

let appRef; // To store the app instance
let mainWindowRef;
let cueManagerRef;
let appConfigManagerRef; // To store appConfigManager
let workspaceManagerRef;
let websocketServerRef;
let oscListenerRef; // To store oscListener
let resetInactivityTimestampCallbackRef; // New: To store the callback from main.js

function initialize(application, mainWin, cueMgrModule, appCfgManager, wsMgr, wsServer, oscLstnr, resetInactivityCb) {
    appRef = application; // Store app
    mainWindowRef = mainWin;
    cueManagerRef = cueMgrModule; 
    appConfigManagerRef = appCfgManager; // Store appConfigManager
    workspaceManagerRef = wsMgr; 
    websocketServerRef = wsServer;
    oscListenerRef = oscLstnr; // Store oscListener
    resetInactivityTimestampCallbackRef = resetInactivityCb; // Store the callback

    console.log("IPC_HANDLERS_INIT: Initializing with references (including inactivity reset callback).");
    // --- DIAGNOSTIC LOG --- 
    console.log("IPC_HANDLERS_INIT: cueManagerModule type:", typeof cueManagerRef); // Changed to cueManagerRef for clarity
    if (cueManagerRef) {
        console.log("IPC_HANDLERS_INIT: cueManagerModule keys:", Object.keys(cueManagerRef));
        console.log("IPC_HANDLERS_INIT: typeof cueManagerModule.getCues:", typeof cueManagerRef.getCues);
        console.log("IPC_HANDLERS_INIT: typeof cueManagerModule.addOrUpdateProcessedCue:", typeof cueManagerRef.addOrUpdateProcessedCue);
    } else {
        console.error("IPC_HANDLERS_INIT: cueManagerModule is undefined!");
    }
    // --- END DIAGNOSTIC LOG ---

    // --- IPC Handlers ---
    ipcMain.handle('get-cues', async (event) => {
        // --- DIAGNOSTIC LOG ---
        console.log("IPC_HANDLER: 'get-cues' - cueManagerRef type:", typeof cueManagerRef);
        if (cueManagerRef && typeof cueManagerRef.getCues === 'function') { // Check type before calling
            const currentCues = cueManagerRef.getCues();
            console.log(`IPC_HANDLER: 'get-cues' - Returning ${currentCues.length} cues to renderer.`);
            return currentCues;
        } else if (cueManagerRef) {
            console.error("IPC_HANDLER: 'get-cues' - cueManagerRef exists, but getCues is not a function. Keys:", Object.keys(cueManagerRef));
        } else {
            console.error("IPC_HANDLER: 'get-cues' - cueManagerRef not available");
        }
        return [];
    });
    console.log("IPC_HANDLERS_INIT: Handler for 'get-cues' registered.");

    ipcMain.handle('save-cues', async (event, updatedCues) => {
        cueManagerRef.setCues(updatedCues);
        // cueManager.saveCuesToFile() is called internally by setCues
        // which in turn calls websocketServer.broadcastCuesListUpdate()
        if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited(); // Mark as edited
        return { success: true };
    });

    ipcMain.handle('generate-uuid', async () => {
        return uuidv4();
    });

    ipcMain.handle('load-cues', async () => {
        return cueManagerRef.loadCues();
    });

    ipcMain.on('cue-status-update-for-companion', (event, { cueId, status, error }) => {
        console.log(`IPC: Cue status update from renderer: ${cueId} - ${status}`);
        if (websocketServerRef) {
            websocketServerRef.broadcastCueStatus(cueId, status, error);
        }
    });

    // Listen for playback time updates from the renderer
    ipcMain.on('playback-time-update', (event, payload) => {
        console.log(`IPC: Playback time update from renderer: Cue ${payload.cueId} - ${payload.status} ${payload.currentTimeFormatted}`);
        if (websocketServerRef && typeof websocketServerRef.broadcastPlaybackTimeUpdate === 'function') {
            websocketServerRef.broadcastPlaybackTimeUpdate(payload);
        }
    });

    // New IPC handlers for app configuration
    ipcMain.removeHandler('get-app-config'); // Remove existing if any, to avoid duplicates
    ipcMain.handle('get-initial-config', async () => {
        const config = appConfigManager.getConfig(); // Use direct import or ref, assuming it holds current state
        console.log('[IPC get-initial-config] Sending config to renderer:', config); // Config Log 5
        return config;
    });
    console.log("IPC_HANDLERS_INIT: Handler for 'get-initial-config' (formerly get-app-config) registered.");

    ipcMain.handle('save-app-config', async (event, config) => {
        console.log(`IPC_HANDLER: 'save-app-config' received with config:`, JSON.stringify(config)); // Log received config
        try {
            const result = appConfigManager.updateConfig(config);
            if (result && result.saved) {
                console.log('IPC_HANDLER: appConfigManager.updateConfig successful and config saved.');
                return { success: true, config: result.config };
            } else {
                console.error('IPC_HANDLER: appConfigManager.updateConfig called, but config save FAILED.');
                return { success: false, error: 'Failed to save configuration file.', config: result.config };
            }
        } catch (error) {
            console.error('IPC_HANDLER: Error calling appConfigManager.updateConfig:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('delete-cue', async (event, cueId) => { // Added delete-cue handler
        try {
            const success = cueManagerRef.deleteCue(cueId); 
            if (success) {
                if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited();
                
                // Notify the renderer that the cue list has changed
                if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                    console.log(`IPC_HANDLER: 'delete-cue' - Cue ${cueId} deleted. Sending updated cue list to renderer.`);
                    mainWindowRef.webContents.send('cues-updated-from-main', cueManagerRef.getCues());
                }
                return { success: true };
            } else {
                // If deleteCue returns false, it means the cue was not found.
                console.warn(`IPC_HANDLER: 'delete-cue' - Cue with ID ${cueId} not found by cueManager.`);
                return { success: false, error: `Cue with ID ${cueId} not found.` };
            }
        } catch (error) {
            console.error('Error deleting cue:', error);
            return { success: false, error: error.message };
        }
    });

    // New IPC handler to get audio output devices
    ipcMain.handle('get-audio-output-devices', async () => {
        try {
            // Ensure defaultSession is available and app is ready
            if (!app.isReady()) {
                console.warn('Attempted to get media devices before app was ready.');
                return []; // Or throw error, or wait for app to be ready
            }
            if (!session.defaultSession) {
                console.error('Electron defaultSession not available to get media devices.');
                return [];
            }
            const devices = await session.defaultSession.getMediaDevices();
            const audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
            return audioOutputDevices.map(device => ({
                deviceId: device.deviceId,
                label: device.label || `Unknown Audio Device ${device.deviceId.substring(0, 8)}`
            }));
        } catch (error) {
            console.error('Error fetching audio output devices:', error);
            return []; // Return empty array on error
        }
    });

    // New handler for adding or updating a single cue, with duration processing
    ipcMain.handle('add-or-update-cue', async (event, cueData) => {
        if (!cueManagerRef || typeof cueManagerRef.addOrUpdateProcessedCue !== 'function') {
            console.error("IPC_HANDLER: 'add-or-update-cue' - cueManagerRef or addOrUpdateProcessedCue not available");
            return { success: false, error: 'Cue manager not properly configured.', cue: null };
        }
        try {
            console.log(`IPC_HANDLER: 'add-or-update-cue' received cue data for ID: ${cueData.id || 'new cue'}`);
            const processedCue = await cueManagerRef.addOrUpdateProcessedCue(cueData);
            // if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited(); // Temporarily comment out
            // cueManager.addOrUpdateProcessedCue calls saveCuesToFile, which broadcasts to companion.
            // We also need to ensure the renderer gets the updated full list.
            if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                 console.log('IPC Handlers: Sending cues-updated-from-main after add-or-update-cue.');
                 mainWindowRef.webContents.send('cues-updated-from-main', cueManagerRef.getCues());
            }
            console.log(`IPC_HANDLER: 'add-or-update-cue' processed cue ID: ${processedCue.id}, knownDuration: ${processedCue.knownDuration}`);
            return { success: true, cue: processedCue }; // Return the processed cue
        } catch (error) {
            console.error('IPC_HANDLER: Error processing add-or-update-cue:', error);
            return { success: false, error: error.message, cue: null };
        }
    });

    // Listener for duration updates from the renderer
    ipcMain.on('cue-duration-update', (event, { cueId, duration, playlistItemId }) => {
        if (cueManagerRef && typeof cueManagerRef.updateCueItemDuration === 'function') {
            console.log(`IPC_HANDLER: 'cue-duration-update' received for cue: ${cueId}, item: ${playlistItemId || 'N/A'}, duration: ${duration}`);
            cueManagerRef.updateCueItemDuration(cueId, duration, playlistItemId);
            // The cueManager.updateCueItemDuration should handle saving and notifying renderers if data changed.
        } else {
            console.error("IPC_HANDLER: 'cue-duration-update' - cueManagerRef or updateCueItemDuration not available.");
        }
    });

    // New IPC handler to get audio file content as a buffer
    ipcMain.handle('get-audio-file-buffer', async (event, filePath) => {
        try {
            if (!filePath) {
                console.error('IPC_HANDLER: \'get-audio-file-buffer\' - No filePath provided.');
                return null; // Or throw error
            }
            console.log(`IPC_HANDLER: 'get-audio-file-buffer' - Reading file: ${filePath}`);
            try {
                const buffer = await fs.readFile(filePath);
                console.log(`IPC_HANDLER: 'get-audio-file-buffer' - Successfully read ${buffer.byteLength} bytes from ${filePath}`);
                return buffer;
            } catch (error) {
                console.error(`IPC_HANDLER: 'get-audio-file-buffer' - Error reading file ${filePath}:`, error);
                return null; // Or throw error, or return { error: message }
            }
        } catch (e) {
            console.error(`IPC_HANDLER: CRITICAL ERROR in 'get-audio-file-buffer' for path ${filePath}:`, e);
            return null;
        }
    });

    ipcMain.handle('get-or-generate-waveform-peaks', async (event, audioFilePath) => {
        const waveformJsonPath = audioFilePath + '.peaks.json';
        console.log(`IPC_HANDLER: 'get-or-generate-waveform-peaks' for ${audioFilePath}, JSON path: ${waveformJsonPath}`);

        try {
            // Check if pre-generated JSON exists
            await fs.access(waveformJsonPath); // Check if file exists and is accessible
            console.log(`IPC_HANDLER: Found existing waveform data at ${waveformJsonPath}`);
            const jsonData = await fs.readFile(waveformJsonPath, 'utf8');
            return JSON.parse(jsonData); // Return { peaks, duration, sampleRate, numberOfChannels }
        } catch (error) {
            // File doesn't exist or other error, proceed to generate
            console.log(`IPC_HANDLER: No existing waveform data found (or error accessing it), generating for ${audioFilePath}. Error: ${error.message}`);
            return new Promise((resolve, reject) => {
                const worker = new Worker(nodePath.join(__dirname, 'waveform-generator.js'), {
                    workerData: { audioFilePath }
                });

                worker.on('message', async (workerResult) => {
                    if (workerResult.error) {
                        // The worker (waveform-generator.js) is now expected to always send
                        // error objects structured as { decodeError: true, message: "..." }
                        console.warn(`IPC_HANDLER: Waveform generation FAILED for ${audioFilePath} (worker posted error): ${workerResult.error.message}. Resolving with decodeError status.`);
                        resolve({
                            peaks: null,
                            duration: null,
                            decodeError: true, // Critical for renderer fallback
                            errorMessage: workerResult.error.message
                        });
                        return;
                    }
                    try {
                        console.log(`IPC_HANDLER: Waveform data received from worker for ${audioFilePath}`);
                        await fs.writeFile(waveformJsonPath, JSON.stringify(workerResult), 'utf8');
                        console.log(`IPC_HANDLER: Saved waveform data to ${waveformJsonPath}`);
                        resolve(workerResult); // Contains { peaks, duration, etc. }
                    } catch (saveError) {
                        console.error(`IPC_HANDLER: Error saving waveform JSON for ${audioFilePath}:`, saveError);
                        reject(saveError);
                    }
                });

                worker.on('error', (workerError) => {
                    console.error(`IPC_HANDLER: Waveform generation worker CRITICAL error event for ${audioFilePath}:`, workerError);
                    // Resolve with decodeError: true to allow the renderer to attempt fallback,
                    // instead of rejecting and causing an unhandled error in the renderer's main catch block.
                    resolve({
                        peaks: null,
                        duration: null,
                        decodeError: true, // Critical for renderer fallback
                        errorMessage: workerError.message || 'Worker process failed critically or with an unhandled error.'
                    });
                });

                worker.on('exit', (code) => {
                    if (code !== 0) {
                        console.error(`IPC_HANDLER: Waveform generation worker stopped with exit code ${code} for ${audioFilePath}`);
                        // This path should ideally not be the primary way to signal failure if worker correctly posts messages/errors.
                        // However, as a fallback, if we haven't resolved/rejected yet, this indicates an issue.
                        // To avoid hanging, we could reject here, but it's tricky without knowing if a message was already processed.
                        // For now, primary error handling is in 'message' and 'error' events.
                    }
                });
            });
        }
    });

    ipcMain.handle('get-media-duration', async (event, filePath) => {
        if (cueManagerRef && typeof cueManagerRef.getAudioFileDuration === 'function') {
            return await cueManagerRef.getAudioFileDuration(filePath);
        } else {
            console.error("IPC_HANDLER: 'get-media-duration' - cueManagerRef or getAudioFileDuration not available");
            return null;
        }
    });

    // Handle 'start-osc-learn' from renderer
    ipcMain.on('start-osc-learn', (event, cueId) => {
        console.log(`IPC_HANDLER: 'start-osc-learn' received for cue ID: ${cueId}`); 
        // Use oscListenerRef here
        if (oscListenerRef) {
            oscListenerRef.enterLearnMode(
                (learnedPath) => {
                    console.log(`IPC_HANDLER: OSC message learned: ${learnedPath}. Sending to renderer.`); 
                    if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                        mainWindowRef.webContents.send('osc-message-learned', learnedPath);
                    }
                },
                (errorMsg) => {
                    console.error(`IPC_HANDLER: OSC learn failed: ${errorMsg}. Sending to renderer.`); 
                    if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                        mainWindowRef.webContents.send('osc-learn-failed', errorMsg);
                    }
                }
            );
        } else {
            console.error("IPC_HANDLER: 'start-osc-learn' - oscListenerRef is not available.");
        }
    });

    ipcMain.handle('get-config-path', () => {
        // Use appConfigManagerRef or direct import
        return appConfigManager.getConfigPath(); 
    });

    // Theme handling
    ipcMain.on('set-theme', (event, theme) => {
        // Pass appRef if nativeTheme is needed from the app instance, otherwise electron.nativeTheme is fine.
        handleThemeChange(theme, mainWindowRef, require('electron').nativeTheme);
    });

    // IPC listener for renderer to signal user activity
    ipcMain.on('reset-inactivity-timer', () => {
        if (typeof resetInactivityTimestampCallbackRef === 'function') {
            console.log("IPC_HANDLER: 'reset-inactivity-timer' received. Calling main process callback.");
            resetInactivityTimestampCallbackRef();
        } else {
            console.warn("IPC_HANDLER: 'reset-inactivity-timer' received, but callback is not configured.");
        }
    });
}

// Theme handling function (not directly part of initialize, but used by it and menu)
function handleThemeChange(theme, win, nativeTheme) {
    if (theme === 'dark') {
        nativeTheme.themeSource = 'dark';
    } else if (theme === 'light') {
        nativeTheme.themeSource = 'light';
    } else {
        nativeTheme.themeSource = 'system';
    }
    // Send updated theme to renderer to apply CSS changes if necessary
    if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('theme-updated', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
    // Save the theme choice to config
    const currentConfig = appConfigManager.getConfig();
    if (currentConfig.theme !== theme) {
        appConfigManager.updateConfig({ theme: theme });
    }
}

module.exports = {
    initialize,
    handleThemeChange // Exporting handleThemeChange
}; 