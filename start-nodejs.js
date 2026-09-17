#!/usr/bin/env node

/**
 * acCompaniment Node.js Backend Startup Script
 * 
 * This script starts the Node.js backend server for acCompaniment.
 * It can be run independently or launched from the Electron launcher.
 */

const AccompanimentServer = require('./server');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

args.forEach(arg => {
    if (arg.startsWith('--port=')) {
        options.port = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--host=')) {
        options.host = arg.split('=')[1];
    } else if (arg === '--dev') {
        options.dev = true;
    } else if (arg === '--help') {
        console.log(`
acCompaniment Node.js Backend

Usage: node start-nodejs.js [options]

Options:
  --port=PORT     Set the server port (default: 3333)
  --host=HOST     Set the server host (default: 0.0.0.0)
  --dev           Enable development mode
  --help          Show this help message

Examples:
  node start-nodejs.js
  node start-nodejs.js --port=8080
  node start-nodejs.js --dev --port=3001
        `);
        process.exit(0);
    }
});

// Set environment variables based on options
if (options.port) {
    process.env.PORT = options.port;
}

if (options.host) {
    process.env.HOST = options.host;
}

if (options.dev) {
    process.env.NODE_ENV = 'development';
    console.log('Development mode enabled');
}

// Start the server
console.log('Starting acCompaniment Node.js Backend...');
console.log(`Server will run on port ${process.env.PORT || 3333}`);
console.log(`HTTP Server: http://localhost:${process.env.PORT || 3333}`);
console.log(`WebSocket Server: ws://localhost:${process.env.PORT || 3333}`);
console.log(`Browser UI: http://localhost:${process.env.PORT || 3333}`);

const server = new AccompanimentServer();
global.server = server;

server.start().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
