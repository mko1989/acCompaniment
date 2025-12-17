const { ipcMain } = require('electron');
const logger = require('../utils/logger');
const { getAudioFileDuration } = require('../utils/audioFileUtils');
const { calculateEffectiveTrimmedDurationSec } = require('../../common/timeUtils');
const path = require('path');
const { Worker } = require('worker_threads');
const fs = require('fs');
const fsPromises = require('fs').promises;

function registerAudioHandlers(ipcMain, { cueManager, workspaceManager, mainWindow, websocketServer, httpServer }) {
    
    ipcMain.handle('get-cues', async (event) => {
        logger.info("IPC_HANDLER: 'get-cues' called");
        if (cueManager && typeof cueManager.getCues === 'function') {
            const currentCues = cueManager.getCues();
            logger.info(`IPC_HANDLER: 'get-cues' - Returning ${currentCues.length} cues.`);
            return currentCues;
        }
        logger.error("IPC_HANDLER: 'get-cues' - cueManager not available");
        return [];
    });

    ipcMain.handle('save-cues', async (event, updatedCues) => {
        await cueManager.setCues(updatedCues);
        if (workspaceManager) workspaceManager.markWorkspaceAsEdited();
        return { success: true };
    });

    ipcMain.handle('save-reordered-cues', async (event, reorderedCues) => {
        logger.info(`IPC_HANDLER: 'save-reordered-cues' received for ${reorderedCues.length} cues.`);
        if (cueManager) {
            await cueManager.setCues(reorderedCues);
            if (workspaceManager) workspaceManager.markWorkspaceAsEdited();
            return { success: true };
        }
        return { success: false, error: 'CueManager not available' };
    });

    ipcMain.handle('load-cues', async () => {
        return await cueManager.loadCuesFromFile();
    });

    ipcMain.on('cue-status-update-for-companion', (event, { cueId, status, error }) => {
        logger.info(`IPC: Cue status update from renderer: ${cueId} - ${status}`);
        if (websocketServer) {
            websocketServer.broadcastCueStatus(cueId, status, error);
        }
    });

    ipcMain.on('cue-status-update', (event, { cueId, status, details }) => {
        logger.info(`[IPC_DEBUG] Cue status update: ${cueId} - ${status}`, details);

        // Send cued state updates to HTTP remote
        if (httpServer && typeof httpServer.broadcastToRemotes === 'function' && status === 'cued_next') {
            const currentCue = cueManager ? cueManager.getCueById(cueId) : null;
            if (currentCue) {
                logger.info(`HTTP_SERVER: Sending cued state update for playlist ${cueId} to remote`);
                
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
                httpServer.broadcastToRemotes(cuedUpdate);
            }
        }
    });

    ipcMain.on('playback-time-update', (event, payload) => {
        // Relay the message back to the renderer for UI updates
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('playback-time-update-from-main', payload);
        }

        // Broadcast to external clients (Companion and remote control)
        if (websocketServer && typeof websocketServer.broadcastPlaybackTimeUpdate === 'function') {
            websocketServer.broadcastPlaybackTimeUpdate(payload);
        }
        if (httpServer && typeof httpServer.broadcastToRemotes === 'function') {
            const currentCue = cueManager ? cueManager.getCueById(payload.cueId) : null;
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
            httpServer.broadcastToRemotes(remoteCueUpdate);

            // CRITICAL FIX: When a cue stops, send idle duration updates for all other cues
            if (payload.status === 'stopped' && cueManager) {
                logger.info(`HTTP_SERVER: Cue ${payload.cueId} stopped, sending idle duration updates for all cues to remote`);
                const allCues = cueManager.getCues();

                allCues.forEach(cue => {
                    if (cue.id !== payload.cueId) {
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
                        httpServer.broadcastToRemotes(idleUpdate);
                    }
                });
            }
        }
    });

    ipcMain.handle('delete-cue', async (event, cueId) => {
        try {
            const success = await cueManager.deleteCue(cueId);
            if (success) {
                if (workspaceManager) workspaceManager.markWorkspaceAsEdited();
                if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    logger.info(`IPC_HANDLER: 'delete-cue' - Cue ${cueId} deleted. Sending updated cue list to renderer.`);
                    mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
                }
                return { success: true };
            } else {
                logger.warn(`IPC_HANDLER: 'delete-cue' - Cue with ID ${cueId} not found.`);
                return { success: false, error: `Cue with ID ${cueId} not found.` };
            }
        } catch (error) {
            logger.error('Error deleting cue:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('add-or-update-cue', async (event, cueData) => {
        if (!cueManager) {
            logger.error("IPC_HANDLER: 'add-or-update-cue' - cueManager not available");
            return { success: false, error: 'Cue manager not available.', cue: null };
        }
        try {
            logger.info(`IPC_HANDLER: 'add-or-update-cue' for ID: ${cueData.id || 'new cue'}`);
            const processedCue = await cueManager.addOrUpdateProcessedCue(cueData);
            
            if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
            }
            return { success: true, cue: processedCue };
        } catch (error) {
            logger.error('IPC_HANDLER: Error processing add-or-update-cue:', error);
            return { success: false, error: error.message, cue: null };
        }
    });

    ipcMain.on('cue-duration-update', (event, { cueId, duration, playlistItemId }) => {
        if (cueManager) {
            logger.info(`IPC_HANDLER: 'cue-duration-update' received for cue: ${cueId}`);
            cueManager.updateCueItemDuration(cueId, duration, playlistItemId);
        }
    });

    ipcMain.handle('get-media-duration', async (event, filePath) => {
        logger.info(`IPC Handler: Received 'get-media-duration' for path: ${filePath}`);
        try {
            if (!filePath) return { success: false, error: 'No file path', duration: null };
            
            const duration = await getAudioFileDuration(filePath);
            if (duration !== null) {
                return { success: true, duration, filePath };
            }
            return { success: false, error: 'Could not determine duration', duration: null, filePath };
        } catch (error) {
            logger.error(`IPC Handler: Error in get-media-duration for ${filePath}:`, error);
            return { success: false, error: error.message, duration: null, filePath };
        }
    });

    ipcMain.handle('get-audio-file-buffer', async (event, filePath) => {
        try {
            if (!filePath) return { success: false, error: 'No file path provided', buffer: null };
            if (!fs.existsSync(filePath)) return { success: false, error: 'File does not exist', buffer: null, filePath };

            logger.info(`IPC_HANDLER: Reading file: ${filePath}`);
            const buffer = await fsPromises.readFile(filePath);
            return { success: true, buffer, size: buffer.byteLength, filePath };
        } catch (e) {
            logger.error(`IPC_HANDLER: Error in 'get-audio-file-buffer':`, e);
            return { success: false, error: e.message, buffer: null, filePath };
        }
    });

    // Helper for waveform generation
    async function generateWaveformWithRetry(audioFilePath, retryCount = 0) {
        const waveformJsonPath = audioFilePath + '.peaks.json';
        const maxRetries = 2;
        logger.info(`IPC_HANDLER: 'generateWaveformWithRetry' for ${audioFilePath}, retry: ${retryCount}`);

        try {
            await fsPromises.access(waveformJsonPath);
            const jsonData = await fsPromises.readFile(waveformJsonPath, 'utf8');
            const parsedData = JSON.parse(jsonData);
            if (parsedData && (parsedData.peaks || parsedData.duration)) {
                return { success: true, ...parsedData, cached: true };
            }
            try { await fsPromises.unlink(waveformJsonPath); } catch (e) {}
        } catch (error) {
            // No cache or invalid
        }

        return new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, '../waveform-generator.js'), {
                workerData: { audioFilePath }
            });

            const workerTimeout = setTimeout(() => {
                worker.terminate();
                if (retryCount < maxRetries) {
                    setTimeout(async () => {
                        resolve(await generateWaveformWithRetry(audioFilePath, retryCount + 1));
                    }, Math.pow(2, retryCount) * 1000);
                } else {
                    resolve({ success: false, error: 'timeout', errorMessage: 'Timed out' });
                }
            }, 30000);

            worker.on('message', async (workerResult) => {
                clearTimeout(workerTimeout);
                if (workerResult.error) {
                    if (retryCount < maxRetries) {
                        setTimeout(async () => {
                            resolve(await generateWaveformWithRetry(audioFilePath, retryCount + 1));
                        }, Math.pow(2, retryCount) * 1000);
                    } else {
                        resolve({ success: false, error: 'generation_failed', errorMessage: workerResult.error.message });
                    }
                    return;
                }
                try {
                    await fsPromises.writeFile(waveformJsonPath, JSON.stringify(workerResult), 'utf8');
                    resolve({ success: true, ...workerResult, cached: false });
                } catch (e) {
                    resolve({ success: true, ...workerResult, cached: false, saveWarning: e.message });
                }
            });

            worker.on('error', (err) => {
                clearTimeout(workerTimeout);
                if (retryCount < maxRetries) {
                    setTimeout(async () => {
                        resolve(await generateWaveformWithRetry(audioFilePath, retryCount + 1));
                    }, Math.pow(2, retryCount) * 1000);
                } else {
                    resolve({ success: false, error: 'worker_error', errorMessage: err.message });
                }
            });

            worker.on('exit', (code) => {
                clearTimeout(workerTimeout);
                if (code !== 0) {
                    if (retryCount < maxRetries) {
                        setTimeout(async () => {
                            resolve(await generateWaveformWithRetry(audioFilePath, retryCount + 1));
                        }, Math.pow(2, retryCount) * 1000);
                    } else {
                        resolve({ success: false, error: 'worker_exit_error', errorMessage: `Exited with code ${code}` });
                    }
                }
            });
        });
    }

    ipcMain.handle('get-or-generate-waveform-peaks', async (event, audioFilePath) => {
        return await generateWaveformWithRetry(audioFilePath);
    });

    // Playlist Navigation Handlers
    ipcMain.handle('playlist-navigate-next', async (event, cueId) => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('playlist-navigate-next-from-main', cueId);
            return { success: true };
        }
        return { success: false, error: 'Main window not available' };
    });

    ipcMain.handle('playlist-navigate-previous', async (event, cueId) => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('playlist-navigate-previous-from-main', cueId);
            return { success: true };
        }
        return { success: false, error: 'Main window not available' };
    });

    ipcMain.handle('playlist-jump-to-item', async (event, cueId, targetIndex) => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('playlist-jump-to-item-from-main', { cueId, targetIndex });
            return { success: true };
        }
        return { success: false, error: 'Main window not available' };
    });
}

module.exports = registerAudioHandlers;

