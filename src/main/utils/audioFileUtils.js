const fs = require('fs');
const logger = require('./logger');

/**
 * parses the audio file to get its duration.
 * Uses music-metadata.
 * @param {string} filePath 
 * @returns {Promise<number|null>} Duration in seconds or null on failure
 */
async function getAudioFileDuration(filePath) {
    let mm;
    try {
        mm = await import('music-metadata'); // Dynamic import
    } catch (e) {
        logger.error('audioFileUtils (getAudioFileDuration): Failed to dynamically import music-metadata:', e);
        return null;
    }

    try {
        if (!filePath) {
            logger.warn('audioFileUtils (getAudioFileDuration): filePath is null or undefined.');
            return null;
        }
        if (!fs.existsSync(filePath)) {
            logger.warn(`audioFileUtils (getAudioFileDuration): File not found at ${filePath}`);
            return null;
        }

        // Check file size to avoid processing very large files
        const stats = fs.statSync(filePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        if (fileSizeMB > 100) { // 100MB limit
            logger.warn(`audioFileUtils (getAudioFileDuration): File too large (${fileSizeMB.toFixed(2)}MB) for duration parsing: ${filePath}`);
            return null;
        }

        logger.info(`audioFileUtils (getAudioFileDuration): Attempting to parse file for duration: ${filePath} (${fileSizeMB.toFixed(2)}MB)`);
        const metadata = await mm.parseFile(filePath);

        if (!metadata || !metadata.format || typeof metadata.format.duration !== 'number') {
            logger.warn(`audioFileUtils (getAudioFileDuration): Invalid or missing duration in metadata for ${filePath}`);
            return null;
        }

        logger.info(`audioFileUtils (getAudioFileDuration): Successfully parsed metadata for ${filePath}, duration: ${metadata.format.duration}s`);
        return metadata.format.duration; // duration in seconds
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`audioFileUtils (getAudioFileDuration): Error getting duration for ${filePath}:`, errorMessage);

        // Provide more specific error information
        if (errorMessage.includes('ENOENT')) {
            logger.error(`audioFileUtils (getAudioFileDuration): File not found: ${filePath}`);
        } else if (errorMessage.includes('EACCES')) {
            logger.error(`audioFileUtils (getAudioFileDuration): Permission denied: ${filePath}`);
        } else if (errorMessage.includes('format')) {
            logger.error(`audioFileUtils (getAudioFileDuration): Unsupported audio format: ${filePath}`);
        }

        return null;
    }
}

module.exports = {
    getAudioFileDuration
};

