const { contextBridge, ipcRenderer } = require('electron');
// const path = require('path'); // Temporarily commented out for diagnosis

// Promise that resolves when the main process signals it's ready
const mainProcessReadyPromise = new Promise((resolve) => {
  ipcRenderer.once('main-process-ready', () => {
    console.log("PRELOAD: Received 'main-process-ready' signal.");
    resolve(true);
  });
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Wait for main process to be ready before proceeding with other calls
  whenMainReady: () => mainProcessReadyPromise,

  // Generic IPC utilities (if still needed directly, though specific ones are better)
  send: (channel, data) => ipcRenderer.send(channel, data),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, callback) => {
    const validChannels = [
      'main-process-ready', 
      'cues-updated-from-main',
      'app-config-updated-from-main',
      'cue-status-update',
      'playback-started',
      'playback-stopped',
      'playback-paused',
      'playback-resumed',
      'playback-error',
      'active-cue-changed',
      'playlist-item-changed',
      'audio-outputs-updated',
      'workspace-did-change',
      'theme-changed-from-main',
      'test-ipc-event',
      // Channels for Companion control
      'play-audio-by-id',
      'stop-audio-by-id',
      'toggle-audio-by-id',
      'stop-all-audio'
      // Add other channels as needed
    ];
    if (validChannels.includes(channel)) {
      // Valid channel: register IPC listener
      ipcRenderer.on(channel, (event, ...args) => {
        // Log for ALL valid channels coming through preload
        console.log(`PRELOAD: IPC event received on channel "${channel}". Args count: ${args.length ? args.length : '0'}. First arg preview:`, args.length > 0 ? (typeof args[0] === 'object' ? JSON.stringify(args[0]).substring(0,100) + '...' : args[0]) : 'N/A');
        
        if (channel === 'app-config-updated-from-main') {
            console.log('PRELOAD DEBUG: app-config-updated-from-main SPECIFICALLY received with args:', args);
        }
        if (channel === 'cues-updated-from-main') {
            console.log('PRELOAD DEBUG: cues-updated-from-main SPECIFICALLY received with args count:', args.length > 0 && args[0] ? args[0].length : 'N/A or empty');
        }
        callback(...args);
      });
    } else {
      console.warn(`Preload: Ignoring registration for invalid channel: ${channel}`);
    }
  },

  // Specific IPC calls previously in ipcRendererBindings.js (or equivalent)
  getCuesFromMain: () => ipcRenderer.invoke('get-cues'),
  saveCuesToMain: (cues) => ipcRenderer.invoke('save-cues', cues),
  addOrUpdateCue: (cueData) => ipcRenderer.invoke('add-or-update-cue', cueData),
  deleteCue: (cueId) => ipcRenderer.invoke('delete-cue', cueId),
  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  saveAppConfig: (config) => ipcRenderer.invoke('save-app-config', config),
  getAudioOutputDevices: () => ipcRenderer.invoke('get-audio-output-devices'),
  getAudioFileBuffer: (filePath) => ipcRenderer.invoke('get-audio-file-buffer', filePath),


  // Waveform Related
  getOrGenerateWaveformPeaks: (filePath) => ipcRenderer.invoke('get-or-generate-waveform-peaks', filePath),
  getAudioFileDuration: (filePath) => ipcRenderer.invoke('get-media-duration', filePath), // Assuming this is the correct channel

  // CueStore related notifications from main
  onCueListUpdated: (callback) => ipcRenderer.on('cues-updated-from-main', (_event, cues) => callback(cues)),
  onClearCueSelection: (callback) => ipcRenderer.on('clear-cue-selection', () => callback()),
  
  // OSC Learn IPC
  sendStartOscLearn: (cueId) => {
    console.log(`PRELOAD: sendStartOscLearn called with cueId: ${cueId}. Sending IPC 'start-osc-learn'.`);
    ipcRenderer.send('start-osc-learn', cueId);
  },
  onOscMessageLearned: (callback) => ipcRenderer.on('osc-message-learned', (_event, path) => callback(path)),
  onOscLearnFailed: (callback) => ipcRenderer.on('osc-learn-failed', (_event, errorMsg) => callback(errorMsg)),
  resetInactivityTimer: () => ipcRenderer.send('reset-inactivity-timer'),

  // Workspace related IPC calls
  newWorkspace: () => ipcRenderer.invoke('new-workspace'),
  openWorkspaceDialog: () => ipcRenderer.invoke('open-workspace-dialog'),
  loadWorkspace: (filePath) => ipcRenderer.invoke('load-workspace', filePath),
  saveWorkspace: () => ipcRenderer.invoke('save-workspace'),
  saveWorkspaceAsDialog: () => ipcRenderer.invoke('save-workspace-as-dialog'),
  getRecentWorkspaces: () => ipcRenderer.invoke('get-recent-workspaces'),
  clearRecentWorkspaces: () => ipcRenderer.invoke('clear-recent-workspaces'),
  onWorkspaceChanged: (callback) => ipcRenderer.on('workspace-did-change', (_event, newPath, newName) => callback(newPath, newName)),
  onWorkspaceError: (callback) => ipcRenderer.on('workspace-error', (_event, errorMsg) => callback(errorMsg)),
  onWorkspaceSaved: (callback) => ipcRenderer.on('workspace-saved', (_event, name, path) => callback(name, path)),
  onSettingsChanged: (callback) => ipcRenderer.on('settings-changed', (_event, settings) => callback(settings)),

  // Audio Playback Control via Main (for OSC/MIDI triggers)
  // No specific sender needed here if main directly sends 'toggle-audio-by-id'
  // However, we need the listener for it if it was previously in ipcRendererBindings
  onToggleAudioById: (callback) => ipcRenderer.on('toggle-audio-by-id', (_event, cueId) => callback(cueId)),

  // UI related
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  showErrorBox: (title, content) => ipcRenderer.send('show-error-box', title, content),
  showConfirmationDialog: (options) => ipcRenderer.invoke('show-confirmation-dialog', options),

  // UUID Generation
  generateUUID: () => ipcRenderer.invoke('generate-uuid'),
  // getMediaDuration: (filePath) => ipcRenderer.invoke('get-media-duration', filePath), // Duplicated from Waveform related - ensure one source

  // File System Access Proxies
  checkFileExists: (filePath) => ipcRenderer.invoke('fs-check-file-exists', filePath),
  copyFile: (sourcePath, destPath) => ipcRenderer.invoke('fs-copy-file', sourcePath, destPath),
  deleteFile: (filePath) => ipcRenderer.invoke('fs-delete-file', filePath),

  // Window Management
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  unmaximizeWindow: () => ipcRenderer.send('unmaximize-window'),
  isWindowMaximized: () => ipcRenderer.invoke('is-window-maximized'),
  setFullScreen: (flag) => ipcRenderer.send('set-full-screen', flag),
  isFullScreen: () => ipcRenderer.invoke('is-full-screen'),

  // Menu related
  updateMenuIPC: () => ipcRenderer.send('update-menu'),

  // App Info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Generic way to register multiple listeners, if preferred by a module
  registerListeners: (listeners) => {
    const unsubscribers = [];
    for (const channel in listeners) {
      if (typeof listeners[channel] === 'function') {
        const handler = (event, ...args) => listeners[channel](...args);
        ipcRenderer.on(channel, handler);
        unsubscribers.push(() => ipcRenderer.removeListener(channel, handler));
      }
    }
    return () => unsubscribers.forEach(unsub => unsub());
  },

  // For Easter Egg game
  openEasterEggGame: () => ipcRenderer.send('open-easter-egg-game')
});

// REMOVE THE FOLLOWING DOMContentLoaded LISTENER AND ITS CONTENTS
/*
document.addEventListener('DOMContentLoaded', () => {
  const dragArea = document.body; // Or a more specific element

  dragArea.addEventListener('dragover', (event) => {
    event.preventDefault(); // Necessary to allow drop
    event.stopPropagation();
    // Add visual cues if desired
  });

  dragArea.addEventListener('dragleave', (event) => {
    // Remove visual cues if desired
  });

  dragArea.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();

    const files = event.dataTransfer.files;
    if (files.length > 0) {
      const filePaths = Array.from(files).map(file => file.path);
      console.log('Files dropped in preload (will be sent to main - THIS LOGIC IS BEING REMOVED):', filePaths);
      // Send file paths to the main process to then be relayed to renderer
      // This is a more secure way than directly accessing fs in renderer
      // ipcRenderer.send('files-dropped-in-preload', filePaths); // THIS LINE IS REMOVED
    }
  });
});
*/

console.log('Preload script loaded (Drag/drop listeners removed from preload)'); 