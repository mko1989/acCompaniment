const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const os = require('os'); // Added for network interfaces
const logger = require('./utils/logger');

const CONFIG_FILE_NAME = 'appConfig.json';

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

// Function to explicitly set the directory for the config file.
// If dirPath is null, resets to default userData path.
function setConfigDirectory(dirPath) {
  const oldPath = currentConfigFilePath;
  if (dirPath) {
    currentConfigFilePath = path.join(dirPath, CONFIG_FILE_NAME);
  } else {
    currentConfigFilePath = path.join(app.getPath('userData'), CONFIG_FILE_NAME);
  }
  logger.info(`[AppConfig] setConfigDirectory: Path changed from "${oldPath}" to "${currentConfigFilePath}"`);
}

// Function to get a deep copy of the default configuration
function getDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function loadConfig() {
  logger.info(`[AppConfig] loadConfig: Attempting to load from "${currentConfigFilePath}"`);
  const defaultConfigForPath = getDefaultConfig();
  try {
    // Check existence
    try {
        await fsPromises.access(currentConfigFilePath);
    } catch (e) {
        // File doesn't exist
        appConfig = defaultConfigForPath;
        logger.info(`[AppConfig] loadConfig: File not found at "${currentConfigFilePath}", loaded defaults. Attempting to save initial default config.`);
        try {
            await fsPromises.mkdir(path.dirname(currentConfigFilePath), { recursive: true });
            await fsPromises.writeFile(currentConfigFilePath, JSON.stringify(appConfig, null, 2), 'utf-8');
        } catch (saveError) {
            logger.error(`[AppConfig] loadConfig: Error saving new default config to "${currentConfigFilePath}":`, saveError);
        }
        return { ...appConfig };
    }

    const rawData = await fsPromises.readFile(currentConfigFilePath, 'utf-8');
    const parsedConfig = JSON.parse(rawData);

    // MIGRATION: Remove obsolete fields from old config files
    const obsoleteFields = ['video'];
    let needsSave = false;
    obsoleteFields.forEach(field => {
      if (field in parsedConfig) {
        logger.info(`[AppConfig] Removing obsolete field: ${field}`);
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
      logger.info(`[AppConfig] Saving config after removing obsolete fields`);
      await saveConfig();
    }
  } catch (error) {
    logger.error(`[AppConfig] loadConfig: Error loading from "${currentConfigFilePath}": ${error.message}. Falling back to defaults.`);
    appConfig = defaultConfigForPath;
  }
  return { ...appConfig }; // Return a copy
}

let isSaving = false;

async function saveConfig() {
  if (!currentConfigFilePath) {
    logger.error('[AppConfig] saveConfig: Config file path not set. Cannot save config.');
    return false;
  }

  if (isSaving) {
    logger.warn('[AppConfig] saveConfig: Save already in progress, skipping concurrent save.');
    return false;
  }
  isSaving = true;

  try {
    const data = JSON.stringify(appConfig, null, 2);
    await fsPromises.mkdir(path.dirname(currentConfigFilePath), { recursive: true }); // Ensure directory exists
    await fsPromises.writeFile(currentConfigFilePath, data, 'utf-8');
    logger.info(`[AppConfig] saveConfig: Successfully saved to "${currentConfigFilePath}".`);
    // Notify listeners
    configChangeListeners.forEach(listener => listener(appConfig));
    return true;
  } catch (error) {
    logger.error(`[AppConfig] saveConfig: Error saving to "${currentConfigFilePath}":`, error);
    return false;
  } finally {
    isSaving = false;
  }
}

// Synchronous save for app quit scenarios
function saveConfigSync() {
    if (!currentConfigFilePath) return false;
    try {
        const data = JSON.stringify(appConfig, null, 2);
        fs.mkdirSync(path.dirname(currentConfigFilePath), { recursive: true });
        fs.writeFileSync(currentConfigFilePath, data, 'utf-8');
        logger.info(`[AppConfig] saveConfigSync: Successfully saved.`);
        return true;
    } catch (error) {
        logger.error(`[AppConfig] saveConfigSync: Error:`, error);
        return false;
    }
}

function getConfig() {
  // If config hasn't been loaded yet (empty or missing key properties), return defaults
  // This assumes loadConfig() will be called properly during initialization.
  // If getConfig() is called before loadConfig(), it returns defaults but doesn't trigger load (to avoid sync I/O).
  if (Object.keys(appConfig).length === 0 || !('recentWorkspaces' in appConfig)) {
    logger.warn('[AppConfig] getConfig called before loadConfig completed or config is empty. Returning defaults.');
    return getDefaultConfig();
  }
  return { ...appConfig }; // Return a copy
}

async function updateConfig(newSettings) {
  logger.info(`[AppConfig] updateConfig: Called with newSettings for "${currentConfigFilePath}"`);

  const currentRecent = appConfig.recentWorkspaces || [];
  appConfig = { ...appConfig, ...newSettings };
  if ('recentWorkspaces' in newSettings && !Array.isArray(newSettings.recentWorkspaces)) {
    logger.warn('[AppConfig] updateConfig: newSettings contained invalid recentWorkspaces, preserving old list.');
    appConfig.recentWorkspaces = currentRecent;
  } else if (!('recentWorkspaces' in newSettings)) {
    appConfig.recentWorkspaces = currentRecent; // Preserve if not in newSettings
  }

  let errorMsg = null;
  const saveSucceeded = await saveConfig();

  if (!saveSucceeded) {
    logger.error(`[AppConfig] updateConfig: Failed to save config after update for "${currentConfigFilePath}".`);
    errorMsg = `Failed to write config to ${currentConfigFilePath}`;
  }
  
  return { config: { ...appConfig }, saved: saveSucceeded, error: errorMsg };
}

// Resets the in-memory config to defaults. Does NOT automatically save.
function resetToDefaults() {
  appConfig = { ...DEFAULT_CONFIG, recentWorkspaces: [] }; // Ensure recentWorkspaces is reset too
  logger.info('App configuration reset to defaults in memory.');
  return { ...appConfig }; // Return a copy of the defaults
}

async function addRecentWorkspace(workspacePath) {
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

  logger.info('Updated recent workspaces:', appConfig.recentWorkspaces);
  await saveConfig(); // Persist the change
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

module.exports = {
  setConfigDirectory,
  loadConfig,
  getConfig,
  updateConfig,
  saveConfig,
  saveConfigSync, // Export sync save for quit
  resetToDefaults,
  addRecentWorkspace,
  addConfigChangeListener,
  removeConfigChangeListener,
  DEFAULT_CONFIG,
  getDefaultConfig,
  MAX_RECENT_WORKSPACES,
  getLocalIpAddresses,
  getConfigPath
};
