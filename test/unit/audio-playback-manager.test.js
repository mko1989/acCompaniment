/**
 * Unit tests for AudioPlaybackManager's stop logic, with a real mixer but no
 * RtAudio stream. The `fading` flag in stopCue()'s result is a contract
 * cueManager depends on: if it says "fading" when the mixer actually stopped
 * immediately, nothing ever reports the cue as stopped and its button stays
 * "playing" forever (the Stop All bug this suite guards against).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const AudioPlaybackManager = require('../../src/backend/audioPlaybackManager');
const SoundboardMixer = require('../../src/backend/soundboardMixer');

const SR = 1000;

/** A manager with a live mixer and the given cues "playing" in it. */
function managerWith(cues) {
    const apm = new AudioPlaybackManager();
    apm.mixer = new SoundboardMixer({ sampleRate: SR, channelCount: 2 });
    const ended = [];
    apm.mixer.setCueCompleteCallback((cueId, reason) => apm.handlePlaybackEnd(cueId, reason));
    apm.setPlaybackEndCallback((cueId, reason) => ended.push({ cueId, reason }));

    for (const { id, fadeOutTime = 0, isPaused = false } of cues) {
        apm.mixer.playCue(id, new Float32Array(10000 * 2).fill(0.1), { sampleRate: SR, channels: 2 });
        if (isPaused) apm.mixer.pauseCue(id);
        apm.playingCues.set(id, { cueId: id, fadeOutTime, isPaused });
    }
    return { apm, ended };
}

function render(apm, frames) {
    apm.mixer.render(new Float32Array(frames * 2), frames, 2);
}

test('stopCue without fade stops immediately and reports fading: false', async () => {
    const { apm } = managerWith([{ id: 'a', fadeOutTime: 2 }]);
    const result = await apm.stopCue('a', false);
    assert.deepEqual(result, { success: true, fading: false });
    assert.equal(apm.playingCues.has('a'), false);
    assert.equal(apm.mixer.getStatus().activeCount, 0);
});

test('stopCue with fade uses the cue\'s own fadeOutTime and reports fading: true', async () => {
    const { apm, ended } = managerWith([{ id: 'a', fadeOutTime: 0.1 }]);
    const result = await apm.stopCue('a', true);
    assert.deepEqual(result, { success: true, fading: true });
    assert.equal(apm.playingCues.has('a'), true, 'still playing until the fade finishes');

    render(apm, 150);
    assert.deepEqual(ended, [{ cueId: 'a', reason: 'stopped' }]);
    assert.equal(apm.playingCues.has('a'), false);
});

test('a fade request on a cue whose fadeOutTime is 0 is an immediate stop, reported as fading: false', async () => {
    const { apm, ended } = managerWith([{ id: 'a', fadeOutTime: 0 }]);
    const result = await apm.stopCue('a', true);
    assert.equal(result.fading, false);
    assert.equal(apm.playingCues.has('a'), false);
    render(apm, 100);
    assert.equal(ended.length, 0, 'the mixer never reports an immediate stop - the caller must');
});

test('a fade override replaces the cue\'s fadeOutTime', async () => {
    const { apm } = managerWith([{ id: 'a', fadeOutTime: 0 }]);
    const result = await apm.stopCue('a', true, 0.5);
    assert.equal(result.fading, true);
    const status = apm.mixer.getStatus().playing[0];
    assert.equal(status.isFadingOut, true);
    assert.ok(Math.abs(status.fadeRemainingSec - 0.5) < 0.01);
});

test('fading a paused cue stops it immediately, since a paused cue\'s fade would never advance', async () => {
    const { apm } = managerWith([{ id: 'a', fadeOutTime: 1, isPaused: true }]);
    const result = await apm.stopCue('a', true);
    assert.equal(result.fading, false);
    assert.equal(apm.mixer.getStatus().activeCount, 0);
});

test('stopAllCues reports, per cue, whether it is fading', async () => {
    const { apm } = managerWith([
        { id: 'a', fadeOutTime: 0 },
        { id: 'b', fadeOutTime: 0 },
        { id: 'c', fadeOutTime: 0, isPaused: true },
    ]);
    const result = await apm.stopAllCues(true, 0.2);
    assert.equal(result.success, true);
    const byId = Object.fromEntries(result.results.map((r) => [r.cueId, r.fading]));
    assert.deepEqual(byId, { a: true, b: true, c: false });
});

test('stopAllCues with a zero fade override stops everything immediately', async () => {
    const { apm } = managerWith([{ id: 'a', fadeOutTime: 3 }, { id: 'b', fadeOutTime: 3 }]);
    const result = await apm.stopAllCues(true, 0);
    assert.ok(result.results.every((r) => r.fading === false));
    assert.equal(apm.playingCues.size, 0);
});

test('stopCue on a cue that is not playing succeeds as a no-op', async () => {
    const { apm } = managerWith([]);
    assert.deepEqual(await apm.stopCue('nope', true), { success: true, fading: false });
});

test('pause/resume/toggle track the paused state and refuse invalid transitions', async () => {
    const { apm } = managerWith([{ id: 'a' }]);
    assert.equal((await apm.resumeCue('a')).success, false, 'cannot resume a cue that is not paused');
    assert.deepEqual(await apm.togglePauseCue('a'), { success: true, status: 'paused' });
    assert.equal((await apm.pauseCue('a')).success, false, 'cannot pause twice');
    assert.deepEqual(await apm.togglePauseCue('a'), { success: true, status: 'playing' });
    assert.equal((await apm.togglePauseCue('missing')).success, false);
});

test('master volume is clamped to 0-2 and pushed to the mixer', () => {
    const { apm } = managerWith([]);
    apm.setMasterVolume(5);
    assert.equal(apm.getMasterVolume(), 2);
    assert.equal(apm.mixer.masterGain, 2);
    apm.setMasterVolume(-1);
    assert.equal(apm.getMasterVolume(), 0);
});

test('playCue refuses cleanly when the engine is not initialized', async () => {
    const apm = new AudioPlaybackManager();
    const result = await apm.playCue('a', '/nonexistent.wav');
    assert.equal(result.success, false);
    assert.match(result.error, /not initialized/);
});
