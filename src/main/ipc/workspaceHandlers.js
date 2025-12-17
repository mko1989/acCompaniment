const logger = require('../utils/logger');

function registerWorkspaceHandlers(ipcMain, { appConfigManager }) {
    ipcMain.handle('get-initial-config', async () => {
        const config = appConfigManager.getConfig();
        logger.info('[IPC get-initial-config] Sending config to renderer:', config);
        return config;
    });

    ipcMain.handle('save-app-config', async (event, config) => {
        logger.info(`IPC_HANDLER: 'save-app-config' received with config:`, JSON.stringify(config));
        try {
            const result = await appConfigManager.updateConfig(config);
            if (result && result.saved) {
                logger.info('IPC_HANDLER: appConfigManager.updateConfig successful and config saved.');
                return { success: true, config: result.config };
            } else {
                logger.error('IPC_HANDLER: appConfigManager.updateConfig called, but config save FAILED.');
                return { success: false, error: 'Failed to save configuration file.', config: result.config };
            }
        } catch (error) {
            logger.error('IPC_HANDLER: Error calling appConfigManager.updateConfig:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-config-path', () => {
        return appConfigManager.getConfigPath();
    });
}

module.exports = registerWorkspaceHandlers;

