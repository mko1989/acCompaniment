// src/renderer/ui/uiLogger.js
// Dedicated logger for UI components to reduce console noise and provide structure

const LogLevel = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    VERBOSE: 5
};

// Default to INFO, but this can be changed via setUILogLevel
let currentLogLevel = LogLevel.INFO;

export function setUILogLevel(level) {
    if (typeof level === 'string') {
        level = LogLevel[level.toUpperCase()] || LogLevel.INFO;
    }
    currentLogLevel = level;
}

export const uiLog = {
    error: (...args) => {
        if (currentLogLevel >= LogLevel.ERROR) {
            console.error('🔴 UI:', ...args);
        }
    },
    warn: (...args) => {
        if (currentLogLevel >= LogLevel.WARN) {
            console.warn('🟡 UI:', ...args);
        }
    },
    info: (...args) => {
        if (currentLogLevel >= LogLevel.INFO) {
            console.log('🔵 UI:', ...args);
        }
    },
    debug: (...args) => {
        if (currentLogLevel >= LogLevel.DEBUG) {
            console.log('🟢 UI [DEBUG]:', ...args);
        }
    },
    verbose: (...args) => {
        if (currentLogLevel >= LogLevel.VERBOSE) {
            console.log('⚪ UI [VERBOSE]:', ...args);
        }
    }
};

