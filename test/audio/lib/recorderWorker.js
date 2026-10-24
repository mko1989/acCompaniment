/**
 * Worker thread that records a loopback device's input with RtAudio - kept
 * off the test's main thread for the same reason the app's engine is
 * (src/backend/audioEngineWorker.js): a late input callback loses samples.
 *
 * Commands (from recorder.js): open, start, stop, dispose. While started,
 * every buffer is kept along with the time it arrived, so the recording can
 * be lined up with what the test did and when.
 */

const { parentPort } = require('node:worker_threads');
const { RtAudio, RtAudioFormat } = require('@hamitzor/rtaudio.js');

const RTAUDIO_INPUT_OVERFLOW = 0x1;

let rt = null;
let channels = 2;
let capturing = false;
let stopRequested = false;
// Preallocated so the callback never allocates (a GC pause in this thread
// is a late callback, and a virtual device answers that with zeros).
const MAX_SECONDS = 120;
let buffer = null;
let frames = 0;
// Per buffer: frames recorded so far, and the epoch ms it arrived.
let arrivalFrames = null;
let arrivalTimes = null;
let arrivalCount = 0;
let overflows = 0;

const epochNow = () => performance.timeOrigin + performance.now();

function open({ deviceId, channelCount, sampleRate, bufferSize }) {
    rt = new RtAudio();
    channels = channelCount;
    buffer = new Float32Array(MAX_SECONDS * sampleRate * channels);
    arrivalFrames = new Float64Array(Math.ceil((MAX_SECONDS * sampleRate) / 16));
    arrivalTimes = new Float64Array(arrivalFrames.length);
    rt.openStream(
        null,
        { deviceId, nChannels: channelCount },
        RtAudioFormat.RTAUDIO_FLOAT32,
        sampleRate,
        bufferSize,
        { streamName: 'acCompaniment loopback recorder' },
        (_output, input, nFrames, _streamTime, status) => {
            if (stopRequested) return 1;
            if (!capturing || !input) return 0;
            if (status & RTAUDIO_INPUT_OVERFLOW) overflows++;
            const room = buffer.length / channels - frames;
            const n = Math.min(nFrames, room);
            if (n > 0) buffer.set(new Float32Array(input.buffer, input.byteOffset, n * channels), frames * channels);
            frames += n;
            if (arrivalCount < arrivalFrames.length) {
                arrivalFrames[arrivalCount] = frames;
                arrivalTimes[arrivalCount++] = epochNow();
            }
            return 0;
        }
    );
    rt.startStream();
}

function start() {
    frames = 0;
    arrivalCount = 0;
    overflows = 0;
    capturing = true;
    return { startedAt: epochNow() };
}

function stop() {
    capturing = false;
    const samples = buffer.slice(0, frames * channels);
    const arrivals = [];
    for (let i = 0; i < arrivalCount; i++) arrivals.push([arrivalFrames[i], arrivalTimes[i]]);
    return { samples, arrivals, overflows, stoppedAt: epochNow() };
}

// Stopping and freeing RtAudio follows audioEngineWorker.js: stop from the
// callback (stopStream() can deadlock against it), then make sure the
// native object is collected while this thread still runs - left to thread
// teardown, its destructor aborts the process.
async function dispose() {
    if (!rt) return;
    if (rt.isStreamRunning()) {
        stopRequested = true;
        const deadline = Date.now() + 2000;
        while (rt.isStreamRunning() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (rt.isStreamRunning()) rt.stopStream();
    }
    if (rt.isStreamOpen()) rt.closeStream();

    const v8 = require('node:v8');
    const vm = require('node:vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    let freed = false;
    const registry = new FinalizationRegistry(() => { freed = true; });
    registry.register(rt, 'rt');
    rt = null;
    for (let attempt = 0; attempt < 20 && !freed; attempt++) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
}

const commands = { open, start, stop, dispose };

parentPort.on('message', async ({ id, type, payload }) => {
    try {
        const result = await commands[type](payload || {});
        const transfer = result?.samples ? [result.samples.buffer] : [];
        parentPort.postMessage({ id, result }, transfer);
    } catch (error) {
        parentPort.postMessage({ id, error: error?.message || String(error) });
    }
});
