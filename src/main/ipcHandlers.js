const { ipcMain, session } = require('electron');
const { generateUUID } = require('./cueManager'); // Assuming generateUUID is still relevant here or in cueManager
const appConfigManager = require('./appConfig'); // Import the new app config manager

let mainWindowRef;
let cueManagerRef;
let websocketServerRef;
let workspaceManagerRef; // Added for workspace management

function initialize(mainWindow, cueManager, websocketServer, workspaceManager) {
    mainWindowRef = mainWindow;
    cueManagerRef = cueManager;
    websocketServerRef = websocketServer;
    workspaceManagerRef = workspaceManager; // Store workspaceManager reference

    // --- IPC Handlers ---
    ipcMain.handle('get-cues', async (event) => {
        if (cueManagerRef) {
            const currentCues = cueManagerRef.getCues();
            // --- DIAGNOSTIC LOG ---
            console.log(`IPC_HANDLER: 'get-cues' - Returning ${currentCues.length} cues to renderer.`);
            return currentCues;
        }
        console.error("IPC_HANDLER: 'get-cues' - cueManagerRef not available");
        return [];
    });

    ipcMain.handle('save-cues', async (event, updatedCues) => {
        cueManagerRef.setCues(updatedCues);
        // cueManager.saveCuesToFile() is called internally by setCues
        // which in turn calls websocketServer.broadcastCuesListUpdate()
        if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited(); // Mark as edited
        return { success: true };
    });

    ipcMain.handle('generate-uuid', async () => {
        return cueManagerRef.generateUUID(); // Corrected to use cueManager instance method
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

    // New IPC handlers for app configuration
    ipcMain.handle('get-app-config', async () => {
        return appConfigManager.getConfig();
    });

    ipcMain.on('save-app-config', (event, configData) => {
        appConfigManager.updateConfig(configData);
        if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited(); // Mark as edited
        // Optionally, confirm save or send updated config back
        // For now, just saving. Renderer can re-fetch if needed or assume success.
    });

    ipcMain.handle('delete-cue', async (event, cueId) => { // Added delete-cue handler
        try {
            const success = cueManagerRef.deleteCue(cueId); // Assuming deleteCue method exists
            if (success) {
                if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited();
                // No need to broadcast here, setCues in cueManager should handle it if it modifies the list
                // Or, if deleteCue directly modifies and saves, cueManager should broadcast.
                // For now, assume cueManager handles broadcasting post-deletion if necessary.
            }
            return { success };
        } catch (error) {
            console.error('Error deleting cue:', error);
            return { success: false, error: error.message };
        }
    });

    // New IPC handler to get audio output devices
    ipcMain.handle('get-audio-output-devices', async () => {
        try {
            // Ensure defaultSession is available
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
            if (workspaceManagerRef) workspaceManagerRef.markWorkspaceAsEdited();
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
}

module.exports = {
    initialize
}; 