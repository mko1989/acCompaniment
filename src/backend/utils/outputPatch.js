function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// Channel 0 is a real channel, so a missing/invalid entry can't be detected
// with `|| fallback` - that turned a swapped patch like [1, 0] into [1, 1].
function channelOr(value, fallback) {
    const n = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeOutputPatch(patch, maxChannels = 2) {
    const channels = Math.max(1, maxChannels || 2);
    const rawLeft = Array.isArray(patch) ? patch[0] : 0;
    const rawRight = Array.isArray(patch) ? (patch[1] ?? patch[0]) : 1;
    const left = clamp(channelOr(rawLeft, 0), 0, channels - 1);
    const right = clamp(channelOr(rawRight, left), 0, channels - 1);
    return [left, right];
}

module.exports = {
    normalizeOutputPatch,
};
