const { ipcMain, session, app, dialog, shell } = require('electron');
// const { generateUUID } = require('./cueManager'); // Assuming generateUUID is still relevant here or in cueManager
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
let mixerIntegrationManagerRef = null;
let audioPlaybackIPCRef = null;
let openEasterEggGameWindowCallback = null; // Added to store the function

function initialize(application, mainWin, cueMgrModule, appCfgManager, wsMgr, wsServer, oscLstnr, httpServerInstance, mixrIntMgr, openEasterEggGameFunc) {
    appRef = application; // Store app
    mainWindowRef = mainWin;
    cueManagerRef = cueMgrModule; 
    appConfigManagerRef = appCfgManager; // Store appConfigManager
    workspaceManagerRef = wsMgr; 
    websocketServerRef = wsServer;
    httpServerRef = httpServerInstance; // Added: Store httpServer reference
    oscListenerRef = oscLstnr; // Store oscListener
    mixerIntegrationManagerRef = mixrIntMgr; // Store mixerIntegrationManager
    openEasterEggGameWindowCallback = openEasterEggGameFunc; // Store the passed function

    console.log("IPC_HANDLERS_INIT: Initializing with references (inactivity reset callback REMOVED).");
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

    // Note: mixerIntegrationManager is already initialized in main.js before IPC handlers are set up
    // We don't need to initialize it again here, just verify it's available
    if (mixerIntegrationManagerRef && typeof mixerIntegrationManagerRef.initialize === 'function') {
        console.log("IPC_HANDLERS_INIT: mixerIntegrationManager is available and already initialized in main.js.");
    } else if (mixerIntegrationManagerRef) {
        console.error("IPC_HANDLERS_INIT: mixerIntegrationManagerRef exists, but its initialize function is missing.");
    } else {
        console.warn("IPC_HANDLERS_INIT: mixerIntegrationManagerRef not provided.");
    }

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
        const config = appConfigManager.getConfig();
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

    ipcMain.handle('save-app-config', async (event, config) => {
        console.log(`IPC_HANDLER: 'save-app-config' received with config:`, JSON.stringify(config));
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
                return [];
            }
            
            // For a soundboard app, audio output device enumeration should be handled 
            // in the renderer process using navigator.mediaDevices.enumerateDevices()
            // This avoids permission issues and provides better device information
            console.log('Audio output device enumeration delegated to renderer process');
            
            // Return empty array - the renderer will handle actual device enumeration
            // This prevents duplicates and permission issues
            return [];
            
        } catch (error) {
            console.error('Error in get-audio-output-devices handler:', error);
            return [];
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
            const processedCue = await cueManagerRef.addOrUpdateProcessedCue(cueData);
            if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                 console.log('IPC Handlers: Sending cues-updated-from-main after add-or-update-cue.');
                 mainWindowRef.webContents.send('cues-updated-from-main', cueManagerRef.getCues());
            }

            // BEGINNING OF ADDED MIXER INTEGRATION LOGIC
            if (mixerIntegrationManagerRef && processedCue) {
                // Check for new mixerButtonAssignment structure
                if (processedCue.mixerButtonAssignment && processedCue.mixerButtonAssignment.buttonId) {
                    console.log(`IPC_HANDLER: 'add-or-update-cue' - Cue ${processedCue.id} has mixer button assignment. Setting up button.`);
                    // Convert mixerButtonAssignment to wingTrigger format for compatibility with existing mixer modules
                    const wingTriggerData = {
                        enabled: true,
                        mixerType: processedCue.mixerButtonAssignment.mixerType,
                        userButton: processedCue.mixerButtonAssignment.buttonId
                    };
                    
                        if (typeof mixerIntegrationManagerRef.setupWingButton === 'function') {
                            try {
                            const wingResult = await mixerIntegrationManagerRef.setupWingButton(processedCue.id, wingTriggerData);
                                if (wingResult && wingResult.success && wingResult.assignedMidiCC !== undefined) {
                                // Update the wingTrigger with the assigned MIDI CC for backward compatibility
                                const updatedCueWithMidi = { 
                                    ...processedCue, 
                                    wingTrigger: { 
                                        ...processedCue.wingTrigger, 
                                        assignedMidiCC: wingResult.assignedMidiCC,
                                        enabled: true
                                    } 
                                };
                                await cueManagerRef.addOrUpdateProcessedCue(updatedCueWithMidi, true);
                                    console.log(`IPC_HANDLER: Wing button setup for cue ${processedCue.id} successful. Assigned MIDI CC: ${wingResult.assignedMidiCC}. Cue updated with CC.`);
                                } else if (wingResult && !wingResult.success) {
                                    console.error(`IPC_HANDLER: Failed to set up Wing button for cue ${processedCue.id}: ${wingResult.error}`);
                                }
                            } catch (err) {
                                console.error(`IPC_HANDLER: Error calling setupWingButton for cue ${processedCue.id}:`, err);
                            }
                        } else {
                            console.warn('IPC_HANDLER: mixerIntegrationManagerRef.setupWingButton is not a function.');
                        }
                } else if (processedCue.wingTrigger && processedCue.wingTrigger.enabled === false) {
                        console.log(`IPC_HANDLER: 'add-or-update-cue' - Cue ${processedCue.id} has Wing trigger disabled. Attempting to clear Wing button.`);
                        if (typeof mixerIntegrationManagerRef.clearWingButton === 'function') {
                            try {
                                await mixerIntegrationManagerRef.clearWingButton(processedCue.wingTrigger);
                                // Also, nullify assignedMidiCC in the cue data
                                const updatedCueNoMidi = { ...processedCue, wingTrigger: { ...processedCue.wingTrigger, assignedMidiCC: null } };
                                await cueManagerRef.addOrUpdateProcessedCue(updatedCueNoMidi, true); // silent update
                                console.log(`IPC_HANDLER: Wing button cleared for cue ${processedCue.id}. Cue updated to remove CC.`);
                            } catch (err) {
                                console.error(`IPC_HANDLER: Error calling clearWingButton for cue ${processedCue.id}:`, err);
                            }
                        } else {
                            console.warn('IPC_HANDLER: mixerIntegrationManagerRef.clearWingButton is not a function.');
                    }
                }
            }
            // END OF ADDED MIXER INTEGRATION LOGIC

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
                return null; 
            }
            console.log(`IPC_HANDLER: 'get-audio-file-buffer' - Reading file: ${filePath}`);
            try {
                const buffer = await fsPromises.readFile(filePath);
                console.log(`IPC_HANDLER: 'get-audio-file-buffer' - Successfully read ${buffer.byteLength} bytes from ${filePath}`);
                return buffer;
            } catch (error) {
                console.error(`IPC_HANDLER: 'get-audio-file-buffer' - Error reading file ${filePath}:`, error);
                return null; 
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
            await fsPromises.access(waveformJsonPath);
            console.log(`IPC_HANDLER: Found existing waveform data at ${waveformJsonPath}`);
            const jsonData = await fsPromises.readFile(waveformJsonPath, 'utf8');
            return JSON.parse(jsonData);
        } catch (error) {
            console.log(`IPC_HANDLER: No existing waveform data found (or error accessing it), generating for ${audioFilePath}. Error: ${error.message}`);
            return new Promise((resolve, reject) => {
                const worker = new Worker(nodePath.join(__dirname, 'waveform-generator.js'), {
                    workerData: { audioFilePath }
                });
                worker.on('message', async (workerResult) => {
                    if (workerResult.error) {
                        console.warn(`IPC_HANDLER: Waveform generation FAILED for ${audioFilePath} (worker posted error): ${workerResult.error.message}. Resolving with decodeError status.`);
                        resolve({
                            peaks: null,
                            duration: null,
                            decodeError: true,
                            errorMessage: workerResult.error.message
                        });
                        return;
                    }
                    try {
                        console.log(`IPC_HANDLER: Waveform data received from worker for ${audioFilePath}`);
                        await fsPromises.writeFile(waveformJsonPath, JSON.stringify(workerResult), 'utf8');
                        console.log(`IPC_HANDLER: Saved waveform data to ${waveformJsonPath}`);
                        resolve(workerResult);
                    } catch (saveError) {
                        console.error(`IPC_HANDLER: Error saving waveform JSON for ${audioFilePath}:`, saveError);
                        reject(saveError);
                    }
                });
                worker.on('error', (workerError) => {
                    console.error(`IPC_HANDLER: Waveform generation worker CRITICAL error event for ${audioFilePath}:`, workerError);
                    resolve({
                        peaks: null,
                        duration: null,
                        decodeError: true,
                        errorMessage: workerError.message || 'Worker process failed critically or with an unhandled error.'
                    });
                });
                worker.on('exit', (code) => {
                    if (code !== 0) {
                        console.error(`IPC_HANDLER: Waveform generation worker stopped with exit code ${code} for ${audioFilePath}`);
                    }
                });
            });
        }
    });

    ipcMain.handle('get-media-duration', async (event, filePath) => {
        console.log(`IPC Handler: Received 'get-media-duration' for path: ${filePath}`);
        try {
            const duration = await getAudioFileDuration(filePath);
            return duration;
        } catch (error) {
            console.error(`IPC Handler: Error processing 'get-media-duration' for ${filePath}:`, error);
            return null;
        }
    });

    ipcMain.handle('get-config-path', () => {
        return appConfigManager.getConfigPath(); 
    });

    ipcMain.on('set-theme', (event, theme) => {
        handleThemeChange(theme, mainWindowRef, require('electron').nativeTheme);
    });

    ipcMain.removeListener('reset-inactivity-timer', () => {});

    ipcMain.handle('send-osc-message-to-mixer', async (event, { address, args }) => {
        if (mixerIntegrationManagerRef && typeof mixerIntegrationManagerRef.sendOsc === 'function') {
            mixerIntegrationManagerRef.sendOsc(address, ...(args || []));
            return { success: true };
        }
        return { success: false, error: 'Mixer integration manager not available or sendOsc not implemented.' };
    });

    ipcMain.handle('update-cue-mixer-trigger-config', async (event, cue) => {
        if (mixerIntegrationManagerRef && typeof mixerIntegrationManagerRef.updateCueMixerTrigger === 'function') {
            mixerIntegrationManagerRef.updateCueMixerTrigger(cue);
            return { success: true };
        }
        return { success: false, error: 'Mixer integration manager not available or updateCueMixerTrigger not implemented.' };
    });
    
    console.log("IPC_HANDLERS_INIT: Handler for 'get-or-generate-waveform-peaks' registered.");

    if (appConfigManagerRef && typeof appConfigManagerRef.onConfigChange === 'function') {
        appConfigManagerRef.onConfigChange((newConfig, oldConfig) => {
            console.log("IPC_HANDLERS: Detected appConfig change. Broadcasting to renderer and updating modules.");
            if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                mainWindowRef.webContents.send('app-config-updated', newConfig);
            }
            if (oscListenerRef && typeof oscListenerRef.updateConfig === 'function') {
                oscListenerRef.updateConfig(newConfig, cueManagerRef, mixerIntegrationManagerRef);
            }
            if (mixerIntegrationManagerRef && typeof mixerIntegrationManagerRef.updateSettings === 'function') {
                mixerIntegrationManagerRef.updateSettings(newConfig);
            }
            // Update HTTP server with new config (for port changes, etc.)
            if (httpServerRef && typeof httpServerRef.updateConfig === 'function') {
                httpServerRef.updateConfig(newConfig);
            }
        });
    } else {
        console.error("IPC_HANDLERS_INIT: appConfigManagerRef or onConfigChange is not available.");
    }

    // Handler for WING Button Configuration
    ipcMain.handle('configure-wing-button-for-cue', async (event, cueId, wingTriggerData) => {
        console.log(`IPC_HANDLER: 'configure-wing-button-for-cue' received for cueId: ${cueId}`, wingTriggerData);
        if (!mixerIntegrationManagerRef || typeof mixerIntegrationManagerRef.setupWingButton !== 'function') {
            console.error('IPC_HANDLER: Mixer Integration Manager or setupWingButton function not available.');
            return { success: false, error: 'Mixer Integration Manager or setupWingButton not available.' };
        }
        if (!cueManagerRef || typeof cueManagerRef.getCueById !== 'function' || typeof cueManagerRef.addOrUpdateProcessedCue !== 'function') {
            console.error('IPC_HANDLER: Cue Manager or its required functions not available.');
            return { success: false, error: 'Cue Manager not available or misconfigured.' };
        }

        try {
            const setupResult = await mixerIntegrationManagerRef.setupWingButton(cueId, wingTriggerData);

            if (setupResult && setupResult.success) {
                const cue = cueManagerRef.getCueById(cueId);
                if (cue) {
                    cue.wingTrigger = {
                        ...(cue.wingTrigger || {}), // Preserve any other existing wingTrigger fields
                        enabled: true,
                        assignedMidiCC: setupResult.assignedMidiCC,
                        label: wingTriggerData.label, // Ensure all relevant data from wingTriggerData is stored
                        wingLayer: wingTriggerData.wingLayer,
                        wingButton: wingTriggerData.wingButton,
                        wingRow: wingTriggerData.wingRow
                    };
                    await cueManagerRef.addOrUpdateProcessedCue(cue); // This saves and broadcasts
                    console.log(`IPC_HANDLER: Successfully configured WING button for cue ${cueId} with CC ${setupResult.assignedMidiCC}. Cue data updated.`);
                    return { success: true, assignedMidiCC: setupResult.assignedMidiCC };
                } else {
                    console.error(`IPC_HANDLER: WING button configured by OSC, but cue ${cueId} not found to save CC. Attempting to clear WING button.`);
                    if (typeof mixerIntegrationManagerRef.clearWingButton === 'function') {
                        // Pass minimal info needed for clearing; setupResult might contain button details
                        await mixerIntegrationManagerRef.clearWingButton(wingTriggerData); 
                    }
                    return { success: false, error: `Cue ${cueId} not found after WING config.` };
                }
            } else {
                console.error(`IPC_HANDLER: Failed to setup WING button via MixerIntegrationManager for cue ${cueId}. Error: ${setupResult ? setupResult.error : 'Unknown error'}`);
                return { success: false, error: setupResult ? setupResult.error : 'Failed to send OSC commands for WING button setup.' };
            }
        } catch (error) {
            console.error(`IPC_HANDLER: Critical error in 'configure-wing-button-for-cue' for ${cueId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('clear-wing-button-for-cue', async (event, cueId, oldWingTriggerData) => {
        console.log(`IPC_HANDLER: 'clear-wing-button-for-cue' received for cueId: ${cueId}`, oldWingTriggerData);
        if (!mixerIntegrationManagerRef || typeof mixerIntegrationManagerRef.clearWingButton !== 'function') {
            console.error('IPC_HANDLER: Mixer Integration Manager or clearWingButton function not available.');
            return { success: false, error: 'Mixer Integration Manager or clearWingButton not available.' };
        }
        if (!cueManagerRef || typeof cueManagerRef.getCueById !== 'function' || typeof cueManagerRef.addOrUpdateProcessedCue !== 'function') {
            console.error('IPC_HANDLER: Cue Manager or its required functions not available.');
            return { success: false, error: 'Cue Manager not available or misconfigured.' };
        }

        try {
            // We need oldWingTriggerData to know which button (layer, button, row) to clear on the WING.
            const clearResult = await mixerIntegrationManagerRef.clearWingButton(oldWingTriggerData);

            if (clearResult && clearResult.success) {
                const cue = cueManagerRef.getCueById(cueId);
                if (cue) {
                    if (cue.wingTrigger) { // Only modify if wingTrigger exists
                        cue.wingTrigger.enabled = false;
                        cue.wingTrigger.assignedMidiCC = null;
                        // Optionally clear other fields like label, wingLayer, etc., or leave them for re-enabling.
                    }
                    await cueManagerRef.addOrUpdateProcessedCue(cue); // This saves and broadcasts
                    console.log(`IPC_HANDLER: Successfully cleared WING button assignment for cue ${cueId}. Cue data updated.`);
                    return { success: true };
                } else {
                    console.warn(`IPC_HANDLER: WING button cleared by OSC, but cue ${cueId} not found to update.`);
                    // This is less critical than if setup failed and cue wasn't found.
                    return { success: true }; // OSC clear was successful, even if cue update failed.
                }
            } else {
                console.error(`IPC_HANDLER: Failed to clear WING button via MixerIntegrationManager for cue ${cueId}. Error: ${clearResult ? clearResult.error : 'Unknown error'}`);
                return { success: false, error: clearResult ? clearResult.error : 'Failed to send OSC commands for WING button clear.' };
            }
        } catch (error) {
            console.error(`IPC_HANDLER: Critical error in 'clear-wing-button-for-cue' for ${cueId}:`, error);
            return { success: false, error: error.message };
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
        console.log(`IPC Handler (getAudioFileDuration): Attempting to parse file for duration: ${filePath}`);
        const metadata = await mm.parseFile(filePath);
        console.log(`IPC Handler (getAudioFileDuration): Successfully parsed metadata for ${filePath}, duration: ${metadata.format.duration}`);
        return metadata.format.duration; // duration in seconds
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`IPC Handler (getAudioFileDuration): Error getting duration for ${filePath}:`, errorMessage);
        return null;
    }
}

module.exports = {
    initialize,
    handleThemeChange // Exporting handleThemeChange
}; 