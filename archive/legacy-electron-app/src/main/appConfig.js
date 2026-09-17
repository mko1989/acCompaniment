const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const os = require('os'); // Added for network interfaces

const CONFIG_FILE_NAME = 'appConfig.json';
// let userDataPath; // Will be set when app is ready // REMOVED
// let configFilePath; // REMOVED

let currentConfigFilePath = path.join(app.getPath('userData'), CONFIG_FILE_NAME); // Default path

let appConfig = {};
const MAX_RECENT_WORKSPACES = 5;

let configChangeListeners = []; // New: Array for change listeners

const DEFAULT_CONFIG = {
  cuesFilePath: '', // Path to the cues.json file
  autoLoadLastWorkspace: true,
  lastOpenedWorkspacePath: '',
  defaultCueType: 'single_file', // 'single_file' or 'playlist'
  defaultFadeInTime: 0, // in milliseconds
  defaultFadeOutTime: 0, // in milliseconds
  defaultLoopSingleCue: false,
  defaultRetriggerBehavior: 'restart', // 'restart', 'pause_resume', 'stop', 'do_nothing', 'fade_out_and_stop', 'fade_stop_restart'
  defaultStopAllBehavior: 'stop', // 'stop' or 'fade_out_and_stop'
  defaultStopAllFadeOutTime: 1500, // Default fade out time for stop all in milliseconds
  crossfadeTime: 2000, // Default crossfade duration in ms
  audioOutputDeviceId: 'default',
  theme: 'system', // 'light', 'dark', or 'system'
  // WebSocket Server Settings for Companion
  websocketEnabled: true, // Enable/disable WebSocket server for Companion
  websocketPort: 8877, // Port for WebSocket server
  // HTTP Remote Control Settings
  httpRemoteEnabled: true, // Enable/disable HTTP remote
  httpRemotePort: 3000, // Port for HTTP remote server
  recentWorkspaces: [], // Ensure recentWorkspaces is part of DEFAULT_CONFIG
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
  const oldPath = currentConfigFilePath;
  if (dirPath) {
    currentConfigFilePath = path.join(dirPath, CONFIG_FILE_NAME);
  } else {
    currentConfigFilePath = path.join(app.getPath('userData'), CONFIG_FILE_NAME);
  }
  console.log(`[AppConfig] setConfigDirectory: Path changed from "${oldPath}" to "${currentConfigFilePath}"`);
  // After changing path, existing appConfig might be stale.
  // Consider if a load should be forced or if it's up to the caller.
  // For now, changing path doesn't auto-load.
}

// Function to get a deep copy of the default configuration
function getDefaultConfig() {
    // DEFAULT_CONFIG already includes recentWorkspaces: []
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function loadConfig() {
  console.log(`[AppConfig] loadConfig: Attempting to load from "${currentConfigFilePath}"`);
  const defaultConfigForPath = getDefaultConfig();
  try {
    if (fs.existsSync(currentConfigFilePath)) {
      const rawData = fs.readFileSync(currentConfigFilePath, 'utf-8');
      const parsedConfig = JSON.parse(rawData);
      
      // MIGRATION: Remove obsolete fields from old config files
      const obsoleteFields = ['mixerIntegrationEnabled', 'mixerType', 'localIpAddress', 'wingIpAddress', 'oscEnabled', 'oscPort', 'video'];
      let needsSave = false;
      obsoleteFields.forEach(field => {
        if (field in parsedConfig) {
          console.log(`[AppConfig] Removing obsolete field: ${field}`);
          delete parsedConfig[field];
          needsSave = true;
        }
      });
      
      // Merge: start with fresh defaults, overlay with loaded file, ensure recentWorkspaces is valid
      appConfig = {
        ...defaultConfigForPath,
        ...parsedConfig,
        recentWorkspaces: Array.isArray(parsedConfig.recentWorkspaces) ? parsedConfig.recentWorkspaces : []
      };
      
      // Save config immediately if we removed obsolete fields
      if (needsSave) {
        console.log(`[AppConfig] Saving config after removing obsolete fields`);
        saveConfig();
      }
      // console.log(`[AppConfig] loadConfig: Successfully loaded and merged from "${currentConfigFilePath}". Loaded config:`, JSON.parse(JSON.stringify(appConfig)));
    } else {
      appConfig = defaultConfigForPath;
      console.log(`[AppConfig] loadConfig: File not found at "${currentConfigFilePath}", loaded defaults. Attempting to save initial default config.`);
      // Try to save the defaults to the new path
      try {
          fs.mkdirSync(path.dirname(currentConfigFilePath), { recursive: true });
          fs.writeFileSync(currentConfigFilePath, JSON.stringify(appConfig, null, 2), 'utf-8');
          // console.log(`[AppConfig] loadConfig: Saved default config to "${currentConfigFilePath}". Config:`, JSON.parse(JSON.stringify(appConfig)));
      } catch (saveError) {
          console.error(`[AppConfig] loadConfig: Error saving new default config to "${currentConfigFilePath}":`, saveError);
          // appConfig remains defaultConfigForPath
      }
    }
  } catch (error) {
    console.error(`[AppConfig] loadConfig: Error loading from "${currentConfigFilePath}": ${error.message}. Falling back to defaults.`);
    appConfig = defaultConfigForPath;
  }
  // console.log(`[AppConfig] loadConfig: Final appConfig (or copy of it) being returned for "${currentConfigFilePath}":`, JSON.parse(JSON.stringify(appConfig)));
  return { ...appConfig }; // Return a copy
}

function saveConfig() { // Renamed from saveConfigInternal
  // initializePaths(); // REMOVED
  if (!currentConfigFilePath) {
    console.error('[AppConfig] saveConfig: Config file path not set. Cannot save config.');
    return false;
  }
  // console.log(`[AppConfig] saveConfig: Attempting to save to "${currentConfigFilePath}". Current appConfig:`, JSON.parse(JSON.stringify(appConfig)));
  try {
    // Ensure recentWorkspaces is properly part of appConfig before saving
    const data = JSON.stringify(appConfig, null, 2);
    fs.mkdirSync(path.dirname(currentConfigFilePath), { recursive: true }); // Ensure directory exists
    fs.writeFileSync(currentConfigFilePath, data, 'utf-8');
    console.log(`[AppConfig] saveConfig: Successfully saved to "${currentConfigFilePath}".`);
    // Notify listeners
    configChangeListeners.forEach(listener => listener(appConfig));
    return true;
  } catch (error) {
    console.error(`[AppConfig] saveConfig: Error saving to "${currentConfigFilePath}":`, error);
    return false;
  }
}

function getConfig() {
  // initializePaths(); // REMOVED
  if (Object.keys(appConfig).length === 0 || !('recentWorkspaces' in appConfig)) {
    return loadConfig();
  }
  return { ...appConfig }; // Return a copy
}

function updateConfig(newSettings) {
  // initializePaths(); // REMOVED
  console.log(`[AppConfig] updateConfig: Called with newSettings for "${currentConfigFilePath}". newSettings:`, JSON.parse(JSON.stringify(newSettings)));
  console.log(`[AppConfig] updateConfig: appConfig BEFORE update for "${currentConfigFilePath}":`, JSON.parse(JSON.stringify(appConfig)));

  // Ensure that when updating, we don't accidentally lose the recentWorkspaces array structure
  // if newSettings doesn't include it or has an invalid type for it.
  const currentRecent = appConfig.recentWorkspaces || [];
  appConfig = { ...appConfig, ...newSettings };
  if ('recentWorkspaces' in newSettings && !Array.isArray(newSettings.recentWorkspaces)) {
      console.warn('[AppConfig] updateConfig: newSettings contained invalid recentWorkspaces, preserving old list.');
      appConfig.recentWorkspaces = currentRecent;
  } else if (!('recentWorkspaces' in newSettings)) {
      appConfig.recentWorkspaces = currentRecent; // Preserve if not in newSettings
  }
  // else, newSettings.recentWorkspaces is used if it's a valid array or undefined (which will be handled by spread)
  console.log(`[AppConfig] updateConfig: appConfig AFTER update (before save) for "${currentConfigFilePath}":`, JSON.parse(JSON.stringify(appConfig)));

  let errorMsg = null;
  const saveSucceeded = saveConfig(); // saveConfig now returns true/false

  if (!saveSucceeded) {
    console.error(`[AppConfig] updateConfig: Failed to save config after update for "${currentConfigFilePath}".`);
    // Attempt to get a generic error message, as saveConfig itself logs details
    errorMsg = `Failed to write config to ${currentConfigFilePath}`;
  }
  // Notify listeners if save was successful (saveConfig handles this internally now)
  console.log(`[AppConfig] updateConfig: Returning for "${currentConfigFilePath}". Saved: ${saveSucceeded}, Config:`, JSON.parse(JSON.stringify(appConfig)));
  return { config: { ...appConfig }, saved: saveSucceeded, error: errorMsg };
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

// New function to add a config change listener
function addConfigChangeListener(listener) {
    if (typeof listener === 'function' && !configChangeListeners.includes(listener)) {
        configChangeListeners.push(listener);
    }
}

// New function to remove a config change listener
function removeConfigChangeListener(listener) {
    configChangeListeners = configChangeListeners.filter(l => l !== listener);
}

// New function to get local IPv4 addresses
function getLocalIpAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push({ name: name, address: iface.address });
            }
        }
    }
    return addresses;
}

// Function to get the current config file path
function getConfigPath() {
    return currentConfigFilePath;
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
  addConfigChangeListener, // New
  removeConfigChangeListener, // New
  DEFAULT_CONFIG,
  getDefaultConfig, // Exporting the function to get a fresh copy
  MAX_RECENT_WORKSPACES, // Export for main.js to know limit if needed elsewhere, though not strictly necessary
  getLocalIpAddresses, // Export the new function
  getConfigPath // Export function to get config file path
}; 