const fs = require('fs');
const fsPromises = require('fs').promises; // Use promises for async I/O
const path = require('path');
const { app } = require('electron'); // Required for app.getPath('userData')
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger');
const { getAudioFileDuration } = require('./utils/audioFileUtils');
// Mixer integration removed as per requirements

const CUES_FILE_NAME = 'cues.json';
let currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME); // Default path

let cues = [];
let websocketServerInstance; // To notify on updates
let httpServerInstance; // Added: To notify remote HTTP clients
let mainWindowRef; // To store mainWindow reference for IPC

// Function to explicitly set the directory for the cues file.
// If dirPath is null, resets to default userData path.
function setCuesDirectory(dirPath) {
  if (dirPath) {
    try {
      // If a full file path was provided (e.g., ends with .json), use it directly
      if (typeof dirPath === 'string' && path.extname(dirPath).toLowerCase() === '.json') {
        currentCuesFilePath = dirPath;
      } else {
        currentCuesFilePath = path.join(dirPath, CUES_FILE_NAME);
      }
    } catch (e) {
      logger.warn('Cues file path resolution failed, falling back to userData. Input:', dirPath, 'Error:', e);
      currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME);
    }
  } else {
    currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME);
  }
  logger.info('Cues file path set to:', currentCuesFilePath);
  // After changing path, existing cues array might be stale.
  // Caller should explicitly call loadCuesFromFile() if needed.
}

async function loadCuesFromFile() {
  try {
    // Check if file exists
    try {
      await fsPromises.access(currentCuesFilePath);
    } catch (e) {
      // File doesn't exist
      cues = [];
      logger.info(`No cues file found at ${currentCuesFilePath}, starting fresh. Save explicitly if needed.`);
      return cues;
    }

    const data = await fsPromises.readFile(currentCuesFilePath, 'utf-8');
    let loadedCues = JSON.parse(data);
    if (Array.isArray(loadedCues)) {
      cues = loadedCues.map(cue => {
        const migratedCue = {
          ...cue,
          // Ensure ducking properties exist with defaults
          enableDucking: cue.enableDucking !== undefined ? cue.enableDucking : false,
          duckingLevel: cue.duckingLevel !== undefined ? cue.duckingLevel : 80,
          isDuckingTrigger: cue.isDuckingTrigger !== undefined ? cue.isDuckingTrigger : false,
        };
        return migratedCue;
      });

      cues.forEach(cue => {
        if (cue.hasOwnProperty('x32Trigger')) {
          logger.info(`CueManager: Removing obsolete 'x32Trigger' from cue: ${cue.id}`);
          delete cue.x32Trigger;
        }
      });
    } else {
      cues = [];
    }
    logger.info('Cues loaded from file:', currentCuesFilePath);
  } catch (error) {
    logger.error('Error loading cues from file:', currentCuesFilePath, error);
    cues = [];
  }
  return cues;
}

async function saveCuesToFile(silent = false) {
  if (!currentCuesFilePath) {
    logger.error('CueManager: Cues file path not set. Cannot save cues.');
    return false;
  }
  // --- DIAGNOSTIC LOG --- 
  logger.info('CueManager: Attempting to save cues to path:', currentCuesFilePath, 'Silent mode:', silent);
  try {
    await fsPromises.writeFile(currentCuesFilePath, JSON.stringify(cues, null, 2));
    logger.info('Cues saved to file:', currentCuesFilePath);

    if (!silent) { // Only broadcast if not in silent mode
      if (websocketServerInstance) {
        websocketServerInstance.broadcastCuesListUpdate(cues);
      }
      // Added: Broadcast to HTTP remotes
      if (httpServerInstance && typeof httpServerInstance.broadcastToRemotes === 'function') {
        httpServerInstance.broadcastToRemotes({ type: 'all_cues', payload: cues });
        logger.info('CueManager: Broadcasted all_cues to HTTP remotes.');
      }
      // Also, if not silent and mainWindowRef exists, inform the renderer that cues were updated.
      // This covers general saves. Specific handlers in ipcHandlers might also send this.
      if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
        logger.info('CueManager (saveCuesToFile): Non-silent save, sending cues-updated-from-main to renderer.');
        mainWindowRef.webContents.send('cues-updated-from-main', getCues());
      }
    }
    return true;
  } catch (error) {
    logger.error('Error saving cues to file:', currentCuesFilePath, error);
    return false;
  }
}

function getCues() {
  // --- DIAGNOSTIC LOG ---
  logger.info(`CueManager: getCues() called. Returning ${cues.length} cues.`);
  return cues;
}

function getCueById(cueId) {
  const cue = cues.find(c => c.id === cueId);
  return cue;
}

async function setCues(updatedCues) {
  cues = updatedCues;
  const success = await saveCuesToFile();
  if (!success) {
    logger.error("Failed to save cues after setCues.");
  }
}

// Resets the in-memory cues to an empty array. Does NOT automatically save.
async function resetCues() {
  logger.info('CueManager: resetCues() called. Current cues length:', cues.length);
  cues = [];
  logger.info('CueManager: Cues array now empty. Length:', cues.length);
  await saveCuesToFile(); // This will save an empty array and also broadcast via its own logic
  logger.info('CueManager: After saveCuesToFile in resetCues.');
}

function generateUUID() {
  return uuidv4();
}

// websocketServerInstance is injected to allow broadcasting updates
// mainWindow is injected to allow sending IPC to renderer
// httpServer is injected for remote control updates
async function initialize(wssInstance, mainWin, httpServerRef) {
  websocketServerInstance = wssInstance;
  mainWindowRef = mainWin; // Store mainWindow reference
  httpServerInstance = httpServerRef; // Added: Store httpServer reference
  await loadCuesFromFile(); // Load cues asynchronously

  // Post-load processing for durations
  let durationsChanged = false;
  const processedCues = [...cues]; // Work on a copy to modify

  for (let i = 0; i < processedCues.length; i++) {
    const cue = processedCues[i];
    if (cue.type === 'single_file' && cue.filePath && (!cue.knownDuration || cue.knownDuration <= 0)) {
      logger.info(`CueManager Init: Processing duration for single file cue ${cue.id} - Path: ${cue.filePath}`);
      const duration = await getAudioFileDuration(cue.filePath);
      if (duration && duration > 0) {
        processedCues[i] = { ...cue, knownDuration: duration };
        durationsChanged = true;
        logger.info(`CueManager Init: Updated knownDuration to ${duration} for cue ${cue.id}`);
      }
    } else if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
      let playlistItemsChanged = false;
      const updatedPlaylistItems = [...cue.playlistItems]; // Work on a copy

      for (let j = 0; j < updatedPlaylistItems.length; j++) {
        const item = updatedPlaylistItems[j];
        if (item.path && (!item.knownDuration || item.knownDuration <= 0)) {
          logger.info(`CueManager Init: Processing duration for playlist item ${item.path} in cue ${cue.id}`);
          const itemDuration = await getAudioFileDuration(item.path);
          if (itemDuration && itemDuration > 0) {
            updatedPlaylistItems[j] = { ...item, knownDuration: itemDuration };
            playlistItemsChanged = true;
            logger.info(`CueManager Init: Updated knownDuration to ${itemDuration} for item ${item.path} in cue ${cue.id}`);
          }
        }
      }
      if (playlistItemsChanged) {
        processedCues[i] = { ...cue, playlistItems: updatedPlaylistItems };
        durationsChanged = true;
      }
    }
  }

  if (durationsChanged) {
    cues = processedCues; // Assign the modified array back to the module-level 'cues'
    logger.info("CueManager Init: Durations updated for some cues during initialization. Saving and notifying renderer.");
    await saveCuesToFile(); // This will also broadcast to companion

    if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
      logger.info("CueManager Init: Sending 'cues-updated-from-main' to renderer due to duration processing.");
      mainWindowRef.webContents.send('cues-updated-from-main', getCues());
    }
  } else {
    logger.info("CueManager Init: No durations needed updating during initialization.");
  }
}

async function deleteCue(cueId) {
  const initialLength = cues.length;
  cues = cues.filter(cue => cue.id !== cueId);
  if (cues.length < initialLength) {
    await saveCuesToFile(); // This will also broadcast the update
    logger.info(`Cue with ID ${cueId} deleted.`);
    return true;
  }
  logger.info(`Cue with ID ${cueId} not found for deletion.`);
  return false;
}

// New function to update known duration of a cue
async function updateCueKnownDuration(cueId, duration) {
  logger.info(`CueManager: Attempting to update knownDuration for cue ${cueId} with duration ${duration}.`);
  const cueIndex = cues.findIndex(c => c.id === cueId);
  if (cueIndex !== -1) {
    logger.info(`CueManager: Found cue ${cueId} at index ${cueIndex}. Current knownDuration: ${cues[cueIndex].knownDuration}`);
    // Only update if duration is a positive number and different or not set
    if (duration > 0 && cues[cueIndex].knownDuration !== duration) {
      cues[cueIndex].knownDuration = duration;
      logger.info(`CueManager: Updated knownDuration for cue ${cueId} to ${duration}. Triggering save.`);
      const success = await saveCuesToFile();
      if (success) { // Check if save was successful
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
          logger.info(`CueManager (updateCueKnownDuration): Sending 'cues-updated-from-main' to renderer.`);
          mainWindowRef.webContents.send('cues-updated-from-main', getCues());
        }
      }
      return true;
    } else {
      logger.info(`CueManager: Did not update knownDuration for ${cueId}. Reason: duration not positive (${duration > 0}) or not different (${cues[cueIndex].knownDuration !== duration}).`);
      return false; // Duration not updated (e.g., same or invalid)
    }
  } else {
    logger.warn(`CueManager: Cue with ID ${cueId} not found to update knownDuration.`);
    return false;
  }
}

// ***** NEW FUNCTION *****
// Function to trigger a cue by its ID
function triggerCueById(cueId, source = 'unknown') {
  logger.info(`CueManager: triggerCueById called for ID: ${cueId}, Source: ${source}`);
  const cue = cues.find(c => c.id === cueId);

  if (cue) {
    logger.info(`CueManager: Found cue "${cue.name}" to trigger.`);
    if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
      logger.info(`CueManager: Sending 'trigger-cue-by-id-from-main' to renderer for cue ${cueId}`);
      mainWindowRef.webContents.send('trigger-cue-by-id-from-main', { cueId, source });
    } else {
      logger.error('CueManager: mainWindowRef not available or webContents destroyed. Cannot send trigger IPC message.');
    }
  } else {
    logger.warn(`CueManager: Cue with ID ${cueId} not found for triggering.`);
  }
}

// Mixer trigger function removed

async function addOrUpdateProcessedCue(cueData, workspacePath) {
  logger.info(`[CueManager] addOrUpdateProcessedCue received raw cueData. ID: ${cueData.id}, Name: ${cueData.name}`);
  // ... (logging kept brief here for clarity, assumed unchanged in logic) ...

  const cueId = cueData.id || generateUUID(); // Generate UUID if not provided
  const existingCueIndex = cues.findIndex(c => c.id === cueId);
  let isNew = true;
  if (existingCueIndex !== -1) {
    isNew = false;
  }

  const effectiveRetriggerBehavior = cueData.retriggerBehavior || 'restart';

  const baseCue = {
    id: cueId,
    name: cueData.name || 'Unnamed Cue',
    type: cueData.type || 'single_file',
    filePath: cueData.filePath || null,
    volume: cueData.volume !== undefined ? cueData.volume : 1,
    fadeInTime: cueData.fadeInTime || 0,
    fadeOutTime: cueData.fadeOutTime || 0,
    loop: cueData.loop || false,
    retriggerBehavior: effectiveRetriggerBehavior,
    retriggerAction: effectiveRetriggerBehavior,
    retriggerActionCompanion: effectiveRetriggerBehavior,
    knownDuration: cueData.knownDuration || 0,
    playlistItems: cueData.playlistItems || [],
    shuffle: cueData.shuffle || false,
    repeatOne: cueData.repeatOne || false,
    playlistPlayMode: cueData.playlistPlayMode || 'continue',
    trimStartTime: (cueData.trimStartTime !== undefined && cueData.trimStartTime !== null) ? cueData.trimStartTime : 0,
    trimEndTime: (cueData.trimEndTime !== undefined && cueData.trimEndTime !== null) ? cueData.trimEndTime : undefined,
    enableDucking: cueData.enableDucking !== undefined ? cueData.enableDucking : false,
    duckingLevel: cueData.duckingLevel !== undefined ? cueData.duckingLevel : 80,
    isDuckingTrigger: cueData.isDuckingTrigger !== undefined ? cueData.isDuckingTrigger : false,
  };

  // Ensure playlist items have unique IDs and knownDurations if not present
  if (baseCue.type === 'playlist' && baseCue.playlistItems) {
    baseCue.playlistItems.forEach(item => {
      if (!item.id) {
        item.id = generateUUID();
      }
      if (item.knownDuration === undefined || item.knownDuration === null || typeof item.knownDuration !== 'number' || item.knownDuration <= 0) {
        item.knownDuration = 0;
      }
    });
  }

  // IMMEDIATE DURATION DETECTION
  let durationsDetected = false;

  // For single file cues
  if (baseCue.type === 'single_file' && baseCue.filePath && (!baseCue.knownDuration || baseCue.knownDuration <= 0)) {
    logger.info(`CueManager: Detecting duration for new single file cue ${baseCue.id}`);
    try {
      const duration = await getAudioFileDuration(baseCue.filePath);
      if (duration && duration > 0) {
        baseCue.knownDuration = duration;
        durationsDetected = true;
        logger.info(`CueManager: Detected knownDuration ${duration}`);
      }
    } catch (error) {
      logger.error(`CueManager: Error detecting duration:`, error);
    }
  }

  // For playlist cues
  if (baseCue.type === 'playlist' && baseCue.playlistItems) {
    for (let i = 0; i < baseCue.playlistItems.length; i++) {
      const item = baseCue.playlistItems[i];
      if (item.path && (!item.knownDuration || item.knownDuration <= 0)) {
        logger.info(`CueManager: Detecting duration for playlist item ${item.path}`);
        try {
          const itemDuration = await getAudioFileDuration(item.path);
          if (itemDuration && itemDuration > 0) {
            baseCue.playlistItems[i].knownDuration = itemDuration;
            durationsDetected = true;
            logger.info(`CueManager: Detected knownDuration ${itemDuration}`);
          }
        } catch (error) {
          logger.error(`CueManager: Error detecting duration:`, error);
        }
      }
    }
  }

  if (isNew) {
    cues.push(baseCue);
    logger.info(`[CueManager] Added new cue.`);
  } else {
    cues[existingCueIndex] = baseCue;
    logger.info(`[CueManager] Updated existing cue.`);
  }

  // Save and notify (unless silentUpdate is true)
  await saveCuesToFile();

  // If durations were detected, send update to renderer
  if (durationsDetected && mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
    logger.info(`CueManager: Sending 'cues-updated-from-main' to renderer due to duration detection.`);
    mainWindowRef.webContents.send('cues-updated-from-main', getCues());
  }

  // Return a copy of the processed cue
  const finalCueIndex = isNew ? cues.length - 1 : existingCueIndex;
  return { ...cues[finalCueIndex] };
}

// New function to update duration for a single cue or a specific playlist item
async function updateCueItemDuration(cueId, duration, playlistItemId = null) {
  if (playlistItemId) {
    // Update duration for a specific playlist item
    const cueIndex = cues.findIndex(c => c.id === cueId);
    if (cueIndex === -1) {
      logger.warn(`CueManager: Cue with ID ${cueId} not found to update playlist item duration.`);
      return false;
    }
    if (cues[cueIndex].type !== 'playlist' || !cues[cueIndex].playlistItems) {
      logger.warn(`CueManager: Cue ${cueId} is not a playlist or has no items.`);
      return false;
    }
    const itemIndex = cues[cueIndex].playlistItems.findIndex(item => item.id === playlistItemId);
    if (itemIndex === -1) {
      logger.warn(`CueManager: Playlist item with ID ${playlistItemId} not found in cue ${cueId}.`);
      return false;
    }

    const existingItem = cues[cueIndex].playlistItems[itemIndex];
    const currentItemKnownDuration = existingItem.knownDuration;

    const isValidNewDuration = duration && typeof duration === 'number' && duration > 0;
    let shouldUpdate = false;

    if (isValidNewDuration) {
      if (currentItemKnownDuration === undefined || currentItemKnownDuration === null || typeof currentItemKnownDuration !== 'number') {
        shouldUpdate = true;
      } else if (Math.abs(currentItemKnownDuration - duration) > 0.01) {
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      cues[cueIndex].playlistItems[itemIndex].knownDuration = duration;
      logger.info(`CueManager: Updated knownDuration for playlist item ${playlistItemId}.`);
      const success = await saveCuesToFile();
      if (success) { // Check if save was successful
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
          logger.info(`CueManager (updateCueItemDuration): Sending 'cues-updated-from-main' to renderer.`);
          mainWindowRef.webContents.send('cues-updated-from-main', getCues());
        }
      }
      return true;
    } else {
      logger.info(`CueManager: Did not update knownDuration for playlist item ${playlistItemId}.`);
      return false;
    }
  } else {
    // Update duration for a single cue (no playlistItemId provided)
    return updateCueKnownDuration(cueId, duration);
  }
}

// Function to get the default cues file path
function getDefaultCuesPath() {
  return path.join(app.getPath('userData'), CUES_FILE_NAME);
}

module.exports = {
  initialize,
  setCuesDirectory,
  loadCuesFromFile,
  saveCuesToFile,
  getCues,
  getCueById,
  setCues,
  addOrUpdateProcessedCue,
  resetCues,
  generateUUID,
  deleteCue,
  updateCueKnownDuration,
  updateCueItemDuration,
  triggerCueById,
  getDefaultCuesPath
};
