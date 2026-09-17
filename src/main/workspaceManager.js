const { dialog, app } = require('electron');
const fs = require('fs-extra'); // Use fs-extra for ensureDirSync
const path = require('path');

// Assume these modules are passed in during initialization
let appConfigManager;
let cueManager;
let mainWindow; // For sending IPC messages and dialog parent

let currentWorkspaceDirectory = null; // Path to the currently open workspace directory
const DEFAULT_CUES_FILENAME = 'cues.json';
const WORKSPACE_CONFIG_SUBDIR = path.join('.ac', 'config'); // '.ac/config'

// To be called from main.js
function initialize(appConfManager, cManager, mainWin) {
    console.log('[WorkspaceManager] Initializing...');
    appConfigManager = appConfManager;
    cueManager = cManager;
    mainWindow = mainWin;

    // On startup, appConfigManager is already loaded with global config by main.js
    const globalConfig = appConfigManager.getConfig(); // getConfig already returns a copy
    // console.log('[WorkspaceManager Initialize] Initial global config from appConfigManager before any action:', JSON.parse(JSON.stringify(globalConfig)));

    if (globalConfig.autoLoadLastWorkspace && globalConfig.lastOpenedWorkspacePath) {
        if (fs.existsSync(globalConfig.lastOpenedWorkspacePath)) {
            console.log(`[WorkspaceManager Initialize] Attempting to auto-load last opened workspace: ${globalConfig.lastOpenedWorkspacePath}`);
            // Pass true for isInitializing to prevent re-saving lastOpenedWorkspacePath to global config if it's already correct.
            // However, the openWorkspace logic ensures it's saved globally before switching.
            openWorkspace(globalConfig.lastOpenedWorkspacePath, true)
                .then(success => {
                    if (success) {
                        console.log(`[WorkspaceManager Initialize] Successfully auto-opened workspace: ${globalConfig.lastOpenedWorkspacePath}`);
                        // console.log('[WorkspaceManager Initialize] Config AFTER successful auto-open:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
                    } else {
                        console.warn(`[WorkspaceManager Initialize] Failed to auto-open workspace: ${globalConfig.lastOpenedWorkspacePath}. Clearing lastOpenedWorkspacePath from global config.`);
                        // If auto-open fails (e.g., directory removed), clear it from global config to avoid repeated attempts.
                        // console.log('[WorkspaceManager Initialize] Config BEFORE setting dir to null for clearing last path:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
                        appConfigManager.setConfigDirectory(null); // Ensure global context
                        // console.log('[WorkspaceManager Initialize] Config AFTER setting dir to null for clearing last path:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
                        const updateResult = appConfigManager.updateConfig({ lastOpenedWorkspacePath: '' });
                        console.log('[WorkspaceManager Initialize] Cleared lastOpenedWorkspacePath. Saved:', updateResult.saved);
                        // Optionally, load default cues or reset workspace state further
                        cueManager.setCuesDirectory(app.getPath('userData'));
                        cueManager.resetCues();
                        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                            mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
                            mainWindow.webContents.send('app-config-updated-from-main', appConfigManager.getConfig());
                        }
                    }
                })
                .catch(error => {
                    console.error(`[WorkspaceManager Initialize] Error auto-opening workspace: ${globalConfig.lastOpenedWorkspacePath}`, error);
                });
        } else {
            console.log(`[WorkspaceManager Initialize] lastOpenedWorkspacePath: ${globalConfig.lastOpenedWorkspacePath} not found. Clearing from global config.`);
            // console.log('[WorkspaceManager Initialize] Config BEFORE setting dir to null for clearing non-existent last path:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
            appConfigManager.setConfigDirectory(null); // Ensure global context
            // console.log('[WorkspaceManager Initialize] Config AFTER setting dir to null for clearing non-existent last path:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
            const updateResultClear = appConfigManager.updateConfig({ lastOpenedWorkspacePath: '' });
            // console.log('[WorkspaceManager Initialize] Config AFTER clearing non-existent lastOpenedWorkspacePath:', JSON.parse(JSON.stringify(updateResultClear.config)), 'Saved:', updateResultClear.saved);
        }
    } else {
        console.log('[WorkspaceManager Initialize] No last workspace to auto-load, or auto-load disabled.');
        // console.log('[WorkspaceManager Initialize] Current global config state:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        // Ensure cues are loaded from a default path if no workspace is loaded
        // This might be redundant if main.js already sets a default cues path.
        const currentCuesPath = globalConfig.cuesFilePath || path.join(app.getPath('userData'), DEFAULT_CUES_FILENAME);
        cueManager.setCuesDirectory(path.dirname(currentCuesPath));
        cueManager.loadCuesFromFile(); // Load or initialize default cues
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
        }
    }
}

// New function to be called when data changes that should mark the workspace as edited
function markWorkspaceAsEdited() {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isDocumentEdited()) {
        console.log('[WorkspaceManager] Marking workspace as edited.');
        mainWindow.setDocumentEdited(true);
    }
}

async function newWorkspace() {
    console.log('[WorkspaceManager] newWorkspace called');
    try {
        // 1. Switch appConfigManager to global context
        // console.log('[WorkspaceManager newWorkspace] Config BEFORE setting dir to null:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        appConfigManager.setConfigDirectory(null);
        // console.log('[WorkspaceManager newWorkspace] Switched to global config. Current global config:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));

        // 2. Update global config: clear last workspace, set cues path to default (e.g., userData)
        const defaultCuesDir = app.getPath('userData');
        const defaultCuesFullPath = path.join(defaultCuesDir, DEFAULT_CUES_FILENAME);
        
        const globalUpdateResult = appConfigManager.updateConfig({
            lastOpenedWorkspacePath: '',
            cuesFilePath: defaultCuesFullPath
            // Potentially reset other settings to global defaults if they were workspace-specific
        });
        console.log('[WorkspaceManager newWorkspace] Global config updated. Saved:', globalUpdateResult.saved);

        // 3. Reset cueManager
        cueManager.setCuesDirectory(defaultCuesDir);
        cueManager.resetCues(); // Clears cues in memory and potentially updates UI via its own logic

        currentWorkspaceDirectory = null;
        if (mainWindow) {
            mainWindow.setTitle('acCompaniment - Untitled Workspace');
            if (typeof mainWindow.setRepresentedFilename === 'function') {
                mainWindow.setRepresentedFilename('');
            }
            mainWindow.setDocumentEdited(false);
        }
        
        console.log('[WorkspaceManager newWorkspace] Workspace state reset.');
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
            mainWindow.webContents.send('app-config-updated-from-main', globalUpdateResult.config);
        }
        return true;
    } catch (error) {
        console.error('[WorkspaceManager newWorkspace] Error:', error);
        dialog.showErrorBox('New Workspace Error', `Could not create new workspace: ${error.message}`);
        return false;
    }
}

async function openWorkspace(workspaceToOpenPath = null, isInitializing = false) {
    console.log(`[WorkspaceManager openWorkspace] Called. Path: ${workspaceToOpenPath}, isInitializing: ${isInitializing}`);
    // console.log(`[WorkspaceManager openWorkspace] Config at VERY START (should be global if user-invoked, or workspace if from init auto-load that succeeded, or global if init auto-load failed/skipped):`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));

    if (!mainWindow) return false;

    let newWorkspacePath = workspaceToOpenPath;

    if (!newWorkspacePath) {
        const globalConfigForDialog = appConfigManager.getConfig(); // Should be global if called by user
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Open Workspace Folder',
            properties: ['openDirectory'],
            defaultPath: currentWorkspaceDirectory || globalConfigForDialog?.recentWorkspaces?.[0] || app.getPath('documents')
        });
        if (canceled || !filePaths || filePaths.length === 0) {
            console.log('[WorkspaceManager openWorkspace] Dialog canceled.');
            return false;
        }
        newWorkspacePath = filePaths[0];
    }
    console.log(`[WorkspaceManager openWorkspace] Attempting to open directory: ${newWorkspacePath}`);

    const workspaceConfigDir = path.join(newWorkspacePath, WORKSPACE_CONFIG_SUBDIR);
    const workspaceCuesFilePath = path.join(newWorkspacePath, DEFAULT_CUES_FILENAME);

    try {
        fs.ensureDirSync(workspaceConfigDir); // Ensure .ac/config directory exists
        console.log(`[WorkspaceManager openWorkspace] Ensured workspace config dir exists: ${workspaceConfigDir}`);

        // 1. Save lastOpenedWorkspacePath to GLOBAL config
        // Regardless of isInitializing, good to ensure global config is up-to-date.
        // console.log(`[WorkspaceManager openWorkspace] Config BEFORE setting dir to null for global save:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        appConfigManager.setConfigDirectory(null); // Switch to global context
        // console.log(`[WorkspaceManager openWorkspace] Switched to global config for saving lastOpened. Current global config IN MEMORY (before update):`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        const globalUpdateResult = appConfigManager.updateConfig({ lastOpenedWorkspacePath: newWorkspacePath });
        if (globalUpdateResult.saved) {
            console.log(`[WorkspaceManager openWorkspace] Saved lastOpenedWorkspacePath='${newWorkspacePath}' to global config.`);
        } else {
            console.error(`[WorkspaceManager openWorkspace] FAILED to save lastOpenedWorkspacePath to global config. Error: ${globalUpdateResult.error}`);
            // Proceeding, but this is a problem for next startup.
        }
        // console.log(`[WorkspaceManager openWorkspace] Config IN MEMORY before addRecentWorkspace:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        appConfigManager.addRecentWorkspace(newWorkspacePath); // Adds to recent list and saves global config again
        // console.log(`[WorkspaceManager openWorkspace] Config IN MEMORY after addRecentWorkspace (should reflect saved global):`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));

        // 2. Switch appConfigManager to WORKSPACE config
        // console.log(`[WorkspaceManager openWorkspace] Config BEFORE setting dir to workspace:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        appConfigManager.setConfigDirectory(workspaceConfigDir);
        // console.log(`[WorkspaceManager openWorkspace] Set config directory to workspace: ${workspaceConfigDir}. Config IN MEMORY (should be global still, path changed):`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));

        // 3. Load workspace-specific config. appConfig.loadConfig() will create with defaults if not found.
        let workspaceConfig = appConfigManager.loadConfig(); // This loads from workspaceConfigDir/appConfig.json
        // console.log('[WorkspaceManager openWorkspace] Workspace config loaded (copy returned by loadConfig):', JSON.parse(JSON.stringify(workspaceConfig)));
        // console.log('[WorkspaceManager openWorkspace] appConfigManager internal state AFTER loading workspace config:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));

        // 4. Update workspace config with essential workspace-specific paths
        // Also, ensure lastOpenedWorkspacePath is stored in workspace config for consistency, though global is primary for startup.
        const workspaceUpdateData = {
            cuesFilePath: workspaceCuesFilePath, // Specific to this workspace
            lastOpenedWorkspacePath: newWorkspacePath // Good to have in workspace config too
            // Other settings might be merged here if a workspace config had its own specific values
        };
        const workspaceUpdateResult = appConfigManager.updateConfig(workspaceUpdateData);
        workspaceConfig = workspaceUpdateResult.config; // Get the latest merged config
        console.log('[WorkspaceManager openWorkspace] Workspace config updated with paths. Saved:', workspaceUpdateResult.saved);
        // console.log('[WorkspaceManager openWorkspace] appConfigManager internal state AFTER updating/saving workspace config:', JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        
        // 5. Set cue manager to use the new workspace path and load cues
        cueManager.setCuesDirectory(newWorkspacePath); // Sets base directory for cues.json
        const loadedCues = cueManager.loadCuesFromFile(); // Loads cues.json from that directory

        currentWorkspaceDirectory = newWorkspacePath;
        if (mainWindow) {
            mainWindow.setTitle(`acCompaniment - ${path.basename(newWorkspacePath)}`);
            if (typeof mainWindow.setRepresentedFilename === 'function') {
                mainWindow.setRepresentedFilename(newWorkspacePath); // Or cues file path
            }
            if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('cues-updated-from-main', loadedCues);
                // Send the fully loaded/updated WORKSPACE config to the renderer
                mainWindow.webContents.send('app-config-updated-from-main', workspaceConfig);
            }
            mainWindow.setDocumentEdited(false);
        }
        
        console.log(`[WorkspaceManager openWorkspace] Successfully opened workspace from ${newWorkspacePath}.`); // Simplified final log
        return true;
    } catch (error) {
        console.error(`[WorkspaceManager openWorkspace] Error opening workspace from ${newWorkspacePath}:`, error);
        dialog.showErrorBox('Error Opening Workspace', `Could not load workspace from ${newWorkspacePath}.\n${error.message}`);
        // Attempt to revert to a stable state (e.g., global config)
        // console.log(`[WorkspaceManager openWorkspace] Config IN MEMORY during error handling BEFORE setting dir to null:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        appConfigManager.setConfigDirectory(null);
        // console.log(`[WorkspaceManager openWorkspace] Config IN MEMORY during error handling AFTER setting dir to null:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
        const reloadedGlobalConf = appConfigManager.loadConfig(); // Reload global config
        console.log(`[WorkspaceManager openWorkspace] Reloaded global config during error handling.`);
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('app-config-updated-from-main', appConfigManager.getConfig());
        }
        return false;
    }
}

async function saveWorkspace() {
    console.log('[WorkspaceManager saveWorkspace] Called.');
    // console.log(`[WorkspaceManager saveWorkspace] Config at start (should be current workspace config):`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
    if (currentWorkspaceDirectory) {
        try {
            // 1. Ensure appConfigManager is pointing to the current workspace config
            const workspaceConfigDir = path.join(currentWorkspaceDirectory, WORKSPACE_CONFIG_SUBDIR);
            // console.log(`[WorkspaceManager saveWorkspace] Config BEFORE setConfigDirectory (should already be workspace):`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
            appConfigManager.setConfigDirectory(workspaceConfigDir); // Should be a no-op if already set
            // console.log(`[WorkspaceManager saveWorkspace] Ensured config directory is workspace. Current config:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));

            // 2. Save cues (to currentWorkspaceDirectory/cues.json)
            const cuesSaved = cueManager.saveCuesToFile(); // Assumes cueManager uses its set cuesDirectory

            // 3. Save current appConfig (workspace-specific settings)
            // updateConfig with empty object effectively just saves current state.
            // console.log(`[WorkspaceManager saveWorkspace] Config BEFORE final updateConfig (save) call:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));
            const workspaceSaveResult = appConfigManager.updateConfig({}); // Save current state to workspace config
            if (workspaceSaveResult.saved) {
                console.log('[WorkspaceManager saveWorkspace] Cues and workspace config saved to:', currentWorkspaceDirectory);
                if (mainWindow) mainWindow.setDocumentEdited(false);
                return true;
            } else {
                if (!cuesSaved) console.error('[WorkspaceManager saveWorkspace] Failed to save cues.json.');
                if (!workspaceSaveResult.saved) console.error(`[WorkspaceManager saveWorkspace] Failed to save workspace appConfig.json. Error: ${workspaceSaveResult.error}`);
                dialog.showErrorBox('Save Error', 'Could not save all workspace files. Check logs for details.');
                return false;
            }
        } catch (error) {
            console.error('[WorkspaceManager saveWorkspace] Error:', error);
            dialog.showErrorBox('Save Error', `An error occurred: ${error.message}`);
            return false;
        }
    } else {
        console.log('[WorkspaceManager saveWorkspace] No current workspace directory, calling saveWorkspaceAs.');
        return await saveWorkspaceAs();
    }
}

async function saveWorkspaceAs() {
    console.log('[WorkspaceManager saveWorkspaceAs] Called.');
    // console.log(`[WorkspaceManager saveWorkspaceAs] Config at start:`, JSON.parse(JSON.stringify(appConfigManager.getConfig())));

    if (!mainWindow) return false;

    const { canceled, filePath: chosenDirectory } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Workspace As',
        buttonLabel: 'Save Workspace',
        defaultPath: currentWorkspaceDirectory || path.join(app.getPath('documents'), 'MySoundboardWorkspace'),
        properties: ['createDirectory', 'showOverwriteConfirmation'] // createDirectory is implicit in choosing a folder
    });

    if (canceled || !chosenDirectory) {
        console.log('[WorkspaceManager saveWorkspaceAs] Dialog canceled.');
        return false;
    }
    
    console.log(`[WorkspaceManager saveWorkspaceAs] Target directory: ${chosenDirectory}`);

    const newWorkspacePath = chosenDirectory;
    const newWorkspaceConfigDir = path.join(newWorkspacePath, WORKSPACE_CONFIG_SUBDIR);
    const newWorkspaceCuesFilePath = path.join(newWorkspacePath, DEFAULT_CUES_FILENAME);

    try {
        fs.ensureDirSync(newWorkspacePath); // Ensure base directory exists
        fs.ensureDirSync(newWorkspaceConfigDir); // Ensure .ac/config directory exists
        console.log(`[WorkspaceManager saveWorkspaceAs] Ensured directories exist: ${newWorkspacePath}, ${newWorkspaceConfigDir}`);
        
        // 1. Update cueManager and save cues to new location
        cueManager.setCuesDirectory(newWorkspacePath);
        const cuesSaved = cueManager.saveCuesToFile();

        // 2. Update global config with new lastOpenedWorkspacePath
        appConfigManager.setConfigDirectory(null); // Switch to global
        // console.log(`[WorkspaceManager saveWorkspaceAs] Switched to global config for saving lastOpened. Path: ${appConfigManager.getConfigFilePath ? appConfigManager.getConfigFilePath() : 'N/A'}`);
        const globalUpdateResult = appConfigManager.updateConfig({ lastOpenedWorkspacePath: newWorkspacePath });
        if (!globalUpdateResult.saved) {
            console.error(`[WorkspaceManager saveWorkspaceAs] FAILED to save lastOpenedWorkspacePath to global config. Error: ${globalUpdateResult.error}`);
        }
        appConfigManager.addRecentWorkspace(newWorkspacePath); // Adds and saves global config

        // 3. Switch to new workspace config path
        appConfigManager.setConfigDirectory(newWorkspaceConfigDir);
        // console.log(`[WorkspaceManager saveWorkspaceAs] Set config directory to new workspace: ${appConfigManager.getConfigFilePath ? appConfigManager.getConfigFilePath() : 'N/A'}`);

        // 4. Create/Update workspace config file in the new location
        // It should inherit current in-memory settings (which might be from old workspace or global)
        let currentInMemoryConfig = appConfigManager.getConfig(); // Get whatever is currently loaded
        const workspaceUpdateData = {
            ...currentInMemoryConfig, // Carry over settings
            cuesFilePath: newWorkspaceCuesFilePath,
            lastOpenedWorkspacePath: newWorkspacePath // Store this in workspace config too
        };
        const workspaceSaveResult = appConfigManager.updateConfig(workspaceUpdateData); // This saves to new workspace path
        
        if (cuesSaved && workspaceSaveResult.saved) {
            currentWorkspaceDirectory = newWorkspacePath;
            if (mainWindow) {
                mainWindow.setTitle(`acCompaniment - ${path.basename(newWorkspacePath)}`);
                if (typeof mainWindow.setRepresentedFilename === 'function') {
                    mainWindow.setRepresentedFilename(newWorkspacePath);
                }
                mainWindow.setDocumentEdited(false);
                if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
                    mainWindow.webContents.send('app-config-updated-from-main', workspaceSaveResult.config); // Send new workspace config
                }
            }
            console.log('[WorkspaceManager saveWorkspaceAs] Workspace saved to new location:', newWorkspacePath);
            return true;
        } else {
            if (!cuesSaved) console.error('[WorkspaceManager saveWorkspaceAs] Failed to save cues.json to new location.');
            if (!workspaceSaveResult.saved) console.error(`[WorkspaceManager saveWorkspaceAs] Failed to save workspace appConfig.json. Error: ${workspaceSaveResult.error}`);
            dialog.showErrorBox('Save As Error', 'Could not save all files to new workspace location. Check logs.');
            return false;
        }
    } catch (error) {
        console.error('[WorkspaceManager saveWorkspaceAs] Error:', error);
        dialog.showErrorBox('Save As Error', `An error occurred: ${error.message}`);
        return false;
    }
}

function getCurrentWorkspacePath() {
    return currentWorkspaceDirectory;
}

// Export functions for use by main.js
module.exports = {
    initialize,
    newWorkspace,
    openWorkspace,
    saveWorkspace,
    saveWorkspaceAs,
    getCurrentWorkspacePath,
    markWorkspaceAsEdited
}; 