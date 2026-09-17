// audioPlaybackLogger.js
// Enhanced logging utility for audio playback management with performance optimization

// Enhanced logging utility for better performance and configurability
const LogLevel = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    VERBOSE: 5
};

// Configuration for logging levels - can be adjusted based on environment
let currentLogLevel = LogLevel.INFO; // Default to INFO level

// Set log level based on environment or configuration
function setLogLevel(level) {
    currentLogLevel = level;
    console.log(`AudioPlaybackManager: Log level set to ${Object.keys(LogLevel)[level]}`);
}

// Optimized logging functions that check level before processing
const log = {
    error: (...args) => {
        if (currentLogLevel >= LogLevel.ERROR) {
            console.error('🔴 AudioPlaybackManager:', ...args);
        }
    },
    warn: (...args) => {
        if (currentLogLevel >= LogLevel.WARN) {
            console.warn('🟡 AudioPlaybackManager:', ...args);
        }
    },
    info: (...args) => {
        if (currentLogLevel >= LogLevel.INFO) {
            console.log('🔵 AudioPlaybackManager:', ...args);
        }
    },
    debug: (...args) => {
        if (currentLogLevel >= LogLevel.DEBUG) {
            console.log('🟢 AudioPlaybackManager [DEBUG]:', ...args);
        }
    },
    verbose: (...args) => {
        if (currentLogLevel >= LogLevel.VERBOSE) {
            console.log('⚪ AudioPlaybackManager [VERBOSE]:', ...args);
        }
    }
};

// Initialize log level based on app configuration
function initializeLogging(appConfig) {
    if (appConfig && appConfig.logLevel !== undefined) {
        setLogLevel(appConfig.logLevel);
    } else if (appConfig && appConfig.isProduction) {
        setLogLevel(LogLevel.WARN); // Only warnings and errors in production
    } else {
        setLogLevel(LogLevel.INFO); // Default development level
    }
}

export {
    LogLevel,
    setLogLevel,
    log,
    initializeLogging
};

