const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');

// Import main process modules
const cueManager = require('./src/main/cueManager');
const { initialize: initializeIpcHandlers } = require('./src/main/ipcHandlers');
const websocketServer = require('./src/main/websocketServer');
const appConfigManager = require('./src/main/appConfig');
const workspaceManager = require('./src/main/workspaceManager');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  mainWindow.setTitle('acCompaniment - Untitled Workspace');

  // Prompt before closing if workspace is edited
  mainWindow.on('close', (event) => {
    if (mainWindow.isDocumentEdited()) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Save', "Don't Save", 'Cancel'],
        title: 'Confirm',
        message: 'You have unsaved changes. Do you want to save them before closing?',
        defaultId: 0, // Default to Save
        cancelId: 2 // Corresponds to Cancel
      });

      if (choice === 0) { // Save
        event.preventDefault(); // Prevent closing immediately
        (async () => {
          const success = await workspaceManager.saveWorkspace();
          if (success) {
            mainWindow.destroy(); // Close if save was successful
          } else {
            // Save was cancelled (e.g. user cancelled "Save As" dialog)
            // Do not close the window, allow user to continue editing or try saving again.
          }
        })();
      } else if (choice === 1) { // Don't Save
        // Proceed to close, do nothing here
      } else { // Cancel (choice === 2)
        event.preventDefault(); // Prevent closing
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMenu() {
    const isMac = process.platform === 'darwin';

    // Get recent workspaces from appConfigManager
    const currentConfig = appConfigManager.getConfig();
    const recentWorkspaces = (currentConfig && Array.isArray(currentConfig.recentWorkspaces)) ? currentConfig.recentWorkspaces : [];

    const recentWorkspacesSubmenu = recentWorkspaces.map(wsPath => ({
        label: path.basename(wsPath), // Show only the folder name for brevity
        click: async () => {
            await workspaceManager.openWorkspace(wsPath);
            createMenu(); // Rebuild menu to reflect potential changes (e.g. recent list, window title)
        }
    })); 

    const fileSubmenu = [
        {
            label: 'New Workspace',
            accelerator: 'CmdOrCtrl+N',
            click: async () => {
                await workspaceManager.newWorkspace();
                createMenu(); // Rebuild menu
            }
        },
        {
            label: 'Open Workspace...',
            accelerator: 'CmdOrCtrl+O',
            click: async () => {
                await workspaceManager.openWorkspace(); // No path, so dialog will show
                createMenu(); // Rebuild menu after open potentially adds to recent
            }
        },
    ];

    if (recentWorkspacesSubmenu.length > 0) {
        fileSubmenu.push({ type: 'separator' });
        fileSubmenu.push(...recentWorkspacesSubmenu);
    }

    fileSubmenu.push(
        {
            label: 'Save Workspace',
            accelerator: 'CmdOrCtrl+S',
            click: async () => {
                await workspaceManager.saveWorkspace();
                // Save doesn't change recent list unless it's a new workspace (handled by Save As)
                // but it does change the window title if it was untitled and document edited status.
                createMenu(); // Rebuild menu for consistency (e.g., update window title if shown in menu)
            }
        },
        {
            label: 'Save Workspace As...',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: async () => {
                await workspaceManager.saveWorkspaceAs();
                createMenu(); // Rebuild menu after Save As adds to recent
            }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
    );

    const template = [
        // { role: 'appMenu' } // on macOS
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        // { role: 'fileMenu' }
        {
            label: 'File',
            submenu: fileSubmenu // Use the dynamically built submenu
        },
        // { role: 'editMenu' }
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                ...(isMac ? [
                    { role: 'pasteAndMatchStyle' },
                    { role: 'delete' },
                    { role: 'selectAll' },
                    { type: 'separator' },
                    {
                        label: 'Speech',
                        submenu: [
                            { role: 'startSpeaking' },
                            { role: 'stopSpeaking' }
                        ]
                    }
                ] : [
                    { role: 'delete' },
                    { type: 'separator' },
                    { role: 'selectAll' }
                ])
            ]
        },
        // { role: 'viewMenu' }
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        // { role: 'windowMenu' }
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                ...(isMac ? [
                    { type: 'separator' },
                    { role: 'front' },
                    { type: 'separator' },
                    { role: 'window' }
                ] : [
                    { role: 'close' }
                ])
            ]
        },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Learn More',
                    click: async () => {
                        const { shell } = require('electron');
                        await shell.openExternal('https://electronjs.org');
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  appConfigManager.loadConfig();

  createWindow();
  createMenu();

  cueManager.initialize(websocketServer);
  websocketServer.initialize(mainWindow, cueManager);
  initializeIpcHandlers(mainWindow, cueManager, websocketServer, workspaceManager);
  workspaceManager.initialize(appConfigManager, cueManager, mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Handle before-quit for app-wide quit attempts (Cmd+Q, etc.)
app.on('before-quit', (event) => {
  if (mainWindow && mainWindow.isDocumentEdited()) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      title: 'Confirm Quit',
      message: 'You have unsaved changes. Do you want to save them before quitting?',
      defaultId: 0,
      cancelId: 2
    });

    if (choice === 0) { // Save
      event.preventDefault(); // Prevent quitting immediately
      (async () => {
        const success = await workspaceManager.saveWorkspace();
        if (success) {
          app.quit(); // Quit if save was successful
        } else {
          // Save was cancelled, do not quit
        }
      })();
    } else if (choice === 1) { // Don't Save
      // Proceed to quit, do nothing here to prevent default
    } else { // Cancel (choice === 2)
      event.preventDefault(); // Prevent quitting
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// No specific logic here anymore, all moved to modules. 