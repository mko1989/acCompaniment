const registerAudioHandlers = require('./audioHandlers');
const registerWorkspaceHandlers = require('./workspaceHandlers');
const { registerSystemHandlers, handleThemeChange } = require('./systemHandlers');
const logger = require('../utils/logger');
const { ipcMain } = require('electron');

function initialize(application, mainWin, cueMgrModule, appCfgManager, wsMgr, wsServer, _oscLstnr, httpServerInstance, _mixrIntMgr, openEasterEggGameFunc) {
    logger.info("IPC_HANDLERS_INIT: Initializing (Modular).");
    
    const context = {
        app: application,
        mainWindow: mainWin,
        cueManager: cueMgrModule,
        appConfigManager: appCfgManager,
        workspaceManager: wsMgr,
        websocketServer: wsServer,
        httpServer: httpServerInstance,
        openEasterEggGameFunc: openEasterEggGameFunc
    };

    registerAudioHandlers(ipcMain, context);
    registerWorkspaceHandlers(ipcMain, context);
    registerSystemHandlers(ipcMain, context);
    
    // Register config change listener
    if (appCfgManager && typeof appCfgManager.addConfigChangeListener === 'function') {
        appCfgManager.addConfigChangeListener((newConfig) => {
            logger.info("IPC_HANDLERS: Detected appConfig change. Broadcasting to renderer and updating modules.");
            // Check if mainWindow is valid and not destroyed before sending IPC
            try {
                if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
                    mainWin.webContents.send('app-config-updated', newConfig);
                } else {
                    logger.debug("IPC_HANDLERS: MainWindow is destroyed or unavailable, skipping config broadcast.");
                }
            } catch (error) {
                logger.warn("IPC_HANDLERS: Error checking/sending to mainWindow:", error.message);
            }

            if (httpServerInstance && typeof httpServerInstance.updateConfig === 'function') {
                httpServerInstance.updateConfig(newConfig);
            }
        });
    } else {
        logger.error("IPC_HANDLERS_INIT: appConfigManager or addConfigChangeListener is not available.");
    }

    logger.info("IPC_HANDLERS_INIT: All handlers registered.");
}

module.exports = {
    initialize,
    handleThemeChange
};
