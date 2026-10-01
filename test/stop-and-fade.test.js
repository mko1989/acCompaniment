/**
 * Stop / Stop All / fade behavior as a client sees it: both the REST status
 * and the WebSocket broadcasts the browser UI renders from. Covers the
 * reported "after Stop All, cues stay in playing state visually" bug (a
 * fade Stop All over cues with no fade of their own never broadcast
 * 'stopped'), the missing fading state on playback-time-update, and the
 * REST config route not reaching cueManager.
 *
 * Tests in this file change server-wide config (defaultStopAllFadeOutTime),
 * which is why they live together in one file - node:test runs a file's
 * tests sequentially, and each file gets its own server.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    uploadTestAudio, pollUntil, useServer, connectWs, waitForMessage, wsSend,
} = require('./helpers/harness');

const server = useServer();

async function createCue(overrides = {}) {
    const audioFile = await uploadTestAudio(server.baseUrl(), {
        name: `Fade Test Audio ${Math.random().toString(36).slice(2)}`,
        filename: `fade-${Math.random().toString(36).slice(2)}.wav`,
        durationSec: 10,
    });
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Fade Test Cue',
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
            volume: 0.05,
            ...overrides,
        }),
    });
    const body = await res.json();
    assert.equal(body.success, true, `createCue failed: ${body.error}`);
    return body.cue.id;
}

async function getStatus(cueId) {
    const res = await fetch(`${server.baseUrl()}/api/cues/${cueId}`);
    return (await res.json()).cue?.status;
}

async function waitForStatus(cueId, status, timeoutMs = 5000) {
    return pollUntil(async () => (await getStatus(cueId)) === status ? true : null, { timeoutMs });
}

async function post(path, body) {
    const res = await fetch(`${server.baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return res.json();
}

async function setConfig(updates) {
    const res = await fetch(`${server.baseUrl()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    const body = await res.json();
    assert.equal(body.success, true, `setConfig failed: ${body.error}`);
    return body.config;
}

async function playing(...cueIds) {
    for (const id of cueIds) await post(`/api/cues/${id}/trigger`);
    for (const id of cueIds) await waitForStatus(id, 'playing');
}

function waitForCueStatus(ws, cueId, status, timeoutMs = 5000) {
    return waitForMessage(
        ws,
        (m) => m.type === 'cue_status' && m.payload?.cueId === cueId && m.payload?.status === status,
        timeoutMs
    );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Stop All (fade) fades cues that have no fade of their own, then reports them stopped', async () => {
    // The reported bug: most cues have fadeOutTime 0. Stop All's fade mode
    // used each cue's own fade time, so those cues were cut instantly - and
    // because the server assumed a fade was running, it never broadcast
    // 'stopped' for them. The audio stopped; the buttons stayed "playing".
    await setConfig({ defaultStopAllFadeOutTime: 1200 });
    const cueA = await createCue({ fadeOutTime: 0 });
    const cueB = await createCue({ fadeOutTime: 0 });
    await playing(cueA, cueB);

    const ws = await connectWs(server.baseUrl());
    try {
        const stoppedA = waitForCueStatus(ws, cueA, 'stopped', 4000);
        const stoppedB = waitForCueStatus(ws, cueB, 'stopped', 4000);

        const body = await post('/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
        assert.equal(body.success, true);

        await sleep(500);
        assert.equal(await getStatus(cueA), 'playing', 'mid Stop All fade, cue A is still audible');
        assert.equal(await getStatus(cueB), 'playing', 'mid Stop All fade, cue B is still audible');

        await Promise.all([stoppedA, stoppedB]);
        assert.equal(await getStatus(cueA), 'stopped');
        assert.equal(await getStatus(cueB), 'stopped');
    } finally {
        ws.close();
    }
});

test('Stop All (fade) with a Stop All fade time of 0 stops at once and broadcasts "stopped" for every cue', async () => {
    await setConfig({ defaultStopAllFadeOutTime: 0 });
    const cueA = await createCue({ fadeOutTime: 0 });
    const cueB = await createCue({ fadeOutTime: 3000 });
    await playing(cueA, cueB);

    const ws = await connectWs(server.baseUrl());
    try {
        const stopped = Promise.all([
            waitForCueStatus(ws, cueA, 'stopped', 1500),
            waitForCueStatus(ws, cueB, 'stopped', 1500),
        ]);
        await post('/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
        await stopped;
        assert.equal(await getStatus(cueA), 'stopped');
        assert.equal(await getStatus(cueB), 'stopped');
    } finally {
        ws.close();
    }
});

test('a stopped cue can be triggered again straight after Stop All (no leftover "playing" state)', async () => {
    // With the stuck state, the server still thought the cue was playing,
    // so the next click ran its retrigger behavior instead of playing it.
    await setConfig({ defaultStopAllFadeOutTime: 0 });
    const cueId = await createCue({ fadeOutTime: 0, retriggerBehavior: 'stop' });
    await playing(cueId);
    await post('/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
    await waitForStatus(cueId, 'stopped');

    await post(`/api/cues/${cueId}/trigger`);
    await waitForStatus(cueId, 'playing');
    await post(`/api/cues/${cueId}/stop`);
});

test('the browser UI\'s stop_all_cues WebSocket message stops cues and broadcasts their status', async () => {
    await setConfig({ defaultStopAllFadeOutTime: 300 });
    const cueA = await createCue();
    const cueB = await createCue();
    await playing(cueA, cueB);

    const ws = await connectWs(server.baseUrl());
    try {
        const stopped = Promise.all([
            waitForCueStatus(ws, cueA, 'stopped', 3000),
            waitForCueStatus(ws, cueB, 'stopped', 3000),
        ]);
        const ack = waitForMessage(ws, (m) => m.type === 'all_cues_stopped');
        wsSend(ws, 'stop_all_cues', { behavior: 'fade_out_and_stop' });
        assert.equal((await ack).payload.success, true);
        await stopped;
    } finally {
        ws.close();
    }
});

test('plain Stop All (no fade) broadcasts "stopped" immediately', async () => {
    await setConfig({ defaultStopAllFadeOutTime: 5000 });
    const cueId = await createCue({ fadeOutTime: 5000 });
    await playing(cueId);

    const ws = await connectWs(server.baseUrl());
    try {
        const stopped = waitForCueStatus(ws, cueId, 'stopped', 1000);
        await post('/api/cues/stop-all', { behavior: 'stop' });
        await stopped;
    } finally {
        ws.close();
    }
});

test('playback-time-update reports the fade-out while it runs, with a shrinking remaining time', async () => {
    await setConfig({ defaultStopAllFadeOutTime: 2000 });
    const cueId = await createCue();
    await playing(cueId);

    const ws = await connectWs(server.baseUrl());
    try {
        const isFadeUpdate = (m) => m.type === 'playback-time-update'
            && m.payload?.cueId === cueId && m.payload.isFadingOut === true;

        // Before any fade, updates say not fading.
        const plain = await waitForMessage(ws, (m) => m.type === 'playback-time-update' && m.payload?.cueId === cueId);
        assert.equal(plain.payload.isFadingOut, false);
        assert.equal(plain.payload.fadeTimeRemainingMs, 0);

        const first = waitForMessage(ws, isFadeUpdate, 2000);
        await post('/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
        const early = (await first).payload;
        assert.equal(early.status, 'playing');
        assert.equal(early.isFadingIn, false);
        assert.ok(early.fadeTimeRemainingMs > 1000 && early.fadeTimeRemainingMs <= 2000,
            `expected most of the 2000ms fade left, got ${early.fadeTimeRemainingMs}`);

        await sleep(700);
        const later = (await waitForMessage(ws, isFadeUpdate, 2000)).payload;
        assert.ok(later.fadeTimeRemainingMs < early.fadeTimeRemainingMs - 300,
            `remaining time should count down (${early.fadeTimeRemainingMs} -> ${later.fadeTimeRemainingMs})`);

        await waitForCueStatus(ws, cueId, 'stopped', 3000);
    } finally {
        ws.close();
    }
});

test('playback-time-update reports a fade-in at the start of a cue with fadeInTime', async () => {
    const cueId = await createCue({ fadeInTime: 1500 });
    const ws = await connectWs(server.baseUrl());
    try {
        const fadingIn = waitForMessage(
            ws,
            (m) => m.type === 'playback-time-update' && m.payload?.cueId === cueId && m.payload.isFadingIn === true,
            3000
        );
        await post(`/api/cues/${cueId}/trigger`);
        const update = (await fadingIn).payload;
        assert.equal(update.isFadingOut, false);
        assert.ok(update.fadeTimeRemainingMs > 0 && update.fadeTimeRemainingMs <= 1500);

        const done = await waitForMessage(
            ws,
            (m) => m.type === 'playback-time-update' && m.payload?.cueId === cueId && m.payload.isFadingIn === false,
            4000
        );
        assert.equal(done.payload.fadeTimeRemainingMs, 0);
    } finally {
        ws.close();
        await post(`/api/cues/${cueId}/stop`);
    }
});

test('fade-out-and-stop on a paused cue stops it instead of leaving it stuck', async () => {
    // A paused cue renders nothing, so a fade on it would never progress
    // and never complete - the cue would be "playing" forever.
    const cueId = await createCue({ fadeOutTime: 1000, retriggerBehavior: 'fade_out_and_stop' });
    await playing(cueId);
    const pause = await post(`/api/cues/${cueId}/toggle-pause`);
    assert.equal(pause.status, 'paused');

    const ws = await connectWs(server.baseUrl());
    try {
        const stopped = waitForCueStatus(ws, cueId, 'stopped', 2000);
        await post('/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
        await stopped;
    } finally {
        ws.close();
    }
});

test('fade-out retrigger uses the cue\'s current fade time, even if edited mid-playback', async () => {
    // The server used to decide "a fade is running, wait for it" from the
    // cue's current settings while the engine faded with the time captured
    // at start - a mismatch that could leave the cue stuck "playing". The
    // fade length is now decided once, at stop time, from current settings.
    const cueId = await createCue({ fadeOutTime: 0, retriggerBehavior: 'fade_out_and_stop' });
    await playing(cueId);

    const upd = await fetch(`${server.baseUrl()}/api/cues/${cueId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fadeOutTime: 1200 }),
    });
    assert.equal((await upd.json()).success, true);

    const ws = await connectWs(server.baseUrl());
    try {
        const stopped = waitForCueStatus(ws, cueId, 'stopped', 4000);
        await post(`/api/cues/${cueId}/trigger`);
        await sleep(500);
        assert.equal(await getStatus(cueId), 'playing', 'still fading out over the edited 1200ms');
        await stopped;
    } finally {
        ws.close();
    }
});

test('fade-out retrigger on a cue with a fade-out time of 0 stops it instantly', async () => {
    // A fade of 0 is a plain stop - not the Stop All fade time, which
    // belongs to Stop All only.
    await setConfig({ defaultStopAllFadeOutTime: 3000 });
    const cueId = await createCue({ fadeOutTime: 0, retriggerBehavior: 'fade_out_and_stop' });
    await playing(cueId);
    const ws = await connectWs(server.baseUrl());
    try {
        const stopped = waitForCueStatus(ws, cueId, 'stopped', 1000);
        await post(`/api/cues/${cueId}/trigger`);
        await stopped;
        assert.equal(await getStatus(cueId), 'stopped');
    } finally {
        ws.close();
    }
});

test('a config change over REST is broadcast to open UIs', async () => {
    const ws = await connectWs(server.baseUrl());
    try {
        const broadcast = waitForMessage(
            ws,
            (m) => m.type === 'config-updated' && m.payload?.config?.defaultStopAllFadeOutTime === 777
        );
        await setConfig({ defaultStopAllFadeOutTime: 777 });
        await broadcast;
    } finally {
        ws.close();
    }
});
