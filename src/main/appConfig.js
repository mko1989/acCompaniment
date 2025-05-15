const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILE_NAME = 'appConfig.json';
// let userDataPath; // Will be set when app is ready // REMOVED
// let configFilePath; // REMOVED

let currentConfigFilePath = path.join(app.getPath('userData'), CONFIG_FILE_NAME); // Default path

let appConfig = {};
const MAX_RECENT_WORKSPACES = 5;

const DEFAULT_CONFIG = {
  defaultFadeInTime: 0,    // seconds
  defaultFadeOutTime: 0,   // seconds
  defaultLoop: false,
  defaultRetriggerBehavior: 'restart', // 'restart', 'fade_stop_restart', 'do_nothing', 'stop', 'pause_resume'
  defaultStopAllBehavior: 'stop',    // 'stop' or 'fade_out_and_stop'
  defaultVolume: 1, // Add default volume (0.0 to 1.0)
  audioOutputDevice: 'default', // Default to system default audio output device ID
  // audioOutputDevice: null, // Placeholder for future audio output device selection
  recentWorkspaces: [], // New: Array to store paths of recent workspaces
};

/* // REMOVED
function initializePaths() {
  if (!userDataPath) {
    userDataPath = app.getPath('userData');
    configFilePath = path.join(userDataPath, CONFIG_FILE_NAME);
  }
}
*/

// Function to explicitly set the directory for the config file.
// If dirPath is null, resets to default userData path.
function setConfigDirectory(dirPath) {
  if (dirPath) {
    currentConfigFilePath = path.join(dirPath, CONFIG_FILE_NAME);
  } else {
    currentConfigFilePath = path.join(app.getPath('userData'), CONFIG_FILE_NAME);
  }
  console.log('App config path set to:', currentConfigFilePath);
  // After changing path, existing appConfig might be stale.
  // Consider if a load should be forced or if it's up to the caller.
  // For now, changing path doesn't auto-load.
}

function loadConfig() {
  // initializePaths(); // REMOVED
  try {
    if (fs.existsSync(currentConfigFilePath)) {
      const rawData = fs.readFileSync(currentConfigFilePath, 'utf-8');
      const parsedConfig = JSON.parse(rawData);
      // Ensure recentWorkspaces is an array and other defaults are applied
      const loadedRecentWorkspaces = Array.isArray(parsedConfig.recentWorkspaces) ? parsedConfig.recentWorkspaces : [];
      appConfig = { ...DEFAULT_CONFIG, ...parsedConfig, recentWorkspaces: loadedRecentWorkspaces };
    } else {
      appConfig = { ...DEFAULT_CONFIG };
      // saveConfigInternal(); // Don't auto-save here, let it be explicit
      console.log(`Config file not found at ${currentConfigFilePath}, loaded defaults. Save explicitly if needed.`);
    }
  } catch (error) {
    console.error(`Error loading app configuration from ${currentConfigFilePath}:`, error);
    appConfig = { ...DEFAULT_CONFIG }; // Fallback to defaults on error
  }
  return { ...appConfig }; // Return a copy
}

function saveConfig() { // Renamed from saveConfigInternal
  // initializePaths(); // REMOVED
  if (!currentConfigFilePath) {
    console.error('Config file path not set. Cannot save config.');
    return false;
  }
  try {
    // Ensure recentWorkspaces is properly part of appConfig before saving
    const data = JSON.stringify(appConfig, null, 2);
    fs.writeFileSync(currentConfigFilePath, data, 'utf-8');
    console.log('App configuration saved to:', currentConfigFilePath);
    return true;
  } catch (error) {
    console.error('Error saving app configuration to:', currentConfigFilePath, error);
    return false;
  }
}

function getConfig() {
  // initializePaths(); // REMOVED
  if (Object.keys(appConfig).length === 0 || !appConfig.hasOwnProperty('recentWorkspaces')) {
    return loadConfig();
  }
  return { ...appConfig }; // Return a copy
}

function updateConfig(newSettings) {
  // initializePaths(); // REMOVED
  // Ensure that when updating, we don't accidentally lose the recentWorkspaces array structure
  // if newSettings doesn't include it or has an invalid type for it.
  const currentRecent = appConfig.recentWorkspaces || [];
  appConfig = { ...appConfig, ...newSettings };
  if (newSettings.hasOwnProperty('recentWorkspaces') && !Array.isArray(newSettings.recentWorkspaces)) {
      console.warn('updateConfig called with invalid recentWorkspaces, preserving old list.');
      appConfig.recentWorkspaces = currentRecent; 
  } else if (!newSettings.hasOwnProperty('recentWorkspaces')) {
      appConfig.recentWorkspaces = currentRecent; // Preserve if not in newSettings
  }
  // else, newSettings.recentWorkspaces is used if it's a valid array or undefined (which will be handled by spread)

  const success = saveConfig();
  if (!success) {
    console.error("Failed to save config after updateConfig.");
    // Optionally, throw an error or handle it more gracefully
  }
  return { ...appConfig }; // Return a copy of the updated config
}

// Resets the in-memory config to defaults. Does NOT automatically save.
function resetToDefaults() {
    appConfig = { ...DEFAULT_CONFIG, recentWorkspaces: [] }; // Ensure recentWorkspaces is reset too
    console.log('App configuration reset to defaults in memory.');
    return { ...appConfig }; // Return a copy of the defaults
}

// New function to add a workspace path to the recent list
function addRecentWorkspace(workspacePath) {
    if (!workspacePath || typeof workspacePath !== 'string') return;

    // Ensure appConfig is loaded and has recentWorkspaces array
    if (!appConfig.recentWorkspaces || !Array.isArray(appConfig.recentWorkspaces)) {
        appConfig.recentWorkspaces = [];
    }

    const existingIndex = appConfig.recentWorkspaces.indexOf(workspacePath);
    if (existingIndex > -1) {
        appConfig.recentWorkspaces.splice(existingIndex, 1); // Remove if exists
    }

    appConfig.recentWorkspaces.unshift(workspacePath); // Add to the beginning

    // Keep the list at a maximum size
    if (appConfig.recentWorkspaces.length > MAX_RECENT_WORKSPACES) {
        appConfig.recentWorkspaces.length = MAX_RECENT_WORKSPACES; // Truncate
    }
    
    console.log('Updated recent workspaces:', appConfig.recentWorkspaces);
    saveConfig(); // Persist the change
}

// Ensure config is loaded when the module is required,
// but paths are initialized lazily or explicitly.
// loadConfig(); // Initial load can be done here or explicitly after app 'ready'.
// Better to call loadConfig explicitly after 'app' is ready, e.g., in main.js, using the default path.

module.exports = {
  setConfigDirectory, // New
  loadConfig,
  getConfig,
  updateConfig,
  saveConfig,         // Renamed
  resetToDefaults,    // New
  addRecentWorkspace, // New
  DEFAULT_CONFIG,
  MAX_RECENT_WORKSPACES // Export for main.js to know limit if needed elsewhere, though not strictly necessary
}; 