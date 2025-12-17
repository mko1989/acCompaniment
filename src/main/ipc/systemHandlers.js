const { clipboard, app, nativeTheme } = require('electron');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

// Helper function to compare version strings
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const part1 = parts1[i] || 0;
        const part2 = parts2[i] || 0;
        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }
    return 0;
}

function handleThemeChange(theme, win, nativeTheme, appConfigManager) {
    if (theme === 'dark') {
        nativeTheme.themeSource = 'dark';
    } else if (theme === 'light') {
        nativeTheme.themeSource = 'light';
    } else {
        nativeTheme.themeSource = 'system';
    }
    if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('theme-updated', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
    
    // Add check for appConfigManager
    if (appConfigManager && typeof appConfigManager.getConfig === 'function') {
        const currentConfig = appConfigManager.getConfig();
        if (currentConfig.theme !== theme) {
            appConfigManager.updateConfig({ theme: theme });
        }
    } else {
        logger.warn('handleThemeChange: appConfigManager is undefined or invalid, cannot update config');
    }
}

function registerSystemHandlers(ipcMain, { appConfigManager, mainWindow, openEasterEggGameFunc, httpServer }) {
    ipcMain.handle('generate-uuid', async () => uuidv4());

    ipcMain.handle('write-to-clipboard', async (event, text) => {
        try {
            clipboard.writeText(text);
            logger.info('IPC_HANDLER: Successfully wrote to clipboard');
            return { success: true };
        } catch (error) {
            logger.error('IPC_HANDLER: Error writing to clipboard:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-audio-output-devices', async () => {
        try {
            if (!app.isReady()) {
                logger.warn('Attempted to get media devices before app was ready.');
                return {
                    success: false,
                    error: 'Application not ready',
                    devices: [],
                    fallback: 'renderer_enumeration'
                };
            }
            logger.info('Audio output device enumeration delegated to renderer process');
            return {
                success: true,
                devices: [],
                delegated: true,
                message: 'Device enumeration delegated to renderer process for better compatibility'
            };
        } catch (error) {
            logger.error('Error in get-audio-output-devices handler:', error);
            return {
                success: false,
                error: error.message,
                devices: [],
                fallback: 'renderer_enumeration'
            };
        }
    });

    ipcMain.handle('get-app-version', async (event) => {
        const packageJson = require('../../../package.json');
        return packageJson.version;
    });

    ipcMain.handle('check-for-update', async (event) => {
        try {
            const packageJson = require('../../../package.json');
            const currentVersion = packageJson.version;

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
                            const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
                            resolve({
                                currentVersion,
                                latestVersion,
                                updateAvailable,
                                releaseUrl: release.html_url
                            });
                        } catch (error) {
                            logger.error('Error parsing GitHub release data:', error);
                            resolve({
                                currentVersion,
                                latestVersion: null,
                                updateAvailable: false,
                                error: 'Failed to check for updates'
                            });
                        }
                    });
                });

                req.on('error', (error) => {
                    logger.error('Error checking for updates:', error);
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
        } catch (error) {
            logger.error('Error checking for updates:', error);
            const packageJson = require('../../../package.json');
            return {
                currentVersion: packageJson.version,
                latestVersion: null,
                updateAvailable: false,
                error: error.message
            };
        }
    });

    ipcMain.on('set-theme', (event, theme) => {
        handleThemeChange(theme, mainWindow, nativeTheme, appConfigManager);
    });

    ipcMain.handle('get-http-remote-info', async () => {
        if (httpServer && typeof httpServer.getRemoteInfo === 'function') {
            return httpServer.getRemoteInfo();
        }
        return { enabled: false, port: 3000, interfaces: [] };
    });

    ipcMain.on('open-easter-egg-game', () => {
        if (openEasterEggGameFunc && typeof openEasterEggGameFunc === 'function') {
            logger.info("IPC_HANDLER: 'open-easter-egg-game' - Requesting to open game window.");
            openEasterEggGameFunc();
        } else {
            logger.error("IPC_HANDLER: 'open-easter-egg-game' - openEasterEggGameWindowCallback function not found or not a function.");
        }
    });
}

module.exports = {
    registerSystemHandlers,
    handleThemeChange
};

