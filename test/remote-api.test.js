/**
 * The /api/remote/* endpoints specifically (src/backend/routes/remote.js) -
 * a separate set of route handlers from /api/cues/*, and the ones actually
 * used by Bitfocus Companion and the HTTP remote control page. They call
 * the same cueManager methods as /api/cues/*, but a bug in response
 * shaping or status-code mapping can exist independently in either file
 * (this suite has already found one bug unique to a route file that looked
 * identical to its sibling at a glance - see the Range-request fix in
 * audio-files.test.js).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { uploadTestAudio, pollUntil, useServer } = require('./helpers/harness');

const server = useServer();

let cueId;

test('uploads audio and creates a cue to drive via /api/remote', async () => {
    const audioFile = await uploadTestAudio(server.baseUrl(), { name: 'Remote API Audio', filename: 'remote-api.wav' });
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Remote API Cue',
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
            volume: 0.05,
        }),
    });
    const body = await res.json();
    assert.equal(body.success, true);
    cueId = body.cue.id;
});

test('GET /api/remote/cues lists the cue in the remote-formatted shape', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const cue = body.cues.find((c) => c.id === cueId);
    assert.ok(cue, 'cue should be present in the remote cue list');
    assert.equal(cue.type, 'single_file');
    assert.equal(cue.status, 'stopped');
});

test('POST /api/remote/cues/:id/trigger starts playback', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues/${cueId}/trigger`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await pollUntil(async () => {
        const r = await fetch(`${server.baseUrl()}/api/remote/cues`);
        const b = await r.json();
        return b.cues.find((c) => c.id === cueId)?.status === 'playing' ? true : null;
    }, { timeoutMs: 5000 });
});

test('GET /api/remote/status reflects the playing cue', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.status.playingCues.includes(cueId));
    assert.equal(body.status.totalPlaying, 1);
});

test('GET /api/remote/health reports playback counts', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.health.status, 'healthy');
    assert.equal(body.health.playback.totalPlaying, 1);
    assert.ok(body.health.playback.playingCues.includes(cueId));
});

test('POST /api/remote/cues/:id/stop stops playback', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues/${cueId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await pollUntil(async () => {
        const r = await fetch(`${server.baseUrl()}/api/remote/cues`);
        const b = await r.json();
        return b.cues.find((c) => c.id === cueId)?.status === 'stopped' ? true : null;
    }, { timeoutMs: 5000 });
});

test('trigger on a nonexistent cue via /api/remote returns a clean error, not a 500', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues/00000000-0000-4000-8000-000000000000/trigger`, {
        method: 'POST',
    });
    assert.notEqual(res.status, 500);
    const body = await res.json();
    assert.equal(body.success, false);
});

test('POST /api/remote/cues/stop-all stops everything', async () => {
    await fetch(`${server.baseUrl()}/api/remote/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => {
        const r = await fetch(`${server.baseUrl()}/api/remote/status`);
        const b = await r.json();
        return b.status.totalPlaying >= 1 ? true : null;
    }, { timeoutMs: 5000 });

    const res = await fetch(`${server.baseUrl()}/api/remote/cues/stop-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const statusRes = await fetch(`${server.baseUrl()}/api/remote/status`);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.status.totalPlaying, 0);
});

test('POST /api/remote/cues/:id/playlist/navigate rejects a non-playlist cue', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues/${cueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'next' }),
    });
    assert.notEqual(res.status, 200);
});

test('POST /api/remote/cues/:id/playlist/navigate rejects a missing direction', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues/${cueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
});

test('GET /api/remote/info reports server identity and network info', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/info`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.info.name, 'acCompaniment');
    // Note: info.httpPort comes from the saved config (default 3333 here,
    // since this test never changes it), which is not necessarily the
    // actual port this test server is listening on - the harness starts
    // it on a random free port via an explicit PORT env var, and the
    // config file is never rewritten to match a PORT override.
    assert.equal(body.info.httpPort, 3333);
    assert.ok(Array.isArray(body.info.networkInterfaces));
    assert.ok(Array.isArray(body.info.features.audioFormats));
});
