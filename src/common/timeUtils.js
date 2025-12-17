(function(exports) {
    /**
     * Formats time in seconds to MM:SS string.
     * Uses Math.floor to ensure 1:59.9 displays as 1:59.
     * @param {number} totalSeconds
     * @returns {string} Formatted time string
     */
    exports.formatTimeMMSS = function(totalSeconds) {
        if (typeof totalSeconds !== 'number' || isNaN(totalSeconds) || !isFinite(totalSeconds) || totalSeconds < 0) {
            return '00:00';
        }
        
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    };

    /**
     * Calculates the effective trimmed duration of a single file cue in seconds.
     * For playlist cues, it returns the knownDuration (sum of items) without applying trim (as trim is per-item usually).
     * @param {object} cue - The cue object.
     * @returns {number} The effective duration in seconds.
     */
    exports.calculateEffectiveTrimmedDurationSec = function(cue) {
        if (!cue || typeof cue.knownDuration !== 'number' || cue.knownDuration < 0) {
            return 0;
        }
        
        if (cue.type === 'playlist') {
            return cue.knownDuration;
        }

        let effectiveDuration = cue.knownDuration;
        const trimStartTime = cue.trimStartTime || 0;
        const trimEndTime = cue.trimEndTime;

        if (trimStartTime > 0) {
            effectiveDuration = Math.max(0, cue.knownDuration - trimStartTime);
            
            if (trimEndTime && typeof trimEndTime === 'number' && trimEndTime > trimStartTime) {
                const actualEndTime = Math.min(trimEndTime, cue.knownDuration);
                effectiveDuration = Math.max(0, actualEndTime - trimStartTime);
            }
        } else if (trimEndTime && typeof trimEndTime === 'number' && trimEndTime > 0 && trimEndTime < cue.knownDuration) {
            effectiveDuration = Math.min(cue.knownDuration, trimEndTime);
        }
        
        return Math.max(0, effectiveDuration);
    };

})(typeof module !== 'undefined' && module.exports ? module.exports : (this.timeUtils = {}));

