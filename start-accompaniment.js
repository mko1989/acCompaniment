#!/usr/bin/env node

/**
 * acCompaniment Startup Script
 * 
 * This script provides options to start either:
 * 1. Node.js backend only
 * 2. Electron launcher only  
 * 3. Both (recommended)
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class AccompanimentStarter {
    constructor() {
        this.nodeProcess = null;
        this.electronProcess = null;
        this.mode = 'both'; // 'node', 'electron', 'both'
        
        this.parseArguments();
    }
    
    parseArguments() {
        const args = process.argv.slice(2);
        
        args.forEach(arg => {
            if (arg === '--node-only') {
                this.mode = 'node';
            } else if (arg === '--electron-only') {
                this.mode = 'electron';
            } else if (arg === '--both' || arg === '--full') {
                this.mode = 'both';
            } else if (arg === '--help') {
                this.showHelp();
                process.exit(0);
            }
        });
    }
    
    showHelp() {
        console.log(`
acCompaniment Startup Script

Usage: node start-accompaniment.js [options]

Options:
  --node-only      Start only the Node.js backend server
  --electron-only  Start only the Electron launcher
  --both, --full   Start both Node.js backend and Electron launcher (default)
  --help           Show this help message

Examples:
  node start-accompaniment.js                    # Start both (recommended)
  node start-accompaniment.js --node-only        # Backend only
  node start-accompaniment.js --electron-only    # Launcher only
  node start-accompaniment.js --full             # Both (explicit)

The recommended approach is to use --both (default) which provides:
- Node.js backend server for audio processing and API
- Electron launcher for system tray integration
- Browser-based UI accessible at http://localhost:3000
        `);
    }
    
    async start() {
        console.log('🚀 Starting acCompaniment...');
        console.log(`📋 Mode: ${this.mode}`);
        
        try {
            switch (this.mode) {
                case 'node':
                    await this.startNodeOnly();
                    break;
                case 'electron':
                    await this.startElectronOnly();
                    break;
                case 'both':
                default:
                    await this.startBoth();
                    break;
            }
        } catch (error) {
            console.error('❌ Failed to start acCompaniment:', error.message);
            process.exit(1);
        }
    }
    
    async startNodeOnly() {
        console.log('🌐 Starting Node.js backend only...');
        
        this.nodeProcess = this.spawnNodeServer();
        
        this.nodeProcess.on('close', (code) => {
            console.log(`🔧 Node.js server exited with code ${code}`);
            process.exit(code);
        });
        
        this.nodeProcess.on('error', (error) => {
            console.error('❌ Failed to start Node.js server:', error.message);
            process.exit(1);
        });
        
        // Wait for server to start
        await this.waitForServer();
        
        console.log('✅ Node.js backend is running');
        console.log('🌐 Browser UI: http://localhost:3000');
        console.log('🔌 WebSocket: ws://localhost:3000');
        console.log('📡 API: http://localhost:3000/api');
        
        this.setupGracefulShutdown();
    }
    
    async startElectronOnly() {
        console.log('🔧 Starting Electron launcher only...');
        console.log('⚠️  Note: This will start the Electron launcher which will manage the Node.js backend');
        
        this.electronProcess = this.spawnElectronLauncher();
        
        this.electronProcess.on('close', (code) => {
            console.log(`🔧 Electron launcher exited with code ${code}`);
            process.exit(code);
        });
        
        this.electronProcess.on('error', (error) => {
            console.error('❌ Failed to start Electron launcher:', error.message);
            process.exit(1);
        });
        
        this.setupGracefulShutdown();
    }
    
    async startBoth() {
        console.log('🚀 Starting Electron launcher...');
        console.log('📋 Note: Electron launcher will manage the Node.js server');
        
        // Start only Electron launcher - it will manage the Node.js server
        this.electronProcess = this.spawnElectronLauncher();
        
        this.electronProcess.on('error', (error) => {
            console.error('❌ Failed to start Electron launcher:', error.message);
            process.exit(1);
        });
        
        console.log('✅ Electron launcher is running');
        console.log('🎯 System tray icon should appear');
        console.log('🌐 Browser UI: http://localhost:3000 (will be available once server starts)');
        console.log('💡 Use the system tray icon to start/stop the server');
        console.log('💡 Or right-click the tray icon and select "Start Server"');
        
        this.setupGracefulShutdown();
    }
    
    spawnNodeServer() {
        const serverPath = path.join(__dirname, 'start-nodejs.js');
        
        console.log(`🌐 Starting Node.js server: ${serverPath}`);
        
        return spawn('node', [serverPath], {
            cwd: __dirname,
            stdio: 'inherit'
        });
    }
    
    spawnElectronLauncher() {
        const launcherPath = path.join(__dirname, 'electron-launcher');
        
        console.log(`🔧 Starting Electron launcher: ${launcherPath}`);
        
        return spawn('npx', ['electron', '.'], {
            cwd: launcherPath,
            stdio: 'inherit'
        });
    }
    
    async waitForServer(timeout = 10000) {
        const http = require('http');
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkServer = () => {
                const req = http.request({
                    hostname: 'localhost',
                    port: 3000,
                    path: '/api/remote/health',
                    method: 'GET',
                    timeout: 2000
                }, (res) => {
                    if (res.statusCode === 200) {
                        resolve();
                    } else {
                        if (Date.now() - startTime > timeout) {
                            reject(new Error('Server health check timeout'));
                        } else {
                            setTimeout(checkServer, 1000);
                        }
                    }
                });
                
                req.on('error', () => {
                    if (Date.now() - startTime > timeout) {
                        reject(new Error('Server startup timeout'));
                    } else {
                        setTimeout(checkServer, 1000);
                    }
                });
                
                req.on('timeout', () => {
                    req.destroy();
                    if (Date.now() - startTime > timeout) {
                        reject(new Error('Server startup timeout'));
                    } else {
                        setTimeout(checkServer, 1000);
                    }
                });
                
                req.end();
            };
            
            // Start checking after a short delay
            setTimeout(checkServer, 2000);
        });
    }
    
    setupGracefulShutdown() {
        const shutdown = () => {
            console.log('\n🛑 Shutting down acCompaniment...');
            
            if (this.electronProcess) {
                console.log('🔧 Stopping Electron launcher...');
                this.electronProcess.kill('SIGTERM');
            }
            
            if (this.nodeProcess) {
                console.log('🌐 Stopping Node.js server...');
                this.nodeProcess.kill('SIGTERM');
            }
            
            // Force exit after 5 seconds
            setTimeout(() => {
                console.log('💥 Force exit');
                process.exit(0);
            }, 5000);
        };
        
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }
}

// Start the application
const starter = new AccompanimentStarter();
starter.start().catch(error => {
    console.error('💥 Startup failed:', error);
    process.exit(1);
});
