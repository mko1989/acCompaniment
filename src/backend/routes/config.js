const express = require('express');
const router = express.Router();

// appConfigManager replaces its config object on every update, so anything
// holding the old one (cueManager reads e.g. defaultStopAllFadeOutTime from
// it) must be handed the new one, and open UIs told about it - the same
// thing the WebSocket 'save-app-config' path does.
function propagateConfig(managers, config) {
    managers.cueManager?.setConfig(config);
    managers.websocketManager?.broadcastConfigUpdate(config);
}

// Get current configuration
router.get('/', async (req, res) => {
    try {
        const { appConfigManager } = req.app.locals.managers;
        const config = appConfigManager.getConfig();
        
        res.json({
            success: true,
            config: config
        });
    } catch (error) {
        console.error('❌ Config route error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update configuration
router.put('/', async (req, res) => {
    try {
        const { appConfigManager } = req.app.locals.managers;
        const updates = req.body;
        const current = appConfigManager.getConfig();
        const merged = { ...current, ...updates };

        const validation = appConfigManager.validateConfig(merged);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid configuration',
                details: validation.errors
            });
        }
        
        const result = await appConfigManager.updateConfig(updates);
        
        if (result.success) {
            propagateConfig(req.app.locals.managers, result.config);
            res.json({
                success: true,
                config: result.config
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('❌ Config update error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Reset configuration to defaults
router.post('/reset', async (req, res) => {
    try {
        const { appConfigManager } = req.app.locals.managers;
        const config = await appConfigManager.resetToDefaults();
        propagateConfig(req.app.locals.managers, config);
        
        res.json({
            success: true,
            config: config
        });
    } catch (error) {
        console.error('❌ Config reset error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get network interfaces
router.get('/network', async (req, res) => {
    try {
        const { appConfigManager } = req.app.locals.managers;
        const interfaces = appConfigManager.getNetworkInterfaces();
        
        res.json({
            success: true,
            interfaces: interfaces
        });
    } catch (error) {
        console.error('❌ Network interfaces error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get configuration file path
router.get('/path', async (req, res) => {
    try {
        const { appConfigManager } = req.app.locals.managers;
        const configPath = appConfigManager.getConfigPath();
        
        res.json({
            success: true,
            path: configPath
        });
    } catch (error) {
        console.error('❌ Config path error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
