/**
 * Disk cache for ffmpeg-decoded stereo Float32 PCM.
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { decodeToFloat32, DECODER_VERSION } = require('./audioDecoder');
const { writeJsonAtomic } = require('./utils/atomicWrite');

async function cacheKeyForFile(filePath) {
    const stat = await fs.stat(filePath);
    return crypto
        .createHash('sha256')
        .update(filePath)
        .update(String(stat.mtimeMs))
        .update(String(stat.size))
        .update(`decoder-${DECODER_VERSION}`)
        .digest('hex');
}

async function getCachedDecoded(filePath, pcmCacheDir, sampleRate) {
    const key = await cacheKeyForFile(filePath);
    const f32Path = path.join(pcmCacheDir, `${key}.f32`);
    const metaPath = path.join(pcmCacheDir, `${key}.json`);

    if (!await fs.pathExists(f32Path) || !await fs.pathExists(metaPath)) {
        return null;
    }

    const meta = await fs.readJson(metaPath);
    if (meta.sampleRate !== sampleRate) {
        return null;
    }

    const buf = await fs.readFile(f32Path);
    const sampleCount = Math.floor(buf.byteLength / 4);
    const floatBuffer = new Float32Array(sampleCount);
    floatBuffer.set(new Float32Array(buf.buffer, buf.byteOffset, sampleCount));

    return {
        floatBuffer,
        channels: meta.channels,
        sampleRate: meta.sampleRate,
        durationSec: meta.durationSec,
        cacheKey: key,
    };
}

async function storeDecodedCache(filePath, pcmCacheDir, sampleRate, decoded) {
    await fs.ensureDir(pcmCacheDir);
    const key = await cacheKeyForFile(filePath);
    const f32Path = path.join(pcmCacheDir, `${key}.f32`);
    const metaPath = path.join(pcmCacheDir, `${key}.json`);

    const body = Buffer.from(decoded.floatBuffer.buffer, decoded.floatBuffer.byteOffset, decoded.floatBuffer.byteLength);
    await fs.writeFile(f32Path, body);
    await writeJsonAtomic(metaPath, {
        sourcePath: filePath,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        durationSec: decoded.durationSec,
        frameCount: Math.floor(decoded.floatBuffer.length / decoded.channels),
        cachedAt: new Date().toISOString(),
    });

    return key;
}

async function warmPcmCache(filePath, pcmCacheDir, sampleRate = 48000) {
    const existing = await getCachedDecoded(filePath, pcmCacheDir, sampleRate);
    if (existing) {
        return existing;
    }

    const decoded = await decodeToFloat32(filePath, sampleRate);
    await storeDecodedCache(filePath, pcmCacheDir, sampleRate, decoded);
    return decoded;
}

module.exports = {
    cacheKeyForFile,
    getCachedDecoded,
    storeDecodedCache,
    warmPcmCache,
};
