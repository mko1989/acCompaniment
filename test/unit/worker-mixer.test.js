/**
 * Unit tests for WorkerMixer, the main-thread side of the audio engine
 * worker. No output stream is opened: the worker's mixer holds voices but
 * never renders, so completions are fed in by hand where a test needs one.
 *
 * What matters here is that callers see a consistent picture even though
 * the worker lags behind: a cue they just stopped never reappears from an
 * older worker report, and a completion from an older play of a cue never
 * ends a newer one (a restarted cue would otherwise show as stopped while
 * it plays).
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const WorkerMixer = require('../../src/backend/workerMixer');
const { toShared } = require('../../src/backend/workerMixer');

const buffer = toShared(new Float32Array(48000 * 2).fill(0.1));
let mixer;

function newMixer() {
    mixer = new WorkerMixer({ sampleRate: 48000, channelCount: 2 });
    const completed = [];
    mixer.setCueCompleteCallback((cueId, reason) => completed.push({ cueId, reason }));
    return completed;
}

/** Resolves once the worker has reported on `cueId` (or reported it gone). */
async function reported(test, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!test()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for a worker report');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

afterEach(async () => {
    await mixer?.terminate();
    mixer = null;
});

test('toShared puts samples in shared memory once', () => {
    const plain = new Float32Array([0.1, 0.2]);
    const shared = toShared(plain);
    assert.ok(shared.buffer instanceof SharedArrayBuffer);
    assert.deepEqual(Array.from(shared), Array.from(plain));
    assert.equal(toShared(shared), shared, 'already shared: no copy');
});

test('a playing cue is known at once and reported by the worker', async () => {
    newMixer();
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    assert.equal(mixer.voiceCount('a'), 1);
    assert.equal(mixer.hasCue('a'), true);

    await reported(() => mixer.getStatus().playing.length === 1);
    const voice = mixer.getStatus().playing[0];
    assert.equal(voice.cueId, 'a');
    assert.equal(voice.isPaused, false);
    assert.equal(voice.trimEndSec, 1);
});

test('new instances add voices; a plain play replaces them', async () => {
    newMixer();
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2, newInstance: true });
    assert.equal(mixer.voiceCount('a'), 2);
    await reported(() => mixer.getStatus().playing.length === 2);

    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    assert.equal(mixer.voiceCount('a'), 1);
    await reported(() => mixer.getStatus().playing.length === 1);
});

test('an immediate stop hides the cue at once, even from an older worker report', async () => {
    newMixer();
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    await reported(() => mixer.getStatus().playing.length === 1);
    const olderReport = mixer._status;

    assert.equal(mixer.stopCue('a'), true);
    assert.equal(mixer.voiceCount('a'), 0);
    // A report the worker sent before it got the stop.
    mixer._status = olderReport;
    assert.deepEqual(mixer.getStatus().playing, []);
    assert.equal(mixer.stopCue('a'), false, 'nothing left to stop');
});

test('a fading stop keeps the cue until the worker says it finished', async () => {
    const completed = newMixer();
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    await reported(() => mixer.getStatus().playing.length === 1);
    const { seq } = mixer._cues.get('a');

    mixer.stopCue('a', 2);
    assert.equal(mixer.hasCue('a'), true);
    await reported(() => mixer.getStatus().playing[0]?.stopping === true);

    mixer._onMessage({ type: 'complete', cueId: 'a', reason: 'stopped', seq });
    assert.deepEqual(completed, [{ cueId: 'a', reason: 'stopped' }]);
    assert.equal(mixer.hasCue('a'), false);
});

test('a completion from an older play of a cue does not end the newer one', async () => {
    const completed = newMixer();
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    const { seq: firstSeq } = mixer._cues.get('a');
    // Restarted before the first play's completion arrived.
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });

    mixer._onMessage({ type: 'complete', cueId: 'a', reason: 'completed', seq: firstSeq });
    assert.deepEqual(completed, []);
    assert.equal(mixer.hasCue('a'), true);
});

test('pause and resume show at once and report whether anything changed', async () => {
    newMixer();
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    await reported(() => mixer.getStatus().playing.length === 1);

    assert.equal(mixer.pauseCue('a'), true);
    assert.equal(mixer.pauseCue('a'), false, 'already paused');
    assert.equal(mixer.getStatus().playing[0].isPaused, true);
    assert.deepEqual(mixer.drainPeakLevels(), { a: 0 });

    assert.equal(mixer.resumeCue('a'), true);
    assert.equal(mixer.resumeCue('a'), false, 'not paused');
    assert.equal(mixer.getStatus().playing[0].isPaused, false);
    assert.equal(mixer.pauseCue('nope'), false);
});

test('gain and duck changes are accepted only for playing cues', () => {
    newMixer();
    assert.equal(mixer.setGain('a', 0.5), false);
    assert.equal(mixer.setDuck('a', 0.2, 1), false);
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    assert.equal(mixer.setGain('a', 0.5), true);
    assert.equal(mixer.setDuck('a', 0.2, 1), true);
});

test('master gain is clamped to 0-2', () => {
    newMixer();
    mixer.setMasterGain(5);
    assert.equal(mixer.masterGain, 2);
    mixer.setMasterGain(-1);
    assert.equal(mixer.masterGain, 0);
});

test('if the engine thread dies, its cues end and the error is reported', async () => {
    const completed = newMixer();
    const errors = [];
    mixer.setEngineErrorCallback((error) => errors.push(error));
    mixer.playCue('a', buffer, { sampleRate: 48000, channels: 2 });
    await reported(() => mixer.getStatus().playing.length === 1);

    await mixer.worker.terminate();
    await reported(() => completed.length === 1);
    assert.deepEqual(completed, [{ cueId: 'a', reason: 'stopped' }]);
    assert.equal(errors[0].type, 'worker-exit');
    assert.deepEqual(mixer.getStatus().playing, []);
});
