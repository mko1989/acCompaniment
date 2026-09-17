#!/usr/bin/env node

/**
 * acCompaniment Electron Launcher Startup Script
 * 
 * This script starts the Electron launcher for acCompaniment.
 * The launcher provides system tray integration and manages the Node.js backend.
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting acCompaniment Electron Launcher...');

// Path to the Electron launcher
const launcherPath = path.join(__dirname, 'electron-launcher');

// Start Electron launcher
const electronProcess = spawn('npx', ['electron', '.'], {
    cwd: launcherPath,
    stdio: 'inherit'
});

electronProcess.on('close', (code) => {
    console.log(`🔧 Electron Launcher exited with code ${code}`);
    process.exit(code);
});

electronProcess.on('error', (error) => {
    console.error('❌ Failed to start Electron Launcher:', error.message);
    process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down Electron Launcher...');
    electronProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down Electron Launcher...');
    electronProcess.kill('SIGTERM');
});
