/**
 * Formats time in seconds to MM:SS string.
 * @param {number} totalSeconds
 * @returns {string} Formatted time string
 */
function formatTimeMMSS(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) {
        return '00:00';
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
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
        effectiveDuration = Math.max(0, cue.knownDuration - trimStartTime);
        if (trimEndTime && trimEndTime > trimStartTime) {
            effectiveDuration = Math.min(effectiveDuration, trimEndTime - trimStartTime);
        }
    } else if (trimEndTime && trimEndTime > 0 && trimEndTime < cue.knownDuration) {
        effectiveDuration = Math.min(cue.knownDuration, trimEndTime);
    }
    
    return Math.max(0, effectiveDuration);
}

module.exports = {
    formatTimeMMSS,
    calculateEffectiveTrimmedDurationSec
}; 