#!/usr/bin/env node
/**
 * B4 step 1 proof: decodes every audio file in the fixtures with the original's decodeToFloat32
 * (ffmpeg) and with the Rust decoder (`decode-file`), at 44100 and 48000 Hz, and compares.
 *
 * Per file: frame counts, the time offset between the two (the cross-correlation peak, to a
 * fraction of a sample), the level difference, the largest sample difference, and the residual
 * (difference after aligning the offset) relative to the signal (dB). Pass rules:
 * - the Rust side used ffmpeg (fallback): identical samples and length (the same command);
 * - not resampled (the file's rate is the engine's): same length, no offset, residual <= -60 dB
 *   (symphonia vs ffmpeg decoders differ only in float rounding and integer-to-float scaling);
 * - resampled (rubato's FFT resampler vs swresample's windowed sinc): same length, offset at most
 *   half a source sample (the two place output samples half a source sample apart: at most ~21 us
 *   for the 24 kHz file, inaudible), level within 0.1 dB, residual after the offset <= -40 dB.
 *
 * Usage: node rust/scripts/compare-decode.js   (after `cargo build --release` in rust/app)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { decodeToFloat32 } = require('../../src/backend/audioDecoder');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'rust', 'app', 'target', 'release', 'decode-file');
const DIRS = ['rust/app-fixtures/data/audio', 'rust/app-fixtures/incoming', 'rust/app-fixtures/probe'];
const AUDIO = /\.(wav|mp3|flac|ogg|m4a|aac|aiff?|opus|mp4)$/i;
// The file's own sample rate, from ffprobe-free means: the rust probe isn't reachable from here,
// so ask ffmpeg's decoder through the original (decode at 0 = native is not possible); use the
// metadata the original's library uses (music-metadata).
const mm = require('music-metadata');
const rates = new Map();
async function sourceRate(file) {
    if (!rates.has(file)) {
        try { rates.set(file, (await mm.parseFile(file, { duration: false })).format.sampleRate || 0); } catch { rates.set(file, 0); }
    }
    return rates.get(file);
}
function sourceRateIs(file, rate) { return rates.get(file) === rate; }
// Half a sample of the source, in output samples (+ 0.1 for the estimate): the two resamplers
// place their output samples half a source sample apart.
function halfSourceSample(file, rate) { return 0.5 * Math.max(1, rate / (rates.get(file) || rate)) + 0.1; }

function files() {
    const out = [];
    for (const d of DIRS) {
        const abs = path.join(ROOT, d);
        if (!fs.existsSync(abs)) continue;
        for (const f of fs.readdirSync(abs).sort()) {
            if (AUDIO.test(f) && fs.statSync(path.join(abs, f)).isFile()) out.push(path.join(abs, f));
        }
    }
    return out;
}

function corrAt(a, b, lag, frames) {
    let s = 0;
    for (let i = 64; i < frames - 64; i += 3) s += a[i * 2] * b[(i + lag) * 2];
    return s;
}

function compare(a, b) {
    const frames = Math.min(a.length, b.length) / 2;
    const rms = (x) => Math.sqrt(x.slice(0, frames * 2).reduce((s, v) => s + v * v, 0) / Math.max(1, frames * 2));
    // Offset: cross-correlation peak over +/-8 frames, refined with a parabola.
    let bestLag = 0;
    let bestC = -Infinity;
    for (let lag = -8; lag <= 8; lag++) {
        const c = corrAt(a, b, lag, frames);
        if (c > bestC) { bestC = c; bestLag = lag; }
    }
    const cm = corrAt(a, b, bestLag - 1, frames);
    const cp = corrAt(a, b, bestLag + 1, frames);
    const denom = cm - 2 * bestC + cp;
    const offset = bestLag + (denom !== 0 ? 0.5 * (cm - cp) / denom : 0);
    let maxDiff = 0;
    let sq = 0;
    let sqAligned = 0;
    for (let i = 0; i < frames * 2; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > maxDiff) maxDiff = d;
        sq += d * d;
    }
    // Residual: b read at i + offset (linear interpolation), away from the ends.
    let count = 0;
    for (let f = 16; f < frames - 16; f++) {
        const x = f + offset;
        const i0 = Math.floor(x);
        const t = x - i0;
        for (let c = 0; c < 2; c++) {
            const v = b[i0 * 2 + c] * (1 - t) + b[(i0 + 1) * 2 + c] * t;
            const d = a[f * 2 + c] - v;
            sqAligned += d * d;
            count += 1;
        }
    }
    const ra = rms(a);
    const rb = rms(b);
    const db = (x) => (ra > 0 ? 20 * Math.log10(Math.max(x, 1e-12) / ra) : (x === 0 ? -Infinity : Infinity));
    return {
        offset,
        maxDiff,
        relDb: db(Math.sqrt(sq / Math.max(1, frames * 2))),
        residualDb: db(Math.sqrt(sqAligned / Math.max(1, count))),
        levelDb: ra > 0 && rb > 0 ? 20 * Math.log10(rb / ra) : 0,
    };
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-decode-'));
    let pass = 0;
    let total = 0;
    for (const file of files()) {
        for (const rate of [44100, 48000]) {
            total += 1;
            const rel = path.relative(ROOT, file);
            await sourceRate(file);
            let node;
            try {
                node = await decodeToFloat32(file, rate);
            } catch (e) {
                node = { error: e.message };
            }
            const out = path.join(tmp, 'out.f32');
            const rust = JSON.parse(execFileSync(BIN, [file, String(rate), out], { encoding: 'utf8' }));
            let verdict;
            let detail = '';
            if (node.error || rust.error) {
                const same = Boolean(node.error) === Boolean(rust.error);
                verdict = same ? 'pass' : 'FAIL';
                detail = `node error: ${node.error || '-'} | rust error: ${rust.error || '-'}`;
            } else {
                const buf = fs.readFileSync(out);
                const r = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
                const n = node.floatBuffer;
                const nFrames = n.length / 2;
                const m = compare(n, r);
                const resampled = !sourceRateIs(file, rate);
                let ok;
                if (rust.via === 'ffmpeg') ok = nFrames === rust.frames && m.maxDiff === 0;
                else if (!resampled) ok = nFrames === rust.frames && Math.abs(m.offset) < 0.05 && m.residualDb <= -60;
                else ok = nFrames === rust.frames && Math.abs(m.offset) <= halfSourceSample(file, rate) && Math.abs(m.levelDb) <= 0.1 && m.residualDb <= -40;
                verdict = ok ? 'pass' : 'FAIL';
                const f = (x) => (x === -Infinity ? '-inf' : x.toFixed(1));
                detail = `via ${rust.via}${resampled ? ', resampled' : ''}, frames node ${nFrames} rust ${rust.frames}, `
                    + `offset ${m.offset.toFixed(3)}, level ${m.levelDb.toFixed(3)} dB, max diff ${m.maxDiff.toExponential(2)}, `
                    + `raw ${f(m.relDb)} dB, residual ${f(m.residualDb)} dB`;
            }
            if (verdict === 'pass') pass += 1;
            console.log(`${verdict}  ${rate}  ${rel}: ${detail}`);
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass}/${total} pass`);
    process.exitCode = pass === total ? 0 : 1;
})();
