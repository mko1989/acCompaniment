const fs = require('fs');
const path = require('path');
const { app } = require('electron'); // Required for app.getPath('userData')
const { v4: uuidv4 } = require('uuid');
// Mixer integration removed as per requirements

const CUES_FILE_NAME = 'cues.json';
let currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME); // Default path

// REMOVED DEFAULT_MIDI_TRIGGER
// const DEFAULT_MIDI_TRIGGER = {
// enabled: false,
// type: null,
// channel: null,
// note: null,
// velocity: null,
// controller: null,
// value: null
// };

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
      console.warn('Cues file path resolution failed, falling back to userData. Input:', dirPath, 'Error:', e);
      currentCuesFilePath = path.join(app.getPath('userData'), CUES_FILE_NAME);
    }
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
        
        
        // Clean up any lingering midiTrigger and oscTrigger properties from old files
        cues.forEach(cue => {
          if (cue.hasOwnProperty('midiTrigger')) {
            console.log(`CueManager: Removing obsolete 'midiTrigger' from cue: ${cue.id}`);
            delete cue.midiTrigger;
          }
          if (cue.hasOwnProperty('oscTrigger')) {
            console.log(`CueManager: Removing obsolete 'oscTrigger' from cue: ${cue.id}`);
            delete cue.oscTrigger;
          }
          if (cue.hasOwnProperty('x32Trigger')) {
            console.log(`CueManager: Removing obsolete 'x32Trigger' from cue: ${cue.id}`);
            delete cue.x32Trigger;
          }
        });
      } else {
        cues = [];
      }
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

function saveCuesToFile(silent = false) {
  if (!currentCuesFilePath) {
    console.error('CueManager: Cues file path not set. Cannot save cues.');
    return false;
  }
  // --- DIAGNOSTIC LOG --- 
  console.log('CueManager: Attempting to save cues to path:', currentCuesFilePath, 'Silent mode:', silent);
  try {
    fs.writeFileSync(currentCuesFilePath, JSON.stringify(cues, null, 2));
    console.log('Cues saved to file:', currentCuesFilePath);

    if (!silent) { // Only broadcast if not in silent mode
      if (websocketServerInstance) {
        websocketServerInstance.broadcastCuesListUpdate(cues);
      }
      // Added: Broadcast to HTTP remotes
      if (httpServerInstance && typeof httpServerInstance.broadcastToRemotes === 'function') {
          httpServerInstance.broadcastToRemotes({ type: 'all_cues', payload: cues });
          console.log('CueManager: Broadcasted all_cues to HTTP remotes.');
      }
      // Also, if not silent and mainWindowRef exists, inform the renderer that cues were updated.
      // This covers general saves. Specific handlers in ipcHandlers might also send this.
      if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
        console.log('CueManager (saveCuesToFile): Non-silent save, sending cues-updated-from-main to renderer.');
        mainWindowRef.webContents.send('cues-updated-from-main', getCues());
      }
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

function getCueById(cueId) {
  const cue = cues.find(c => c.id === cueId);
  // Optional: Add logging here if needed, for example:
  // if (cue) {
  //   console.log(`CueManager: Found cue by ID ${cueId}:`, cue.name);
  // } else {
  //   console.warn(`CueManager: Cue with ID ${cueId} not found.`);
  // }
  return cue;
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
// httpServer is injected for remote control updates
async function initialize(wssInstance, mainWin, httpServerRef) {
  websocketServerInstance = wssInstance;
  mainWindowRef = mainWin; // Store mainWindow reference
  httpServerInstance = httpServerRef; // Added: Store httpServer reference
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

// ***** NEW FUNCTION *****
// Function to trigger a cue by its ID, typically called from an external source (MIDI, OSC)
function triggerCueById(cueId, source = 'unknown') {
  console.log(`CueManager: triggerCueById called for ID: ${cueId}, Source: ${source}`);
  const cue = cues.find(c => c.id === cueId);

  if (cue) {
    console.log(`CueManager: Found cue "${cue.name}" to trigger.`);
    if (mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
      console.log(`CueManager: Sending 'trigger-cue-by-id-from-main' to renderer for cue ${cueId}`);
      mainWindowRef.webContents.send('trigger-cue-by-id-from-main', { cueId, source });
    } else {
      console.error('CueManager: mainWindowRef not available or webContents destroyed. Cannot send trigger IPC message.');
    }
  } else {
    console.warn(`CueManager: Cue with ID ${cueId} not found for triggering.`);
  }
}

// Mixer trigger function removed

// Function to get audio file duration (used internally)
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

async function addOrUpdateProcessedCue(cueData, workspacePath) {
    console.log(`[CueManager] addOrUpdateProcessedCue received raw cueData. ID: ${cueData.id}, Name: ${cueData.name}`);
    console.log(`[CueManager] Ducking properties received: isDuckingTrigger=${cueData.isDuckingTrigger}, duckingLevel=${cueData.duckingLevel}, enableDucking=${cueData.enableDucking}`);
    console.log(`[CueManager] Trim properties received: trimStartTime=${cueData.trimStartTime}, trimEndTime=${cueData.trimEndTime}`);
    console.log(`[CueManager] All received cueData properties:`, Object.keys(cueData));
    
    // Log the full cueData object for complete debugging (temporarily)
    console.log(`[CueManager] Full cueData object:`, JSON.stringify(cueData, null, 2));

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
      volume: cueData.volume !== undefined ? cueData.volume : 1, // Default to 1 (100%)
      fadeInTime: cueData.fadeInTime || 0,
      fadeOutTime: cueData.fadeOutTime || 0,
      loop: cueData.loop || false,
      retriggerBehavior: effectiveRetriggerBehavior,
      retriggerAction: effectiveRetriggerBehavior, // TODO: Consolidate retriggerAction & retriggerBehavior
      retriggerActionCompanion: effectiveRetriggerBehavior, // TODO: Consolidate
      knownDuration: cueData.knownDuration || 0,
      // OSC Trigger specific properties - REMOVED
      // oscTrigger: cueData.oscTrigger ? 
      //             { enabled: false, path: null, args: [], ...cueData.oscTrigger } : 
      //             { enabled: false, path: null, args: [] },
      // Playlist specific properties
      playlistItems: cueData.playlistItems || [],
      shuffle: cueData.shuffle || false, // for playlists
      repeatOne: cueData.repeatOne || false, // for playlists
      playlistPlayMode: cueData.playlistPlayMode || 'continue', // 'continue' or 'stop_and_cue_next'
      // Trim specific properties
      // Use explicit checks so that an unset end trim is treated as undefined ("play to end")
      // rather than 0, which some renderer logic interprets as a literal zero-second end.
      trimStartTime: (cueData.trimStartTime !== undefined && cueData.trimStartTime !== null) ? cueData.trimStartTime : 0,
      trimEndTime: (cueData.trimEndTime !== undefined && cueData.trimEndTime !== null) ? cueData.trimEndTime : undefined,
      // X32/X-Air specific - REMOVED
      // x32Trigger: cueData.x32Trigger ? 
      //             { enabled: false, layer: 'A', button: '1', ...cueData.x32Trigger } :
      //             { enabled: false, layer: 'A', button: '1' },
      // Ducking Properties
      enableDucking: cueData.enableDucking !== undefined ? cueData.enableDucking : false,
      duckingLevel: cueData.duckingLevel !== undefined ? cueData.duckingLevel : 80,
      isDuckingTrigger: cueData.isDuckingTrigger !== undefined ? cueData.isDuckingTrigger : false,
    };

    // Debug logging for the constructed baseCue
    console.log(`[CueManager] Constructed baseCue trim properties: trimStartTime=${baseCue.trimStartTime}, trimEndTime=${baseCue.trimEndTime}`);
    console.log(`[CueManager] Constructed baseCue knownDuration: ${baseCue.knownDuration}`);

    // Ensure playlist items have unique IDs and knownDurations if not present
    if (baseCue.type === 'playlist' && baseCue.playlistItems) {
      baseCue.playlistItems.forEach(item => {
        if (!item.id) {
          item.id = generateUUID();
        }
        // If item.knownDuration is missing or invalid, leave it as is (or ensure it's 0).
        // Duration will be detected below if missing.
        if (item.knownDuration === undefined || item.knownDuration === null || typeof item.knownDuration !== 'number' || item.knownDuration <= 0) {
          item.knownDuration = 0; // Default to 0 if not a valid positive number
        }
      });
    }

    // IMMEDIATE DURATION DETECTION: Detect audio file durations for new cues
    let durationsDetected = false;
    
    // For single file cues: detect duration if missing and file path exists
    if (baseCue.type === 'single_file' && baseCue.filePath && (!baseCue.knownDuration || baseCue.knownDuration <= 0)) {
      console.log(`CueManager: Detecting duration for new single file cue ${baseCue.id} - Path: ${baseCue.filePath}`);
      try {
        const duration = await getAudioFileDuration(baseCue.filePath);
        if (duration && duration > 0) {
          baseCue.knownDuration = duration;
          durationsDetected = true;
          console.log(`CueManager: Detected knownDuration ${duration} for cue ${baseCue.id}`);
        } else {
          console.warn(`CueManager: Could not detect duration for ${baseCue.filePath}`);
        }
      } catch (error) {
        console.error(`CueManager: Error detecting duration for ${baseCue.filePath}:`, error);
      }
    }
    
    // For playlist cues: detect durations for items with missing durations
    if (baseCue.type === 'playlist' && baseCue.playlistItems) {
      for (let i = 0; i < baseCue.playlistItems.length; i++) {
        const item = baseCue.playlistItems[i];
        if (item.path && (!item.knownDuration || item.knownDuration <= 0)) {
          console.log(`CueManager: Detecting duration for playlist item ${item.path} in cue ${baseCue.id}`);
          try {
            const itemDuration = await getAudioFileDuration(item.path);
            if (itemDuration && itemDuration > 0) {
              baseCue.playlistItems[i].knownDuration = itemDuration;
              durationsDetected = true;
              console.log(`CueManager: Detected knownDuration ${itemDuration} for item ${item.path} in cue ${baseCue.id}`);
            } else {
              console.warn(`CueManager: Could not detect duration for playlist item ${item.path}`);
            }
          } catch (error) {
            console.error(`CueManager: Error detecting duration for playlist item ${item.path}:`, error);
          }
        }
      }
    }

    if (isNew) {
      cues.push(baseCue);
      console.log(`[CueManager] Added new cue to array. Final trim properties: trimStartTime=${baseCue.trimStartTime}, trimEndTime=${baseCue.trimEndTime}`);
    } else {
      cues[existingCueIndex] = baseCue;
      console.log(`[CueManager] Updated existing cue in array. Final trim properties: trimStartTime=${baseCue.trimStartTime}, trimEndTime=${baseCue.trimEndTime}`);
    }

    // Save and notify (unless silentUpdate is true)
    saveCuesToFile();
    
    // If durations were detected, send update to renderer
    if (durationsDetected && mainWindowRef && mainWindowRef.webContents && !mainWindowRef.webContents.isDestroyed()) {
        console.log(`CueManager: Sending 'cues-updated-from-main' to renderer due to duration detection for cue ${baseCue.id}`);
        mainWindowRef.webContents.send('cues-updated-from-main', getCues());
    }

    // Return a copy of the processed cue from the array
    const finalCueIndex = isNew ? cues.length - 1 : existingCueIndex;
    return { ...cues[finalCueIndex] };
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



// Function to get the default cues file path
function getDefaultCuesPath() {
    return path.join(app.getPath('userData'), CUES_FILE_NAME);
}

module.exports = {
  initialize,
  setCuesDirectory, // New
  loadCuesFromFile,
  saveCuesToFile,
  getCues,
  getCueById, // Added missing export
  setCues,
  addOrUpdateProcessedCue, // Export new function
  resetCues, // New
  generateUUID,
  deleteCue, // Added deleteCue
  updateCueKnownDuration, // Export new function
  updateCueItemDuration, // Export the new combined function
  triggerCueById, // Export the new function
  // Mixer function removed
  getDefaultCuesPath                 // Added for menu functionality
}; 