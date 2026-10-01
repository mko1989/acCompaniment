/**
 * Crossfade mode (the XFADE toggle): while on, starting a cue fades every
 * other playing cue out and the new cue in, both over the configured
 * crossfadeTime. Checked against the audio engine's voices.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    useServer, waitForMessage, waitForReceived, wsSend,
} = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

async function setMode(enabled) {
    const res = await t.post('/api/remote/crossfade', { enabled });
    assert.equal(res.success, true);
    assert.equal(res.enabled, enabled);
}

async function voice(cueId) {
    return (await t.voices(cueId))[0] || null;
}

test('crossfade mode is off by default and can be switched on and off over REST', async () => {
    assert.deepEqual(await t.get('/api/remote/crossfade'), { success: true, enabled: false });
    await setMode(true);
    assert.equal((await t.get('/api/remote/crossfade')).enabled, true);
    assert.equal((await t.playback()).crossfadeMode, true);
    await setMode(false);
    assert.equal((await t.get('/api/remote/crossfade')).enabled, false);
});

test('rejects a crossfade mode that is not true/false', async () => {
    const res = await t.request('POST', '/api/remote/crossfade', { enabled: 'yes' });
    assert.equal(res.status, 400);
});

test('switching crossfade mode is broadcast, and a newly connected page is told the current mode', async () => {
    const socket = await t.ws();
    try {
        const on = waitForMessage(socket, (m) => m.type === 'crossfade-mode-updated' && m.payload.enabled === true);
        wsSend(socket, 'set_crossfade_mode', { enabled: true });
        await on;
    } finally {
        socket.close();
    }

    const late = await t.ws();
    try {
        const initial = await waitForReceived(late, (m) => m.type === 'crossfade-mode-updated');
        assert.equal(initial.payload.enabled, true);
    } finally {
        late.close();
        await setMode(false);
    }
});

test('with crossfade off, starting a cue leaves the others playing', async () => {
    const a = await t.createCue({}, 20);
    const b = await t.createCue({}, 20);
    await t.playing(a, b);
    const va = await voice(a);
    assert.equal(va.isFadingOut, false);
    assert.equal((await voice(b)).isFadingIn, false);
    await t.stopAll();
});

test('with crossfade on, starting a cue fades the playing ones out and the new one in', async () => {
    await t.setConfig({ crossfadeTime: 1500 });
    await setMode(true);
    try {
        const a = await t.createCue({}, 20);
        const c = await t.createCue({}, 20);
        const b = await t.createCue({}, 20);
        await t.playing(a);
        // Wait on outcomes rather than fixed sleeps - wall-clock margins
        // this thin fail on a machine that's busy with anything else.
        await t.waitFor(async () => (await voice(a))?.isFadingIn === false, 4000); // a's own crossfade-in
        await t.playing(c);
        await t.waitForStatus(a, 'stopped', 4000); // starting c crossfaded a out

        await t.trigger(b);
        const vc = await voice(c);
        const vb = await voice(b);
        assert.equal(vc.isFadingOut, true, 'the playing cue fades out');
        assert.equal(vb.isFadingIn, true, 'the new cue fades in');
        assert.ok(vb.gain < 0.05, 'the new cue starts from silence');

        await sleep(700);
        assert.equal(await t.status(c), 'playing', 'still audible mid-crossfade');
        await t.waitForStatus(c, 'stopped', 4000);
        assert.equal(await t.status(b), 'playing');
        await t.waitFor(async () => (await voice(b)).isFadingIn === false, 2000);
        assert.ok(Math.abs((await voice(b)).gain - 0.05) < 1e-6, 'the new cue reaches its own volume');
    } finally {
        await setMode(false);
        await t.stopAll();
    }
});

test('the crossfade length follows the configured crossfadeTime', async () => {
    await t.setConfig({ crossfadeTime: 400 });
    await setMode(true);
    try {
        const a = await t.createCue({}, 20);
        const b = await t.createCue({}, 20);
        await t.playing(a);
        const start = Date.now();
        await t.trigger(b);
        await t.waitForStatus(a, 'stopped', 3000);
        // 400ms configured: done well before the 2000ms default would be.
        assert.ok(Date.now() - start < 1800, `took ${Date.now() - start}ms`);
    } finally {
        await setMode(false);
        await t.setConfig({ crossfadeTime: 2000 });
        await t.stopAll();
    }
});

test('with crossfade on, retriggering a playing cue (restart) does not fade out the others', async () => {
    await t.setConfig({ crossfadeTime: 300 });
    try {
        const other = await t.createCue({}, 20);
        const b = await t.createCue({ retriggerBehavior: 'restart' }, 20);
        await t.playing(other, b); // crossfade still off: both just start
        await setMode(true);
        await t.trigger(b); // a restart, not a new cue starting
        assert.equal((await voice(other)).isFadingOut, false);
        await sleep(600); // well past the 300ms crossfade time
        assert.equal(await t.status(other), 'playing');
        assert.ok((await voice(b)).positionSec < 1, 'b restarted');
    } finally {
        await setMode(false);
        await t.setConfig({ crossfadeTime: 2000 });
        await t.stopAll();
    }
});

test('with crossfade on, a playlist moving to its next item does not fade out other cues', async () => {
    const other = await t.createCue({}, 20);
    const list = await t.createPlaylist(2, {}, 1);
    await t.playing(other);
    await t.playing(list);
    await setMode(true);
    try {
        await t.waitFor(async () => (await t.getCue(list)).currentPlaylistIndex === 1, 3000);
        await sleep(200);
        assert.equal((await voice(other)).isFadingOut, false);
        assert.equal(await t.status(other), 'playing');
    } finally {
        await setMode(false);
        await t.stopAll();
    }
});
