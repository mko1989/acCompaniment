function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeOutputPatch(patch, maxChannels = 2) {
    const channels = Math.max(1, maxChannels || 2);
    const left = clamp(Number(Array.isArray(patch) ? patch[0] : 0) || 0, 0, channels - 1);
    const right = clamp(
        Number(Array.isArray(patch) ? (patch[1] ?? patch[0]) : 1) || left,
        0,
        channels - 1
    );
    return [left, right];
}

module.exports = {
    normalizeOutputPatch,
};
