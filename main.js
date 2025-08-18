const { app, BrowserWindow, ipcMain, Menu, dialog, screen, nativeTheme, session } = require('electron');
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
console.log('MAIN_JS: Importing oscListener...');
const oscListener = require('./src/main/oscListener');
console.log('MAIN_JS: Importing mixerIntegrationManager...');
const mixerIntegrationManager = require('./src/main/mixerIntegrationManager');
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

    easterEggWindow = new BrowserWindow({
        width: 700, // Adjust as needed
        height: 560, // Adjust as needed
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
}
// --- END NEW FUNCTION ---

let isDev = process.env.NODE_ENV !== 'production';

async function createWindow() {
  console.log('MAIN_JS: createWindow START'); // LOG 1
  try {
    console.log('[MainCreateWindow] Config BEFORE initial appConfigManager.loadConfig():', JSON.parse(JSON.stringify(appConfigManager.getConfig())) ); // Config Log PRE-LOAD
    console.log('MAIN_JS: createWindow - In try block, before appConfigManager.loadConfig()'); // LOG 2
    appConfigManager.loadConfig();
    console.log('[MainCreateWindow] Initial global config loaded (directly after loadConfig call):', JSON.parse(JSON.stringify(appConfigManager.getConfig())) ); // Config Log 1
    console.log('MAIN_JS: createWindow - After appConfigManager.loadConfig()'); // LOG 3
    const currentConfig = appConfigManager.getConfig(); // getConfig returns a copy
    console.log('[MainCreateWindow] currentConfig variable after initial load and getConfig():', JSON.parse(JSON.stringify(currentConfig)) ); // Config Log 1.1
    console.log('MAIN_JS: createWindow - After appConfigManager.getConfig()'); // LOG 4

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
    console.log('MAIN_JS: createWindow - BrowserWindow created'); // LOG 5

    mainWindow.on('resize', saveWindowBounds);
    mainWindow.on('move', saveWindowBounds);
    mainWindow.on('close', saveWindowBounds); 
    console.log('MAIN_JS: createWindow - Window event listeners set'); // LOG 6

    await mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
    console.log('MAIN_JS: createWindow - mainWindow.loadFile complete'); // LOG 7

    // DevTools are now only opened in development mode if explicitly requested
    if (isDev && process.env.OPEN_DEV_TOOLS) {
      mainWindow.webContents.openDevTools();
      console.log('MAIN_JS: createWindow - DevTools opened'); // LOG 8
    }

    console.log('MAIN_JS: createWindow - Before cueManager.setCuesDirectory'); // LOG 9
    cueManager.setCuesDirectory(currentConfig.cuesFilePath);
    console.log('MAIN_JS: createWindow - After cueManager.setCuesDirectory'); // LOG 10
    await cueManager.initialize(websocketServer, mainWindow, httpServer);
    console.log('MAIN_JS: createWindow - After cueManager.initialize'); // LOG 11

    console.log('[MainCreateWindow] Config BEFORE workspaceManager.initialize:', JSON.parse(JSON.stringify(appConfigManager.getConfig())) ); // Config Log PRE-WS_INIT
    console.log('MAIN_JS: createWindow - Before workspaceManager.initialize'); // LOG 12
    workspaceManager.initialize(appConfigManager, cueManager, mainWindow);
    console.log('[MainCreateWindow] Config AFTER workspaceManager.initialize (from appConfigManager.getConfig()):', JSON.parse(JSON.stringify(appConfigManager.getConfig())) ); // Config Log 2
    console.log('MAIN_JS: createWindow - After workspaceManager.initialize'); // LOG 13

    console.log('MAIN_JS: createWindow - Before websocketServer.setContext'); // LOG 14
    websocketServer.setContext(mainWindow, cueManager);
    console.log('MAIN_JS: createWindow - After websocketServer.setContext'); // LOG 15
    await websocketServer.startServer(currentConfig.websocketPort, currentConfig.websocketEnabled);
    console.log('MAIN_JS: createWindow - After websocketServer.startServer'); // LOG 16

    // console.log('MAIN_JS: createWindow - Before oscListener.setContext'); // LOG 17
    // oscListener.setContext(mainWindow, cueManager); // REMOVED - oscListener no longer uses direct context
    // console.log('MAIN_JS: createWindow - After oscListener.setContext'); // LOG 18
    oscListener.initializeOscListener(currentConfig.oscPort, currentConfig.oscEnabled);
    console.log('MAIN_JS: createWindow - After oscListener.initializeOscListener'); // LOG 19

    console.log('MAIN_JS: createWindow - Before mixerIntegrationManager.initialize'); // LOG 20
    mixerIntegrationManager.initialize(currentConfig, mainWindow, cueManager);
    console.log('MAIN_JS: createWindow - After mixerIntegrationManager.initialize'); // LOG 21

    // Added: Initialize httpServer with app config
    console.log('MAIN_JS: createWindow - Before httpServer.initialize');
    const currentAppConfig = appConfigManager.getConfig();
    httpServer.initialize(cueManager, mainWindow, currentAppConfig);
    console.log('MAIN_JS: createWindow - After httpServer.initialize');

    console.log('MAIN_JS: About to initialize IPC Handlers. cueManager type:', typeof cueManager, 'cueManager keys:', cueManager ? Object.keys(cueManager) : 'undefined'); // LOG 22
    initializeIpcHandlers(app, mainWindow, cueManager, appConfigManager, workspaceManager, websocketServer, oscListener, httpServer, mixerIntegrationManager, openEasterEggGameWindow);
    console.log('MAIN_JS: createWindow - After initializeIpcHandlers'); // LOG 23

    appConfigManager.addConfigChangeListener(async (newConfig) => {
      // ... existing code ...
    });

    const menu = Menu.buildFromTemplate(getMenuTemplate(mainWindow, cueManager, workspaceManager, appConfigManager));
    Menu.setApplicationMenu(menu);
    console.log('MAIN_JS: createWindow - Menu created and set'); // LOG 26

    // The theme should be applied based on the config potentially updated by workspaceManager.initialize
    const finalConfigForTheme = appConfigManager.getConfig();
    const themeToApply = finalConfigForTheme.theme || 'system'; 
    console.log('Main: Applying theme from config on startup:', themeToApply);
    handleThemeChange(themeToApply, mainWindow, nativeTheme);
    console.log('MAIN_JS: createWindow - After handleThemeChange'); // LOG 28

    if (mainWindow && mainWindow.webContents) {
      console.log("MAIN_JS: createWindow - Attempting to send main-process-ready at the end of try block.");
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
          label: 'Learn More',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/YourRepo/acCompaniment'); 
          }
        }
      ]
    }
  ];
  return template;
}

// --- Electron App Lifecycle Events ---
app.whenReady().then(async () => {
  console.log('MAIN_JS: App is ready, starting createWindow...');

  // Block microphone/camera permission prompts unless explicitly allowed later
  try {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'media') {
        console.log('Permission request (media) blocked by default. Details:', details);
        return callback(false);
      }
      callback(false);
    });
  } catch (e) {
    console.warn('Failed to set permission request handler:', e);
  }
  await createWindow();
  console.log('MAIN_JS: createWindow has completed.');

  // Register global shortcut for Easter Egg game
  // const { globalShortcut } = require('electron');
  // const ret = globalShortcut.register('Shift+CommandOrControl+P', () => {
  //   console.log('MAIN_JS: Shift+CommandOrControl+P pressed, opening Easter Egg game.');
  //   openEasterEggGameWindow();
  // });

  // if (!ret) {
  //   console.error('MAIN_JS: globalShortcut registration failed for Shift+CommandOrControl+P');
  // } else {
  //   console.log('MAIN_JS: globalShortcut Shift+CommandOrControl+P registered successfully.');
  // }

  app.on('activate', () => {
    console.log('MAIN_JS: app.on(activate) - START'); // LOG C
    if (BrowserWindow.getAllWindows().length === 0) {
      console.log('MAIN_JS: app.on(activate) - No windows open, calling createWindow()'); // LOG D
      createWindow();
    }
    console.log('MAIN_JS: app.on(activate) - END'); // LOG F
  });
  console.log('MAIN_JS: app.whenReady() - activate listener attached'); // LOG G
});
console.log('MAIN_JS: app.whenReady() listener attached'); // LOG H

app.on('window-all-closed', () => {
  console.log('MAIN_JS: window-all-closed event');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
console.log('MAIN_JS: window-all-closed listener attached'); // LOG I

app.on('will-quit', () => {
  console.log('MAIN_JS: will-quit event. Ensuring config is saved.');
  if (mainWindow && !mainWindow.isDestroyed()) { 
    saveWindowBounds();
  }
  appConfigManager.saveConfig(); 
  console.log('MAIN_JS: App is quitting.');
  // Unregister all shortcuts.
  // const { globalShortcut } = require('electron'); // Ensure it's in scope
  // globalShortcut.unregisterAll();
  // console.log('MAIN_JS: All global shortcuts unregistered.');
});
console.log('MAIN_JS: will-quit listener attached'); // LOG J

if (process.platform === 'darwin') {
  app.setName('acCompaniment Soundboard');
}
console.log('MAIN_JS: Script end'); // LOG K

// Example: Listen for a message from renderer to open a new window
ipcMain.on('open-new-window-example', () => {
    // ... existing new window example code ...
});

// Handle request to open Easter Egg game window (this is for the dev button)
// ipcMain.on('open-easter-egg-game', () => {
//     openEasterEggGameWindow();
// }); 