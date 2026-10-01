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

// --- Auto-advance (playlistPlayMode) ----------------------------------------

async function createPlaylist(playlistPlayMode, extra = {}) {
    const items = [];
    for (const label of ['First', 'Second']) {
        const f = await uploadTestAudio(server.baseUrl(), {
            name: `Advance ${label} ${Math.random().toString(36).slice(2)}`,
            filename: `advance-${label}-${Math.random().toString(36).slice(2)}.wav`,
            durationSec: 1,
        });
        items.push({ id: `item-${label}`, name: f.name, audioFileId: f.id, relativePath: f.relativePath });
    }
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: `Advance ${playlistPlayMode}`, type: 'playlist', volume: 0.05,
            playlistPlayMode, playlistItems: items, ...extra,
        }),
    });
    return (await res.json()).cue.id;
}

async function cueState(cueId) {
    const body = await (await fetch(`${server.baseUrl()}/api/cues/${cueId}`)).json();
    return { status: body.cue.status, index: body.cue.currentPlaylistIndex };
}

test('"continue" mode plays the next item automatically when one finishes', async () => {
    const cueId = await createPlaylist('continue');
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => (await cueState(cueId)).status === 'playing');

    const advanced = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.index === 1 && s.status === 'playing' ? s : null;
    }, { timeoutMs: 4000 });
    assert.equal(advanced.index, 1);

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('"continue" mode stops and resets to the first item after the last one', async () => {
    const cueId = await createPlaylist('continue');
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => (await cueState(cueId)).index === 1 ? true : null, { timeoutMs: 4000 });

    const done = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.status !== 'playing' ? s : null;
    }, { timeoutMs: 4000 });
    assert.equal(done.index, 0, 'should be back on the first item, ready to play the list again');
    assert.notEqual(done.status, 'playing');
});

test('"continue" mode with loop wraps back to the first item and keeps playing', async () => {
    const cueId = await createPlaylist('continue', { loop: true });
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => (await cueState(cueId)).index === 1 ? true : null, { timeoutMs: 4000 });

    const wrapped = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.index === 0 && s.status === 'playing' ? s : null;
    }, { timeoutMs: 4000 });
    assert.equal(wrapped.status, 'playing');

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('"stop_and_cue_next" mode stops after an item and cues the next one', async () => {
    const cueId = await createPlaylist('stop_and_cue_next');
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => (await cueState(cueId)).status === 'playing');

    const cued = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.status === 'cued_next' ? s : null;
    }, { timeoutMs: 4000 });
    assert.equal(cued.index, 1);

    // The next trigger plays the cued item.
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    const playingNext = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.status === 'playing' ? s : null;
    });
    assert.equal(playingNext.index, 1);
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('repeat-one re-cues the same item instead of advancing', async () => {
    const cueId = await createPlaylist('continue', { repeatOnePlaylistItem: true });
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => (await cueState(cueId)).status === 'playing');

    const cued = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.status === 'cued_next' ? s : null;
    }, { timeoutMs: 4000 });
    assert.equal(cued.index, 0);
});

test('a fade-out stop of a playlist does not advance it', async () => {
    const cueId = await createPlaylist('continue', { fadeOutTime: 200, retriggerBehavior: 'fade_out_and_stop' });
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    await pollUntil(async () => (await cueState(cueId)).status === 'playing');
    await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });

    const stopped = await pollUntil(async () => {
        const s = await cueState(cueId);
        return s.status === 'stopped' ? s : null;
    });
    assert.equal(stopped.index, 0);
});
