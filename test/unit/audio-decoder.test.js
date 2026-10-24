/**
 * Unit tests for src/backend/audioDecoder.js, which runs ffmpeg to turn any
 * audio file into interleaved stereo Float32 PCM. Needs ffmpeg installed
 * (as the app itself does).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decodeToFloat32 } = require('../../src/backend/audioDecoder');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-decoder-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Mono 16-bit WAV: `seconds` of a constant sample value. */
function writeWav(name, { seconds = 1, sampleRate = 44100, value = 8000 } = {}) {
    const samples = Math.floor(sampleRate * seconds);
    const buf = Buffer.alloc(44 + samples * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + samples * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(value, 44 + i * 2);
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    return file;
}

test('decodes to interleaved stereo float32 at the requested sample rate', async () => {
    const file = writeWav('tone.wav', { seconds: 1.5, sampleRate: 44100, value: 16384 });
    const result = await decodeToFloat32(file, 48000);
    assert.equal(result.channels, 2);
    assert.equal(result.sampleRate, 48000);
    assert.ok(Math.abs(result.durationSec - 1.5) < 0.01, `duration ${result.durationSec}`);
    assert.ok(result.floatBuffer instanceof Float32Array);
    assert.equal(result.floatBuffer.length % 2, 0);
    // A mono source goes to both channels at its own level (WO-004 - not
    // ffmpeg's -3 dB mono-to-stereo): 16384/32768 = 0.5.
    const mid = Math.floor(result.floatBuffer.length / 2) & ~1;
    assert.ok(Math.abs(result.floatBuffer[mid] - 0.5) < 0.01, `mono decoded at ${result.floatBuffer[mid]}`);
    assert.equal(result.floatBuffer[mid], result.floatBuffer[mid + 1]);
});

test('decodes to other sample rates too', async () => {
    const file = writeWav('rate.wav', { seconds: 1 });
    const result = await decodeToFloat32(file, 44100);
    assert.equal(result.floatBuffer.length, 44100 * 2);
});

test('a missing file is reported clearly', async () => {
    await assert.rejects(decodeToFloat32(path.join(dir, 'nope.wav')), /Audio file not found/);
});

test('a file that is not audio is reported with ffmpeg\'s reason', async () => {
    const file = path.join(dir, 'bad.wav');
    fs.writeFileSync(file, 'definitely not audio');
    await assert.rejects(decodeToFloat32(file), /ffmpeg decode failed for bad\.wav: .+/);
});

test('a missing ffmpeg is reported with a hint', async () => {
    const file = writeWav('noffmpeg.wav');
    const previous = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(dir, 'no-such-ffmpeg');
    try {
        await assert.rejects(decodeToFloat32(file), /ffmpeg not found - install it, or set FFMPEG_PATH/);
    } finally {
        if (previous === undefined) delete process.env.FFMPEG_PATH;
        else process.env.FFMPEG_PATH = previous;
    }
});

test('cached PCM from an older decoder is not reused (the decoder version is in the cache key)', async () => {
    const { cacheKeyForFile } = require('../../src/backend/pcmCache');
    const { DECODER_VERSION } = require('../../src/backend/audioDecoder');
    const crypto = require('node:crypto');
    const file = writeWav('keyed.wav');
    const stat = fs.statSync(file);
    const unversioned = crypto.createHash('sha256').update(file).update(String(stat.mtimeMs)).update(String(stat.size)).digest('hex');
    assert.ok(DECODER_VERSION >= 2);
    assert.notEqual(await cacheKeyForFile(file), unversioned);
});
