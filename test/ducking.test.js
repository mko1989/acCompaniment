/**
 * Ducking: while a cue marked "triggers ducking" is playing, every other
 * playing cue with "enable ducking" is lowered by the trigger's ducking
 * level (a percentage), and restored when the trigger stops. Checked
 * against the audio engine's actual duck gain for each cue.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

const DUCK_RAMP_MS = 1000; // default ducking fade time

async function duckGain(cueId) {
    const v = await t.voices(cueId);
    return v.length ? v[0].duckGain : null;
}

async function waitForDuckGain(cueId, target, timeoutMs = DUCK_RAMP_MS + 1500) {
    return t.waitFor(async () => {
        const g = await duckGain(cueId);
        return g !== null && Math.abs(g - target) < 0.01;
    }, timeoutMs);
}

async function bed(overrides = {}) {
    return t.createCue({ enableDucking: true, ...overrides }, 20);
}

async function trigger(level = 80, overrides = {}, durationSec = 20) {
    return t.createCue({ isDuckingTrigger: true, duckingLevel: level, ...overrides }, durationSec);
}

test('starting a trigger ducks a playing cue by the trigger\'s level, over about a second', async () => {
    const bedId = await bed();
    const trigId = await trigger(80);
    await t.playing(bedId);
    assert.equal(await duckGain(bedId), 1);

    await t.trigger(trigId);
    // It ramps rather than jumps: some reading lands strictly in between.
    await t.waitFor(async () => {
        const g = await duckGain(bedId);
        return g < 0.95 && g > 0.25;
    }, DUCK_RAMP_MS + 1000);
    await waitForDuckGain(bedId, 0.2);
    assert.equal(await duckGain(trigId), 1, 'the trigger itself is never ducked');

    await t.stop(trigId);
    await waitForDuckGain(bedId, 1);
    await t.stop(bedId);
});

test('stopping the trigger restores the ducked cue', async () => {
    const bedId = await bed();
    const trigId = await trigger(50);
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.5);
    await t.stop(trigId);
    await waitForDuckGain(bedId, 1);
    await t.stop(bedId);
});

test('cues without "enable ducking" are left alone', async () => {
    const plainId = await t.createCue({ enableDucking: false }, 20);
    const trigId = await trigger(80);
    await t.playing(plainId, trigId);
    await sleep(DUCK_RAMP_MS + 300);
    assert.equal(await duckGain(plainId), 1);
    await t.stopAll();
});

test('a duckable cue started while a trigger plays starts already ducked', async () => {
    const trigId = await trigger(75);
    const bedId = await bed();
    await t.playing(trigId);
    await t.playing(bedId);
    const g = await duckGain(bedId);
    assert.ok(Math.abs(g - 0.25) < 0.01, `should start at the ducked level, got ${g}`);
    await t.stopAll();
});

test('with two triggers the stronger duck wins, and the weaker takes over when it stops', async () => {
    const bedId = await bed();
    const strong = await trigger(90);
    const weak = await trigger(40);
    await t.playing(bedId, weak, strong);
    await waitForDuckGain(bedId, 0.1);

    await t.stop(strong);
    await waitForDuckGain(bedId, 0.6);

    await t.stop(weak);
    await waitForDuckGain(bedId, 1);
    await t.stop(bedId);
});

test('a paused trigger stops ducking; resuming it ducks again', async () => {
    const bedId = await bed();
    const trigId = await trigger(80);
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.2);

    await t.post(`/api/cues/${trigId}/toggle-pause`);
    await waitForDuckGain(bedId, 1);

    await t.post(`/api/cues/${trigId}/toggle-pause`);
    await waitForDuckGain(bedId, 0.2);
    await t.stopAll();
});

test('a trigger that plays to its end restores ducked cues', async () => {
    const bedId = await bed();
    const trigId = await trigger(80, {}, 1.5);
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.2);
    await t.waitForStatus(trigId, 'completed', 3000);
    await waitForDuckGain(bedId, 1);
    await t.stop(bedId);
});

test('a trigger that fades out keeps ducking until its fade finishes', async () => {
    const bedId = await bed();
    const trigId = await trigger(80, { fadeOutTime: 1500, retriggerBehavior: 'fade_out_and_stop' });
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.2);

    await t.trigger(trigId); // start the fade-out
    await sleep(600);
    assert.ok(Math.abs((await duckGain(bedId)) - 0.2) < 0.01, 'still ducked mid-fade');
    await t.waitForStatus(trigId, 'stopped', 3000);
    await waitForDuckGain(bedId, 1);
    await t.stop(bedId);
});

test('Stop All restores everything (nothing is left ducked)', async () => {
    const bedId = await bed();
    const trigId = await trigger(80);
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.2);
    await t.stop(trigId);
    await waitForDuckGain(bedId, 1);
    await t.stopAll();
    assert.equal((await t.voices(bedId)).length, 0);
});

test('changing the trigger\'s ducking level while it plays re-ducks to the new level', async () => {
    const bedId = await bed();
    const trigId = await trigger(80);
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.2);
    await t.updateCue(trigId, { duckingLevel: 30 });
    await waitForDuckGain(bedId, 0.7);
    await t.stopAll();
});

test('turning "enable ducking" off on a ducked cue restores it; turning it on ducks it', async () => {
    const bedId = await bed();
    const trigId = await trigger(80);
    await t.playing(bedId, trigId);
    await waitForDuckGain(bedId, 0.2);
    await t.updateCue(bedId, { enableDucking: false });
    await waitForDuckGain(bedId, 1);
    await t.updateCue(bedId, { enableDucking: true });
    await waitForDuckGain(bedId, 0.2);
    await t.stopAll();
});

test('making a playing cue a trigger (or not) ducks and restores the others live', async () => {
    const bedId = await bed();
    const otherId = await t.createCue({ duckingLevel: 60 }, 20);
    await t.playing(bedId, otherId);
    await t.updateCue(otherId, { isDuckingTrigger: true });
    await waitForDuckGain(bedId, 0.4);
    await t.updateCue(otherId, { isDuckingTrigger: false });
    await waitForDuckGain(bedId, 1);
    await t.stopAll();
});

test('a ducking level of 0 leaves cues at full level; 100 silences them', async () => {
    const bedId = await bed();
    const zero = await trigger(0);
    await t.playing(bedId, zero);
    await sleep(300);
    assert.equal(await duckGain(bedId), 1);
    await t.stop(zero);

    const full = await trigger(100);
    await t.playing(full);
    await waitForDuckGain(bedId, 0);
    await t.stopAll();
});

test('playback-time-update reports which cues are ducked, and by how much', async () => {
    const bedId = await bed();
    const trigId = await trigger(80);
    await t.playing(bedId);
    const socket = await t.ws();
    try {
        const unducked = await t.waitForTimeUpdate(socket, bedId);
        assert.equal(unducked.payload.isDucked, false);
        assert.equal(unducked.payload.duckGain, 1);

        await t.trigger(trigId);
        const ducked = await t.waitForTimeUpdate(socket, bedId, (p) => p.isDucked && p.duckGain < 0.21, 3000);
        assert.ok(ducked.payload.duckGain >= 0.19);
    } finally {
        socket.close();
        await t.stopAll();
    }
});

test('the ducking ramp time can be configured (duckingFadeTime)', async () => {
    await t.setConfig({ duckingFadeTime: 100 });
    try {
        const bedId = await bed();
        const trigId = await trigger(80);
        await t.playing(bedId);
        await t.trigger(trigId);
        await waitForDuckGain(bedId, 0.2, 600);
        await t.stopAll();
    } finally {
        await t.setConfig({ duckingFadeTime: 1000 });
    }
});
