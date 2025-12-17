const { dialog, app } = require('electron');
const fs = require('fs-extra'); // Use fs-extra for ensureDirSync
const path = require('path');
const logger = require('./utils/logger');

// Assume these modules are passed in during initialization
let appConfigManager;
let cueManager;
let mainWindow; // For sending IPC messages and dialog parent

let currentWorkspaceDirectory = null; // Path to the currently open workspace directory
const DEFAULT_CUES_FILENAME = 'cues.json';
const WORKSPACE_CONFIG_SUBDIR = path.join('.ac', 'config'); // '.ac/config'

// To be called from main.js
async function initialize(appConfManager, cManager, mainWin) {
    logger.info('[WorkspaceManager] Initializing...');
    appConfigManager = appConfManager;
    cueManager = cManager;
    mainWindow = mainWin;

    // On startup, appConfigManager is already loaded with global config by main.js
    const globalConfig = appConfigManager.getConfig(); // getConfig already returns a copy

    if (globalConfig.autoLoadLastWorkspace && globalConfig.lastOpenedWorkspacePath) {
        if (fs.existsSync(globalConfig.lastOpenedWorkspacePath)) {
            logger.info(`[WorkspaceManager Initialize] Attempting to auto-load last opened workspace: ${globalConfig.lastOpenedWorkspacePath}`);
            try {
                const success = await openWorkspace(globalConfig.lastOpenedWorkspacePath, true);
                if (success) {
                    logger.info(`[WorkspaceManager Initialize] Successfully auto-opened workspace: ${globalConfig.lastOpenedWorkspacePath}`);
                } else {
                    logger.warn(`[WorkspaceManager Initialize] Failed to auto-open workspace: ${globalConfig.lastOpenedWorkspacePath}. Clearing lastOpenedWorkspacePath from global config.`);
                    appConfigManager.setConfigDirectory(null); // Ensure global context
                    const updateResult = await appConfigManager.updateConfig({ lastOpenedWorkspacePath: '' });
                    logger.info('[WorkspaceManager Initialize] Cleared lastOpenedWorkspacePath. Saved:', updateResult.saved);
                    
                    cueManager.setCuesDirectory(app.getPath('userData'));
                    await cueManager.resetCues();
                    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                        mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
                        mainWindow.webContents.send('app-config-updated-from-main', appConfigManager.getConfig());
                    }
                }
            } catch (error) {
                logger.error(`[WorkspaceManager Initialize] Error auto-opening workspace: ${globalConfig.lastOpenedWorkspacePath}`, error);
            }
        } else {
            logger.info(`[WorkspaceManager Initialize] lastOpenedWorkspacePath: ${globalConfig.lastOpenedWorkspacePath} not found. Clearing from global config.`);
            appConfigManager.setConfigDirectory(null); // Ensure global context
            const updateResultClear = await appConfigManager.updateConfig({ lastOpenedWorkspacePath: '' });
        }
    } else {
        logger.info('[WorkspaceManager Initialize] No last workspace to auto-load, or auto-load disabled.');
        const currentCuesPath = globalConfig.cuesFilePath || path.join(app.getPath('userData'), DEFAULT_CUES_FILENAME);
        cueManager.setCuesDirectory(path.dirname(currentCuesPath));
        await cueManager.loadCuesFromFile(); // Load or initialize default cues
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
        }
    }
}

// New function to be called when data changes that should mark the workspace as edited
function markWorkspaceAsEdited() {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isDocumentEdited()) {
        logger.info('[WorkspaceManager] Marking workspace as edited.');
        mainWindow.setDocumentEdited(true);
    }
}

async function newWorkspace() {
    logger.info('[WorkspaceManager] newWorkspace called');
    try {
        // 1. Switch appConfigManager to global context
        appConfigManager.setConfigDirectory(null);

        // 2. Update global config: clear last workspace, set cues path to default
        const defaultCuesDir = app.getPath('userData');
        const defaultCuesFullPath = path.join(defaultCuesDir, DEFAULT_CUES_FILENAME);

        const globalUpdateResult = await appConfigManager.updateConfig({
            lastOpenedWorkspacePath: '',
            cuesFilePath: defaultCuesFullPath
        });
        logger.info('[WorkspaceManager newWorkspace] Global config updated. Saved:', globalUpdateResult.saved);

        // 3. Reset cueManager
        cueManager.setCuesDirectory(defaultCuesDir);
        await cueManager.resetCues();

        currentWorkspaceDirectory = null;
        if (mainWindow) {
            mainWindow.setTitle('acCompaniment - Untitled Workspace');
            if (typeof mainWindow.setRepresentedFilename === 'function') {
                mainWindow.setRepresentedFilename('');
            }
            mainWindow.setDocumentEdited(false);
        }

        logger.info('[WorkspaceManager newWorkspace] Workspace state reset.');
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('cues-updated-from-main', cueManager.getCues());
            mainWindow.webContents.send('app-config-updated-from-main', globalUpdateResult.config);
        }
        return true;
    } catch (error) {
        logger.error('[WorkspaceManager newWorkspace] Error:', error);
        dialog.showErrorBox('New Workspace Error', `Could not create new workspace: ${error.message}`);
        return false;
    }
}

async function openWorkspace(workspaceToOpenPath = null, isInitializing = false) {
    logger.info(`[WorkspaceManager openWorkspace] Called. Path: ${workspaceToOpenPath}, isInitializing: ${isInitializing}`);

    if (!mainWindow) return false;

    let newWorkspacePath = workspaceToOpenPath;

    if (!newWorkspacePath) {
        const globalConfigForDialog = appConfigManager.getConfig();
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Open Workspace Folder',
            properties: ['openDirectory'],
            defaultPath: currentWorkspaceDirectory || globalConfigForDialog?.recentWorkspaces?.[0] || app.getPath('documents')
        });
        if (canceled || !filePaths || filePaths.length === 0) {
            logger.info('[WorkspaceManager openWorkspace] Dialog canceled.');
            return false;
        }
        newWorkspacePath = filePaths[0];
    }
    logger.info(`[WorkspaceManager openWorkspace] Attempting to open directory: ${newWorkspacePath}`);

    const workspaceConfigDir = path.join(newWorkspacePath, WORKSPACE_CONFIG_SUBDIR);
    const workspaceCuesFilePath = path.join(newWorkspacePath, DEFAULT_CUES_FILENAME);

    try {
        fs.ensureDirSync(workspaceConfigDir); // Ensure .ac/config directory exists
        logger.info(`[WorkspaceManager openWorkspace] Ensured workspace config dir exists: ${workspaceConfigDir}`);

        // 1. Save lastOpenedWorkspacePath to GLOBAL config
        appConfigManager.setConfigDirectory(null); // Switch to global context
        const globalUpdateResult = await appConfigManager.updateConfig({ lastOpenedWorkspacePath: newWorkspacePath });
        if (globalUpdateResult.saved) {
            logger.info(`[WorkspaceManager openWorkspace] Saved lastOpenedWorkspacePath='${newWorkspacePath}' to global config.`);
        } else {
            logger.error(`[WorkspaceManager openWorkspace] FAILED to save lastOpenedWorkspacePath to global config. Error: ${globalUpdateResult.error}`);
        }
        await appConfigManager.addRecentWorkspace(newWorkspacePath); // Adds to recent list and saves global config

        // 2. Switch appConfigManager to WORKSPACE config
        appConfigManager.setConfigDirectory(workspaceConfigDir);

        // 3. Load workspace-specific config
        let workspaceConfig = await appConfigManager.loadConfig(); // Async load

        // 4. Update workspace config with essential workspace-specific paths
        const workspaceUpdateData = {
            cuesFilePath: workspaceCuesFilePath,
            lastOpenedWorkspacePath: newWorkspacePath
        };
        const workspaceUpdateResult = await appConfigManager.updateConfig(workspaceUpdateData);
        workspaceConfig = workspaceUpdateResult.config;
        logger.info('[WorkspaceManager openWorkspace] Workspace config updated with paths. Saved:', workspaceUpdateResult.saved);

        // 5. Set cue manager to use the new workspace path and load cues
        cueManager.setCuesDirectory(newWorkspacePath);
        const loadedCues = await cueManager.loadCuesFromFile(); // Async load

        currentWorkspaceDirectory = newWorkspacePath;
        if (mainWindow) {
            mainWindow.setTitle(`acCompaniment - ${path.basename(newWorkspacePath)}`);
            if (typeof mainWindow.setRepresentedFilename === 'function') {
                mainWindow.setRepresentedFilename(newWorkspacePath);
            }
            if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('cues-updated-from-main', loadedCues);
                mainWindow.webContents.send('app-config-updated-from-main', workspaceConfig);
            }
            mainWindow.setDocumentEdited(false);
        }

        logger.info(`[WorkspaceManager openWorkspace] Successfully opened workspace from ${newWorkspacePath}.`);
        return true;
    } catch (error) {
        logger.error(`[WorkspaceManager openWorkspace] Error opening workspace from ${newWorkspacePath}:`, error);
        dialog.showErrorBox('Error Opening Workspace', `Could not load workspace from ${newWorkspacePath}.\n${error.message}`);
        // Attempt to revert to a stable state (e.g., global config)
        appConfigManager.setConfigDirectory(null);
        await appConfigManager.loadConfig(); // Reload global config
        logger.info(`[WorkspaceManager openWorkspace] Reloaded global config during error handling.`);
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('app-config-updated-from-main', appConfigManager.getConfig());
        }
        return false;
    }
}

async function saveWorkspace() {
    logger.info('[WorkspaceManager saveWorkspace] Called.');
    if (currentWorkspaceDirectory) {
        try {
            // 1. Ensure appConfigManager is pointing to the current workspace config
            const workspaceConfigDir = path.join(currentWorkspaceDirectory, WORKSPACE_CONFIG_SUBDIR);
            appConfigManager.setConfigDirectory(workspaceConfigDir);

            // 2. Save cues
            const cuesSaved = await cueManager.saveCuesToFile();

            // 3. Save current appConfig
            const workspaceSaveResult = await appConfigManager.updateConfig({}); // Save current state
            if (workspaceSaveResult.saved) {
                logger.info('[WorkspaceManager saveWorkspace] Cues and workspace config saved to:', currentWorkspaceDirectory);
                if (mainWindow) mainWindow.setDocumentEdited(false);
                return true;
            } else {
                if (!cuesSaved) logger.error('[WorkspaceManager saveWorkspace] Failed to save cues.json.');
                if (!workspaceSaveResult.saved) logger.error(`[WorkspaceManager saveWorkspace] Failed to save workspace appConfig.json. Error: ${workspaceSaveResult.error}`);
                dialog.showErrorBox('Save Error', 'Could not save all workspace files. Check logs for details.');
                return false;
            }
        } catch (error) {
            logger.error('[WorkspaceManager saveWorkspace] Error:', error);
            dialog.showErrorBox('Save Error', `An error occurred: ${error.message}`);
            return false;
        }
    } else {
        logger.info('[WorkspaceManager saveWorkspace] No current workspace directory, calling saveWorkspaceAs.');
        return await saveWorkspaceAs();
    }
}

async function saveWorkspaceAs() {
    logger.info('[WorkspaceManager saveWorkspaceAs] Called.');

    if (!mainWindow) return false;

    const { canceled, filePath: chosenDirectory } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Workspace As',
        buttonLabel: 'Save Workspace',
        defaultPath: currentWorkspaceDirectory || path.join(app.getPath('documents'), 'MySoundboardWorkspace'),
        properties: ['createDirectory', 'showOverwriteConfirmation']
    });

    if (canceled || !chosenDirectory) {
        logger.info('[WorkspaceManager saveWorkspaceAs] Dialog canceled.');
        return false;
    }

    logger.info(`[WorkspaceManager saveWorkspaceAs] Target directory: ${chosenDirectory}`);

    const newWorkspacePath = chosenDirectory;
    const newWorkspaceConfigDir = path.join(newWorkspacePath, WORKSPACE_CONFIG_SUBDIR);
    const newWorkspaceCuesFilePath = path.join(newWorkspacePath, DEFAULT_CUES_FILENAME);

    try {
        fs.ensureDirSync(newWorkspacePath);
        fs.ensureDirSync(newWorkspaceConfigDir);
        logger.info(`[WorkspaceManager saveWorkspaceAs] Ensured directories exist: ${newWorkspacePath}, ${newWorkspaceConfigDir}`);

        // 1. Update cueManager and save cues to new location
        cueManager.setCuesDirectory(newWorkspacePath);
        const cuesSaved = await cueManager.saveCuesToFile();

        // 2. Update global config with new lastOpenedWorkspacePath
        appConfigManager.setConfigDirectory(null);
        const globalUpdateResult = await appConfigManager.updateConfig({ lastOpenedWorkspacePath: newWorkspacePath });
        if (!globalUpdateResult.saved) {
            logger.error(`[WorkspaceManager saveWorkspaceAs] FAILED to save lastOpenedWorkspacePath to global config. Error: ${globalUpdateResult.error}`);
        }
        await appConfigManager.addRecentWorkspace(newWorkspacePath);

        // 3. Switch to new workspace config path
        appConfigManager.setConfigDirectory(newWorkspaceConfigDir);

        // 4. Create/Update workspace config file in the new location
        let currentInMemoryConfig = appConfigManager.getConfig();
        const workspaceUpdateData = {
            ...currentInMemoryConfig,
            cuesFilePath: newWorkspaceCuesFilePath,
            lastOpenedWorkspacePath: newWorkspacePath
        };
        const workspaceSaveResult = await appConfigManager.updateConfig(workspaceUpdateData);

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
                    mainWindow.webContents.send('app-config-updated-from-main', workspaceSaveResult.config);
                }
            }
            logger.info('[WorkspaceManager saveWorkspaceAs] Workspace saved to new location:', newWorkspacePath);
            return true;
        } else {
            if (!cuesSaved) logger.error('[WorkspaceManager saveWorkspaceAs] Failed to save cues.json to new location.');
            if (!workspaceSaveResult.saved) logger.error(`[WorkspaceManager saveWorkspaceAs] Failed to save workspace appConfig.json. Error: ${workspaceSaveResult.error}`);
            dialog.showErrorBox('Save As Error', 'Could not save all files to new workspace location. Check logs.');
            return false;
        }
    } catch (error) {
        logger.error('[WorkspaceManager saveWorkspaceAs] Error:', error);
        dialog.showErrorBox('Save As Error', `An error occurred: ${error.message}`);
        return false;
    }
}

function getCurrentWorkspacePath() {
    return currentWorkspaceDirectory;
}

module.exports = {
    initialize,
    newWorkspace,
    openWorkspace,
    saveWorkspace,
    saveWorkspaceAs,
    getCurrentWorkspacePath,
    markWorkspaceAsEdited
};
