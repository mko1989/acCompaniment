/**
 * Main-thread stand-in for SoundboardMixer that runs the real mixer - and
 * the RtAudio output stream - on a worker thread (audioEngineWorker.js), so
 * nothing else the server does can make an audio buffer late.
 *
 * It has the mixer interface AudioPlaybackManager uses (playCue, stopCue,
 * setGain, setDuck, pauseCue, resumeCue, voiceCount, getStatus,
 * drainPeakLevels, setMasterGain, ...), plus openStream/closeStream.
 * Commands are posted to the worker in order. Queries are answered here,
 * synchronously, from:
 *   - what this side has asked for (which cues are playing/paused, voice
 *     counts), so a caller sees its own command's effect immediately;
 *   - the worker's status reports (positions, fades, levels), which arrive
 *     every 40 ms while anything plays.
 *
 * Every play command carries a sequence number that the worker echoes back
 * with the cue's completion and in its reports. A completion or report
 * about an older play of a cue - one that raced a newer play of it - is
 * ignored, so a restarted cue is never reported as ended.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'audioEngineWorker.js');

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/** The same samples, in memory the worker can share instead of copying. */
function toShared(floatBuffer) {
    if (floatBuffer.buffer instanceof SharedArrayBuffer) return floatBuffer;
    const shared = new Float32Array(new SharedArrayBuffer(floatBuffer.length * 4));
    shared.set(floatBuffer);
    return shared;
}

class WorkerMixer {
    constructor({ sampleRate = 48000, channelCount = 2, workerPath = WORKER_PATH } = {}) {
        this.sampleRate = sampleRate;
        this.channelCount = channelCount;
        this.masterGain = 1.0;
        this.onCueComplete = null;
        this.onEngineError = null;
        this.workerPath = workerPath;

        this.worker = null;
        this._seq = 0;
        this._requestId = 0;
        this._pending = new Map(); // request id -> { resolve, reject }
        // cueId -> { voices, paused, seq } for every cue this side has
        // started and not yet seen end.
        this._cues = new Map();
        this._status = null; // the worker's latest report
        this._peaks = {};
    }

    // --- Worker -------------------------------------------------------------

    _ensureWorker() {
        if (this.worker) return this.worker;

        const worker = new Worker(this.workerPath);
        this.worker = worker;
        worker.on('message', (message) => this._onMessage(message));
        worker.on('error', (error) => {
            console.error('WorkerMixer: Audio engine worker error:', error);
        });
        worker.on('exit', (code) => {
            if (this.worker !== worker) return;
            this.worker = null;
            this._status = null;
            for (const { reject } of this._pending.values()) {
                reject(new Error('Audio engine stopped'));
            }
            this._pending.clear();
            if (this._terminating) return;

            // Everything it was playing has gone quiet.
            console.error(`WorkerMixer: Audio engine worker exited unexpectedly (code ${code})`);
            this.onEngineError?.({ type: 'worker-exit', message: `Audio engine stopped (code ${code})` });
            const cueIds = Array.from(this._cues.keys());
            this._cues.clear();
            for (const cueId of cueIds) this.onCueComplete?.(cueId, 'stopped');
        });
        // Re-apply state a fresh worker doesn't have.
        this._post('setMasterGain', { value: this.masterGain });
        this._post('setFormat', { sampleRate: this.sampleRate, channelCount: this.channelCount });
        return worker;
    }

    _post(type, payload) {
        if (!this.worker) return;
        this.worker.postMessage({ type, payload });
    }

    _request(type, payload) {
        const worker = this._ensureWorker();
        const id = ++this._requestId;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            worker.postMessage({ type, id, payload });
        });
    }

    _onMessage(message) {
        switch (message.type) {
            case 'reply': {
                const pending = this._pending.get(message.id);
                if (!pending) return;
                this._pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.result);
                break;
            }
            case 'status':
                this._applyStatus(message);
                break;
            case 'complete': {
                const cue = this._cues.get(message.cueId);
                if (!cue || cue.seq !== message.seq) return; // about an older play
                this._cues.delete(message.cueId);
                this.onCueComplete?.(message.cueId, message.reason);
                break;
            }
            case 'engine-error':
                this.onEngineError?.(message.error);
                break;
            case 'dropouts':
                // Not an error the UI can act on, but the first thing to
                // look for when someone hears one.
                console.warn(
                    `WorkerMixer: Audio dropouts in the last ${message.intervalMs / 1000}s: `
                    + `${message.underflows} underflow(s) reported by the driver, `
                    + `${message.late} late buffer(s) (worst gap ${message.worstGapMs.toFixed(1)} ms, `
                    + `buffer period ${message.periodMs.toFixed(1)} ms)`
                );
                break;
            default:
                break;
        }
    }

    _applyStatus({ status, peaks, seqs }) {
        this._status = { status, seqs };
        for (const [cueId, level] of Object.entries(peaks || {})) {
            this._peaks[cueId] = Math.max(this._peaks[cueId] || 0, level);
        }
        // A layered voice that ended on its own while newer ones play on.
        const counts = new Map();
        for (const voice of status.playing) {
            counts.set(voice.cueId, (counts.get(voice.cueId) || 0) + 1);
        }
        for (const [cueId, cue] of this._cues) {
            const count = counts.get(cueId);
            if (count && seqs[cueId] === cue.seq) cue.voices = count;
        }
    }

    // --- Stream -------------------------------------------------------------

    /** Opens (or reopens) the output: { deviceId, channelCount, sampleRate, bufferSize }. */
    async openStream(options) {
        this.sampleRate = options.sampleRate;
        this.channelCount = options.channelCount;
        return this._request('open', options);
    }

    async closeStream(timeoutMs) {
        if (!this.worker) return;
        await this._request('close', { timeoutMs });
    }

    async isStreamRunning() {
        if (!this.worker) return false;
        return this._request('isOpen');
    }

    /** Closes the stream and ends the worker. */
    async terminate() {
        if (!this.worker) return;
        try {
            // Must precede terminate(): see dispose() in audioEngineWorker.js.
            await this._request('dispose');
        } catch (error) {
            console.warn('WorkerMixer: Audio engine did not shut down cleanly:', error.message);
        }
        this._terminating = true;
        const worker = this.worker;
        this.worker = null;
        await worker.terminate();
        this._terminating = false;
        this._cues.clear();
        this._status = null;
    }

    // --- SoundboardMixer interface ------------------------------------------

    setMasterGain(value) {
        this.masterGain = clamp(Number(value) || 0, 0, 2);
        this._post('setMasterGain', { value: this.masterGain });
    }

    setChannelCount(channelCount) {
        this.channelCount = channelCount;
        this._post('setFormat', { channelCount });
    }

    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
        this._post('setFormat', { sampleRate });
    }

    setCueCompleteCallback(callback) {
        this.onCueComplete = callback;
    }

    setEngineErrorCallback(callback) {
        this.onEngineError = callback;
    }

    hasCue(cueId) {
        return this.voiceCount(cueId) > 0;
    }

    voiceCount(cueId) {
        return this._cues.get(cueId)?.voices || 0;
    }

    /** floatBuffer should be shared (see toShared) - otherwise it's copied on every play. */
    playCue(cueId, floatBuffer, options = {}) {
        this._ensureWorker();
        const seq = ++this._seq;
        const existing = this._cues.get(cueId);
        this._cues.set(cueId, {
            voices: options.newInstance && existing ? existing.voices + 1 : 1,
            paused: false,
            seq,
        });
        this._post('play', { cueId, seq, buffer: floatBuffer, options });
    }

    stopCue(cueId, fadeOutSeconds = 0) {
        if (!this._cues.has(cueId)) return false;
        // An immediate stop ends the cue now, without a completion; a fade
        // completes (reason 'stopped') once it reaches silence.
        if (!(fadeOutSeconds > 0)) this._cues.delete(cueId);
        this._post('stop', { cueId, fadeSeconds: fadeOutSeconds });
        return true;
    }

    stopAll(fadeOutSeconds = 0) {
        for (const cueId of Array.from(this._cues.keys())) {
            this.stopCue(cueId, fadeOutSeconds);
        }
    }

    setGain(cueId, volume, rampSeconds = 0.05) {
        if (!this._cues.has(cueId)) return false;
        this._post('setGain', { cueId, volume, rampSeconds });
        return true;
    }

    setDuck(cueId, multiplier, fadeSeconds = 0) {
        if (!this._cues.has(cueId)) return false;
        this._post('setDuck', { cueId, multiplier, fadeSeconds });
        return true;
    }

    pauseCue(cueId) {
        const cue = this._cues.get(cueId);
        if (!cue || cue.paused) return false;
        cue.paused = true;
        this._post('pause', { cueId });
        return true;
    }

    resumeCue(cueId) {
        const cue = this._cues.get(cueId);
        if (!cue || !cue.paused) return false;
        cue.paused = false;
        this._post('resume', { cueId });
        return true;
    }

    /**
     * The worker's latest report, limited to what this side knows is
     * playing: a cue stopped here a moment ago can still be in a report the
     * worker sent before it got the stop, and must not reappear.
     */
    getStatus() {
        const playing = [];
        if (this._status) {
            const { status, seqs } = this._status;
            for (const voice of status.playing) {
                const cue = this._cues.get(voice.cueId);
                if (!cue || seqs[voice.cueId] !== cue.seq) continue;
                playing.push({ ...voice, isPaused: cue.paused });
            }
        }
        return {
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
            activeCount: playing.length,
            masterGain: this.masterGain,
            playing,
        };
    }

    drainPeakLevels() {
        const levels = {};
        for (const [cueId, cue] of this._cues) {
            levels[cueId] = cue.paused ? 0 : this._peaks[cueId] || 0;
        }
        this._peaks = {};
        return levels;
    }
}

module.exports = WorkerMixer;
module.exports.toShared = toShared;
