const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const os = require('os');

// Import our modules. CueManager pulls in AudioPlaybackManager, which loads
// the native @hamitzor/rtaudio.js addon at require() time - if that binary
// is missing or was built for the wrong ABI, this throws synchronously here,
// before any of the class-level error handling below even runs. Catch it
// and fail with a clear message instead of a raw native-addon stack trace.
let AudioFileManager, CueDataManager, PathManager, AppConfigManager, WebSocketManager, CueManager;
try {
    AudioFileManager = require('./src/backend/audioFileManager');
    CueDataManager = require('./src/backend/cueDataManager');
    PathManager = require('./src/backend/pathManager');
    AppConfigManager = require('./src/backend/appConfigManager');
    WebSocketManager = require('./src/backend/websocketManager');
    CueManager = require('./src/backend/cueManager');
} catch (error) {
    console.error('Failed to load server modules:', error.message);
    if (error.cause) {
        console.error('Caused by:', error.cause.message || error.cause);
    }
    process.exit(1);
}

class AccompanimentServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        
        // Configuration - will be set from config file
        this.port = process.env.PORT || 3333;
        this.host = process.env.HOST || '0.0.0.0';
        
        // Managers
        this.audioFileManager = null;
        this.cueDataManager = null;
        this.pathManager = null;
        this.appConfigManager = null;
        this.websocketManager = null;
        this.cueManager = null;
        
        // Data directory
        this.dataDir = process.env.ACCOMPANIMENT_DATA_DIR || path.join(os.homedir(), '.accompaniment');
        
        this.setupMiddleware();
        this.setupRoutes();
    }
    
    setupMiddleware() {
        // CORS for browser access - will be updated after config loads
        this.app.use(cors({
            origin: true, // Allow all origins for now
            credentials: true
        }));
        
        // JSON parsing
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

        // express.json()/urlencoded() only populate req.body when the
        // request actually has a matching Content-Type; a POST with no
        // body at all (a very normal thing for an action endpoint like
        // "stop" or "stop all") leaves req.body === undefined. Many route
        // handlers destructure fields straight off req.body
        // (`const { fadeOut } = req.body`) with no fallback, which throws
        // and 500s in exactly that case. Guarantee req.body is always at
        // least {} so every route can destructure safely.
        this.app.use((req, res, next) => {
            if (req.body === undefined) {
                req.body = {};
            }
            next();
        });

        // Static files for browser UI
        this.app.use(express.static(path.join(__dirname, 'src', 'frontend')));
        
        // Serve main UI
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'src', 'frontend', 'index.html'));
        });

        // Dedicated HTTP remote control page (simplified cue grid for
        // triggering from a phone/tablet on the LAN)
        this.app.get('/remote', (req, res) => {
            res.sendFile(path.join(__dirname, 'src', 'frontend', 'remote_control', 'remote.html'));
        });
    }
    
    setupRoutes() {
        // API Routes
        // Health check endpoint
        this.app.get('/api/remote/health', (req, res) => {
            res.json({ status: 'ok', timestamp: new Date().toISOString() });
        });
        
        this.app.use('/api/config', require('./src/backend/routes/config'));
        this.app.use('/api/cues', require('./src/backend/routes/cues'));
        this.app.use('/api/audio', require('./src/backend/routes/audio'));
        this.app.use('/api/workspaces', require('./src/backend/routes/workspaces'));
        this.app.use('/api/remote', require('./src/backend/routes/remote'));
    }
    
    async initialize() {
        try {
            console.log('Initializing acCompaniment Node.js Server...');
            
            // Ensure data directory exists
            await require('fs-extra').ensureDir(this.dataDir);
            console.log(`Data directory: ${this.dataDir}`);
            
            // Initialize managers
            this.pathManager = new PathManager(this.dataDir);
            this.appConfigManager = new AppConfigManager(this.pathManager);
            this.audioFileManager = new AudioFileManager(this.pathManager);
            this.cueDataManager = new CueDataManager(this.pathManager);
            this.websocketManager = new WebSocketManager(this.wss);
            this.cueManager = new CueManager(
                this.audioFileManager,
                this.cueDataManager,
                this.websocketManager
            );
            
            // Load configuration
            await this.appConfigManager.loadConfig();
            console.log('Configuration loaded');

            const config = this.appConfigManager.getConfig();
            if (config.maxAudioFileSize) {
                this.audioFileManager.setMaxFileSize(config.maxAudioFileSize);
            }

            this.cueManager.setConfig(config);

            if (config.audioSampleRate) {
                this.audioFileManager.setPcmSampleRate(config.audioSampleRate);
            }
            
            // Update port from the saved app config - but never override an
            // explicit PORT env var. Without this guard, a fresh data
            // directory (no config file yet) gets one auto-created with the
            // default httpRemotePort, which would then silently clobber
            // whatever port the caller explicitly asked for via PORT=.
            // (The Electron launcher already resolves the config port
            // itself before spawning and passes it via PORT, so this
            // doesn't change that path's behavior.)
            if (!process.env.PORT && config.httpRemotePort && config.httpRemotePort !== this.port) {
                this.port = config.httpRemotePort;
                console.log(`Port updated from config: ${this.port}`);
            }
            
            // Initialize cue manager
            await this.cueManager.initialize();
            console.log('Cue manager initialized');
            
            // Set up WebSocket manager
            this.websocketManager.setCueManager(this.cueManager);
            this.websocketManager.setAppConfigManager(this.appConfigManager);
            this.websocketManager.setAudioFileManager(this.audioFileManager);
            console.log('WebSocket manager ready');
            
            // Make managers available to routes
            this.app.locals.managers = {
                audioFileManager: this.audioFileManager,
                cueDataManager: this.cueDataManager,
                pathManager: this.pathManager,
                appConfigManager: this.appConfigManager,
                websocketManager: this.websocketManager,
                cueManager: this.cueManager
            };
            
            console.log('All managers initialized successfully');
            
        } catch (error) {
            console.error('Failed to initialize server:', error);
            throw error;
        }
    }
    
    async start() {
        try {
            await this.initialize();

            // Surface a clear message for listen()-time failures (most
            // commonly EADDRINUSE) instead of letting them become an
            // unhandled 'error' event on the http.Server, which crashes the
            // process with a raw stack trace and no actionable guidance.
            this.server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    console.error(`Failed to start server: port ${this.port} is already in use.`);
                    console.error('Another instance of acCompaniment (or something else) is likely already running. ' +
                        'Stop it, or set a different port via the PORT environment variable / app config.');
                } else {
                    console.error('Failed to start server:', error.message || error);
                }
                process.exit(1);
            });

            // Start the server on the configured port
            this.server.listen(this.port, this.host, () => {
        console.log(`HTTP Server running at http://${this.host}:${this.port}`);
        console.log(`WebSocket Server running at ws://${this.host}:${this.port}`);
        console.log(`Browser UI: http://localhost:${this.port}`);

                // Log network interfaces
                const interfaces = os.networkInterfaces();
                console.log('Network interfaces:');
                Object.keys(interfaces).forEach(name => {
                    interfaces[name].forEach(iface => {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            console.log(`   ${name}: http://${iface.address}:${this.port}`);
                        }
                    });
                });
            });

        } catch (error) {
            console.error('Failed to start server:', error);
            process.exit(1);
        }
    }
    
    async stop() {
        console.log('Stopping server...');
        
        // Set a timeout to force exit if cleanup takes too long
        const forceExitTimeout = setTimeout(() => {
            console.error('Server shutdown timeout - forcing exit');
            process.exit(1);
        }, 10000); // 10 second timeout
        
        try {
            if (this.cueManager) {
                await this.cueManager.cleanup();
            }
            
            if (this.server) {
                this.server.close(() => {
                    clearTimeout(forceExitTimeout);
                    console.log('Server stopped');
                    process.exit(0);
                });
            } else {
                clearTimeout(forceExitTimeout);
                process.exit(0);
            }
        } catch (error) {
            clearTimeout(forceExitTimeout);
            console.error('Error during server shutdown:', error);
            process.exit(1);
        }
    }
}

// Handle graceful shutdown - prevent multiple calls
let isShuttingDown = false;

async function handleFatalError(kind, error) {
    console.error(`Unhandled ${kind} - shutting down:`, error);
    if (isShuttingDown) {
        process.exit(1);
        return;
    }
    isShuttingDown = true;
    try {
        if (global.server) {
            // Best-effort: flush workspace state and release the audio
            // device before exiting, same as a normal SIGTERM shutdown.
            // If this itself throws or hangs, stop() has its own 10s
            // force-exit timeout as a backstop.
            await global.server.stop();
        } else {
            process.exit(1);
        }
    } catch (_cleanupError) {
        process.exit(1);
    }
}

// Without these, any stray exception anywhere in the app (including from
// the native audio render callback) crashes the process instantly with no
// cleanup and no save of in-progress workspace state. The Electron launcher
// (electron-launcher/main.js) auto-restarts the server on unexpected exit,
// so a crash here becomes a brief, logged, self-recovering blip rather than
// a silent, permanent outage.
process.on('uncaughtException', (error) => {
    handleFatalError('exception', error);
});

process.on('unhandledRejection', (reason) => {
    handleFatalError('promise rejection', reason);
});

process.on('SIGINT', async () => {
    if (isShuttingDown) {
        console.log('\nShutdown already in progress, forcing exit...');
        process.exit(1);
        return;
    }
    isShuttingDown = true;
    console.log('\nReceived SIGINT, shutting down gracefully...');
    if (global.server) {
        await global.server.stop();
    } else {
        process.exit(0);
    }
});

process.on('SIGTERM', async () => {
    if (isShuttingDown) {
        console.log('\nShutdown already in progress, forcing exit...');
        process.exit(1);
        return;
    }
    isShuttingDown = true;
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    if (global.server) {
        await global.server.stop();
    } else {
        process.exit(0);
    }
});

// Start server
if (require.main === module) {
    const server = new AccompanimentServer();
    global.server = server;
    server.start().catch(error => {
        console.error('Server startup failed:', error);
        process.exit(1);
    });
}

module.exports = AccompanimentServer;
