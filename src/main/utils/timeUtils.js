/**
 * Formats time in seconds to MM:SS string.
 * @param {number} totalSeconds
 * @returns {string} Formatted time string
 */
function formatTimeMMSS(totalSeconds) {
    // More robust input validation
    if (typeof totalSeconds !== 'number' || isNaN(totalSeconds) || !isFinite(totalSeconds) || totalSeconds < 0) {
        return '00:00';
    }
    
    // Use Math.round to handle floating point precision issues
    const totalSecondsRounded = Math.round(totalSeconds);
    const minutes = Math.floor(totalSecondsRounded / 60);
    const seconds = totalSecondsRounded % 60;
    
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Calculates the effective trimmed duration of a single file cue in seconds.
 * For playlist cues, it returns the original knownDuration as trimming is not applied at the playlist level itself by this function.
 * @param {object} cue - The cue object.
 * @returns {number} The effective duration in seconds after trimming for single cues, or knownDuration for playlists.
 */
function calculateEffectiveTrimmedDurationSec(cue) {
    if (!cue || typeof cue.knownDuration !== 'number' || cue.knownDuration < 0) {
        return 0;
    }
    // If it's a playlist cue, or a single cue with no valid knownDuration, return knownDuration or 0.
    // Trimming logic below is primarily for single_file cues.
    if (cue.type === 'playlist') {
        return cue.knownDuration; // For playlists, top-level duration is sum of items, not trimmed itself here.
    }

    let effectiveDuration = cue.knownDuration;
    const trimStartTime = cue.trimStartTime || 0;
    const trimEndTime = cue.trimEndTime; // Can be null/undefined

    // Apply trimming only if it's a single file cue with actual trim values
    if (trimStartTime > 0) {
        // Calculate duration after trimming from start
        effectiveDuration = Math.max(0, cue.knownDuration - trimStartTime);
        
        // If trimEndTime is specified, apply end trimming
        if (trimEndTime && typeof trimEndTime === 'number' && trimEndTime > trimStartTime) {
            // Calculate the actual end position in the original file
            const actualEndTime = Math.min(trimEndTime, cue.knownDuration);
            // Calculate the duration between start and end trim points
            effectiveDuration = Math.max(0, actualEndTime - trimStartTime);
        }
    } else if (trimEndTime && typeof trimEndTime === 'number' && trimEndTime > 0 && trimEndTime < cue.knownDuration) {
        // Only end trimming (no start trimming)
        effectiveDuration = Math.min(cue.knownDuration, trimEndTime);
    }
    
    return Math.max(0, effectiveDuration);
}

module.exports = {
    formatTimeMMSS,
    calculateEffectiveTrimmedDurationSec
}; 