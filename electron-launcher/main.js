const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs-extra');

class AccompanimentLauncher {
    constructor() {
        this.tray = null;
        this.configWindow = null;
        this.nodeProcess = null;
        this.isNodeRunning = false;
        this.nodePort = 3000; // Default, will be updated from config
        this.nodeHost = 'localhost';
        
        this.setupApp();
    }
    
    setupApp() {
        // Suppress security warnings
        process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
        
        // Handle app ready
        app.whenReady().then(async () => {
            this.createTray();
            this.setupIpcHandlers();
            // Auto-start server
            await this.startNodeServer();
            console.log('Electron Launcher: Ready. Server auto-started.');
        });
        
        // Handle app activation (macOS)
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.showConfigWindow();
            }
        });
        
        // Handle app window closed
        app.on('window-all-closed', () => {
            // Don't quit on macOS when all windows are closed
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });
        
        // Handle app quit
        app.on('before-quit', () => {
            this.stopNodeServer();
        });
        
        // Set app name
        if (process.platform === 'darwin') {
            app.setName('acCompaniment');
        }
    }
    
    createTray() {
        // Create tray icon - use the properly sized tray icon
        const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
        const fallbackIconPath = path.join(__dirname, 'assets', 'icon.png');
        
        // Use the proper tray icon if it exists, otherwise fallback
        let finalIconPath = iconPath;
        if (!fs.existsSync(iconPath)) {
            if (fs.existsSync(fallbackIconPath)) {
                finalIconPath = fallbackIconPath;
            } else {
                console.warn('No tray icon found, using default');
                return; // Skip tray creation if no icon available
            }
        }
        
        this.tray = new Tray(finalIconPath);
        
        // Set tooltip
        this.tray.setToolTip('acCompaniment Soundboard');
        
        // Create context menu
        this.updateTrayMenu();
        
        // Handle tray click
        this.tray.on('click', () => {
            this.showConfigWindow();
        });
        
        // Handle double click (Windows/Linux)
        this.tray.on('double-click', () => {
            this.openBrowserUI();
        });
        
        console.log('Electron Launcher: Tray created');
    }
    
    updateTrayMenu() {
        const menu = Menu.buildFromTemplate([
            {
                label: 'acCompaniment',
                enabled: false
            },
            { type: 'separator' },
            {
                label: this.isNodeRunning ? 'Server Running' : 'Server Stopped',
                enabled: false
            },
            {
                label: `Port: ${this.nodePort}`,
                enabled: false
            },
            { type: 'separator' },
            {
                label: 'Open Browser UI',
                click: () => this.openBrowserUI(),
                enabled: this.isNodeRunning
            },
            {
                label: 'Configuration',
                click: () => this.showConfigWindow()
            },
            { type: 'separator' },
            {
                label: 'Show Logs',
                click: () => this.showLogs()
            },
            {
                label: 'Open Data Directory',
                click: () => this.openDataDirectory()
            },
            { type: 'separator' },
            {
                label: 'About',
                click: () => this.showAbout()
            },
            {
                label: 'Quit',
                click: () => app.quit()
            }
        ]);
        
        this.tray.setContextMenu(menu);
    }
    
    showConfigWindow() {
        if (this.configWindow && !this.configWindow.isDestroyed()) {
            this.configWindow.focus();
            return;
        }
        
        this.configWindow = new BrowserWindow({
            width: 500,
            height: 600,
            resizable: false,
            show: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            icon: path.join(__dirname, 'assets', 'icon.png'),
            title: 'acCompaniment Configuration'
        });
        
        this.configWindow.loadFile(path.join(__dirname, 'config.html'));
        
        this.configWindow.once('ready-to-show', () => {
            this.configWindow.show();
        });
        
        this.configWindow.on('closed', () => {
            this.configWindow = null;
        });
        
        console.log('Electron Launcher: Configuration window opened');
    }
    
    openBrowserUI() {
        if (!this.isNodeRunning) {
            dialog.showErrorBox('Server Not Running', 'The Node.js server is not running. Please start it first.');
            return;
        }
        
        const url = `http://${this.nodeHost}:${this.nodePort}`;
        shell.openExternal(url);
        console.log(`Electron Launcher: Opened browser UI: ${url}`);
    }
    
    async startNodeServer() {
        if (this.isNodeRunning) {
            console.log('Electron Launcher: Server already running');
            return;
        }
        
        // Update port from config before starting
        await this.updatePortFromConfig();
        
        // Check if server is already running on the port
        const isRunning = await this.checkServerStatus();
        if (isRunning) {
            console.log('Electron Launcher: Server already running on port, connecting to existing instance');
            this.isNodeRunning = true;
            this.updateTrayMenu();
            return;
        }
        
        try {
            const serverPath = path.join(__dirname, '..', 'start-nodejs.js');
            
            console.log(`Electron Launcher: Starting Node.js server: ${serverPath}`);
            
            this.nodeProcess = spawn('node', [serverPath], {
                cwd: path.join(__dirname, '..'),
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    PORT: this.nodePort,
                    HOST: this.nodeHost
                }
            });
            
            this.nodeProcess.stdout.on('data', (data) => {
                const output = data.toString();
                console.log(`Node.js: ${output}`);
                this.handleNodeOutput(output);
            });
            
            this.nodeProcess.stderr.on('data', (data) => {
                const error = data.toString();
                console.error(`Node.js Error: ${error}`);
            });
            
            this.nodeProcess.on('close', (code) => {
                console.log(`Electron Launcher: Node.js process exited with code ${code}`);
                this.isNodeRunning = false;
                this.updateTrayMenu();
            });
            
            this.nodeProcess.on('error', (error) => {
                console.error(`Electron Launcher: Failed to start Node.js: ${error.message}`);
                dialog.showErrorBox('Server Start Failed', `Failed to start Node.js server: ${error.message}`);
            });
            
            // Wait a moment for server to start, then check status
            setTimeout(async () => {
                const isRunning = await this.checkServerStatus();
                if (isRunning) {
                    console.log('Electron Launcher: Server started successfully');
                } else {
                    console.log('Electron Launcher: Server may still be starting...');
                    // Try again after another delay
                    setTimeout(async () => {
                        const isRunning2 = await this.checkServerStatus();
                        if (isRunning2) {
                            console.log('Electron Launcher: Server started successfully (delayed)');
                        } else {
                            console.log('Electron Launcher: Server startup may have failed');
                        }
                    }, 3000);
                }
            }, 4000);
            
        } catch (error) {
            console.error(`Electron Launcher: Error starting server: ${error.message}`);
            dialog.showErrorBox('Server Start Error', error.message);
        }
    }
    
    async stopNodeServer() {
        if (!this.isNodeRunning || !this.nodeProcess) {
            console.log('Electron Launcher: Server not running');
            return;
        }
        
        try {
            console.log('Electron Launcher: Stopping Node.js server...');
            
            // Set up promise to wait for process to actually stop
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.log('Electron Launcher: Force stopping server after timeout');
                    this.isNodeRunning = false;
                    this.nodeProcess = null;
                    this.updateTrayMenu();
                    resolve();
                }, 5000);
                
                this.nodeProcess.on('exit', () => {
                    clearTimeout(timeout);
                    console.log('Electron Launcher: Node.js server stopped');
                    this.isNodeRunning = false;
                    this.nodeProcess = null;
                    this.updateTrayMenu();
                    resolve();
                });
                
                if (process.platform === 'win32') {
                    // Windows: Use taskkill
                    exec(`taskkill /pid ${this.nodeProcess.pid} /T /F`, (error) => {
                        if (error) {
                            console.error(`Error killing process: ${error.message}`);
                        }
                    });
                } else {
                    // Unix-like systems: Use SIGTERM
                    this.nodeProcess.kill('SIGTERM');
                }
            });
            
        } catch (error) {
            console.error(`Electron Launcher: Error stopping server: ${error.message}`);
            this.isNodeRunning = false;
            this.nodeProcess = null;
            this.updateTrayMenu();
        }
    }
    
    checkServerStatus() {
        return new Promise((resolve) => {
            const http = require('http');
            const options = {
                hostname: this.nodeHost,
                port: this.nodePort,
                path: '/api/remote/health',
                method: 'GET',
                timeout: 5000
            };
            
            const req = http.request(options, (res) => {
                if (res.statusCode === 200) {
                    this.isNodeRunning = true;
                    this.updateTrayMenu();
                    console.log(`Electron Launcher: Server is running and healthy on port ${this.nodePort}`);
                    resolve(true);
                } else {
                    this.isNodeRunning = false;
                    this.updateTrayMenu();
                    console.log(`Electron Launcher: Server health check failed with status: ${res.statusCode}`);
                    resolve(false);
                }
            });
            
            req.on('error', (error) => {
                this.isNodeRunning = false;
                this.updateTrayMenu();
                console.log(`Electron Launcher: Server health check failed: ${error.message}`);
                resolve(false);
            });
            
            req.on('timeout', () => {
                req.destroy();
                this.isNodeRunning = false;
                this.updateTrayMenu();
                console.log(`Electron Launcher: Server health check timed out on port ${this.nodePort}`);
                resolve(false);
            });
            
            req.end();
        });
    }
    
    handleNodeOutput(output) {
        // Parse Node.js output for status updates
        if (output.includes('HTTP Server running at') || output.includes('All managers initialized successfully')) {
            this.isNodeRunning = true;
            this.updateTrayMenu();
        } else if (output.includes('Server stopped') || output.includes('Failed to start') || output.includes('Server startup failed')) {
            this.isNodeRunning = false;
            this.updateTrayMenu();
        }
    }
    
    showLogs() {
        // Open a simple log viewer window
        const logWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            title: 'acCompaniment Logs'
        });
        
        logWindow.loadFile(path.join(__dirname, 'logs.html'));
        
        console.log('Electron Launcher: Logs window opened');
    }
    
    openDataDirectory() {
        const os = require('os');
        const dataDir = path.join(os.homedir(), '.accompaniment');
        
        if (fs.existsSync(dataDir)) {
            shell.openPath(dataDir);
        } else {
            dialog.showErrorBox('Directory Not Found', `Data directory not found: ${dataDir}`);
        }
        
        console.log(`Electron Launcher: Opened data directory: ${dataDir}`);
    }
    
    showAbout() {
        dialog.showMessageBox({
            type: 'info',
            title: 'About acCompaniment',
            message: 'acCompaniment Soundboard',
            detail: `Version: 0.3.0\nNode.js Backend with Electron Launcher\n\nA professional soundboard application for live performance and broadcasting.`,
            buttons: ['OK']
        });
    }
    
    setupIpcHandlers() {
        // Handle IPC messages from renderer
        
        ipcMain.handle('start-server', async () => {
            try {
                // Stop existing server if running
                if (this.isNodeRunning) {
                    await this.stopNodeServer();
                }
                await this.startNodeServer();
                return { success: true };
            } catch (error) {
                console.error('Error starting server:', error);
                return { success: false, error: error.message };
            }
        });
        
        ipcMain.handle('stop-server', async () => {
            try {
                this.stopNodeServer();
                return { success: true };
            } catch (error) {
                console.error('Error stopping server:', error);
                return { success: false, error: error.message };
            }
        });
        
        
        ipcMain.handle('update-config', async (event, configData) => {
            try {
                const os = require('os');
                const configPath = path.join(os.homedir(), '.accompaniment', 'config', 'appConfig.json');
                
                // Ensure config directory exists
                await fs.ensureDir(path.dirname(configPath));
                
                // Read existing config
                let config = {};
                if (await fs.pathExists(configPath)) {
                    const configContent = await fs.readFile(configPath, 'utf-8');
                    config = JSON.parse(configContent);
                }
                
                // Update config with new data
                Object.assign(config, configData);
                
                // Write updated config
                await fs.writeFile(configPath, JSON.stringify(config, null, 2));
                
                // Update local port if it changed
                if (configData.httpRemotePort && configData.httpRemotePort !== this.nodePort) {
                    const oldPort = this.nodePort;
                    this.nodePort = configData.httpRemotePort;
                    console.log(`Electron Launcher: Port updated from ${oldPort} to ${this.nodePort}`);
                    this.updateTrayMenu();
                    
                    // If server is running, restart it with new port
                    if (this.isNodeRunning) {
                        console.log('Electron Launcher: Restarting server with new port...');
                        await this.stopNodeServer();
                        // Wait for server to fully stop before starting
                        setTimeout(async () => {
                            console.log('Electron Launcher: Starting server on new port...');
                            await this.startNodeServer();
                        }, 3000);
                    }
                }
                
                return { success: true };
            } catch (error) {
                console.error('Error updating config:', error);
                return { success: false, error: error.message };
            }
        });
        
        ipcMain.handle('get-server-status', async () => {
            return {
                isRunning: this.isNodeRunning,
                port: this.nodePort,
                host: this.nodeHost
            };
        });
        
        ipcMain.handle('open-browser-ui', async () => {
            this.openBrowserUI();
            return { success: true };
        });
        
        ipcMain.handle('get-data-directory', async () => {
            const os = require('os');
            return path.join(os.homedir(), '.accompaniment');
        });
        
        
        ipcMain.handle('get-config', async () => {
            try {
                const os = require('os');
                const configPath = path.join(os.homedir(), '.accompaniment', 'config', 'appConfig.json');
                
                if (await fs.pathExists(configPath)) {
                    const configContent = await fs.readFile(configPath, 'utf-8');
                    return JSON.parse(configContent);
                }
                
                return {};
            } catch (error) {
                console.error('Error reading config:', error);
                return {};
            }
        });
        
        console.log('Electron Launcher: IPC handlers registered');
    }
    
    async updatePortFromConfig() {
        try {
            const os = require('os');
            const configPath = path.join(os.homedir(), '.accompaniment', 'config', 'appConfig.json');
            
            if (await fs.pathExists(configPath)) {
                const configData = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configData);
                
                if (config.httpRemotePort && config.httpRemotePort !== this.nodePort) {
                    this.nodePort = config.httpRemotePort;
                    console.log(`Electron Launcher: Port updated from config: ${this.nodePort}`);
                    this.updateTrayMenu();
                }
            }
        } catch (error) {
            console.warn('Electron Launcher: Could not read config for port:', error.message);
        }
    }
}

// Create launcher instance
const launcher = new AccompanimentLauncher();
