/**
 * Decode audio files to interleaved stereo Float32 PCM via ffmpeg.
 * Used by AudioPlaybackManager until ENG4 pre-decode-on-import lands.
 */

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

// Same lookup the fluent-ffmpeg package used (it's deprecated and no longer
// maintained, and only ever ran this one command for us): FFMPEG_PATH if
// set, otherwise `ffmpeg` on the PATH.
function ffmpegBinary() {
    return process.env.FFMPEG_PATH || 'ffmpeg';
}

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

    const name = path.basename(filePath);
    const channels = 2;
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', filePath,
        '-vn', // ignore cover art / video streams
        '-f', 'f32le', '-acodec', 'pcm_f32le',
        '-ac', String(channels),
        '-ar', String(sampleRate),
        'pipe:1',
    ];

    return new Promise((resolve, reject) => {
        const chunks = [];
        let stderr = '';
        const proc = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stdout.on('data', (chunk) => chunks.push(chunk));
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('error', (err) => {
            const hint = err.code === 'ENOENT'
                ? ' (ffmpeg not found - install it, or set FFMPEG_PATH)'
                : '';
            reject(new Error(`ffmpeg decode failed for ${name}: ${err.message}${hint}`));
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg decode failed for ${name}: ${stderr.trim() || `exit code ${code}`}`));
                return;
            }
            if (chunks.length === 0) {
                reject(new Error(`ffmpeg produced no audio data for ${name}`));
                return;
            }

            const floatBuffer = bufferToFloat32(chunks);
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
