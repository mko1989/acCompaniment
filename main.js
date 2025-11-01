const { app, BrowserWindow, ipcMain, Menu, dialog, nativeTheme, session } = require('electron');
const path = require('node:path');
const fs = require('fs-extra'); // For file system operations

// Import main process modules
console.log('MAIN_JS: Importing cueManager...');
const cueManager = require('./src/main/cueManager');
console.log('MAIN_JS: Importing ipcHandlers...');
const { initialize: initializeIpcHandlers, handleThemeChange } = require('./src/main/ipcHandlers');
console.log('MAIN_JS: Importing websocketServer...');
const websocketServer = require('./src/main/websocketServer');
console.log('MAIN_JS: Importing appConfigManager...');
const appConfigManager = require('./src/main/appConfig');
console.log('MAIN_JS: Importing workspaceManager...');
const workspaceManager = require('./src/main/workspaceManager');
// Mixer integration removed as per requirements
console.log('MAIN_JS: Importing httpServer...');
const httpServer = require('./src/main/httpServer'); // Added: Import httpServer
console.log('MAIN_JS: All main modules imported.');

let mainWindow;
let easterEggWindow = null; // Keep track of the game window

// --- START NEW FUNCTION ---
function openEasterEggGameWindow() {
    if (easterEggWindow && !easterEggWindow.isDestroyed()) {
        easterEggWindow.focus();
        return;
    }

    try {
        // Easter egg game window dimensions
        const EASTER_EGG_WIDTH = 700;
        const EASTER_EGG_HEIGHT = 560;
        
        easterEggWindow = new BrowserWindow({
            width: EASTER_EGG_WIDTH,
            height: EASTER_EGG_HEIGHT,
            parent: mainWindow, // Optional: to make it a child window
            modal: false,       // Optional: set to true to make it a modal dialog
            resizable: false,
            show: false, // Don't show until content is loaded
            webPreferences: {
                nodeIntegration: false, // Important for security
                contextIsolation: true, // Important for security
                // preload: path.join(__dirname, 'preloadForGame.js'), // If you need a specific preload for the game
            }
        });

        easterEggWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'easter_egg_game', 'game.html'));

        easterEggWindow.once('ready-to-show', () => {
            easterEggWindow.show();
            // easterEggWindow.webContents.openDevTools(); // Optional: for debugging the game window
        });

        easterEggWindow.on('closed', () => {
            easterEggWindow = null;
        });
    } catch (error) {
        console.error('Failed to open Easter Egg game window:', error);
        easterEggWindow = null;
    }
}
// --- END NEW FUNCTION ---

let isDev = process.env.NODE_ENV !== 'production';

async function createWindow() {
  console.log('MAIN_JS: createWindow START');
  try {
    // Reduced verbose logging
    appConfigManager.loadConfig();
    
    const currentConfig = appConfigManager.getConfig(); // getConfig returns a copy
    

    mainWindow = new BrowserWindow({
      width: currentConfig.windowWidth || 1200, 
      height: currentConfig.windowHeight || 800, 
      x: currentConfig.windowX, 
      y: currentConfig.windowY, 
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        enableRemoteModule: false,
        nodeIntegration: false, 
      },
      icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
      title: "acCompaniment"
    });
    

    mainWindow.on('resize', saveWindowBounds);
    mainWindow.on('move', saveWindowBounds);
    mainWindow.on('close', saveWindowBounds); 
    

    await mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
    

    // DevTools are now only opened in development mode if explicitly requested
    if (isDev && process.env.OPEN_DEV_TOOLS) {
      mainWindow.webContents.openDevTools();
      console.log('MAIN_JS: createWindow - DevTools opened');
    }

    // Initialize cue manager
    cueManager.setCuesDirectory(currentConfig.cuesFilePath);
    
    await cueManager.initialize(websocketServer, mainWindow, httpServer);
    

    
    workspaceManager.initialize(appConfigManager, cueManager, mainWindow);
    

    
    websocketServer.setContext(mainWindow, cueManager);
    
    await websocketServer.startServer(currentConfig.websocketPort, currentConfig.websocketEnabled);

    // Mixer integration removed as per requirements
    

    // Added: Initialize httpServer with app config
    
    const currentAppConfig = appConfigManager.getConfig();
    httpServer.initialize(cueManager, mainWindow, currentAppConfig);
    

    
    initializeIpcHandlers(app, mainWindow, cueManager, appConfigManager, workspaceManager, websocketServer, null, httpServer, null, openEasterEggGameWindow);
    

    // Configuration change listener can be added here if needed
    // appConfigManager.addConfigChangeListener(async (newConfig) => {
    //   // Handle configuration changes
    // });

    const menu = Menu.buildFromTemplate(getMenuTemplate(mainWindow, cueManager, workspaceManager, appConfigManager));
    Menu.setApplicationMenu(menu);
    

    // The theme should be applied based on the config potentially updated by workspaceManager.initialize
    const finalConfigForTheme = appConfigManager.getConfig();
    const themeToApply = finalConfigForTheme.theme || 'system'; 
    
    handleThemeChange(themeToApply, mainWindow, nativeTheme);
    

    if (mainWindow && mainWindow.webContents) {
      
      mainWindow.webContents.send('main-process-ready');
    } else {
        console.error("MAIN_JS: DEBUG Cannot send main-process-ready, mainWindow or webContents is null at the end of try block.");
    }

    console.log('MAIN_JS: createWindow END - Successfully reached end of try block'); // LOG 29

  } catch (error) {
    console.error('MAIN_JS: CRITICAL ERROR in createWindow:', error);
  }
}

// Function to save window bounds
function saveWindowBounds() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    appConfigManager.updateConfig({
      windowWidth: bounds.width,
      windowHeight: bounds.height,
      windowX: bounds.x,
      windowY: bounds.y
    });
  }
}

// --- Application Menu Template ---
function getMenuTemplate(mainWindow, cueManager, workspaceManager, appConfigManagerInstance) {
  const template = [
    // Standard App Menu (macOS)
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { 
          label: 'Preferences',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
              mainWindow.webContents.send('open-preferences');
            }
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // File Menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace',
          accelerator: 'CmdOrCtrl+N',
          click: () => workspaceManager.newWorkspace()
        },
        {
          label: 'Open Workspace...',
          accelerator: 'CmdOrCtrl+O',
          click: () => workspaceManager.openWorkspace()
        },
        {
          label: 'Save Workspace',
          accelerator: 'CmdOrCtrl+S',
          click: () => workspaceManager.saveWorkspace()
        },
        {
          label: 'Save Workspace As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => workspaceManager.saveWorkspaceAs()
        },
        {
          label: 'Reveal Cues File',
          click: () => {
            const currentConfig = appConfigManagerInstance.getConfig();
            const cuesPath = currentConfig.cuesFilePath || cueManager.getDefaultCuesPath();
            if (fs.existsSync(cuesPath)) {
              require('electron').shell.showItemInFolder(cuesPath);
            } else {
              dialog.showErrorBox('File Not Found', `The cues file was not found at: ${cuesPath}`);
            }
          }
        },
        {
          label: 'Reveal Config File',
          click: () => {
            const configPath = appConfigManagerInstance.getConfigPath();
            if (fs.existsSync(configPath)) {
              require('electron').shell.showItemInFolder(configPath);
            } else {
              dialog.showErrorBox('File Not Found', `The config file was not found at: ${configPath}`);
            }
          }
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit Menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(process.platform === 'darwin' ? [
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
    // View Menu
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
    // Window Menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    // Help Menu (Optional)
    {
      role: 'help',
      submenu: [
        {
          label: `Version ${app.getVersion()}`,
          enabled: false
        },
        {
          type: 'separator'
        },
        {
          label: 'Check for Updates...',
          click: async () => {
            try {
              const { ipcMain } = require('electron');
              const https = require('https');
              const packageJson = require('./package.json');
              const currentVersion = packageJson.version;
              
              const checkUpdate = () => {
                return new Promise((resolve) => {
                  const options = {
                    hostname: 'api.github.com',
                    path: '/repos/mko1989/acCompaniment/releases/latest',
                    method: 'GET',
                    headers: {
                      'User-Agent': 'acCompaniment'
                    }
                  };

                  const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                      data += chunk;
                    });
                    res.on('end', () => {
                      try {
                        const release = JSON.parse(data);
                        const latestVersion = release.tag_name.replace(/^v/, '');
                        const parts1 = latestVersion.split('.').map(Number);
                        const parts2 = currentVersion.split('.').map(Number);
                        const maxLength = Math.max(parts1.length, parts2.length);
                        let updateAvailable = false;
                        for (let i = 0; i < maxLength; i++) {
                          const part1 = parts1[i] || 0;
                          const part2 = parts2[i] || 0;
                          if (part1 > part2) {
                            updateAvailable = true;
                            break;
                          }
                          if (part1 < part2) break;
                        }
                        resolve({
                          currentVersion,
                          latestVersion,
                          updateAvailable,
                          releaseUrl: release.html_url
                        });
                      } catch (error) {
                        resolve({
                          currentVersion,
                          latestVersion: null,
                          updateAvailable: false,
                          error: 'Failed to parse release data'
                        });
                      }
                    });
                  });

                  req.on('error', () => {
                    resolve({
                      currentVersion,
                      latestVersion: null,
                      updateAvailable: false,
                      error: 'Network error'
                    });
                  });

                  req.setTimeout(5000, () => {
                    req.destroy();
                    resolve({
                      currentVersion,
                      latestVersion: null,
                      updateAvailable: false,
                      error: 'Timeout'
                    });
                  });

                  req.end();
                });
              };

              const updateInfo = await checkUpdate();
              if (updateInfo.updateAvailable) {
                const { dialog } = require('electron');
                const result = await dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: 'Update Available',
                  message: `A new version is available!`,
                  detail: `Current version: ${updateInfo.currentVersion}\nLatest version: ${updateInfo.latestVersion}\n\nWould you like to visit the releases page?`,
                  buttons: ['Visit Releases', 'Cancel'],
                  defaultId: 0
                });
                if (result.response === 0) {
                  const { shell } = require('electron');
                  await shell.openExternal('https://github.com/mko1989/acCompaniment/releases');
                }
              } else if (updateInfo.error) {
                const { dialog } = require('electron');
                await dialog.showMessageBox(mainWindow, {
                  type: 'warning',
                  title: 'Update Check Failed',
                  message: `Could not check for updates: ${updateInfo.error}`,
                  detail: `Current version: ${updateInfo.currentVersion}`
                });
              } else {
                const { dialog } = require('electron');
                await dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: 'Up to Date',
                  message: `You are running the latest version.`,
                  detail: `Version: ${updateInfo.currentVersion}`
                });
              }
            } catch (error) {
              console.error('Error checking for updates:', error);
              const { dialog } = require('electron');
              await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Error',
                message: 'Failed to check for updates',
                detail: error.message
              });
            }
          }
        },
        {
          type: 'separator'
        },
        {
          label: 'Learn More',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/mko1989/acCompaniment'); 
          }
        }
      ]
    }
  ];
  return template;
}

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('MAIN_JS: Another instance is already running. Exiting.');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, focus our window instead
    console.log('MAIN_JS: Second instance attempted. Focusing existing window.');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// --- Electron App Lifecycle Events ---
app.whenReady().then(async () => {
  console.log('MAIN_JS: App is ready, starting createWindow...');

  // Allow media permissions (needed for audio device enumeration on macOS)
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'media') {
        console.log('Permission request (media) granted. Details:', details);
        return callback(true);
      }
      callback(true);
    });
  } catch (e) {
    console.warn('Failed to set permission request handler:', e);
  }
  await createWindow();
  console.log('MAIN_JS: createWindow has completed.');

  // Global shortcut registration can be enabled here if needed
  // Currently disabled to avoid conflicts

  app.on('activate', () => {
    console.log('MAIN_JS: app.on(activate) - START');
    if (BrowserWindow.getAllWindows().length === 0) {
      console.log('MAIN_JS: app.on(activate) - No windows open, calling createWindow()');
      createWindow();
    }
    console.log('MAIN_JS: app.on(activate) - END');
  });
  console.log('MAIN_JS: app.whenReady() - activate listener attached');
});
console.log('MAIN_JS: app.whenReady() listener attached');

app.on('window-all-closed', () => {
  console.log('MAIN_JS: window-all-closed event');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
console.log('MAIN_JS: window-all-closed listener attached');

app.on('will-quit', () => {
  console.log('MAIN_JS: will-quit event. Ensuring config is saved.');
  if (mainWindow && !mainWindow.isDestroyed()) { 
    saveWindowBounds();
  }
  appConfigManager.saveConfig(); 
  console.log('MAIN_JS: App is quitting.');
  // Global shortcuts cleanup can be enabled here if needed
  // Currently disabled since no shortcuts are registered
});
console.log('MAIN_JS: will-quit listener attached');

if (process.platform === 'darwin') {
  app.setName('acCompaniment Soundboard');
}
console.log('MAIN_JS: Script end');

// IPC handlers for opening new windows can be added here if needed
// Example:
// ipcMain.on('open-new-window-example', () => {
//     // Implementation for opening new windows
// });

// Easter Egg game window handler (currently disabled)
// ipcMain.on('open-easter-egg-game', () => {
//     openEasterEggGameWindow();
// }); 