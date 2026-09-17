const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, Notification } = require('electron');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs-extra');

const HEALTH_CHECK_PATH = '/api/remote/health';
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 2000;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate past 5MB

class AccompanimentLauncher {
    constructor() {
        this.tray = null;
        this.configWindow = null;
        this.nodeProcess = null;
        this.isNodeRunning = false;
        this.nodePort = 3333; // Default, matches server.js's own default; updated from config
        this.nodeHost = 'localhost'; // host the launcher itself uses to reach the server locally
        this.logFilePath = path.join(os.homedir(), '.accompaniment', 'logs', 'accompaniment-server.log');
        this.heartbeatTimer = null;
        this.restartAttempts = 0;
        this._deliberateStop = false;

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
            this.stopHeartbeat();
            this.stopNodeServer();
        });

        // Electron does NOT translate SIGTERM/SIGINT into a graceful
        // app.quit() by default - sent directly (e.g. `kill`, a session
        // logout, a process manager stopping the app), the process is just
        // terminated immediately, `before-quit` never fires, and the
        // spawned server child is left running as an orphan holding the
        // port open. Handle the signals explicitly and route them through
        // the same graceful quit path.
        let signalShutdownInProgress = false;
        const handleTerminationSignal = async (signal) => {
            if (signalShutdownInProgress) return;
            signalShutdownInProgress = true;
            console.log(`Electron Launcher: Received ${signal}, shutting down gracefully...`);
            this.stopHeartbeat();
            await this.stopNodeServer();
            app.quit();
            // Backstop in case something in app.quit()'s own shutdown path hangs
            setTimeout(() => process.exit(0), 5000);
        };
        process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'));
        process.on('SIGINT', () => handleTerminationSignal('SIGINT'));

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

    /**
     * Appends a line to the persistent server log file, rotating it once it
     * grows past LOG_MAX_BYTES so "Show Logs" doesn't open an unbounded file.
     */
    async _appendToLogFile(text) {
        try {
            await fs.ensureDir(path.dirname(this.logFilePath));
            try {
                const stat = await fs.stat(this.logFilePath);
                if (stat.size > LOG_MAX_BYTES) {
                    await fs.move(this.logFilePath, `${this.logFilePath}.old`, { overwrite: true });
                }
            } catch (_statErr) {
                // file doesn't exist yet - nothing to rotate
            }
            await fs.appendFile(this.logFilePath, text);
        } catch (error) {
            console.error('Electron Launcher: Failed to write server log file:', error.message);
        }
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
            this.startHeartbeat();
            return;
        }

        try {
            const serverPath = path.join(__dirname, '..', 'server.js');

            console.log(`Electron Launcher: Starting Node.js server: ${serverPath}`);
            this._deliberateStop = false;
            await this._appendToLogFile(`\n--- acCompaniment server starting ${new Date().toISOString()} (port ${this.nodePort}) ---\n`);

            // Run the server with Electron's own bundled Node runtime
            // (process.execPath + ELECTRON_RUN_AS_NODE) instead of shelling
            // out to a system-installed `node` binary. This matters for a
            // packaged, distributable app: end users won't necessarily have
            // Node.js installed, a plain `node` binary can't read files
            // inside this app's asar archive, and Electron's bundled Node
            // is the exact ABI electron-rebuild already targets for native
            // modules like @hamitzor/rtaudio.js.
            //
            // Deliberately no `cwd` option here: in a packaged build,
            // __dirname resolves to a path inside app.asar, and child_process
            // can't chdir() the OS process into a virtual archive path
            // (fails with ENOTDIR). server.js doesn't depend on cwd - it
            // resolves everything relative to __dirname or os.homedir() -
            // so it's safe to just inherit the launcher's own cwd.
            this.nodeProcess = spawn(process.execPath, [serverPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    PORT: this.nodePort
                    // Intentionally NOT setting HOST here: the server should
                    // keep binding to 0.0.0.0 for LAN access (Companion,
                    // remote control from other devices). `this.nodeHost`
                    // ('localhost') is only used by the launcher itself to
                    // reach the server on the same machine.
                }
            });

            this.nodeProcess.stdout.on('data', (data) => {
                const output = data.toString();
                console.log(`Node.js: ${output}`);
                this._appendToLogFile(output);
                this.handleNodeOutput(output);
            });

            this.nodeProcess.stderr.on('data', (data) => {
                const error = data.toString();
                console.error(`Node.js Error: ${error}`);
                this._appendToLogFile(`[stderr] ${error}`);
            });

            this.nodeProcess.on('close', (code) => {
                console.log(`Electron Launcher: Node.js process exited with code ${code}`);
                this._appendToLogFile(`--- acCompaniment server exited (code ${code}) ${new Date().toISOString()} ---\n`);
                this.isNodeRunning = false;
                this.nodeProcess = null;
                this.updateTrayMenu();
                this.stopHeartbeat();

                if (!this._deliberateStop) {
                    this._handleUnexpectedExit();
                }
            });

            this.nodeProcess.on('error', (error) => {
                console.error(`Electron Launcher: Failed to start Node.js: ${error.message}`);
                dialog.showErrorBox('Server Start Failed', `Failed to start Node.js server: ${error.message}`);
            });

            // Wait a moment for server to start, then check status
            setTimeout(async () => {
                const running = await this.checkServerStatus();
                if (running) {
                    console.log('Electron Launcher: Server started successfully');
                    this.restartAttempts = 0;
                    this.startHeartbeat();
                } else {
                    console.log('Electron Launcher: Server may still be starting...');
                    // Try again after another delay
                    setTimeout(async () => {
                        const running2 = await this.checkServerStatus();
                        if (running2) {
                            console.log('Electron Launcher: Server started successfully (delayed)');
                            this.restartAttempts = 0;
                        } else {
                            console.log('Electron Launcher: Server startup may have failed');
                        }
                        this.startHeartbeat();
                    }, 3000);
                }
            }, 4000);

        } catch (error) {
            console.error(`Electron Launcher: Error starting server: ${error.message}`);
            dialog.showErrorBox('Server Start Error', error.message);
        }
    }

    /**
     * Called when the server subprocess exits without us having asked it to
     * (stopNodeServer() wasn't the cause). Attempts a bounded number of
     * automatic restarts with backoff before giving up and alerting the
     * user - so a mid-show crash is a brief, self-healing blip instead of a
     * silent, permanent outage that only shows up as a stale tray label.
     */
    _handleUnexpectedExit() {
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            console.error(`Electron Launcher: Server crashed ${this.restartAttempts} times, giving up on auto-restart.`);
            this._notifyOrAlert(
                'acCompaniment server stopped unexpectedly',
                `The audio server crashed ${this.restartAttempts} times and could not be restarted automatically. Check the logs (tray menu -> Show Logs) and restart the app.`
            );
            return;
        }

        this.restartAttempts += 1;
        const delay = RESTART_BACKOFF_BASE_MS * this.restartAttempts;
        console.warn(`Electron Launcher: Server exited unexpectedly. Restart attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms.`);
        setTimeout(() => {
            this.startNodeServer();
        }, delay);
    }

    _notifyOrAlert(title, body) {
        if (Notification.isSupported()) {
            new Notification({ title, body }).show();
        } else {
            dialog.showErrorBox(title, body);
        }
    }

    /**
     * Polls the health endpoint periodically once the server is up, so a
     * hang (process alive but not responding) is caught even after the
     * initial startup checks stop running - not just a subprocess exit.
     */
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(async () => {
            const healthy = await this.checkServerStatus();
            if (!healthy && this.nodeProcess) {
                console.warn('Electron Launcher: Heartbeat check failed while process is still alive - server may be hung.');
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    async stopNodeServer() {
        if (!this.isNodeRunning || !this.nodeProcess) {
            console.log('Electron Launcher: Server not running');
            return;
        }

        this._deliberateStop = true;
        this.stopHeartbeat();

        try {
            console.log('Electron Launcher: Stopping Node.js server...');
            const pid = this.nodeProcess.pid;

            // Set up promise to wait for process to actually stop
            return new Promise((resolve) => {
                // SIGTERM asks server.js to clean up (flush the workspace,
                // release the audio device) and exit on its own. But a
                // graceful SIGTERM handler that gets stuck deep inside a
                // synchronous native call (observed in practice: RtAudio's
                // stopStream() can deadlock against its own audio I/O
                // thread) freezes the entire JS event loop - at that point
                // nothing in that process, including its own shutdown
                // timeout, can run. The only way out is from outside the
                // process: escalate to SIGKILL so a stuck child never
                // lingers holding the port and audio device forever.
                const killTimeout = setTimeout(() => {
                    console.warn(`Electron Launcher: Server did not exit within 5s of SIGTERM - force killing (pid ${pid})`);
                    try {
                        if (process.platform === 'win32') {
                            exec(`taskkill /pid ${pid} /T /F`);
                        } else {
                            process.kill(pid, 'SIGKILL');
                        }
                    } catch (killError) {
                        console.error(`Electron Launcher: Failed to force-kill server process: ${killError.message}`);
                    }
                }, 5000);

                // Backstop in case even SIGKILL somehow doesn't produce an
                // 'exit' event promptly (e.g. a zombie state) - don't let
                // the launcher's own shutdown/restart flow hang forever.
                const giveUpTimeout = setTimeout(() => {
                    console.error('Electron Launcher: Server process did not exit even after SIGKILL - giving up waiting.');
                    this.isNodeRunning = false;
                    this.nodeProcess = null;
                    this.updateTrayMenu();
                    resolve();
                }, 10000);

                this.nodeProcess.on('exit', () => {
                    clearTimeout(killTimeout);
                    clearTimeout(giveUpTimeout);
                    console.log('Electron Launcher: Node.js server stopped');
                    this.isNodeRunning = false;
                    this.nodeProcess = null;
                    this.updateTrayMenu();
                    resolve();
                });

                if (process.platform === 'win32') {
                    // Windows: Use taskkill
                    exec(`taskkill /pid ${pid} /T /F`, (error) => {
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
            const options = {
                hostname: this.nodeHost,
                port: this.nodePort,
                path: HEALTH_CHECK_PATH,
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

    async showLogs() {
        try {
            await fs.ensureDir(path.dirname(this.logFilePath));
            if (!(await fs.pathExists(this.logFilePath))) {
                await fs.writeFile(this.logFilePath, `acCompaniment server log - created ${new Date().toISOString()}\n`);
            }
            shell.showItemInFolder(this.logFilePath);
            console.log(`Electron Launcher: Revealed log file: ${this.logFilePath}`);
        } catch (error) {
            dialog.showErrorBox('Could Not Open Logs', error.message);
        }
    }

    openDataDirectory() {
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
                this.restartAttempts = 0;
                await this.startNodeServer();
                return { success: true };
            } catch (error) {
                console.error('Error starting server:', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('stop-server', async () => {
            try {
                await this.stopNodeServer();
                return { success: true };
            } catch (error) {
                console.error('Error stopping server:', error);
                return { success: false, error: error.message };
            }
        });


        ipcMain.handle('update-config', async (event, configData) => {
            try {
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
                            this.restartAttempts = 0;
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
            return path.join(os.homedir(), '.accompaniment');
        });


        ipcMain.handle('get-config', async () => {
            try {
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
