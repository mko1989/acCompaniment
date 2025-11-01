const { ipcMain, session, app, dialog, shell, clipboard } = require('electron');
const appConfigManager = require('./appConfig'); // Import the new app config manager
const fsPromises = require('fs').promises; // Renamed from fs to fsPromises
const fs = require('fs'); // Added for synchronous operations like existsSync
const { Worker } = require('worker_threads');
const nodePath = require('path'); // To distinguish from browser path module if any
const workspaceManager = require('./workspaceManager');
const cueManager = require('./cueManager');
const { v4: uuidv4 } = require('uuid');


let appRef; // To store the app instance
let mainWindowRef;
let cueManagerRef;
let appConfigManagerRef; // To store appConfigManager
let workspaceManagerRef;
let websocketServerRef;
let httpServerRef; // Added: For HTTP remote updates
let audioPlaybackIPCRef = null;
let openEasterEggGameWindowCallback = null; // Added to store the function

function initialize(application, mainWin, cueMgrModule, appCfgManager, wsMgr, wsServer, _oscLstnr, httpServerInstance, _mixrIntMgr, openEasterEggGameFunc) {
    appRef = application; // Store app
    mainWindowRef = mainWin;
    cueManagerRef = cueMgrModule; 
    appConfigManagerRef = appCfgManager; // Store appConfigManager
    workspaceManagerRef = wsMgr; 
    websocketServerRef = wsServer;
    httpServerRef = httpServerInstance; // Added: Store httpServer reference
    // Mixer integration removed as per requirements
    openEasterEggGameWindowCallback = openEasterEggGameFunc; // Store the passed function

    console.log("IPC_HANDLERS_INIT: Initializing.");
    // --- DIAGNOSTIC LOG --- 
    console.log("IPC_HANDLERS_INIT: cueManagerModule type:", typeof cueManagerRef);
    if (cueManagerRef) {
        console.log("IPC_HANDLERS_INIT: cueManagerModule keys:", Object.keys(cueManagerRef));
        console.log("IPC_HANDLERS_INIT: typeof cueManagerModule.getCues:", typeof cueManagerRef.getCues);
        console.log("IPC_HANDLERS_INIT: typeof cueManagerModule.addOrUpdateProcessedCue:", typeof cueManagerRef.addOrUpdateProcessedCue);
    } else {
        console.error("IPC_HANDLERS_INIT: cueManagerModule is undefined!");
    }
    // --- END DIAGNOSTIC LOG ---

    // Mixer integration functionality removed as per requirements

    // --- IPC Handlers ---
    ipcMain.handle('get-cues', async (event) => {
        console.log("IPC_HANDLER: 'get-cues' - cueManagerRef type:", typeof cueManagerRef);
        if (cueManagerRef && typeof cueManagerRef.getCues === 'function') {
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
        if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited();
        return { success: true };
    });

    ipcMain.handle('save-reordered-cues', async (event, reorderedCues) => {
        console.log(`IPC_HANDLER: 'save-reordered-cues' received for ${reorderedCues.length} cues.`);
        if (cueManagerRef && typeof cueManagerRef.setCues === 'function') {
            cueManagerRef.setCues(reorderedCues);
            if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited();
            return { success: true };
        }
        return { success: false, error: 'CueManager not available' };
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

    // CRITICAL FIX: Add handler for cue-status-update to send cued state to HTTP remote
    ipcMain.on('cue-status-update', (event, { cueId, status, details }) => {
        console.log(`IPC: Cue status update: ${cueId} - ${status}`, details);
        
        // Send cued state updates to HTTP remote
        if (httpServerRef && typeof httpServerRef.broadcastToRemotes === 'function' && status === 'cued_next') {
            const currentCue = cueManagerRef ? cueManagerRef.getCueById(cueId) : null;
            if (currentCue) {
                console.log(`HTTP_SERVER: Sending cued state update for playlist ${cueId} to remote`);
                const { calculateEffectiveTrimmedDurationSec } = require('./utils/timeUtils');
                
                let cuedDurationS = 0;
                let originalKnownDurationS = 0;
                let nextItemName = null;
                
                if (currentCue.type === 'playlist' && currentCue.playlistItems && currentCue.playlistItems.length > 0) {
                    // For cued playlists, calculate duration of the next item
                    const nextItem = details && details.nextItem ? 
                        currentCue.playlistItems.find(item => item.name === details.nextItem) || currentCue.playlistItems[0] :
                        currentCue.playlistItems[0];
                    
                    cuedDurationS = calculateEffectiveTrimmedDurationSec(nextItem);
                    originalKnownDurationS = nextItem.knownDuration || 0;
                    nextItemName = nextItem.name || 'Next Item';
                } else {
                    cuedDurationS = calculateEffectiveTrimmedDurationSec(currentCue);
                    originalKnownDurationS = currentCue.knownDuration || 0;
                }
                
                const cuedUpdate = {
                    type: 'remote_cue_update',
                    cue: {
                        id: cueId,
                        name: currentCue.name,
                        type: currentCue.type,
                        status: 'cued', // Convert 'cued_next' to 'cued' for remote
                        currentTimeS: 0,
                        currentItemDurationS: cuedDurationS,
                        currentItemRemainingTimeS: cuedDurationS,
                        playlistItemName: null, // Not currently playing
                        nextPlaylistItemName: nextItemName,
                        knownDurationS: originalKnownDurationS
                    }
                };
                httpServerRef.broadcastToRemotes(cuedUpdate);
            }
        }
    });

    ipcMain.on('playback-time-update', (event, payload) => {
        // Relay the message back to the renderer for UI updates
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
            mainWindowRef.webContents.send('playback-time-update-from-main', payload);
        }
        
        // Broadcast to external clients (Companion and remote control)
        if (websocketServerRef && typeof websocketServerRef.broadcastPlaybackTimeUpdate === 'function') {
            websocketServerRef.broadcastPlaybackTimeUpdate(payload);
        }
        if (httpServerRef && typeof httpServerRef.broadcastToRemotes === 'function') {
            const currentCue = cueManagerRef ? cueManagerRef.getCueById(payload.cueId) : null;
            let cueTypeFromManager = 'single_file';
            if (currentCue) {
                cueTypeFromManager = currentCue.type;
            }
            const remoteCueUpdate = {
                type: 'remote_cue_update',
                cue: {
                    id: payload.cueId,
                    name: payload.cueName, 
                    type: cueTypeFromManager, 
                    status: payload.status, 
                    currentTimeS: payload.currentTimeSec, 
                    currentItemDurationS: payload.totalDurationSec, 
                    currentItemRemainingTimeS: payload.remainingTimeSec, 
                    playlistItemName: payload.playlistItemName, 
                    nextPlaylistItemName: payload.nextPlaylistItemName, 
                    knownDurationS: payload.originalKnownDuration || 0 
                }
            };
            httpServerRef.broadcastToRemotes(remoteCueUpdate);
            
            // CRITICAL FIX: When a cue stops, send idle duration updates for all other cues
            // This prevents other cues from showing zeros when one cue stops
            if (payload.status === 'stopped' && cueManagerRef) {
                console.log(`HTTP_SERVER: Cue ${payload.cueId} stopped, sending idle duration updates for all cues to remote`);
                const { calculateEffectiveTrimmedDurationSec } = require('./utils/timeUtils');
                const allCues = cueManagerRef.getCues();
                
                allCues.forEach(cue => {
                    if (cue.id !== payload.cueId) { // Don't update the cue that just stopped (already handled above)
                        let idleDurationS = 0;
                        let originalKnownDurationS = 0;
                        
                        if (cue.type === 'single_file') {
                            idleDurationS = calculateEffectiveTrimmedDurationSec(cue);
                            originalKnownDurationS = cue.knownDuration || 0;
                        } else if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
                            const firstItem = cue.playlistItems[0];
                            idleDurationS = calculateEffectiveTrimmedDurationSec(firstItem);
                            originalKnownDurationS = firstItem.knownDuration || 0;
                        } else {
                            idleDurationS = cue.knownDuration || 0;
                            originalKnownDurationS = cue.knownDuration || 0;
                        }
                        
                        const idleUpdate = {
                            type: 'remote_cue_update',
                            cue: {
                                id: cue.id,
                                name: cue.name,
                                type: cue.type,
                                status: 'stopped',
                                currentTimeS: 0,
                                currentItemDurationS: idleDurationS,
                                currentItemRemainingTimeS: idleDurationS,
                                playlistItemName: (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) ? cue.playlistItems[0].name : null,
                                nextPlaylistItemName: null,
                                knownDurationS: originalKnownDurationS
                            }
                        };
                        httpServerRef.broadcastToRemotes(idleUpdate);
                    }
                });
            }
        }
    });

    ipcMain.handle('get-initial-config', async () => {
        const config = appConfigManagerRef.getConfig();
        console.log('[IPC get-initial-config] Sending config to renderer:', config);
        return config;
    });
    console.log("IPC_HANDLERS_INIT: Handler for 'get-initial-config' explicitly registered.");

    ipcMain.handle('get-http-remote-info', async () => {
        if (httpServerRef && typeof httpServerRef.getRemoteInfo === 'function') {
            return httpServerRef.getRemoteInfo();
        }
        return { enabled: false, port: 3000, interfaces: [] };
    });
    console.log("IPC_HANDLERS_INIT: Handler for 'get-http-remote-info' explicitly registered.");

    ipcMain.handle('write-to-clipboard', async (event, text) => {
        try {
            clipboard.writeText(text);
            console.log('IPC_HANDLER: Successfully wrote to clipboard');
            return { success: true };
        } catch (error) {
            console.error('IPC_HANDLER: Error writing to clipboard:', error);
            return { success: false, error: error.message };
        }
    });
    console.log("IPC_HANDLERS_INIT: Handler for 'write-to-clipboard' explicitly registered.");

    ipcMain.handle('save-app-config', async (event, config) => {
        console.log(`IPC_HANDLER: 'save-app-config' received with config:`, JSON.stringify(config));
        try {
            const result = appConfigManagerRef.updateConfig(config);
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

    ipcMain.handle('delete-cue', async (event, cueId) => {
        try {
            const success = cueManagerRef.deleteCue(cueId); 
            if (success) {
                if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited();
                if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                    console.log(`IPC_HANDLER: 'delete-cue' - Cue ${cueId} deleted. Sending updated cue list to renderer.`);
                    mainWindowRef.webContents.send('cues-updated-from-main', cueManagerRef.getCues());
                }
                return { success: true };
            } else {
                console.warn(`IPC_HANDLER: 'delete-cue' - Cue with ID ${cueId} not found by cueManager.`);
                return { success: false, error: `Cue with ID ${cueId} not found.` };
            }
        } catch (error) {
            console.error('Error deleting cue:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-audio-output-devices', async () => {
        try {
            if (!app.isReady()) {
                console.warn('Attempted to get media devices before app was ready.');
                return { 
                    success: false, 
                    error: 'Application not ready', 
                    devices: [],
                    fallback: 'renderer_enumeration'
                };
            }
            
            // For a soundboard app, audio output device enumeration should be handled 
            // in the renderer process using navigator.mediaDevices.enumerateDevices()
            // This avoids permission issues and provides better device information
            console.log('Audio output device enumeration delegated to renderer process');
            
            // Return structured response indicating delegation to renderer
            return { 
                success: true, 
                devices: [], 
                delegated: true,
                message: 'Device enumeration delegated to renderer process for better compatibility'
            };
            
        } catch (error) {
            console.error('Error in get-audio-output-devices handler:', error);
            return { 
                success: false, 
                error: error.message, 
                devices: [],
                fallback: 'renderer_enumeration'
            };
        }
    });
    console.log("IPC_HANDLERS_INIT: Handler for 'get-audio-output-devices' explicitly registered.");

    ipcMain.handle('add-or-update-cue', async (event, cueData) => {
        if (!cueManagerRef || typeof cueManagerRef.addOrUpdateProcessedCue !== 'function') {
            console.error("IPC_HANDLER: 'add-or-update-cue' - cueManagerRef or addOrUpdateProcessedCue not available");
            return { success: false, error: 'Cue manager not properly configured.', cue: null };
        }
        try {
            console.log(`IPC_HANDLER: 'add-or-update-cue' received cue data for ID: ${cueData.id || 'new cue'}`);
            console.log(`IPC_HANDLER: 'add-or-update-cue' received trim properties: trimStartTime=${cueData.trimStartTime}, trimEndTime=${cueData.trimEndTime}`);
            console.log(`IPC_HANDLER: 'add-or-update-cue' all received properties:`, Object.keys(cueData));
            // Temporarily log the full cueData object for debugging
            console.log(`IPC_HANDLER: 'add-or-update-cue' full cueData:`, JSON.stringify(cueData, null, 2));
            
            const processedCue = await cueManagerRef.addOrUpdateProcessedCue(cueData);
            if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                 console.log('IPC Handlers: Sending cues-updated-from-main after add-or-update-cue.');
                 mainWindowRef.webContents.send('cues-updated-from-main', cueManagerRef.getCues());
            }

            // Mixer integration logic removed as per requirements

            console.log(`IPC_HANDLER: 'add-or-update-cue' processed cue ID: ${processedCue.id}, knownDuration: ${processedCue.knownDuration}`);
            return { success: true, cue: processedCue };
        } catch (error) {
            console.error('IPC_HANDLER: Error processing add-or-update-cue:', error);
            return { success: false, error: error.message, cue: null };
        }
    });

    ipcMain.on('cue-duration-update', (event, { cueId, duration, playlistItemId }) => {
        if (cueManagerRef && typeof cueManagerRef.updateCueItemDuration === 'function') {
            console.log(`IPC_HANDLER: 'cue-duration-update' received for cue: ${cueId}, item: ${playlistItemId || 'N/A'}, duration: ${duration}`);
            cueManagerRef.updateCueItemDuration(cueId, duration, playlistItemId);
        } else {
            console.error("IPC_HANDLER: 'cue-duration-update' - cueManagerRef or updateCueItemDuration not available.");
        }
    });

    ipcMain.on('open-easter-egg-game', () => {
        if (openEasterEggGameWindowCallback && typeof openEasterEggGameWindowCallback === 'function') {
            console.log("IPC_HANDLER: 'open-easter-egg-game' - Requesting to open game window.");
            openEasterEggGameWindowCallback();
        } else {
            console.error("IPC_HANDLER: 'open-easter-egg-game' - openEasterEggGameWindowCallback function not found or not a function.");
        }
    });

    ipcMain.handle('get-audio-file-buffer', async (event, filePath) => {
        try {
            if (!filePath) {
                console.error('IPC_HANDLER: \'get-audio-file-buffer\' - No filePath provided.');
                return { 
                    success: false, 
                    error: 'No file path provided', 
                    buffer: null 
                }; 
            }
            
            // Validate file exists before attempting to read
            if (!fs.existsSync(filePath)) {
                console.error(`IPC_HANDLER: 'get-audio-file-buffer' - File does not exist: ${filePath}`);
                return { 
                    success: false, 
                    error: 'File does not exist', 
                    buffer: null,
                    filePath: filePath
                };
            }
            
            console.log(`IPC_HANDLER: 'get-audio-file-buffer' - Reading file: ${filePath}`);
            
            try {
                const buffer = await fsPromises.readFile(filePath);
                console.log(`IPC_HANDLER: 'get-audio-file-buffer' - Successfully read ${buffer.byteLength} bytes from ${filePath}`);
                return { 
                    success: true, 
                    buffer: buffer, 
                    size: buffer.byteLength,
                    filePath: filePath
                };
            } catch (error) {
                console.error(`IPC_HANDLER: 'get-audio-file-buffer' - Error reading file ${filePath}:`, error);
                return { 
                    success: false, 
                    error: error.message, 
                    buffer: null,
                    filePath: filePath
                }; 
            }
        } catch (e) {
            console.error(`IPC_HANDLER: CRITICAL ERROR in 'get-audio-file-buffer' for path ${filePath}:`, e);
            return { 
                success: false, 
                error: e.message || 'Critical error occurred', 
                buffer: null,
                filePath: filePath
            };
        }
    });

    // Helper function for waveform generation with retry logic
    async function generateWaveformWithRetry(audioFilePath, retryCount = 0) {
        const waveformJsonPath = audioFilePath + '.peaks.json';
        const maxRetries = 2;
        console.log(`IPC_HANDLER: 'generateWaveformWithRetry' for ${audioFilePath}, retry: ${retryCount}`);
        
        try {
            await fsPromises.access(waveformJsonPath);
            console.log(`IPC_HANDLER: Found existing waveform data at ${waveformJsonPath}`);
            const jsonData = await fsPromises.readFile(waveformJsonPath, 'utf8');
            const parsedData = JSON.parse(jsonData);
            
            // Validate the cached data
            if (parsedData && (parsedData.peaks || parsedData.duration)) {
                return {
                    success: true,
                    ...parsedData,
                    cached: true
                };
            } else {
                console.warn(`IPC_HANDLER: Cached waveform data is invalid, regenerating for ${audioFilePath}`);
                // Remove invalid cache file
                try {
                    await fsPromises.unlink(waveformJsonPath);
                } catch (unlinkError) {
                    console.warn(`IPC_HANDLER: Could not remove invalid cache file: ${unlinkError.message}`);
                }
            }
        } catch (error) {
            console.log(`IPC_HANDLER: No existing waveform data found (or error accessing it), generating for ${audioFilePath}. Error: ${error.message}`);
        }
        
        return new Promise((resolve, reject) => {
            const worker = new Worker(nodePath.join(__dirname, 'waveform-generator.js'), {
                workerData: { audioFilePath }
            });
            
            // Set a timeout for the worker
            const workerTimeout = setTimeout(() => {
                console.warn(`IPC_HANDLER: Waveform generation timeout for ${audioFilePath}, terminating worker`);
                worker.terminate();
                if (retryCount < maxRetries) {
                    console.log(`IPC_HANDLER: Retrying waveform generation for ${audioFilePath} (attempt ${retryCount + 1})`);
                    // Retry with exponential backoff
                    setTimeout(async () => {
                        const retryResult = await generateWaveformWithRetry(audioFilePath, retryCount + 1);
                        resolve(retryResult);
                    }, Math.pow(2, retryCount) * 1000);
                } else {
                    resolve({
                        success: false,
                        peaks: null,
                        duration: null,
                        error: 'timeout',
                        errorMessage: 'Waveform generation timed out after multiple attempts',
                        retryCount: retryCount
                    });
                }
            }, 30000); // 30 second timeout
            
            worker.on('message', async (workerResult) => {
                clearTimeout(workerTimeout);
                
                if (workerResult.error) {
                    console.warn(`IPC_HANDLER: Waveform generation FAILED for ${audioFilePath} (worker posted error): ${workerResult.error.message}`);
                    
                    if (retryCount < maxRetries) {
                        console.log(`IPC_HANDLER: Retrying waveform generation for ${audioFilePath} (attempt ${retryCount + 1})`);
                        setTimeout(async () => {
                            const retryResult = await generateWaveformWithRetry(audioFilePath, retryCount + 1);
                            resolve(retryResult);
                        }, Math.pow(2, retryCount) * 1000);
                    } else {
                        resolve({
                            success: false,
                            peaks: null,
                            duration: null,
                            error: 'generation_failed',
                            errorMessage: workerResult.error.message,
                            retryCount: retryCount
                        });
                    }
                    return;
                }
                
                try {
                    console.log(`IPC_HANDLER: Waveform data received from worker for ${audioFilePath}`);
                    await fsPromises.writeFile(waveformJsonPath, JSON.stringify(workerResult), 'utf8');
                    console.log(`IPC_HANDLER: Saved waveform data to ${waveformJsonPath}`);
                    resolve({
                        success: true,
                        ...workerResult,
                        cached: false
                    });
                } catch (saveError) {
                    console.error(`IPC_HANDLER: Error saving waveform JSON for ${audioFilePath}:`, saveError);
                    // Even if we can't save, return the generated data
                    resolve({
                        success: true,
                        ...workerResult,
                        cached: false,
                        saveWarning: 'Could not save waveform cache: ' + saveError.message
                    });
                }
            });
            
            worker.on('error', (workerError) => {
                clearTimeout(workerTimeout);
                console.error(`IPC_HANDLER: Waveform generation worker CRITICAL error event for ${audioFilePath}:`, workerError);
                
                if (retryCount < maxRetries) {
                    console.log(`IPC_HANDLER: Retrying waveform generation for ${audioFilePath} (attempt ${retryCount + 1})`);
                    setTimeout(async () => {
                        const retryResult = await generateWaveformWithRetry(audioFilePath, retryCount + 1);
                        resolve(retryResult);
                    }, Math.pow(2, retryCount) * 1000);
                } else {
                    resolve({
                        success: false,
                        peaks: null,
                        duration: null,
                        error: 'worker_critical_error',
                        errorMessage: workerError.message || 'Worker process failed critically or with an unhandled error.',
                        retryCount: retryCount
                    });
                }
            });
            
            worker.on('exit', (code) => {
                clearTimeout(workerTimeout);
                if (code !== 0) {
                    console.error(`IPC_HANDLER: Waveform generation worker stopped with exit code ${code} for ${audioFilePath}`);
                    if (retryCount < maxRetries) {
                        console.log(`IPC_HANDLER: Retrying waveform generation for ${audioFilePath} (attempt ${retryCount + 1})`);
                        setTimeout(async () => {
                            const retryResult = await generateWaveformWithRetry(audioFilePath, retryCount + 1);
                            resolve(retryResult);
                        }, Math.pow(2, retryCount) * 1000);
                    } else {
                        resolve({
                            success: false,
                            peaks: null,
                            duration: null,
                            error: 'worker_exit_error',
                            errorMessage: `Worker exited with code ${code}`,
                            retryCount: retryCount
                        });
                    }
                }
            });
        });
    }

    ipcMain.handle('get-or-generate-waveform-peaks', async (event, audioFilePath) => {
        console.log(`IPC_HANDLER: 'get-or-generate-waveform-peaks' for ${audioFilePath}`);
        return await generateWaveformWithRetry(audioFilePath);
    });

    ipcMain.handle('get-media-duration', async (event, filePath) => {
        console.log(`IPC Handler: Received 'get-media-duration' for path: ${filePath}`);
        try {
            if (!filePath) {
                console.error('IPC Handler: No file path provided for get-media-duration');
                return { 
                    success: false, 
                    error: 'No file path provided', 
                    duration: null 
                };
            }
            
            const duration = await getAudioFileDuration(filePath);
            if (duration !== null) {
                return { 
                    success: true, 
                    duration: duration, 
                    filePath: filePath 
                };
            } else {
                return { 
                    success: false, 
                    error: 'Could not determine duration', 
                    duration: null,
                    filePath: filePath
                };
            }
        } catch (error) {
            console.error(`IPC Handler: Error processing 'get-media-duration' for ${filePath}:`, error);
            return { 
                success: false, 
                error: error.message, 
                duration: null,
                filePath: filePath
            };
        }
    });

    ipcMain.handle('get-config-path', () => {
        return appConfigManagerRef.getConfigPath(); 
    });

    ipcMain.on('set-theme', (event, theme) => {
        handleThemeChange(theme, mainWindowRef, require('electron').nativeTheme);
    });

    // Note: reset-inactivity-timer listener removal not needed as no listener was registered

    // OSC and mixer integration handlers removed as per requirements
    
    // Handler for 'get-or-generate-waveform-peaks' registered

    if (appConfigManagerRef && typeof appConfigManagerRef.onConfigChange === 'function') {
        appConfigManagerRef.onConfigChange((newConfig, oldConfig) => {
            console.log("IPC_HANDLERS: Detected appConfig change. Broadcasting to renderer and updating modules.");
            if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                mainWindowRef.webContents.send('app-config-updated', newConfig);
            }
            // Mixer integration settings update removed as per requirements
            // Update HTTP server with new config (for port changes, etc.)
            if (httpServerRef && typeof httpServerRef.updateConfig === 'function') {
                httpServerRef.updateConfig(newConfig);
            }
        });
    } else {
        console.error("IPC_HANDLERS_INIT: appConfigManagerRef or onConfigChange is not available.");
    }

    // Wing button configuration handlers removed as per requirements
    
    // Playlist Navigation Handlers
    ipcMain.handle('playlist-navigate-next', async (event, cueId) => {
        console.log(`IPC_HANDLER: 'playlist-navigate-next' received for cueId: ${cueId}`);
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
            mainWindowRef.webContents.send('playlist-navigate-next-from-main', cueId);
            return { success: true };
        }
        return { success: false, error: 'Main window not available' };
    });

    ipcMain.handle('playlist-navigate-previous', async (event, cueId) => {
        console.log(`IPC_HANDLER: 'playlist-navigate-previous' received for cueId: ${cueId}`);
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
            mainWindowRef.webContents.send('playlist-navigate-previous-from-main', cueId);
            return { success: true };
        }
        return { success: false, error: 'Main window not available' };
    });

    ipcMain.handle('playlist-jump-to-item', async (event, cueId, targetIndex) => {
        console.log(`IPC_HANDLER: 'playlist-jump-to-item' received for cueId: ${cueId}, index: ${targetIndex}`);
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
            mainWindowRef.webContents.send('playlist-jump-to-item-from-main', { cueId, targetIndex });
            return { success: true };
        }
        return { success: false, error: 'Main window not available' };
    });

    ipcMain.handle('get-app-version', async (event) => {
        const packageJson = require('../../package.json');
        return packageJson.version;
    });

    ipcMain.handle('check-for-update', async (event) => {
        try {
            const https = require('https');
            const packageJson = require('../../package.json');
            const currentVersion = packageJson.version;
            
            return new Promise((resolve) => {
                const options = {
                    hostname: 'api.github.com',
                    path: '/repos/mko1989/acCompaniment/releases/latest',
                    method: 'GET',
                    headers: {
                        'User-Agent': 'acCompaniment'
                    }
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        try {
                            const release = JSON.parse(data);
                            const latestVersion = release.tag_name.replace(/^v/, '');
                            const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
                            resolve({
                                currentVersion,
                                latestVersion,
                                updateAvailable,
                                releaseUrl: release.html_url
                            });
                        } catch (error) {
                            console.error('Error parsing GitHub release data:', error);
                            resolve({
                                currentVersion,
                                latestVersion: null,
                                updateAvailable: false,
                                error: 'Failed to check for updates'
                            });
                        }
                    });
                });

                req.on('error', (error) => {
                    console.error('Error checking for updates:', error);
                    resolve({
                        currentVersion,
                        latestVersion: null,
                        updateAvailable: false,
                        error: 'Network error'
                    });
                });

                req.setTimeout(5000, () => {
                    req.destroy();
                    resolve({
                        currentVersion,
                        latestVersion: null,
                        updateAvailable: false,
                        error: 'Timeout'
                    });
                });

                req.end();
            });
        } catch (error) {
            console.error('Error checking for updates:', error);
            const packageJson = require('../../package.json');
            return {
                currentVersion: packageJson.version,
                latestVersion: null,
                updateAvailable: false,
                error: error.message
            };
        }
    });

    // Helper function to compare version strings (e.g., "1.0.1" vs "1.0.2")
    function compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        const maxLength = Math.max(parts1.length, parts2.length);
        
        for (let i = 0; i < maxLength; i++) {
            const part1 = parts1[i] || 0;
            const part2 = parts2[i] || 0;
            if (part1 > part2) return 1;
            if (part1 < part2) return -1;
        }
        return 0;
    }
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
    const currentConfig = appConfigManagerRef.getConfig();
    if (currentConfig.theme !== theme) {
        appConfigManagerRef.updateConfig({ theme: theme });
    }
}

// Copied from cueManager.js - consider refactoring to a shared util later
async function getAudioFileDuration(filePath) {
    let mm;
    try {
        mm = await import('music-metadata'); // Dynamic import
    } catch (e) {
        console.error('IPC Handler (getAudioFileDuration): Failed to dynamically import music-metadata:', e);
        return null;
    }

    try {
        if (!filePath) {
            console.warn('IPC Handler (getAudioFileDuration): filePath is null or undefined.');
            return null;
        }
        if (!fs.existsSync(filePath)) {
            console.warn(`IPC Handler (getAudioFileDuration): File not found at ${filePath}`);
            return null;
        }
        
        // Check file size to avoid processing very large files
        const stats = fs.statSync(filePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        if (fileSizeMB > 100) { // 100MB limit
            console.warn(`IPC Handler (getAudioFileDuration): File too large (${fileSizeMB.toFixed(2)}MB) for duration parsing: ${filePath}`);
            return null;
        }
        
        console.log(`IPC Handler (getAudioFileDuration): Attempting to parse file for duration: ${filePath} (${fileSizeMB.toFixed(2)}MB)`);
        const metadata = await mm.parseFile(filePath);
        
        if (!metadata || !metadata.format || typeof metadata.format.duration !== 'number') {
            console.warn(`IPC Handler (getAudioFileDuration): Invalid or missing duration in metadata for ${filePath}`);
            return null;
        }
        
        console.log(`IPC Handler (getAudioFileDuration): Successfully parsed metadata for ${filePath}, duration: ${metadata.format.duration}s`);
        return metadata.format.duration; // duration in seconds
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`IPC Handler (getAudioFileDuration): Error getting duration for ${filePath}:`, errorMessage);
        
        // Provide more specific error information
        if (errorMessage.includes('ENOENT')) {
            console.error(`IPC Handler (getAudioFileDuration): File not found: ${filePath}`);
        } else if (errorMessage.includes('EACCES')) {
            console.error(`IPC Handler (getAudioFileDuration): Permission denied: ${filePath}`);
        } else if (errorMessage.includes('format')) {
            console.error(`IPC Handler (getAudioFileDuration): Unsupported audio format: ${filePath}`);
        }
        
        return null;
    }
}

module.exports = {
    initialize,
    handleThemeChange // Exporting handleThemeChange
}; 