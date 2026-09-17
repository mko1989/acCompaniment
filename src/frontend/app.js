/**
 * Main Application Entry Point for acCompaniment Browser Interface
 * 
 * This file now simply imports and uses renderer.js, which contains
 * the proper initialization flow matching the original Electron app structure.
 * 
 * The renderer.js module handles all initialization including:
 * - WebSocket connection setup
 * - AppConfigUI initialization
 * - Main UI module initialization
 * - CueStore initialization
 * - AudioController initialization
 * - DragDropHandler initialization
 * - Loading initial data
 */

// Import the renderer module which handles all initialization
import './renderer.js';

// The renderer.js module will handle all initialization when DOMContentLoaded fires
// No additional code needed here - renderer.js is the main entry point

console.log('app.js: Imported renderer.js - initialization will occur when DOM is ready');
