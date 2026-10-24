/**
 * Test signals the loopback suite can recognise in a recording.
 *
 * Every generated file is a "position-encoded" tone: the file is cut into
 * equal segments and each segment is a pure sine at its own frequency. Hear
 * which frequency is playing and you know where in the file playback is -
 * so a recording shows restarts (position jumps back), pauses (silence,
 * then the same position again), loops (position wraps), trims (starts and
 * ends at the trimmed segments) and layered instances (two positions at
 * once), not just "something was audible".
 *
 * Each file also lives in a *band* of its own: band 0's segment frequencies
 * don't overlap band 1's, and so on, so several cues playing at once can be
 * told apart and measured separately.
 *
 * Frequencies sit on the centre of an analysis bin (48 kHz, 2048-point FFT,
 * see analyzer.js) four bins apart, so each one is measured exactly and
 * neighbouring segments don't leak into each other.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ANALYSIS_RATE = 48000;
const FFT_SIZE = 2048;
const BIN_HZ = ANALYSIS_RATE / FFT_SIZE; // 23.4375 Hz
const SLOTS = 32; // segments per band before the frequencies repeat
const SLOT_SPACING_BINS = 4;
const BAND_BASE_BINS = [24, 160, 296, 432]; // ~560 Hz, 3.75 kHz, 6.9 kHz, 10.1 kHz
const DEFAULT_AMPLITUDE = 0.5;

function slotFrequency(band, slot) {
    if (!(band in BAND_BASE_BINS)) throw new Error(`No band ${band}`);
    return (BAND_BASE_BINS[band] + SLOT_SPACING_BINS * (slot % SLOTS)) * BIN_HZ;
}

/**
 * Renders a position-encoded tone to interleaved float samples.
 *
 * @param {object} spec
 * @param {number} spec.durationSec
 * @param {number} [spec.segmentSec=0.1]  length of each segment
 * @param {number} [spec.band=0]          band of the left (or only) channel
 * @param {number} [spec.rightBand]       stereo: band of the right channel
 * @param {number} [spec.channels=1]
 * @param {number} [spec.sampleRate=48000]
 * @param {number} [spec.amplitude=0.5]
 */
function renderTone({
    durationSec, segmentSec = 0.1, band = 0, rightBand, channels = 1,
    sampleRate = ANALYSIS_RATE, amplitude = DEFAULT_AMPLITUDE,
}) {
    const frames = Math.round(durationSec * sampleRate);
    const samples = new Float32Array(frames * channels);
    const bands = channels === 1 ? [band] : [band, rightBand ?? band];
    const phases = bands.map(() => 0);
    // A short ramp at the very start and end so a cue's first and last
    // sample aren't clicks (which smear energy over every band).
    const edge = Math.min(Math.round(0.002 * sampleRate), Math.floor(frames / 2));

    for (let i = 0; i < frames; i++) {
        const slot = Math.floor(i / (segmentSec * sampleRate));
        let env = 1;
        if (i < edge) env = i / edge;
        else if (i >= frames - edge) env = (frames - 1 - i) / edge;
        for (let c = 0; c < channels; c++) {
            const freq = slotFrequency(bands[c], slot);
            // Phase-continuous across segment changes, so a frequency step
            // is not also a discontinuity.
            phases[c] += (2 * Math.PI * freq) / sampleRate;
            samples[i * channels + c] = amplitude * env * Math.sin(phases[c]);
        }
    }
    return { samples, channels, sampleRate, frames };
}

/** Encodes interleaved float samples as WAV: format 'pcm16' | 'pcm24' | 'float32'. */
function encodeWav({ samples, channels, sampleRate }, format = 'pcm16') {
    const bytesPerSample = { pcm16: 2, pcm24: 3, float32: 4 }[format];
    if (!bytesPerSample) throw new Error(`Unknown WAV format ${format}`);
    const dataSize = samples.length * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(format === 'float32' ? 3 : 1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bytesPerSample * 8, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        if (format === 'float32') {
            buffer.writeFloatLE(s, offset);
        } else if (format === 'pcm16') {
            buffer.writeInt16LE(Math.round(s * 32767), offset);
        } else {
            buffer.writeIntLE(Math.round(s * 8388607), offset, 3);
        }
        offset += bytesPerSample;
    }
    return buffer;
}

/** The ffmpeg the app itself would use (see audioDecoder.js), for encoding MP3s. */
function ffmpegBinary() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const vendor = path.join(__dirname, '..', '..', '..', 'vendor', 'ffmpeg');
    const candidates = [
        path.join(vendor, `${process.platform}-universal`, exe),
        path.join(vendor, `${process.platform}-${process.arch}`, exe),
    ];
    return candidates.find((c) => fs.existsSync(c)) || 'ffmpeg';
}

/** Encodes a WAV buffer to MP3 with ffmpeg/LAME. */
function wavToMp3(wavBuffer, { bitrate = '192k' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-mp3-'));
    try {
        const input = path.join(dir, 'in.wav');
        const output = path.join(dir, 'out.mp3');
        fs.writeFileSync(input, wavBuffer);
        execFileSync(ffmpegBinary(), [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
            '-codec:a', 'libmp3lame', '-b:a', bitrate, output,
        ]);
        return fs.readFileSync(output);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * A complete test file: { buffer, filename, mime, spec }.
 * `format`: 'wav' (pcm16), 'wav24', 'wavf32' or 'mp3'. Stereo unless spec.channels
 * says otherwise, so the right channel can carry a band of its own.
 */
function makeToneFile(spec = {}, format = 'wav') {
    const full = { durationSec: 3.2, segmentSec: 0.1, band: 0, channels: 2, sampleRate: ANALYSIS_RATE, ...spec };
    const tone = renderTone(full);
    let buffer;
    let ext = 'wav';
    let mime = 'audio/wav';
    if (format === 'mp3') {
        buffer = wavToMp3(encodeWav(tone, 'pcm16'), spec.mp3 || {});
        ext = 'mp3';
        mime = 'audio/mpeg';
    } else {
        buffer = encodeWav(tone, { wav: 'pcm16', wav24: 'pcm24', wavf32: 'float32' }[format]);
    }
    const name = `tone-b${full.band}${full.channels === 2 ? `-r${full.rightBand ?? full.band}` : ''}`
        + `-${full.durationSec}s-${full.sampleRate}-${format}`;
    return { buffer, filename: `${name}.${ext}`, mime, spec: full };
}

module.exports = {
    ANALYSIS_RATE,
    FFT_SIZE,
    BIN_HZ,
    SLOTS,
    BAND_BASE_BINS,
    DEFAULT_AMPLITUDE,
    slotFrequency,
    renderTone,
    encodeWav,
    wavToMp3,
    makeToneFile,
    ffmpegBinary,
};
