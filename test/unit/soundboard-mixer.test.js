/**
 * Pure unit tests for the PCM mixer (src/backend/soundboardMixer.js) - no
 * server, no RtAudio. render() is driven by hand, so every timing assertion
 * is exact in frames rather than dependent on wall-clock scheduling.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SoundboardMixer = require('../../src/backend/soundboardMixer');

const SR = 1000; // small sample rate keeps frame math readable

/** Interleaved stereo buffer of `frames` frames, every sample = value. */
function constBuffer(frames, value = 0.5) {
    return new Float32Array(frames * 2).fill(value);
}

function render(mixer, nFrames, nChannels = 2) {
    const out = new Float32Array(nFrames * nChannels);
    mixer.render(out, nFrames, nChannels);
    return out;
}

function makeMixer() {
    const mixer = new SoundboardMixer({ sampleRate: SR, channelCount: 2 });
    const completions = [];
    mixer.setCueCompleteCallback((cueId, reason) => completions.push({ cueId, reason }));
    return { mixer, completions };
}

function statusOf(mixer, cueId) {
    return mixer.getStatus().playing.find((p) => p.cueId === cueId);
}

test('a cue that reaches the end of its audio completes with reason "completed"', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(100), { sampleRate: SR, channels: 2 });

    render(mixer, 99);
    assert.equal(completions.length, 0);
    render(mixer, 10);
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'completed' }]);
    assert.equal(mixer.getStatus().activeCount, 0);
});

test('an immediate stop removes the cue without firing the completion callback', () => {
    // Callers rely on this: an immediate stop is final right away, and they
    // must clean up themselves - no completion will ever arrive for it.
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(1000), { sampleRate: SR, channels: 2 });

    assert.equal(mixer.stopCue('a', 0), true);
    assert.equal(mixer.getStatus().activeCount, 0);
    render(mixer, 100);
    assert.equal(completions.length, 0);
});

test('a fade-out stop completes with reason "stopped" once the gain reaches silence', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2 });
    render(mixer, 10);

    mixer.stopCue('a', 0.2); // 200 frames at SR=1000
    render(mixer, 150);
    assert.equal(completions.length, 0, 'still fading, must not complete early');
    render(mixer, 100);
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'stopped' }]);
});

test('getStatus reports a fade-out in progress with a shrinking remaining time', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2 });
    render(mixer, 10);
    assert.equal(statusOf(mixer, 'a').isFadingOut, false);
    assert.equal(statusOf(mixer, 'a').fadeRemainingSec, 0);

    mixer.stopCue('a', 0.5);
    const start = statusOf(mixer, 'a');
    assert.equal(start.isFadingOut, true);
    assert.equal(start.isFadingIn, false);
    assert.ok(Math.abs(start.fadeRemainingSec - 0.5) < 0.01, `expected ~0.5s, got ${start.fadeRemainingSec}`);

    render(mixer, 200);
    const mid = statusOf(mixer, 'a');
    assert.equal(mid.isFadingOut, true);
    assert.ok(Math.abs(mid.fadeRemainingSec - 0.3) < 0.01, `expected ~0.3s, got ${mid.fadeRemainingSec}`);
});

test('getStatus reports a fade-in until the cue reaches its target volume', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2, fadeInTime: 0.1, volume: 0.8 });

    const start = statusOf(mixer, 'a');
    assert.equal(start.isFadingIn, true);
    assert.equal(start.isFadingOut, false);
    assert.ok(Math.abs(start.fadeRemainingSec - 0.1) < 0.01);

    render(mixer, 150);
    const after = statusOf(mixer, 'a');
    assert.equal(after.isFadingIn, false);
    assert.equal(after.fadeRemainingSec, 0);
    assert.equal(after.currentGain, 0.8);
});

test('fade-in ramps output level up from silence', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(5000, 1), { sampleRate: SR, channels: 2, fadeInTime: 0.1 });
    const out = render(mixer, 100);
    assert.ok(out[0] < 0.05, 'first frame should be near-silent');
    assert.ok(out[2 * 50] > 0.4 && out[2 * 50] < 0.6, 'halfway through the fade should be ~half level');
});

test('a paused cue produces no output and does not advance', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(1000), { sampleRate: SR, channels: 2 });
    render(mixer, 50);
    mixer.pauseCue('a');
    const before = statusOf(mixer, 'a').positionSec;

    const out = render(mixer, 100);
    assert.ok(out.every((s) => s === 0));
    assert.equal(statusOf(mixer, 'a').positionSec, before);

    assert.equal(mixer.pauseCue('a'), false, 'pausing twice reports no change');
    assert.equal(mixer.resumeCue('a'), true);
    render(mixer, 10);
    assert.ok(statusOf(mixer, 'a').positionSec > before);
});

test('a looping cue wraps back to its trim start instead of completing', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(100), { sampleRate: SR, channels: 2, loop: true });
    render(mixer, 350);
    assert.equal(completions.length, 0);
    assert.equal(mixer.getStatus().activeCount, 1);
});

test('trim start/end bound the region that plays', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(1000), {
        sampleRate: SR, channels: 2, trimStartTime: 0.2, trimEndTime: 0.3,
    });
    const st = statusOf(mixer, 'a');
    assert.equal(st.trimStartSec, 0.2);
    assert.equal(st.trimEndSec, 0.3);
    render(mixer, 99);
    assert.equal(completions.length, 0);
    render(mixer, 5);
    assert.equal(completions.length, 1);
});

test('output patch routes a cue to the chosen output channels', () => {
    const mixer = new SoundboardMixer({ sampleRate: SR, channelCount: 4 });
    mixer.playCue('a', constBuffer(100, 0.5), { sampleRate: SR, channels: 2, outputPatch: [2, 3] });
    const out = render(mixer, 1, 4);
    assert.deepEqual(Array.from(out), [0, 0, 0.5, 0.5]);
});

test('both sides patched to one output fold down: L and R mixed at half each (WO-005)', () => {
    const mixer = new SoundboardMixer({ sampleRate: SR, channelCount: 2 });
    const stereo = new Float32Array(200);
    for (let i = 0; i < 100; i++) { stereo[i * 2] = 0.4; stereo[i * 2 + 1] = 0.2; }
    mixer.playCue('a', stereo, { sampleRate: SR, channels: 2, outputPatch: [1, 1] });
    assert.deepEqual(Array.from(render(mixer, 1)).map((v) => +v.toFixed(6)), [0, 0.3]);

    // A mono file (L = R) keeps its level when folded.
    mixer.playCue('a', constBuffer(100, 0.5), { sampleRate: SR, channels: 2, outputPatch: [0, 0] });
    assert.deepEqual(Array.from(render(mixer, 1)), [0.5, 0]);
    assert.equal(mixer.drainPeakLevels().a, 0.5);
});

test('output patch channels beyond the device are clamped, not written out of bounds', () => {
    const mixer = new SoundboardMixer({ sampleRate: SR, channelCount: 2 });
    mixer.playCue('a', constBuffer(100, 0.5), { sampleRate: SR, channels: 2, outputPatch: [7, 9] });
    assert.deepEqual(statusOf(mixer, 'a').outputPatch, [1, 1]);
});

test('multiple cues are summed and master gain scales the mix', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(100, 0.25), { sampleRate: SR, channels: 2 });
    mixer.playCue('b', constBuffer(100, 0.25), { sampleRate: SR, channels: 2 });
    assert.equal(render(mixer, 1)[0], 0.5);

    mixer.setMasterGain(0.5);
    assert.equal(render(mixer, 1)[0], 0.25);

    mixer.setMasterGain(99);
    assert.equal(mixer.masterGain, 2, 'master gain is clamped to 2');
});

test('drainPeakLevels returns the peak since the last drain, then resets it', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(1000, 0.4), { sampleRate: SR, channels: 2 });
    render(mixer, 10);
    assert.ok(Math.abs(mixer.drainPeakLevels().a - 0.4) < 1e-6);
    assert.equal(mixer.drainPeakLevels().a, 0);
});

test('stop/pause/resume on an unknown cue report false instead of throwing', () => {
    const { mixer } = makeMixer();
    assert.equal(mixer.stopCue('missing'), false);
    assert.equal(mixer.pauseCue('missing'), false);
    assert.equal(mixer.resumeCue('missing'), false);
    assert.equal(mixer.setGain('missing', 1), false);
});

// --- Voices (play new instance) ------------------------------------------

test('a new instance layers a second voice; a normal play replaces all voices', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(1000, 0.25), { sampleRate: SR, channels: 2 });
    mixer.playCue('a', constBuffer(1000, 0.25), { sampleRate: SR, channels: 2, newInstance: true });
    assert.equal(mixer.voiceCount('a'), 2);
    assert.equal(render(mixer, 1)[0], 0.5, 'both voices are mixed');

    mixer.playCue('a', constBuffer(1000, 0.25), { sampleRate: SR, channels: 2 });
    assert.equal(mixer.voiceCount('a'), 1);
});

test('the cue completes only when its last voice ends', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(100), { sampleRate: SR, channels: 2 });
    render(mixer, 50);
    mixer.playCue('a', constBuffer(100), { sampleRate: SR, channels: 2, newInstance: true });

    render(mixer, 60); // first voice ends
    assert.equal(completions.length, 0);
    assert.equal(mixer.voiceCount('a'), 1);

    render(mixer, 60); // second voice ends
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'completed' }]);
});

test('stop, pause and resume apply to every voice of a cue', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2 });
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2, newInstance: true });

    assert.equal(mixer.pauseCue('a'), true);
    assert.ok(mixer.getStatus().playing.every((v) => v.isPaused));
    assert.equal(mixer.resumeCue('a'), true);
    assert.ok(mixer.getStatus().playing.every((v) => !v.isPaused));

    mixer.stopCue('a', 0.1);
    render(mixer, 150);
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'stopped' }], 'one completion for the cue, not one per voice');
});

test('peak level for a cue is the loudest of its voices', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(1000, 0.2), { sampleRate: SR, channels: 2, outputPatch: [0, 0] });
    mixer.playCue('a', constBuffer(1000, 0.3), { sampleRate: SR, channels: 2, newInstance: true, outputPatch: [1, 1] });
    render(mixer, 5);
    assert.ok(Math.abs(mixer.drainPeakLevels().a - 0.3) < 1e-6);
});

// --- Ducking ----------------------------------------------------------------

test('setDuck ramps a cue down to the duck level and back, independent of its volume', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(10000, 1), { sampleRate: SR, channels: 2, volume: 0.5 });
    assert.equal(render(mixer, 1)[0], 0.5);

    mixer.setDuck('a', 0.2, 0.1); // to 20% over 100 frames
    assert.equal(statusOf(mixer, 'a').isDucked, true);
    const mid = render(mixer, 50);
    assert.ok(mid[2 * 49] < 0.5 && mid[2 * 49] > 0.1, 'partway through the duck ramp');
    render(mixer, 60);
    assert.ok(Math.abs(render(mixer, 1)[0] - 0.1) < 1e-6, 'ducked to 0.5 * 0.2');

    mixer.setDuck('a', 1, 0.1);
    assert.equal(statusOf(mixer, 'a').isDucked, false);
    render(mixer, 120);
    assert.ok(Math.abs(render(mixer, 1)[0] - 0.5) < 1e-6, 'back to its own volume');
});

test('a cue can start already ducked', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(1000, 1), { sampleRate: SR, channels: 2, duckGain: 0.25 });
    assert.equal(render(mixer, 1)[0], 0.25);
    assert.equal(statusOf(mixer, 'a').isDucked, true);
});

test('ducking does not disturb a fade-out in progress (and the fade still completes)', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(10000, 1), { sampleRate: SR, channels: 2 });
    mixer.stopCue('a', 0.2);
    render(mixer, 50);
    mixer.setDuck('a', 0.5, 0.05);
    assert.equal(statusOf(mixer, 'a').isFadingOut, true);
    render(mixer, 200);
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'stopped' }]);
});

test('setGain changes a playing cue\'s volume with a short ramp, but never revives a fade-out', () => {
    const { mixer } = makeMixer();
    mixer.playCue('a', constBuffer(10000, 1), { sampleRate: SR, channels: 2, volume: 1 });
    mixer.setGain('a', 0.25, 0.01);
    render(mixer, 20);
    assert.equal(render(mixer, 1)[0], 0.25);

    mixer.stopCue('a', 0.5);
    mixer.setGain('a', 1);
    assert.equal(statusOf(mixer, 'a').isFadingOut, true);
    assert.equal(statusOf(mixer, 'a').volume, 1);
});

test('a fade-out stop on a voice that is already silent completes (fade-in not yet started)', () => {
    // Regression: the ramp from gain 0 to 0 has a step of 0, and the
    // "reached silence" check only ran while ramping - so the voice stayed
    // forever, silent but still counted as playing.
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2, fadeInTime: 0.4 });
    mixer.stopCue('a', 0.4);
    render(mixer, 10);
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'stopped' }]);
});

test('a fade-out stop on a volume-0 cue completes', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('a', constBuffer(5000), { sampleRate: SR, channels: 2, volume: 0 });
    render(mixer, 10);
    mixer.stopCue('a', 1);
    render(mixer, 10);
    assert.deepEqual(completions, [{ cueId: 'a', reason: 'stopped' }]);
});

test('a queued next buffer follows on in the same render, with no gap (WO-006)', () => {
    const { mixer, completions } = makeMixer();
    const advances = [];
    mixer.setCueAdvanceCallback((cueId, token) => advances.push({ cueId, token }));
    mixer.playCue('p', constBuffer(10, 0.1), { sampleRate: SR, channels: 2 });
    mixer.queueNext('p', constBuffer(100, 0.2), { sampleRate: SR, channels: 2, trimStartTime: 0.005, token: 7 });
    const out = render(mixer, 16);
    const left = Array.from(out).filter((_, i) => i % 2 === 0).map((v) => +v.toFixed(6));
    assert.deepEqual(left, [...Array(10).fill(0.1), ...Array(6).fill(0.2)]);
    assert.deepEqual(advances, [{ cueId: 'p', token: 7 }]);
    assert.deepEqual(completions, []);
    // Now on the next buffer, from its trim start (frame 5) on.
    const status = statusOf(mixer, 'p');
    assert.equal(status.positionSec, 0.011);
    assert.equal(status.trimStartSec, 0.005);
});

test('without a queued next, or after a stop, the voice ends as before', () => {
    const { mixer, completions } = makeMixer();
    mixer.playCue('p', constBuffer(10, 0.1), { sampleRate: SR, channels: 2, fadeInTime: 0 });
    mixer.queueNext('p', constBuffer(100, 0.2), { sampleRate: SR, channels: 2, token: 1 });
    mixer.clearNext('p');
    render(mixer, 16);
    assert.deepEqual(completions, [{ cueId: 'p', reason: 'completed' }]);

    // A voice fading out when it reaches its end doesn't move on either.
    mixer.playCue('q', constBuffer(10, 0.1), { sampleRate: SR, channels: 2 });
    mixer.queueNext('q', constBuffer(100, 0.2), { sampleRate: SR, channels: 2, token: 2 });
    mixer.stopCue('q', 1);
    render(mixer, 16);
    assert.equal(mixer.hasCue('q'), false);
    assert.deepEqual(completions[1], { cueId: 'q', reason: 'completed' });
});
