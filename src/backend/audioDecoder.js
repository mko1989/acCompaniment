/**
 * Decode audio files to interleaved stereo Float32 PCM via ffmpeg.
 * Used by AudioPlaybackManager until ENG4 pre-decode-on-import lands.
 */

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const musicMetadata = require('music-metadata');

// Bumped whenever decoding changes what comes out, so PCM cached by an
// older decoder (pcmCache.js) isn't reused. 2: mono at full level (WO-004).
const DECODER_VERSION = 2;

// How many channels the file has, or null if its tags don't say.
async function sourceChannelCount(filePath) {
    try {
        const { format } = await musicMetadata.parseFile(filePath, { duration: false, skipCovers: true });
        return Number(format.numberOfChannels) || null;
    } catch {
        return null;
    }
}

const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

// FFMPEG_PATH if set, then the binary bundled with the packaged app
// (Resources/ffmpeg/, next to app.asar), then the one scripts/fetch-ffmpeg.js
// put in vendor/ffmpeg/ for running from source, and only then `ffmpeg` on
// the PATH. Relying on the PATH alone broke playback on any machine without
// a system ffmpeg.
let resolvedBinary = null;
function ffmpegBinary() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    if (resolvedBinary) return resolvedBinary;

    const root = path.join(__dirname, '..', '..');
    const vendorDir = path.join(root, 'vendor', 'ffmpeg');
    const candidates = [
        path.join(root, '..', 'ffmpeg', FFMPEG_EXE),
        path.join(vendorDir, `${process.platform}-universal`, FFMPEG_EXE),
        path.join(vendorDir, `${process.platform}-${process.arch}`, FFMPEG_EXE),
    ];
    resolvedBinary = candidates.find((candidate) => fs.existsSync(candidate)) || 'ffmpeg';
    return resolvedBinary;
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
    // Mono goes to both sides at full level. ffmpeg's own mono-to-stereo
    // (-ac 2) puts it at -3 dB a side, so mono files played quieter than
    // the same audio in stereo (WO-004). Everything else is mixed to stereo
    // by ffmpeg as before.
    const toStereo = await sourceChannelCount(filePath) === 1
        ? ['-af', 'pan=stereo|c0=c0|c1=c0']
        : ['-ac', String(channels)];
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', filePath,
        '-vn', // ignore cover art / video streams
        '-f', 'f32le', '-acodec', 'pcm_f32le',
        ...toStereo,
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
    DECODER_VERSION,
};
