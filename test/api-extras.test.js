/**
 * API behaviour added or changed alongside the new features: cue reordering
 * (REST and the UI's WebSocket call), creating a cue with a client-chosen
 * id, what trigger responses report, Stop All defaulting to the configured
 * behavior, and the engine voice snapshot in the playback status.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer, wsInvoke } = require('./helpers/harness');
const { api } = require('./helpers/api');

const server = useServer();
const t = api(server);

async function cueOrder() {
    return (await t.get('/api/cues')).cues.map((c) => c.id);
}

test('POST /api/cues/reorder reorders the cues and the order persists in the listing', async () => {
    const a = await t.createCue({ name: 'A' });
    const b = await t.createCue({ name: 'B' });
    const c = await t.createCue({ name: 'C' });
    const before = await cueOrder();
    const res = await t.post('/api/cues/reorder', { cueIds: [c, a, b] });
    assert.equal(res.success, true);
    const after = await cueOrder();
    const ours = after.filter((id) => [a, b, c].includes(id));
    assert.deepEqual(ours, [c, a, b]);
    assert.equal(after.length, before.length, 'no cue lost or duplicated');
});

test('reorder keeps cues it was not told about, and ignores unknown or repeated ids', async () => {
    const x = await t.createCue({ name: 'X' });
    const y = await t.createCue({ name: 'Y' });
    const before = await cueOrder();
    await t.post('/api/cues/reorder', { cueIds: [y, y, 'not-a-cue'] });
    const after = await cueOrder();
    assert.equal(after[0], y);
    assert.equal(after.length, before.length);
    assert.ok(after.includes(x));
});

test('reorder rejects a body without a cueIds array', async () => {
    const res = await t.request('POST', '/api/cues/reorder', { cueIds: 'nope' });
    assert.equal(res.status, 400);
});

test('the UI\'s save-reordered-cues WebSocket call reorders and broadcasts the new order', async () => {
    const a = await t.createCue({ name: 'WS A' });
    const b = await t.createCue({ name: 'WS B' });
    const socket = await t.ws();
    try {
        const cues = (await t.get('/api/cues')).cues;
        const reordered = [cues.find((c) => c.id === b), cues.find((c) => c.id === a), ...cues.filter((c) => c.id !== a && c.id !== b)];
        const response = await wsInvoke(socket, 'save-reordered-cues', reordered);
        assert.equal(response.payload.success, true);
        const order = await cueOrder();
        assert.equal(order[0], b);
        assert.equal(order[1], a);
    } finally {
        socket.close();
    }
});

test('add-or-update-cue with a new client-chosen id creates the cue with that id', async () => {
    const audio = await t.upload(1);
    const id = '9b2f4c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e';
    const socket = await t.ws();
    try {
        const response = await wsInvoke(socket, 'add-or-update-cue', {
            id, name: 'Client Id Cue', type: 'single_file', audioFileId: audio.id, relativePath: audio.relativePath,
        });
        assert.equal(response.payload.success, true);
        assert.equal(response.payload.cue.id, id);
        assert.equal((await t.getCue(id)).name, 'Client Id Cue');

        const again = await wsInvoke(socket, 'add-or-update-cue', { id, name: 'Client Id Cue (edited)' });
        assert.equal(again.payload.success, true);
        assert.equal((await t.getCue(id)).name, 'Client Id Cue (edited)');
        const count = (await t.get('/api/cues')).cues.filter((c) => c.id === id).length;
        assert.equal(count, 1, 'the second call updated rather than duplicated');
    } finally {
        socket.close();
    }
});

test('trigger responses report the resulting status', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'toggle_pause_play' });
    assert.equal((await t.trigger(cueId)).status, 'playing');
    assert.equal((await t.trigger(cueId)).status, 'paused');
    assert.equal((await t.post(`/api/remote/cues/${cueId}/trigger`)).status, 'playing');
    await t.stop(cueId);
});

test('Stop All without a behavior uses the configured Stop All behavior', async () => {
    await t.setConfig({ defaultStopAllBehavior: 'fade_out_and_stop', defaultStopAllFadeOutTime: 800 });
    try {
        const cueId = await t.createCue();
        await t.playing(cueId);
        await t.post('/api/remote/cues/stop-all', {});
        assert.equal((await t.voices(cueId))[0]?.isFadingOut, true, 'fading, not cut');
        await t.waitForStatus(cueId, 'stopped', 2000);
    } finally {
        await t.setConfig({ defaultStopAllBehavior: 'stop', defaultStopAllFadeOutTime: 1500 });
    }
});

test('an explicit Stop All behavior overrides the configured one', async () => {
    await t.setConfig({ defaultStopAllBehavior: 'fade_out_and_stop', defaultStopAllFadeOutTime: 3000 });
    try {
        const cueId = await t.createCue();
        await t.playing(cueId);
        await t.post('/api/cues/stop-all', { behavior: 'stop' });
        assert.equal(await t.status(cueId), 'stopped');
    } finally {
        await t.setConfig({ defaultStopAllBehavior: 'stop' });
    }
});

test('the playback status lists what the engine is playing, voice by voice', async () => {
    const cueId = await t.createCue({ volume: 0.25, trimStartTime: 1 });
    await t.playing(cueId);
    const [voice] = await t.voices(cueId);
    assert.equal(voice.volume, 0.25);
    assert.equal(voice.trimStartSec, 1);
    assert.equal(voice.isPaused, false);
    assert.equal(voice.isDucked, false);
    assert.equal(voice.duckGain, 1);
    assert.ok(typeof voice.voiceId === 'string');
    await t.stop(cueId);
    assert.equal((await t.voices(cueId)).length, 0);
});

test('the remote cue listing reports a volume of 0 as 0', async () => {
    const cueId = await t.createCue({ volume: 0 });
    const { cues } = await t.get('/api/remote/cues');
    assert.equal(cues.find((c) => c.id === cueId).volume, 0);
});

test('duckingFadeTime is validated', async () => {
    const bad = await t.request('PUT', '/api/config', { duckingFadeTime: -5 });
    assert.equal(bad.status, 400);
    const ok = await t.request('PUT', '/api/config', { duckingFadeTime: 250 });
    assert.equal(ok.status, 200);
    await t.setConfig({ duckingFadeTime: 1000 });
});

test('resetting the config reaches the playback engine too', async () => {
    await t.setConfig({ defaultStopAllBehavior: 'fade_out_and_stop', defaultStopAllFadeOutTime: 5000 });
    await t.post('/api/config/reset');
    const cueId = await t.createCue();
    await t.playing(cueId);
    await t.post('/api/remote/cues/stop-all', {});
    assert.equal(await t.status(cueId), 'stopped', 'reset config says Stop All = stop');
});
