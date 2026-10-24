const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, Notification } = require('electron');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, exec, execFile } = require('child_process');
const fs = require('fs-extra');

// Used only to learn when a freshly started server is ready (and whether one
// is already running on the port). There is deliberately no periodic
// heartbeat: a crash is caught the instant the server process exits, and the
// old every-20s check only logged "healthy" forever and relabelled the tray
// after a minute of a frozen server - it never restarted anything.
const HEALTH_CHECK_PATH = '/api/remote/health';
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 2000;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate past 5MB

// How long to keep polling for readiness before giving up on a freshly
// spawned server. The very first launch on a machine (or after any update
// to the native @hamitzor/rtaudio.js addon) can be substantially slower than
// every subsequent one - constructing RtAudio synchronously enumerates
// audio devices via CoreAudio/WASAPI/ALSA, and on macOS specifically the
// very first execution of a freshly-extracted native binary can be held up
// for tens of seconds by Gatekeeper's one-time verification scan (cached
// after that, which is exactly why a second launch right afterward is
// instant). A short, fixed 7s check window mistook that one-time slowness
// for a crash. Poll generously instead of declaring failure early - but
// often: a normal start is healthy in ~1.5s, and a 3s interval kept "Open
// Browser UI" disabled for up to 3s longer than the server needed.
const STARTUP_POLL_INTERVAL_MS = 500;
const STARTUP_POLL_TIMEOUT_MS = 60000;

class AccompanimentLauncher {
    constructor() {
        this.tray = null;
        this.configWindow = null;
        this.nodeProcess = null;
        this.isNodeRunning = false;
        this.isStarting = false;
        this.nodePort = 3333; // Default, matches server.js's own default; updated from config
        this.nodeHost = 'localhost'; // host the launcher itself uses to reach the server locally
        // Same data directory the server uses (server.js honours the same
        // variable) - config, log and "Open Data Directory" all live here.
        this.dataDir = process.env.ACCOMPANIMENT_DATA_DIR || path.join(os.homedir(), '.accompaniment');
        this.configPath = path.join(this.dataDir, 'config', 'appConfig.json');
        this.logFilePath = path.join(this.dataDir, 'logs', 'accompaniment-server.log');
        this.restartAttempts = 0;
        this._deliberateStop = false;
        this._portConflictDetected = false;

        this.setupApp();
    }

    setupApp() {
        // Suppress security warnings
        process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

        // Handle app ready
        app.whenReady().then(async () => {
            // Without this the dock shows Electron's default icon (packaged
            // builds get build.mac.icon; running from source got nothing).
            if (process.platform === 'darwin' && app.dock) {
                this.dockIconPath = path.join(__dirname, 'assets', 'icon.png');
                app.dock.setIcon(this.dockIconPath);
            }
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
            await this.stopNodeServer();
            app.quit();
            // Backstop in case something in app.quit()'s own shutdown path hangs
            setTimeout(() => process.exit(0), 5000);
        };
        process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'));
        process.on('SIGINT', () => handleTerminationSignal('SIGINT'));

        // Last-resort synchronous safety net. Verified in practice: on
        // SIGTERM, Electron/Chromium's own internal shutdown can tear the
        // whole launcher process down faster than the async
        // stopNodeServer() escalation above gets a chance to run (its
        // SIGKILL timers never fire because the process holding them is
        // already gone) - confirmed by testing an actual packaged build,
        // not just dev mode. process.on('exit', ...) only allows
        // synchronous work, but is reliably called right before the
        // process actually terminates regardless of *why* it's exiting
        // (our own graceful path, a faster Electron-internal shutdown, an
        // uncaught exception), so it's the one place a kill signal is
        // guaranteed a chance to actually be sent.
        process.on('exit', () => {
            if (this.nodeProcess && this.nodeProcess.exitCode === null) {
                try {
                    this.nodeProcess.kill('SIGKILL');
                } catch (_error) {
                    // best-effort - the process may already be gone
                }
            }
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
                label: this.isNodeRunning
                    ? 'Server Running'
                    : (this.isStarting ? 'Server Starting…' : 'Server Stopped'),
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
            title: 'acCompaniment'
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

        // Check if server is already running on the port. Retried rather
        // than a single shot: a real, already-healthy server (e.g. left
        // over from a previous launcher instance that exited without
        // killing its child - see stopNodeServer()'s fix above) can still
        // fail one HTTP health check under transient load, and trusting
        // that single miss would send
        // this launcher off to spawn a *competing* second server, which can
        // only fail with EADDRINUSE against the real one, burn all of
        // MAX_RESTART_ATTEMPTS retrying that same doomed spawn, and give up
        // - while the perfectly healthy original instance sits there the
        // whole time, unreachable because this tray never adopted it.
        const isRunning = await this._probeServerRunning();
        if (isRunning) {
            console.log('Electron Launcher: Server already running on port, connecting to existing instance');
            this.isNodeRunning = true;
            this.updateTrayMenu();
            return;
        }

        try {
            const serverPath = SERVER_PATH;

            console.log(`Electron Launcher: Starting Node.js server: ${serverPath}`);
            this._deliberateStop = false;
            this.isStarting = true;
            this.updateTrayMenu();
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

            this._portConflictDetected = false;
            this.nodeProcess.stderr.on('data', (data) => {
                const error = data.toString();
                console.error(`Node.js Error: ${error}`);
                this._appendToLogFile(`[stderr] ${error}`);
                if (error.includes('EADDRINUSE')) {
                    this._portConflictDetected = true;
                }
            });

            this.nodeProcess.on('close', (code) => {
                console.log(`Electron Launcher: Node.js process exited with code ${code}`);
                this._appendToLogFile(`--- acCompaniment server exited (code ${code}) ${new Date().toISOString()} ---\n`);
                this.isNodeRunning = false;
                this.isStarting = false;
                this.nodeProcess = null;
                this.updateTrayMenu();

                if (!this._deliberateStop) {
                    if (this._portConflictDetected) {
                        this._handlePortConflictExit();
                    } else {
                        this._handleUnexpectedExit();
                    }
                }
            });

            this.nodeProcess.on('error', (error) => {
                console.error(`Electron Launcher: Failed to start Node.js: ${error.message}`);
                this.isStarting = false;
                this.updateTrayMenu();
                dialog.showErrorBox('Server Start Failed', `Failed to start Node.js server: ${error.message}`);
            });

            this._pollForStartup();

        } catch (error) {
            console.error(`Electron Launcher: Error starting server: ${error.message}`);
            this.isStarting = false;
            this.updateTrayMenu();
            dialog.showErrorBox('Server Start Error', error.message);
        }
    }

    /**
     * Polls the health endpoint until the freshly spawned server answers, up
     * to STARTUP_POLL_TIMEOUT_MS. Replaces a previous fixed 4s+3s check,
     * which mistook a slow-but-legitimate first boot (see the constant's
     * comment above) for a failure, leaving the tray stuck on "Server
     * Stopped" - misleading during a run that would have succeeded seconds
     * later if just given the time.
     */
    _pollForStartup(elapsedMs = 0) {
        setTimeout(async () => {
            // The process may have exited (and already handled its own
            // cleanup via the 'close' listener) while this poll was
            // in flight - nothing left to check.
            if (!this.nodeProcess) {
                return;
            }

            const running = await this.checkServerStatus();
            if (running) {
                console.log('Electron Launcher: Server started successfully');
                this.isNodeRunning = true;
                this.isStarting = false;
                this.restartAttempts = 0;
                this.updateTrayMenu();
                return;
            }

            const nextElapsed = elapsedMs + STARTUP_POLL_INTERVAL_MS;
            if (nextElapsed >= STARTUP_POLL_TIMEOUT_MS) {
                console.error(`Electron Launcher: Server did not become healthy within ${STARTUP_POLL_TIMEOUT_MS}ms.`);
                this.isStarting = false;
                this.updateTrayMenu();
                this._notifyOrAlert(
                    'acCompaniment server is taking too long to start',
                    'The audio server hasn\'t responded after a minute. Check the logs (tray menu -> Show Logs) - it may still finish starting, or it may need a manual restart.'
                );
                return;
            }

            if (nextElapsed % 3000 === 0) {
                console.log('Electron Launcher: Server may still be starting...');
            }
            this._pollForStartup(nextElapsed);
        }, STARTUP_POLL_INTERVAL_MS);
    }

    /**
     * The child just died specifically from EADDRINUSE - something else is
     * definitely bound to this port right now, which a blind respawn-with-
     * backoff (_handleUnexpectedExit()'s normal path) cannot fix: it'll just
     * hit the same EADDRINUSE again as long as that occupant is still there,
     * burn all MAX_RESTART_ATTEMPTS, and give up. Most commonly that
     * occupant is an already-healthy acCompaniment server left over from a
     * previous launcher instance that exited without killing its child (see
     * stopNodeServer()'s fix above) - in that case there's nothing to fix,
     * just adopt it instead of fighting it. If it isn't (something
     * unrelated is squatting the port), fall through to the normal
     * bounded-retry-then-alert path so the user still gets told.
     */
    async _handlePortConflictExit() {
        const alreadyRunning = await this._probeServerRunning();
        if (alreadyRunning) {
            console.log('Electron Launcher: Port is held by an already-healthy acCompaniment instance - adopting it instead of retrying a competing spawn.');
            this.isNodeRunning = true;
            this.isStarting = false;
            this.restartAttempts = 0;
            this.updateTrayMenu();
            return;
        }
        // Counted as a restart attempt, so a holder that won't die can't
        // turn this into an endless kill-and-respawn loop.
        if (this.restartAttempts < MAX_RESTART_ATTEMPTS && await this._killHungOwnServer()) {
            this.restartAttempts += 1;
            this.startNodeServer();
            return;
        }
        this._handleUnexpectedExit();
    }

    /**
     * The port is held but nothing healthy answers on it. If the holder is
     * our own server.js (an orphan from an earlier launcher that hung on its
     * way out - observed: deadlocked joining the audio engine's worker
     * thread), it will never recover or let go of the port, so kill it.
     * Anything else holding the port is left alone. Resolves true if it
     * killed one. macOS/Linux only (needs lsof).
     */
    async _killHungOwnServer() {
        if (process.platform === 'win32') return false;
        const run = (cmd, args) => new Promise((resolve) => {
            execFile(cmd, args, { timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout));
        });
        const pids = (await run('lsof', ['-nP', `-iTCP:${this.nodePort}`, '-sTCP:LISTEN', '-t']))
            .split('\n').map((line) => Number(line.trim())).filter((pid) => pid > 0 && pid !== process.pid);
        let killed = false;
        for (const pid of pids) {
            const command = (await run('ps', ['-o', 'command=', '-p', String(pid)])).trim();
            if (!command.includes(SERVER_PATH)) continue;
            console.warn(`Electron Launcher: Port ${this.nodePort} is held by an unresponsive acCompaniment server (pid ${pid}) - killing it.`);
            this._appendToLogFile(`--- killed unresponsive orphaned server pid ${pid} holding port ${this.nodePort} ---\n`);
            try {
                process.kill(pid, 'SIGKILL');
                killed = true;
            } catch (error) {
                console.error(`Electron Launcher: Could not kill pid ${pid}: ${error.message}`);
            }
        }
        if (killed) {
            // The OS frees the port once the process is reaped.
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return killed;
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

    async stopNodeServer() {
        // Deliberately keyed on nodeProcess alone, not isNodeRunning: a
        // server that's still starting up (nodeProcess spawned, but the
        // health check hasn't passed yet - see STARTUP_POLL_TIMEOUT_MS
        // above) has isNodeRunning === false despite being a live process
        // that very much needs killing on quit. Guarding on isNodeRunning
        // here used to silently no-op in that window, leaving the child an
        // orphan holding the port and audio device.
        if (!this.nodeProcess) {
            console.log('Electron Launcher: Server not running');
            return;
        }

        this._deliberateStop = true;
        this.isStarting = false;

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

    /**
     * Retries checkServerStatus() a few times (short gap between attempts)
     * before concluding nothing is listening on the port. See the call site
     * in startNodeServer() for why a single check isn't trustworthy enough
     * here specifically.
     */
    async _probeServerRunning(attempts = 3, intervalMs = 750) {
        for (let i = 0; i < attempts; i++) {
            const result = await this._healthProbe();
            if (result === 'healthy') {
                return true;
            }
            // A refused connection means nothing is listening at all - the
            // retries exist for a busy server that's slow to answer, and
            // there is no such server here. Retrying anyway added ~1.5s to
            // every normal launch before the server was even spawned.
            if (result === 'refused') {
                return false;
            }
            if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }
        return false;
    }

    // A pure health probe - resolves true/false and never touches
    // isNodeRunning or the tray itself; callers own that state. Silent:
    // callers log outcomes ("started", "gave up") - logging every probe
    // filled the log with one line per check.
    async checkServerStatus() {
        return (await this._healthProbe()) === 'healthy';
    }

    // Resolves 'healthy', 'refused' (nothing listening on the port) or
    // 'failed' (anything else: bad status, timeout, other network error).
    _healthProbe() {
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
                    resolve('healthy');
                } else {
                    resolve('failed');
                }
                res.resume();
            });

            req.on('error', (error) => {
                resolve(error.code === 'ECONNREFUSED' ? 'refused' : 'failed');
            });

            req.on('timeout', () => {
                req.destroy();
                resolve('failed');
            });

            req.end();
        });
    }

    handleNodeOutput(output) {
        // Parse Node.js output for status updates
        if (output.includes('HTTP Server running at') || output.includes('All managers initialized successfully')) {
            this.isNodeRunning = true;
            this.isStarting = false;
            this.updateTrayMenu();
        } else if (output.includes('Server stopped') || output.includes('Failed to start') || output.includes('Server startup failed')) {
            this.isNodeRunning = false;
            this.isStarting = false;
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
        const dataDir = this.dataDir;

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
                const configPath = this.configPath;

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
            return this.dataDir;
        });


        ipcMain.handle('get-config', async () => {
            try {
                const configPath = this.configPath;

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
            const configPath = this.configPath;

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

// Create launcher instance. Exposed on `global` so the Electron tests
// (test/electron/, Playwright's Electron support evaluates code in this
// main process) can inspect and drive it without clicking the tray.
const launcher = new AccompanimentLauncher();
global.accompanimentLauncher = launcher;
