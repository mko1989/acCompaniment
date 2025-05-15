const { dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');

// Assume these modules are passed in during initialization
let appConfigManager;
let cueManager;
let mainWindow; // For sending IPC messages and dialog parent

let currentWorkspaceDirectory = null; // Path to the currently open workspace directory

// To be called from main.js
function initialize(appConfManager, cManager, mainWin) {
    appConfigManager = appConfManager;
    cueManager = cManager;
    mainWindow = mainWin;
}

// New function to be called when data changes that should mark the workspace as edited
function markWorkspaceAsEdited() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isDocumentEdited()) {
            console.log('WorkspaceManager: Marking workspace as edited.');
            mainWindow.setDocumentEdited(true);
        }
    }
}

async function newWorkspace() {
    console.log('WorkspaceManager: newWorkspace called');
    try {
        // 1. Reset paths to default (userData)
        cueManager.setCuesDirectory(null);
        appConfigManager.setConfigDirectory(null);

        // 2. Explicitly clear cue data in memory AND ensure default config is loaded/reset
        cueManager.resetCues(); // This sets cueManager.cues = [] and tells Companion
        appConfigManager.resetToDefaults(); // Resets config in memory
        appConfigManager.loadConfig(); // Loads default config from userData or applies internal defaults

        // At this point, cueManager.cues is guaranteed to be [].
        // We don't need cueManager.loadCuesFromFile() here for a "new" workspace.

        currentWorkspaceDirectory = null;
        if (mainWindow) {
            mainWindow.setTitle('acCompaniment - Untitled Workspace'); // App name updated here
            if (typeof mainWindow.setRepresentedFilename === 'function') {
                mainWindow.setRepresentedFilename('');
            }
            mainWindow.setDocumentEdited(false);
        }
        console.log('WorkspaceManager: Workspace state reset. Cues cleared, config at defaults.');
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('workspace-did-change');
        }
        return true;
    } catch (error) {
        console.error('Error creating new workspace:', error);
        if (mainWindow) {
            dialog.showErrorBox('New Workspace Error', `Could not create new workspace.\n${error.message}`);
        }
        return false;
    }
}

async function openWorkspace(workspaceToOpenPath = null) {
    console.log(`WorkspaceManager: openWorkspace called. Path: ${workspaceToOpenPath}`);
    if (!mainWindow) return false;

    let newWorkspacePath = workspaceToOpenPath;

    if (!newWorkspacePath) {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Open Workspace Folder',
            properties: ['openDirectory'],
            defaultPath: currentWorkspaceDirectory || appConfigManager.getConfig()?.recentWorkspaces?.[0] || undefined // Suggest last opened or first recent
        });

        if (canceled || !filePaths || filePaths.length === 0) {
            console.log('Workspace open dialog canceled.');
            return false;
        }
        newWorkspacePath = filePaths[0];
    } 

    console.log('Attempting to open workspace directory:', newWorkspacePath);

    try {
        appConfigManager.setConfigDirectory(newWorkspacePath);
        cueManager.setCuesDirectory(newWorkspacePath);

        appConfigManager.loadConfig(); 
        cueManager.loadCuesFromFile(); 

        currentWorkspaceDirectory = newWorkspacePath;
        if (mainWindow) {
            mainWindow.setTitle(`acCompaniment - ${path.basename(newWorkspacePath)}`);
            mainWindow.webContents.send('workspace-did-change');
            mainWindow.setDocumentEdited(false);
        }
        
        appConfigManager.addRecentWorkspace(newWorkspacePath); // Add to recent workspaces

        console.log(`Workspace opened from ${newWorkspacePath}`);
        return true;
    } catch (error) {
        console.error(`Error opening workspace from ${newWorkspacePath}:`, error);
        dialog.showErrorBox('Error Opening Workspace', `Could not load workspace from ${newWorkspacePath}. Ensure it contains valid appConfig.json and cues.json files, or is an empty directory you intend to use.\n${error.message}`);
        // Optionally, revert to previous state or default state
        // appConfigManager.setConfigDirectory(currentWorkspaceDirectory); // Revert path
        // cueManager.setCuesDirectory(currentWorkspaceDirectory);
        // appConfigManager.loadConfig();
        // cueManager.loadCuesFromFile();
        return false;
    }
}

async function saveWorkspace() {
    console.log('WorkspaceManager: saveWorkspace called');
    if (currentWorkspaceDirectory) {
        try {
            const configSaved = appConfigManager.saveConfig();
            const cuesSaved = cueManager.saveCuesToFile(); 

            if (configSaved && cuesSaved) {
                console.log('Workspace saved to:', currentWorkspaceDirectory);
                if (mainWindow) mainWindow.setDocumentEdited(false);
                return true;
            } else {
                console.error('Failed to save one or more workspace files to:', currentWorkspaceDirectory);
                dialog.showErrorBox('Save Error', `Could not save all workspace files to ${currentWorkspaceDirectory}. Check file permissions or disk space.`);
                return false;
            }
        } catch (error) {
            console.error('Error saving workspace:', error);
            dialog.showErrorBox('Save Error', `An error occurred while saving the workspace: ${error.message}`);
            return false;
        }
    } else {
        return await saveWorkspaceAs();
    }
}

async function saveWorkspaceAs() {
    console.log('WorkspaceManager: saveWorkspaceAs called');
    if (!mainWindow) return false;

    const { canceled, filePath: chosenDirectory } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Workspace As',
        buttonLabel: 'Save Workspace',
        defaultPath: currentWorkspaceDirectory || appConfigManager.DEFAULT_CONFIG?.lastProposedSavePath || path.join(app.getPath('documents'), 'MySoundboardWorkspace'),
        properties: ['createDirectory', 'showOverwriteConfirmation']
    });

    if (canceled || !chosenDirectory) {
        console.log('Workspace "Save As" canceled.');
        return false;
    }
    
    console.log('Target directory for "Save As":', chosenDirectory);

    try {
        // Ensure the directory exists (showSaveDialog with createDirectory should handle this, but a check is good)
        if (!fs.existsSync(chosenDirectory)) {
            fs.mkdirSync(chosenDirectory, { recursive: true });
            console.log('Created workspace directory:', chosenDirectory);
        }
        
        appConfigManager.setConfigDirectory(chosenDirectory);
        cueManager.setCuesDirectory(chosenDirectory);

        const configSaved = appConfigManager.saveConfig();
        const cuesSaved = cueManager.saveCuesToFile(); 

        if (configSaved && cuesSaved) {
            currentWorkspaceDirectory = chosenDirectory;
            if (mainWindow) {
                mainWindow.setTitle(`acCompaniment - ${path.basename(chosenDirectory)}`);
                mainWindow.setDocumentEdited(false);
            }
            console.log('Workspace saved to new location:', currentWorkspaceDirectory);
            appConfigManager.addRecentWorkspace(currentWorkspaceDirectory); // Add to recent workspaces

            // No need to send 'workspace-did-change' as data hasn't changed from renderer's perspective, only its save location.
            // However, if the title or other UI elements need to reflect the new path, consider it.
            return true;
        } else {
            console.error('Failed to save one or more workspace files to new location:', chosenDirectory);
            dialog.showErrorBox('Save As Error', `Could not save all workspace files to ${chosenDirectory}. Check permissions or disk space.`);
            // Should we revert paths if one saved and other didn't?
            // This can be complex. For now, log and error.
            return false;
        }
    } catch (error) {
        console.error('Error during "Save As" operation:', error);
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