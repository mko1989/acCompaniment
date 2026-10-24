/**
 * Audio engine worker thread: owns the RtAudio output stream and the
 * SoundboardMixer that renders into it.
 *
 * rtaudio.js calls the render callback on the JS thread that opened the
 * stream, and CoreAudio/WASAPI's audio thread *blocks* until it returns. On
 * the main thread that meant anything else the server did - WebSocket
 * broadcasts, HTTP, JSON, logging, garbage collection - could make a buffer
 * late, which is an audible dropout. Here, this thread does nothing but
 * mix, so the rest of the server can't starve it.
 *
 * The main thread drives it through WorkerMixer (workerMixer.js); see there
 * for the message protocol.
 */

const { parentPort } = require('worker_threads');
const { RtAudio, RtAudioFormat } = require('@hamitzor/rtaudio.js');
const SoundboardMixer = require('./soundboardMixer');

// How often the mixer's state is reported while anything plays. The main
// thread's time broadcast runs every 100 ms; this keeps its view fresh.
const STATUS_INTERVAL_MS = 40;
// How often dropouts seen since the last report are reported (if any).
const DROPOUT_REPORT_INTERVAL_MS = 5000;
// RtAudioStreamStatus flag: the driver reported the output ran dry.
const RTAUDIO_OUTPUT_UNDERFLOW = 0x2;

let rt = null;
let stopRequested = false;
let streamOpen = false;
// cueId -> seq of the last play command for it. Echoed back with its
// completion so the main thread can ignore a completion that raced a newer
// play of the same cue.
const playSeqs = new Map();
let wasActive = false;

// Dropout accounting: underflows the driver reported, and callbacks that
// came more than two buffer periods after the previous one (this thread was
// late - the driver may or may not have covered for it).
const dropouts = { underflows: 0, late: 0, worstGapMs: 0 };
let lastCallbackAt = 0;
let periodMs = 0;

const mixer = new SoundboardMixer();
mixer.setCueCompleteCallback((cueId, reason) => {
    const seq = playSeqs.get(cueId);
    playSeqs.delete(cueId);
    parentPort.postMessage({ type: 'complete', cueId, reason, seq });
});
// A voice moved on into its queued next buffer (a playlist's next item).
mixer.setCueAdvanceCallback((cueId, token) => {
    parentPort.postMessage({ type: 'advanced', cueId, token, seq: playSeqs.get(cueId) });
});

function post(message) {
    parentPort.postMessage(message);
}

function engineError(type, message) {
    post({ type: 'engine-error', error: { type: String(type), message: String(message) } });
}

function sendStatus() {
    const active = mixer.activeCues.size > 0;
    // Once more after going idle, so the main thread sees the last voice go.
    if (!active && !wasActive) return;
    wasActive = active;
    post({
        type: 'status',
        status: mixer.getStatus(),
        peaks: mixer.drainPeakLevels(),
        seqs: Object.fromEntries(playSeqs),
    });
}

setInterval(sendStatus, STATUS_INTERVAL_MS);

setInterval(() => {
    if (dropouts.underflows === 0 && dropouts.late === 0) return;
    post({ type: 'dropouts', ...dropouts, periodMs, intervalMs: DROPOUT_REPORT_INTERVAL_MS });
    dropouts.underflows = 0;
    dropouts.late = 0;
    dropouts.worstGapMs = 0;
}, DROPOUT_REPORT_INTERVAL_MS);

// Stops and closes the stream without deadlocking: stopStream() called
// while the audio thread waits on a render callback made both threads wait
// on each other forever. Instead the next callback returns 1 ("drain and
// stop") and RtAudio stops the stream on a thread of its own, while this
// one keeps servicing callbacks until it has.
async function closeStream(timeoutMs = 2000) {
    if (!rt) return;
    try {
        if (rt.isStreamRunning()) {
            stopRequested = true;
            const deadline = Date.now() + timeoutMs;
            while (rt.isStreamRunning() && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (rt.isStreamRunning()) {
                console.warn('AudioEngineWorker: Stream did not stop from its callback; stopping directly.');
                rt.stopStream();
            }
        }
        if (rt.isStreamOpen()) {
            rt.closeStream();
        }
    } finally {
        stopRequested = false;
        streamOpen = false;
    }
}

async function openStream({ deviceId, channelCount, sampleRate, bufferSize }) {
    if (!rt) {
        rt = new RtAudio();
        if (typeof rt.setErrorCallback === 'function') {
            rt.setErrorCallback((errType, message) => {
                console.error(`AudioEngineWorker: RtAudio error (${errType}): ${message}`);
                streamOpen = false;
                engineError(errType, message);
            });
        }
    }

    await closeStream();

    mixer.setSampleRate(sampleRate);
    mixer.setChannelCount(channelCount);

    const device = rt.getDevices().find((d) => d.id === deviceId);
    periodMs = (bufferSize / sampleRate) * 1000;
    lastCallbackAt = 0;

    rt.openStream(
        { deviceId, nChannels: channelCount },
        null,
        RtAudioFormat.RTAUDIO_FLOAT32,
        sampleRate,
        bufferSize,
        null,
        (output, _input, nFrames, _streamTime, status) => {
            if (stopRequested) {
                return 1;
            }
            const now = performance.now();
            if (lastCallbackAt) {
                const gap = now - lastCallbackAt;
                if (gap > periodMs * 2) {
                    dropouts.late++;
                    dropouts.worstGapMs = Math.max(dropouts.worstGapMs, gap);
                }
            }
            lastCallbackAt = now;
            if (status & RTAUDIO_OUTPUT_UNDERFLOW) dropouts.underflows++;

            try {
                const out = new Float32Array(output.buffer, output.byteOffset, nFrames * channelCount);
                mixer.render(out, nFrames, channelCount);
            } catch (error) {
                // Keep the stream alive: this cycle is silence (the binding
                // zero-fills the buffer), and the error is reported.
                console.error('AudioEngineWorker: Error in mixer render callback:', error);
                engineError('render-exception', error.message);
            }
            return 0;
        }
    );
    rt.startStream();
    streamOpen = true;
    return { deviceName: device?.name || `device ${deviceId}` };
}

// Frees the RtAudio object while this thread is still running. Left to
// thread teardown, the binding's destructor releases its thread-safe
// callbacks while Node is already destroying them, which aborts the whole
// process (rtaudio.js 2.2.0: ~NodeRtAudio -> napi_release_threadsafe_function
// from inside ~ThreadSafeFunction). Freed here, its callbacks close normally
// and teardown has nothing left to trip over. A wrapped native object is only
// freed by garbage collection, so collect until it has been.
async function dispose() {
    await closeStream();
    if (!rt) return;

    const v8 = require('v8');
    const vm = require('vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');

    let freed = false;
    const registry = new FinalizationRegistry(() => {
        freed = true;
    });
    registry.register(rt, 'rt');
    rt = null;
    for (let attempt = 0; attempt < 20 && !freed; attempt++) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The native finalizer runs from the event loop shortly after.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!freed) {
        console.warn('AudioEngineWorker: RtAudio was not freed before shutdown');
    }
}

const commands = {
    open: (p) => openStream(p),
    close: (p) => closeStream(p?.timeoutMs),
    dispose: () => dispose(),
    isOpen: () => streamOpen && Boolean(rt?.isStreamOpen()) && Boolean(rt?.isStreamRunning()),
    play: ({ cueId, seq, buffer, options }) => {
        playSeqs.set(cueId, seq);
        mixer.playCue(cueId, buffer, options);
    },
    stop: ({ cueId, fadeSeconds }) => {
        mixer.stopCue(cueId, fadeSeconds);
        // An immediate stop never completes (no callback) - forget it here.
        if (!mixer.hasCue(cueId)) playSeqs.delete(cueId);
    },
    queueNext: ({ cueId, buffer, options }) => mixer.queueNext(cueId, buffer, options),
    clearNext: ({ cueId }) => mixer.clearNext(cueId),
    setGain: ({ cueId, volume, rampSeconds }) => mixer.setGain(cueId, volume, rampSeconds),
    setDuck: ({ cueId, multiplier, fadeSeconds }) => mixer.setDuck(cueId, multiplier, fadeSeconds),
    pause: ({ cueId }) => mixer.pauseCue(cueId),
    resume: ({ cueId }) => mixer.resumeCue(cueId),
    setMasterGain: ({ value }) => mixer.setMasterGain(value),
    setFormat: ({ sampleRate, channelCount }) => {
        if (sampleRate) mixer.setSampleRate(sampleRate);
        if (channelCount) mixer.setChannelCount(channelCount);
    },
};

parentPort.on('message', async (message) => {
    const { type, id, payload } = message;
    const command = commands[type];
    if (!command) {
        if (id != null) post({ type: 'reply', id, error: `Unknown command: ${type}` });
        return;
    }
    try {
        const result = await command(payload || {});
        if (id != null) post({ type: 'reply', id, result });
    } catch (error) {
        if (id != null) {
            post({ type: 'reply', id, error: error?.message || String(error) });
        } else {
            console.error(`AudioEngineWorker: ${type} failed:`, error);
        }
    }
    // Report state changes promptly rather than on the next tick.
    if (type !== 'isOpen') sendStatus();
});
