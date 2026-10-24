/**
 * Loopback capture, independent of any test runner (the node:test suite in
 * loopback.js and the Playwright one in test/audio-ui/ both use it): finding
 * the loopback device, recording its input on a worker thread, and the
 * resulting Take - samples lined up with what the test did and when.
 *
 * Device: ACCOMPANIMENT_LOOPBACK_DEVICE (part of the name) picks it, and
 * ACCOMPANIMENT_LOOPBACK_INPUT picks a separate input when the loopback is
 * a pair of devices (VB-Cable: play to "CABLE Input", record "CABLE
 * Output"). Otherwise the first known loopback driver found is used
 * (BlackHole, Loopback, Soundflower, NoMachine Audio Adapter, ...).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');

const { encodeWav } = require('./signals');
const { analyze } = require('./analyzer');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const KNOWN_LOOPBACKS = [
    /BlackHole/i, /Loopback Audio/i, /Soundflower/i, /NoMachine Audio Adapter/i,
    /VB-Audio|VB-Cable|CABLE/i, /Virtual Audio Cable/i, /snd-aloop|Loopback/i,
];

// How soon a press must be heard to count as "immediate" (see immediate()).
const RESPONSE_SEC = 0.08;
const epochNow = () => performance.timeOrigin + performance.now();

function listDevices() {
    try {
        const out = execFileSync(process.execPath, [path.join(__dirname, 'listDevices.js')], {
            cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000,
        });
        return JSON.parse(out);
    } catch (error) {
        return { error: error.message };
    }
}

/** { output, input } devices to use, or { reason } when there are none. */
function findLoopback() {
    const devices = listDevices();
    if (!Array.isArray(devices)) return { reason: `could not list audio devices: ${devices.error}` };

    const byName = (pattern) => devices.find((d) => d.name.toLowerCase().includes(pattern.toLowerCase()));
    const wanted = process.env.ACCOMPANIMENT_LOOPBACK_DEVICE;
    const wantedInput = process.env.ACCOMPANIMENT_LOOPBACK_INPUT;
    if (wanted) {
        const output = byName(wanted);
        const input = wantedInput ? byName(wantedInput) : output;
        if (!output || !(output.outputChannels > 0)) return { reason: `no output device matching "${wanted}"` };
        if (!input || !(input.inputChannels > 0)) return { reason: `no input device matching "${wantedInput || wanted}"` };
        return { output, input };
    }
    for (const pattern of KNOWN_LOOPBACKS) {
        const output = devices.find((d) => pattern.test(d.name) && d.outputChannels > 0 && d.inputChannels > 0);
        if (output) return { output, input: output };
    }
    return {
        reason: 'no loopback audio device found - install one (macOS: `brew install blackhole-2ch`) '
            + 'or set ACCOMPANIMENT_LOOPBACK_DEVICE',
    };
}

/** Records a device's input on a worker thread (recorderWorker.js). */
class Recorder {
    constructor() {
        this.worker = new Worker(path.join(__dirname, 'recorderWorker.js'));
        this.worker.unref();
        this._id = 0;
        this._pending = new Map();
        this.worker.on('message', ({ id, result, error }) => {
            const p = this._pending.get(id);
            this._pending.delete(id);
            if (error) p?.reject(new Error(error));
            else p?.resolve(result);
        });
    }

    _call(type, payload) {
        const id = ++this._id;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, type, payload });
        });
    }

    open(options) { return this._call('open', options); }
    start() { return this._call('start'); }
    stop() { return this._call('stop'); }

    async dispose() {
        await this._call('dispose').catch(() => {});
        await this.worker.terminate();
    }
}

/**
 * One recording: samples, the marks a test made while it ran, and the
 * mapping between the two. `take.at('label')` is the recording time (s) of
 * a mark; `take.a` the analysis.
 */
class Take {
    constructor({ samples, arrivals, overflows }, { channels, sampleRate, marks, name }) {
        this.samples = samples;
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.marks = marks;
        this.name = name;
        this.overflows = overflows;
        // Each buffer arrives just after its last frame was captured, plus
        // some scheduling delay; the least-delayed one fixes when frame 0
        // was captured.
        this.originEpochMs = Math.min(...arrivals.map(([frames, at]) => at - (frames / sampleRate) * 1000));
        this.durationSec = samples.length / channels / sampleRate;
        this._analysis = null;
    }

    get a() {
        if (!this._analysis) this._analysis = analyze(this);
        return this._analysis;
    }

    /** Recording time (s) of an epoch time. */
    sec(epochMs) {
        return (epochMs - this.originEpochMs) / 1000;
    }

    /** Recording time (s) of the n-th (default first) mark with this label. */
    at(label, n = 0) {
        const mark = this.marks.filter((m) => m.label === label)[n];
        assert.ok(mark, `no mark "${label}" #${n} in take ${this.name}`);
        return this.sec(mark.epochMs);
    }

    /**
     * Dropouts in [t0, t1] (recording seconds) on a channel: runs of at
     * least `minSamples` digital-silence samples. A tone never sits at zero
     * for more than a sample or two, so inside a stretch the test knows was
     * playing, such a run is a buffer the output never filled.
     */
    dropouts(t0, t1, { channel = 0, minSamples = 16 } = {}) {
        const found = [];
        const from = Math.max(0, Math.floor(t0 * this.sampleRate));
        const to = Math.min(this.samples.length / this.channels, Math.ceil(t1 * this.sampleRate));
        let run = 0;
        for (let i = from; i <= to; i++) {
            const quiet = i < to && Math.abs(this.samples[i * this.channels + channel]) < 1e-5;
            if (quiet) {
                run++;
            } else {
                if (run >= minSamples) found.push({ atSec: (i - run) / this.sampleRate, samples: run });
                run = 0;
            }
        }
        return found;
    }

    /**
     * Holes anywhere in the take, on either channel: runs of digital
     * silence with loud audio right before and right after - a buffer that
     * went missing mid-sound, as opposed to a stop (nothing after it) or a
     * start (nothing before it).
     */
    holes({ minSamples = 64, edge = 32, loud = 0.01 } = {}) {
        const found = [];
        const frames = this.samples.length / this.channels;
        const peak = (c, from, to) => {
            let max = 0;
            for (let i = Math.max(0, from); i < Math.min(frames, to); i++) {
                max = Math.max(max, Math.abs(this.samples[i * this.channels + c]));
            }
            return max;
        };
        for (let c = 0; c < this.channels; c++) {
            let run = 0;
            for (let i = 0; i < frames; i++) {
                if (Math.abs(this.samples[i * this.channels + c]) < 1e-5) {
                    run++;
                    continue;
                }
                if (run >= minSamples && peak(c, i - run - edge, i - run) > loud && peak(c, i, i + edge) > loud) {
                    found.push({ channel: c, atSec: (i - run) / this.sampleRate, samples: run });
                }
                run = 0;
            }
        }
        return found;
    }

    assertNoDropouts(t0, t1, options) {
        const found = this.dropouts(t0, t1, options);
        assert.equal(
            found.length, 0,
            `${found.length} dropout(s) in ${t0.toFixed(2)}-${t1.toFixed(2)}s of ${this.name}: `
            + found.slice(0, 5).map((d) => `${d.samples} samples at ${d.atSec.toFixed(3)}s`).join(', ')
        );
    }

    save(dir) {
        fs.mkdirSync(dir, { recursive: true });
        const base = path.join(dir, this.name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120));
        fs.writeFileSync(`${base}.wav`, encodeWav(this, 'float32'));
        // Audacity: File > Import > Labels.
        const labels = this.marks.map((m) => {
            const t = this.sec(m.epochMs).toFixed(4);
            return `${t}\t${t}\t${m.label}`;
        });
        fs.writeFileSync(`${base}.labels.txt`, `${labels.join('\n')}\n`);
        return `${base}.wav`;
    }
}

module.exports = {
    REPO_ROOT, RESPONSE_SEC, epochNow, listDevices, findLoopback, Recorder, Take,
};
