const fs = require('fs');
const path = require('path');
const { app } = require('electron'); // Required for app.getPath('userData')
const { v4: uuidv4 } = require('uuid');
const mixerIntegrationManager = require('./mixerIntegrationManager'); // Added for WING integration
// const mm = require('music-metadata'); // REMOVE this line

const CUES_FILE_NAME = 'cues.json';
// const CUES_CONFIG_FILE = path.join(app.getPath('userData'), 'cues.json'); // REMOVED
let currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME); // Default path

let cues = [];
let websocketServerInstance; // To notify on updates
let mainWindowRef; // To store mainWindow reference for IPC

// Function to explicitly set the directory for the cues file.
// If dirPath is null, resets to default userData path.
function setCuesDirectory(dirPath) {
  if (dirPath) {
    currentCuesFilePath = path.join(dirPath, CUES_FILE_NAME);
  } else {
    currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME);
  }
  console.log('Cues file path set to:', currentCuesFilePath);
  // After changing path, existing cues array might be stale.
  // Caller should explicitly call loadCuesFromFile() if needed.
}

function loadCuesFromFile() {
  try {
    if (fs.existsSync(currentCuesFilePath)) {
      const data = fs.readFileSync(currentCuesFilePath, 'utf-8');
      cues = JSON.parse(data);
      if (!Array.isArray(cues)) cues = [];
      console.log('Cues loaded from file:', currentCuesFilePath);
    } else {
      cues = [];
      console.log(`No cues file found at ${currentCuesFilePath}, starting fresh. Save explicitly if needed.`);
    }
  } catch (error) {
    console.error('Error loading cues from file:', currentCuesFilePath, error);
    cues = [];
  }
  return cues;
}

function saveCuesToFile() {
  if (!currentCuesFilePath) {
    console.error('CueManager: Cues file path not set. Cannot save cues.');
    return false;
  }
  // --- DIAGNOSTIC LOG --- 
  console.log('CueManager: Attempting to save cues to path:', currentCuesFilePath);
  try {
    fs.writeFileSync(currentCuesFilePath, JSON.stringify(cues, null, 2));
    console.log('Cues saved to file:', currentCuesFilePath);
    if (websocketServerInstance) {
      websocketServerInstance.broadcastCuesListUpdate(cues);
    }
    return true;
  } catch (error) {
    console.error('Error saving cues to file:', currentCuesFilePath, error);
    return false;
  }
}

function getCues() {
  // --- DIAGNOSTIC LOG ---
  console.log(`CueManager: getCues() called. Returning ${cues.length} cues.`);
  return cues;
}

function setCues(updatedCues) {
  cues = updatedCues;
  const success = saveCuesToFile();
  if (!success) {
    console.error("Failed to save cues after setCues.");
    // Optionally, throw an error or handle it more gracefully
  }
}

// Resets the in-memory cues to an empty array. Does NOT automatically save.
function resetCues() {
  console.log('CueManager: resetCues() called. Current cues length:', cues.length);
  cues = [];
  console.log('CueManager: Cues array now empty. Length:', cues.length);
  saveCuesToFile(); // This will save an empty array and also broadcast via its own logic
  console.log('CueManager: After saveCuesToFile in resetCues.');
}

function generateUUID() {
  return uuidv4();
}

// websocketServerInstance is injected to allow broadcasting updates
// mainWindow is injected to allow sending IPC to renderer
async function initialize(wssInstance, mainWin) {
  websocketServerInstance = wssInstance;
  mainWindowRef = mainWin; // Store mainWindow reference
  loadCuesFromFile(); // Load cues synchronously first

  // Post-load processing for durations
  let durationsChanged = false;
  const processedCues = [...cues]; // Work on a copy to modify

  for (let i = 0; i < processedCues.length; i++) {
    const cue = processedCues[i];
    if (cue.type === 'single_file' && cue.filePath && (!cue.knownDuration || cue.knownDuration <= 0)) {
      console.log(`CueManager Init: Processing duration for single file cue ${cue.id} - Path: ${cue.filePath}`);
      const duration = await getAudioFileDuration(cue.filePath);
      if (duration && duration > 0) {
        processedCues[i] = { ...cue, knownDuration: duration };
        durationsChanged = true;
        console.log(`CueManager Init: Updated knownDuration to ${duration} for cue ${cue.id}`);
      }
    } else if (cue.type === 'playlist' && cue.playlistItems && cue.playlistItems.length > 0) {
      let playlistItemsChanged = false;
      const updatedPlaylistItems = [...cue.playlistItems]; // Work on a copy

      for (let j = 0; j < updatedPlaylistItems.length; j++) {
        const item = updatedPlaylistItems[j];
        if (item.path && (!item.knownDuration || item.knownDuration <= 0)) {
          console.log(`CueManager Init: Processing duration for playlist item ${item.path} in cue ${cue.id}`);
          const itemDuration = await getAudioFileDuration(item.path);
          if (itemDuration && itemDuration > 0) {
            updatedPlaylistItems[j] = { ...item, knownDuration: itemDuration };
            playlistItemsChanged = true;
            console.log(`CueManager Init: Updated knownDuration to ${itemDuration} for item ${item.path} in cue ${cue.id}`);
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
    console.log("CueManager Init: Durations updated for some cues during initialization. Saving and notifying renderer.");
    saveCuesToFile(); // This will also broadcast to companion

    if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
        console.log("CueManager Init: Sending 'cues-updated-from-main' to renderer due to duration processing.");
        mainWindowRef.webContents.send('cues-updated-from-main', getCues());
    }
  } else {
    console.log("CueManager Init: No durations needed updating during initialization.");
  }
}

function deleteCue(cueId) {
  const initialLength = cues.length;
  cues = cues.filter(cue => cue.id !== cueId);
  if (cues.length < initialLength) {
    saveCuesToFile(); // This will also broadcast the update
    console.log(`Cue with ID ${cueId} deleted.`);
    return true;
  }
  console.log(`Cue with ID ${cueId} not found for deletion.`);
  return false;
}

// New function to update known duration of a cue
function updateCueKnownDuration(cueId, duration) {
  console.log(`CueManager: Attempting to update knownDuration for cue ${cueId} with duration ${duration}.`);
  const cueIndex = cues.findIndex(c => c.id === cueId);
  if (cueIndex !== -1) {
    console.log(`CueManager: Found cue ${cueId} at index ${cueIndex}. Current knownDuration: ${cues[cueIndex].knownDuration}`);
    // Only update if duration is a positive number and different or not set
    if (duration > 0 && cues[cueIndex].knownDuration !== duration) {
      cues[cueIndex].knownDuration = duration;
      console.log(`CueManager: Updated knownDuration for cue ${cueId} to ${duration}. Triggering save.`);
      if (saveCuesToFile()) { // Check if save was successful
        if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
            console.log(`CueManager (updateCueKnownDuration): Sending 'cues-updated-from-main' to renderer.`);
            mainWindowRef.webContents.send('cues-updated-from-main', getCues());
        }
      }
      return true;
    } else {
      console.log(`CueManager: Did not update knownDuration for ${cueId}. Reason: duration not positive (${duration > 0}) or not different (${cues[cueIndex].knownDuration !== duration}).`);
      return false; // Duration not updated (e.g., same or invalid)
    }
  } else {
    console.warn(`CueManager: Cue with ID ${cueId} not found to update knownDuration.`);
    return false;
  }
}

async function getAudioFileDuration(filePath) {
    let mm;
    try {
        mm = await import('music-metadata'); // Dynamic import
    } catch (e) {
        console.error('CueManager: Failed to dynamically import music-metadata:', e);
        return null;
    }

    try {
        if (!filePath) {
            console.warn('getAudioFileDuration: filePath is null or undefined.');
            return null;
        }
        // Check if file exists before trying to parse
        if (!fs.existsSync(filePath)) {
            console.warn(`getAudioFileDuration: File not found at ${filePath}`);
            return null;
        }
        console.log(`CueManager: Attempting to parse file for duration: ${filePath}`);
        const metadata = await mm.parseFile(filePath);
        console.log(`CueManager: Successfully parsed metadata for ${filePath}, duration: ${metadata.format.duration}`);
        return metadata.format.duration; // duration in seconds
    } catch (error) {
        // Log specific error message if available, otherwise generic error
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`CueManager: Error getting duration for ${filePath}:`, errorMessage);
        // Optionally, log the full error object for more details if in a debug mode
        // console.error(error); 
        return null;
    }
}

async function addOrUpdateProcessedCue(cueData) {
    let cueToProcess = JSON.parse(JSON.stringify(cueData)); // Deep copy to avoid modifying original object if passed by reference

    console.log(`CueManager: Processing cue ${cueToProcess.id || 'new cue'} - Type: ${cueToProcess.type}`);

    // Ensure playlistPlayMode defaults if not present for playlists
    if (cueToProcess.type === 'playlist') {
        if (cueToProcess.playlistPlayMode === undefined) {
            cueToProcess.playlistPlayMode = 'continue';
            console.log(`CueManager: Defaulted playlistPlayMode to 'continue' for cue ${cueToProcess.id || 'new cue'}`);
        }
        // Remove playlistPlayMode if it's not a playlist (e.g., type changed from playlist to single)
    } else if (cueToProcess.hasOwnProperty('playlistPlayMode')) {
        delete cueToProcess.playlistPlayMode;
    }

    if (cueToProcess.type === 'single_file' && cueToProcess.filePath) {
        if (cueToProcess.knownDuration === undefined || cueToProcess.knownDuration === null || cueToProcess.knownDuration <= 0) {
            console.log(`CueManager: Fetching duration for single file cue ${cueToProcess.id || 'new cue'} - Path: ${cueToProcess.filePath}`);
            const duration = await getAudioFileDuration(cueToProcess.filePath);
            if (duration && duration > 0) {
                cueToProcess.knownDuration = duration;
                console.log(`CueManager: Set knownDuration to ${duration} for cue ${cueToProcess.id || 'new cue'}`);
            } else {
                console.log(`CueManager: No valid duration found for single file ${cueToProcess.filePath}, knownDuration not set.`);
            }
        } else {
            console.log(`CueManager: Skipping duration fetch for single file cue ${cueToProcess.id || 'new cue'}, knownDuration already exists: ${cueToProcess.knownDuration}`);
        }
    } else if (cueToProcess.type === 'playlist' && cueToProcess.playlistItems && cueToProcess.playlistItems.length > 0) {
        console.log(`CueManager: Processing playlist items for cue ${cueToProcess.id || 'new cue'}. Items count: ${cueToProcess.playlistItems.length}`);
        for (let i = 0; i < cueToProcess.playlistItems.length; i++) {
            let item = cueToProcess.playlistItems[i];
            if (item.path && (item.knownDuration === undefined || item.knownDuration === null || item.knownDuration <= 0)) {
                console.log(`CueManager: Fetching duration for playlist item (index ${i}): ${item.path}`);
                const itemDuration = await getAudioFileDuration(item.path);
                if (itemDuration && itemDuration > 0) {
                    cueToProcess.playlistItems[i] = { ...item, knownDuration: itemDuration };
                    console.log(`CueManager: Set knownDuration to ${itemDuration} for playlist item ${item.path}`);
                } else {
                    console.log(`CueManager: No valid duration found for playlist item ${item.path}, knownDuration not set.`);
                    cueToProcess.playlistItems[i] = { ...item, knownDuration: null };
                }
            } else if (item.path && item.knownDuration && item.knownDuration > 0) {
                 console.log(`CueManager: Skipping duration fetch for playlist item (index ${i}), knownDuration already exists: ${item.knownDuration}`);
            } else if (!item.path) {
                 console.log(`CueManager: Skipping duration fetch for playlist item (index ${i}), path is missing.`);
            }
        }
    }

    const existingCueIndex = cues.findIndex(c => c.id === cueToProcess.id);
    if (existingCueIndex !== -1) {
        // Preserve fields that might not be sent from renderer every time but should persist
        const existingCue = cues[existingCueIndex];
        cueToProcess = { ...existingCue, ...cueToProcess };

        // If type changed from playlist to single_file, ensure playlist-specific fields are cleared
        if (existingCue.type === 'playlist' && cueToProcess.type === 'single_file') {
            delete cueToProcess.playlistItems;
            delete cueToProcess.shuffle;
            delete cueToProcess.repeatOne;
            delete cueToProcess.playlistPlayMode;
        }
        // If type changed from single_file to playlist, ensure single-file specific fields are cleared (filePath is usually handled by renderer)
        else if (existingCue.type === 'single_file' && cueToProcess.type === 'playlist') {
            delete cueToProcess.filePath; // filePath should be null for playlists
        }

        cues[existingCueIndex] = cueToProcess; // Replace existing cue
        console.log(`CueManager: Cue updated with ID: ${cueToProcess.id}`);
    } else {
        if (!cueToProcess.id) { // Should ideally always have an ID from renderer
            cueToProcess.id = generateUUID();
            console.warn(`CueManager: Generated new ID for cue as it was missing: ${cueToProcess.id}`);
        }
        cues.push(cueToProcess);
        console.log(`CueManager: Cue added with ID: ${cueToProcess.id}`);
    }
    saveCuesToFile(); // This will also broadcast via websocketServerInstance

    // After saving, if mixer integration is involved, update the mixer
    if (mixerIntegrationManager && typeof mixerIntegrationManager.updateCueMixerTrigger === 'function') {
        // Pass the fully processed cue data (which might include new ID, knownDurations etc.)
        mixerIntegrationManager.updateCueMixerTrigger(cueToProcess);
    }

    return cueToProcess; // Return the processed cue (potentially with new/updated id and durations)
}

// New function to update duration for a single cue or a specific playlist item
function updateCueItemDuration(cueId, duration, playlistItemId = null) {
    if (playlistItemId) {
        // Update duration for a specific playlist item
        const cueIndex = cues.findIndex(c => c.id === cueId);
        if (cueIndex === -1) {
            console.warn(`CueManager: Cue with ID ${cueId} not found to update playlist item duration.`);
            return false;
        }
        if (cues[cueIndex].type !== 'playlist' || !cues[cueIndex].playlistItems) {
            console.warn(`CueManager: Cue ${cueId} is not a playlist or has no items.`);
            return false;
        }
        const itemIndex = cues[cueIndex].playlistItems.findIndex(item => item.id === playlistItemId);
        if (itemIndex === -1) {
            console.warn(`CueManager: Playlist item with ID ${playlistItemId} not found in cue ${cueId}.`);
            return false;
        }

        const existingItem = cues[cueIndex].playlistItems[itemIndex];
        const currentItemKnownDuration = existingItem.knownDuration;

        // Update if new duration is valid and either no previous duration, or it's meaningfully different.
        const isValidNewDuration = duration && typeof duration === 'number' && duration > 0;
        let shouldUpdate = false;

        if (isValidNewDuration) {
            if (currentItemKnownDuration === undefined || currentItemKnownDuration === null || typeof currentItemKnownDuration !== 'number') {
                shouldUpdate = true; // No valid previous duration, so update.
            } else if (Math.abs(currentItemKnownDuration - duration) > 0.01) { // Only update if diff > 0.01s
                shouldUpdate = true; // Duration is meaningfully different.
            }
        }

        if (shouldUpdate) {
            cues[cueIndex].playlistItems[itemIndex].knownDuration = duration;
            console.log(`CueManager: Updated knownDuration for playlist item ${playlistItemId} in cue ${cueId} to ${duration}.`);
            if (saveCuesToFile()) { // Check if save was successful
                if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
                    console.log(`CueManager (updateCueItemDuration): Sending 'cues-updated-from-main' to renderer.`);
                    mainWindowRef.webContents.send('cues-updated-from-main', getCues());
                }
            }
            return true;
        } else {
            console.log(`CueManager: Did not update knownDuration for playlist item ${playlistItemId}. New duration: ${duration}, Existing: ${currentItemKnownDuration}. Reason: New duration not valid, or not meaningfully different from existing.`);
            return false;
        }
    } else {
        // Update duration for a single cue (no playlistItemId provided)
        return updateCueKnownDuration(cueId, duration);
    }
}

module.exports = {
  initialize,
  setCuesDirectory, // New
  loadCuesFromFile,
  saveCuesToFile,
  getCues,
  setCues,
  addOrUpdateProcessedCue, // Export new function
  resetCues, // New
  generateUUID,
  deleteCue, // Added deleteCue
  updateCueKnownDuration, // Export new function
  updateCueItemDuration // Export the new combined function
}; 