const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./utils/atomicWrite');

class AppConfigManager {
    constructor(pathManager) {
        this.pathManager = pathManager;
        this.configPath = path.join(pathManager.configDir, 'appConfig.json');
        this.config = null;
        this.changeListeners = [];
        
        this.DEFAULT_CONFIG = {
            // Audio settings
            audioOutputDeviceId: 'default',
            audioOutputChannelCount: 2,
            audioSampleRate: 48000,
            audioBufferSize: 512,
            defaultFadeInTime: 0,
            defaultFadeOutTime: 0,
            defaultLoopSingleCue: false,
            defaultRetriggerBehavior: 'restart',
            defaultStopAllBehavior: 'stop',
            defaultStopAllFadeOutTime: 1500,
            crossfadeTime: 2000,
            
            // UI settings
            theme: 'system',
            windowWidth: 1200,
            windowHeight: 800,
            windowX: null,
            windowY: null,
            
            // Server settings
            websocketEnabled: true,
            websocketPort: 8877,
            httpRemoteEnabled: true,
            httpRemotePort: 3333, // matches server.js's own default (process.env.PORT || 3333)
            
            // File management
            audioDirectory: pathManager.audioDir,
            cuesDirectory: pathManager.cuesDir,
            autoLoadLastWorkspace: true,
            lastOpenedWorkspacePath: '',
            
            // Workspace management
            recentWorkspaces: [],
            maxRecentWorkspaces: 5,
            
            // Advanced settings
            enableDebugLogging: false,
            maxAudioFileSize: 100 * 1024 * 1024, // 100MB
            supportedAudioFormats: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']
        };
    }
    
    async loadConfig() {
        try {
            if (await fs.pathExists(this.configPath)) {
                const rawData = await fs.readFile(this.configPath, 'utf-8');
                const parsedConfig = JSON.parse(rawData);
                
                // Merge with defaults to handle new config options
                this.config = {
                    ...this.DEFAULT_CONFIG,
                    ...parsedConfig
                };
                
                // Ensure recentWorkspaces is an array
                if (!Array.isArray(this.config.recentWorkspaces)) {
                    this.config.recentWorkspaces = [];
                }
                
                console.log(`⚙️  AppConfigManager: Loaded config from ${this.configPath}`);
            } else {
                this.config = { ...this.DEFAULT_CONFIG };
                await this.saveConfig();
                console.log(`⚙️  AppConfigManager: Created default config at ${this.configPath}`);
            }
            
            return this.config;
        } catch (error) {
            console.error(`❌ AppConfigManager: Error loading config: ${error.message}`);
            this.config = { ...this.DEFAULT_CONFIG };
            return this.config;
        }
    }
    
    async saveConfig() {
        try {
            if (!this.config) {
                console.warn('⚠️  AppConfigManager: No config to save');
                return false;
            }
            
            await fs.ensureDir(path.dirname(this.configPath));
            await writeJsonAtomic(this.configPath, this.config);
            
            // Notify listeners
            this.changeListeners.forEach(listener => {
                try {
                    listener(this.config);
                } catch (error) {
                    console.error('❌ AppConfigManager: Error in config change listener:', error);
                }
            });
            
            console.log(`💾 AppConfigManager: Config saved to ${this.configPath}`);
            return true;
        } catch (error) {
            console.error(`❌ AppConfigManager: Error saving config: ${error.message}`);
            return false;
        }
    }
    
    getConfig() {
        if (!this.config) {
            console.warn('⚠️  AppConfigManager: Config not loaded, returning defaults');
            return { ...this.DEFAULT_CONFIG };
        }
        return { ...this.config };
    }
    
    async updateConfig(updates) {
        try {
            if (!this.config) {
                await this.loadConfig();
            }

            const merged = { ...this.config, ...updates };
            const validation = this.validateConfig(merged);
            if (!validation.valid) {
                return {
                    success: false,
                    config: this.getConfig(),
                    error: validation.errors.join('; ')
                };
            }

            this.config = merged;
            
            const saved = await this.saveConfig();
            
            return {
                success: saved,
                config: this.getConfig(),
                error: saved ? null : 'Failed to save config'
            };
        } catch (error) {
            console.error(`❌ AppConfigManager: Error updating config: ${error.message}`);
            return {
                success: false,
                config: this.getConfig(),
                error: error.message
            };
        }
    }
    
    // Add a workspace to recent workspaces
    async addRecentWorkspace(workspacePath) {
        if (!workspacePath || typeof workspacePath !== 'string') {
            return false;
        }
        
        try {
            if (!this.config) {
                await this.loadConfig();
            }
            
            // Remove if already exists
            this.config.recentWorkspaces = this.config.recentWorkspaces.filter(
                path => path !== workspacePath
            );
            
            // Add to beginning
            this.config.recentWorkspaces.unshift(workspacePath);
            
            // Limit size
            if (this.config.recentWorkspaces.length > this.config.maxRecentWorkspaces) {
                this.config.recentWorkspaces = this.config.recentWorkspaces.slice(
                    0, this.config.maxRecentWorkspaces
                );
            }
            
            await this.saveConfig();
            console.log(`📁 AppConfigManager: Added recent workspace: ${workspacePath}`);
            return true;
        } catch (error) {
            console.error(`❌ AppConfigManager: Error adding recent workspace: ${error.message}`);
            return false;
        }
    }
    
    // Remove a workspace from recent workspaces
    async removeRecentWorkspace(workspacePath) {
        try {
            if (!this.config) {
                await this.loadConfig();
            }
            
            this.config.recentWorkspaces = this.config.recentWorkspaces.filter(
                path => path !== workspacePath
            );
            
            await this.saveConfig();
            console.log(`📁 AppConfigManager: Removed recent workspace: ${workspacePath}`);
            return true;
        } catch (error) {
            console.error(`❌ AppConfigManager: Error removing recent workspace: ${error.message}`);
            return false;
        }
    }
    
    // Add config change listener
    addChangeListener(listener) {
        if (typeof listener === 'function' && !this.changeListeners.includes(listener)) {
            this.changeListeners.push(listener);
        }
    }
    
    // Remove config change listener
    removeChangeListener(listener) {
        this.changeListeners = this.changeListeners.filter(l => l !== listener);
    }
    
    // Get config file path
    getConfigPath() {
        return this.configPath;
    }
    
    // Reset to defaults
    async resetToDefaults() {
        this.config = { ...this.DEFAULT_CONFIG };
        await this.saveConfig();
        console.log('🔄 AppConfigManager: Reset to defaults');
        return this.getConfig();
    }
    
    // Get network interfaces for remote access
    getNetworkInterfaces() {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        const addresses = [];
        
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    addresses.push({
                        name: name,
                        address: iface.address,
                        httpUrl: `http://${iface.address}:${this.config.httpRemotePort}`,
                        wsUrl: `ws://${iface.address}:${this.config.websocketPort}`
                    });
                }
            }
        }
        
        return addresses;
    }
    
    // Validate config values
    validateConfig(config) {
        const errors = [];
        
        // Validate ports
        if (config.websocketPort && (config.websocketPort < 1 || config.websocketPort > 65535)) {
            errors.push('WebSocket port must be between 1 and 65535');
        }
        
        if (config.httpRemotePort && (config.httpRemotePort < 1 || config.httpRemotePort > 65535)) {
            errors.push('HTTP remote port must be between 1 and 65535');
        }
        
        // Validate fade times
        if (config.defaultFadeInTime < 0) {
            errors.push('Default fade in time cannot be negative');
        }
        
        if (config.defaultFadeOutTime < 0) {
            errors.push('Default fade out time cannot be negative');
        }
        
        // Validate crossfade time
        if (config.crossfadeTime < 100 || config.crossfadeTime > 10000) {
            errors.push('Crossfade time must be between 100ms and 10000ms');
        }
        
        return {
            valid: errors.length === 0,
            errors: errors
        };
    }
}

module.exports = AppConfigManager;
