const LogLevel = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    VERBOSE: 5
};

let currentLevel = LogLevel.INFO;

function setLogLevel(level) {
    if (typeof level === 'string') {
        level = LogLevel[level.toUpperCase()] || LogLevel.INFO;
    } else if (typeof level === 'number') {
        currentLevel = level;
    }
}

function formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const argsStr = args.length ? args.map(arg => {
        if (arg instanceof Error) {
            return arg.stack || arg.message;
        }
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg, null, 2);
            } catch (e) {
                return '[Circular/Unserializable Object]';
            }
        }
        return String(arg);
    }).join(' ') : '';
    return `[${timestamp}] [${level}] ${message} ${argsStr}`;
}

const logger = {
    error: (message, ...args) => {
        if (currentLevel >= LogLevel.ERROR) {
            console.error(formatMessage('ERROR', message, ...args));
        }
    },
    warn: (message, ...args) => {
        if (currentLevel >= LogLevel.WARN) {
            console.warn(formatMessage('WARN', message, ...args));
        }
    },
    info: (message, ...args) => {
        if (currentLevel >= LogLevel.INFO) {
            console.log(formatMessage('INFO', message, ...args));
        }
    },
    debug: (message, ...args) => {
        if (currentLevel >= LogLevel.DEBUG) {
            console.log(formatMessage('DEBUG', message, ...args));
        }
    },
    verbose: (message, ...args) => {
        if (currentLevel >= LogLevel.VERBOSE) {
            console.log(formatMessage('VERBOSE', message, ...args));
        }
    },
    LogLevel,
    setLogLevel
};

module.exports = logger;
