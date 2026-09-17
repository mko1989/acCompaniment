/**
 * Playlist cue coverage: creation with multiple items, navigation
 * (next/previous, clamped at the ends), and playback of a playlist cue.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { uploadTestAudio, pollUntil, useServer } = require('./helpers/harness');

const server = useServer();

let itemA;
let itemB;
let playlistCueId;

test('uploads two audio files for a playlist', async () => {
    itemA = await uploadTestAudio(server.baseUrl(), { name: 'Playlist Item A', filename: 'item-a.wav' });
    itemB = await uploadTestAudio(server.baseUrl(), { name: 'Playlist Item B', filename: 'item-b.wav' });
    assert.ok(itemA.id);
    assert.ok(itemB.id);
    assert.notEqual(itemA.id, itemB.id);
});

test('creates a playlist cue with both items', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Smoke Test Playlist',
            type: 'playlist',
            volume: 0.05,
            playlistItems: [
                { id: 'item-a', name: itemA.name, audioFileId: itemA.id, relativePath: itemA.relativePath },
                { id: 'item-b', name: itemB.name, audioFileId: itemB.id, relativePath: itemB.relativePath },
            ],
        }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.cue.type, 'playlist');
    assert.equal(body.cue.playlistItems.length, 2);
    assert.equal(body.cue.currentPlaylistIndex, 0);
    playlistCueId = body.cue.id;
});

test('each playlist item picked up its duration from the uploaded audio file', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}`);
    const body = await res.json();
    for (const item of body.cue.playlistItems) {
        assert.ok(item.knownDuration > 0, `playlist item ${item.name} should have a known duration`);
    }
});

test('navigates the playlist forward', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'next' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.newIndex, 1);

    const cueRes = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}`);
    const cueBody = await cueRes.json();
    assert.equal(cueBody.cue.currentPlaylistIndex, 1);
});

test('navigating forward past the last item clamps at the end', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'next' }),
    });
    const body = await res.json();
    assert.equal(body.newIndex, 1, 'index should stay clamped at the last item (index 1 of 2)');
});

test('navigates the playlist backward to the first item', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'previous' }),
    });
    const body = await res.json();
    assert.equal(body.newIndex, 0);
});

test('navigating backward past the first item clamps at zero', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'previous' }),
    });
    const body = await res.json();
    assert.equal(body.newIndex, 0);
});

test('rejects navigation with an invalid direction', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'sideways' }),
    });
    assert.equal(res.status, 400);
});

test('triggers and stops playlist playback', async () => {
    const triggerRes = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/trigger`, { method: 'POST' });
    assert.equal(triggerRes.status, 200);

    await pollUntil(async () => {
        const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}`);
        const body = await res.json();
        return body.cue?.status === 'playing' ? body : null;
    }, { timeoutMs: 5000 });

    const stopRes = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}/stop`, { method: 'POST' });
    assert.equal(stopRes.status, 200);

    await pollUntil(async () => {
        const res = await fetch(`${server.baseUrl()}/api/cues/${playlistCueId}`);
        const body = await res.json();
        return body.cue?.status === 'stopped' ? body : null;
    }, { timeoutMs: 5000 });
});

test('rejects playlist navigation on a non-playlist (or missing) cue', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/00000000-0000-4000-8000-000000000000/playlist/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'next' }),
    });
    // cueManager.navigatePlaylist returns the error string
    // 'Cue not found or not a playlist', which routes/cues.js's
    // notFoundStatus() only maps to 404 for the exact string 'Cue not
    // found' - anything else (including this one) falls through to 400.
    assert.equal(res.status, 400);
});
