/**
 * Decode audio files to interleaved stereo Float32 PCM via ffmpeg.
 * Used by AudioPlaybackManager until ENG4 pre-decode-on-import lands.
 */

const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

function bufferToFloat32(chunks) {
    const buf = Buffer.concat(chunks);
    const sampleCount = Math.floor(buf.byteLength / 4);
    const floatBuffer = new Float32Array(sampleCount);
    floatBuffer.set(new Float32Array(buf.buffer, buf.byteOffset, sampleCount));
    return floatBuffer;
}

/**
 * @param {string} filePath
 * @param {number} sampleRate
 * @returns {Promise<{ floatBuffer: Float32Array, channels: number, sampleRate: number, durationSec: number }>}
 */
async function decodeToFloat32(filePath, sampleRate = 48000) {
    if (!await fs.pathExists(filePath)) {
        throw new Error(`Audio file not found: ${filePath}`);
    }

    return new Promise((resolve, reject) => {
        const chunks = [];

        ffmpeg(filePath)
            .outputFormat('f32le')
            .audioChannels(2)
            .audioFrequency(sampleRate)
            .on('error', (err) => {
                reject(new Error(`ffmpeg decode failed for ${path.basename(filePath)}: ${err.message}`));
            })
            .pipe()
            .on('data', (chunk) => chunks.push(chunk))
            .on('end', () => {
                if (chunks.length === 0) {
                    reject(new Error(`ffmpeg produced no audio data for ${path.basename(filePath)}`));
                    return;
                }

                const floatBuffer = bufferToFloat32(chunks);
                const channels = 2;
                const frameCount = Math.floor(floatBuffer.length / channels);
                resolve({
                    floatBuffer,
                    channels,
                    sampleRate,
                    durationSec: frameCount / sampleRate,
                });
            });
    });
}

module.exports = {
    decodeToFloat32,
};
