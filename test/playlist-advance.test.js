/**
 * Playlist auto-advance against the server: what happens when an item ends by itself, in every
 * advance mode and with the options that change it (loop, repeat one, shuffle, pause, ducking,
 * edits while playing), with items in every format the app decodes. `test/playlist.test.js`
 * has the basics; `test/e2e/playlist-playback.spec.js` checks the browser follows along.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { useServer, makeTestWav } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');
const { ffmpegBinary } = require('./audio/lib/signals');

const server = useServer();
const t = api(server);

/** The playlist's index and status sampled every 50 ms, as "status@index" changes. */
async function trace(cueId, ms) {
    const seen = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const c = await t.getCue(cueId);
        const s = `${c.status}@${c.currentPlaylistIndex}`;
        if (seen[seen.length - 1] !== s) seen.push(s);
        await sleep(50);
    }
    return seen;
}

const index = async (cueId) => (await t.getCue(cueId)).currentPlaylistIndex;

async function waitForIndex(cueId, wanted, status = 'playing', timeoutMs = 4000) {
    return t.waitFor(async () => {
        const c = await t.getCue(cueId);
        return c.currentPlaylistIndex === wanted && c.status === status;
    }, timeoutMs);
}

// --- Item formats --------------------------------------------------------------------------

/** Uploads a 1 s tone converted to `ext` with the bundled ffmpeg (WO-034). */
async function uploadAs(ext) {
    const dir = fs.mkdtempSync(path.join(server.tempDataDir(), `fmt-${ext}-`));
    const wav = path.join(dir, 'source.wav');
    const out = path.join(dir, `item.${ext}`);
    fs.writeFileSync(wav, makeTestWav(1));
    execFileSync(ffmpegBinary(), ['-y', '-loglevel', 'error', '-i', wav, out]);
    const form = new FormData();
    form.append('audioFile', new Blob([fs.readFileSync(out)]), `item-${Math.random().toString(36).slice(2)}.${ext}`);
    form.append('name', `Item ${ext}`);
    const body = await (await fetch(`${server.baseUrl()}/api/audio/upload`, { method: 'POST', body: form })).json();
    assert.equal(body.success, true, `upload ${ext}: ${body.error}`);
    return body.audioFile;
}

for (const ext of ['mp3', 'flac', 'm4a', 'ogg']) {
    test(`continue: a playlist of ${ext} items plays every item, then stops (WO-054)`, async () => {
        const items = [];
        for (let i = 0; i < 3; i++) {
            const f = await uploadAs(ext);
            items.push({ id: `i${i}`, name: `Item ${i}`, audioFileId: f.id, relativePath: f.relativePath });
        }
        const created = await t.post('/api/cues', {
            name: `Formats ${ext}`, type: 'playlist', volume: 0.05, playlistItems: items, playlistPlayMode: 'continue',
        });
        const cueId = created.cue.id;
        await t.trigger(cueId);
        const seen = await trace(cueId, 5500);
        assert.deepEqual(seen, ['playing@0', 'playing@1', 'playing@2', 'stopped@0']);
    });
}

test('continue: items of different formats in one playlist hand over to each other', async () => {
    const items = [];
    for (const ext of ['mp3', 'wav', 'flac']) {
        const f = ext === 'wav' ? await t.upload(1) : await uploadAs(ext);
        items.push({ id: ext, name: ext, audioFileId: f.id, relativePath: f.relativePath });
    }
    const created = await t.post('/api/cues', {
        name: 'Mixed formats', type: 'playlist', volume: 0.05, playlistItems: items, playlistPlayMode: 'continue',
    });
    await t.trigger(created.cue.id);
    assert.deepEqual(await trace(created.cue.id, 5500), ['playing@0', 'playing@1', 'playing@2', 'stopped@0']);
});

// --- What the server tells the UI at a hand-over ----------------------------------------------

test('continue: no stopped or completed status is broadcast between items, one completed at the end', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'continue' });
    const socket = await t.ws();
    try {
        await t.trigger(cueId);
        await t.waitForCueStatus(socket, cueId, 'completed', 6000);
        await sleep(200);
        const statuses = socket.received
            .filter((m) => m.type === 'cue_status' && m.payload?.cueId === cueId)
            .map((m) => m.payload.status);
        const firstPlaying = statuses.indexOf('playing');
        assert.ok(firstPlaying >= 0, statuses.join(' '));
        const after = statuses.slice(firstPlaying);
        assert.equal(after.filter((s) => s === 'completed').length, 1, after.join(' '));
        assert.equal(after[after.length - 1], 'completed', after.join(' '));
        assert.ok(!after.includes('stopped'), after.join(' '));
    } finally {
        socket.close();
    }
});

test('continue: the time updates of each item start again from 0', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'continue' }, 2);
    const socket = await t.ws();
    try {
        await t.trigger(cueId);
        await waitForIndex(cueId, 1);
        const update = await t.waitForTimeUpdate(socket, cueId, () => true, 2000);
        assert.ok(update.payload.currentTimeSec < 1, `item 2 should start near 0, got ${update.payload.currentTimeSec}`);
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

// --- Modes and options ---------------------------------------------------------------------

test('stop_and_cue_next without loop: after the last item it stops on item 1, not cued', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'stop_and_cue_next' });
    await t.trigger(cueId);
    await waitForIndex(cueId, 1, 'cued_next');
    await t.trigger(cueId);
    await waitForIndex(cueId, 1, 'playing');
    await t.waitFor(async () => (await t.status(cueId)) !== 'playing', 4000);
    const c = await t.getCue(cueId);
    assert.equal(c.currentPlaylistIndex, 0);
    assert.notEqual(c.status, 'cued_next');
});

test('stop_and_cue_next + loop: after the last item it cues item 1', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'stop_and_cue_next', loop: true });
    await t.trigger(cueId);
    await waitForIndex(cueId, 1, 'cued_next');
    await t.trigger(cueId);
    await waitForIndex(cueId, 1, 'playing');
    await waitForIndex(cueId, 0, 'cued_next');
});

for (const [label, extra] of [
    ['stop_and_cue_next', { playlistPlayMode: 'stop_and_cue_next' }],
    ['loop', { playlistPlayMode: 'continue', loop: true }],
    ['shuffle', { playlistPlayMode: 'continue', shufflePlaylist: true }],
]) {
    test(`repeat one with ${label}: the item that played is cued again`, async () => {
        const cueId = await t.createPlaylist(3, { repeatOnePlaylistItem: true, ...extra });
        await t.trigger(cueId);
        await t.waitForStatus(cueId, 'playing');
        const first = await index(cueId);
        await t.waitForStatus(cueId, 'cued_next', 4000);
        assert.equal(await index(cueId), first);
        await t.trigger(cueId);
        await t.waitForStatus(cueId, 'playing');
        assert.equal(await index(cueId), first);
        await t.stop(cueId);
    });
}

test('continue + shuffle + loop keeps playing past the end of the list', async () => {
    // A reshuffle can start with the item that just ended, so the index need not change at the
    // wrap: what shows it went round is that it is still playing well past the list's 2 s.
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'continue', shufflePlaylist: true, loop: true });
    await t.trigger(cueId);
    const seen = await trace(cueId, 4500);
    assert.ok(seen.every((s) => s.startsWith('playing@')), seen.join(' '));
    assert.equal(await t.status(cueId), 'playing');
    await t.stop(cueId);
});

test('continue: a playlist of one item plays it once and stops', async () => {
    const cueId = await t.createPlaylist(1, { playlistPlayMode: 'continue' });
    await t.trigger(cueId);
    assert.deepEqual(await trace(cueId, 2500), ['playing@0', 'stopped@0']);
});

test('continue: pausing mid-item and resuming still goes on to the next item', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'continue', retriggerBehavior: 'toggle_pause_play' }, 2);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await sleep(500);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'paused');
    await sleep(2500); // longer than the item
    assert.equal(await index(cueId), 0, 'a paused item does not end');
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await waitForIndex(cueId, 1);
    await t.stop(cueId);
});

test('continue: starting a playlist on item 2 (navigated there) plays 2, 3, then stops', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'continue' });
    await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
    await t.trigger(cueId);
    assert.deepEqual(await trace(cueId, 4000), ['playing@1', 'playing@2', 'stopped@0']);
});

test('continue: an item with a trim plays only its trimmed part, then the next item', async () => {
    const a = await t.upload(4);
    const b = await t.upload(1);
    const created = await t.post('/api/cues', {
        name: 'Trimmed item', type: 'playlist', volume: 0.05, playlistPlayMode: 'continue',
        playlistItems: [
            { id: 'a', name: 'A', audioFileId: a.id, relativePath: a.relativePath, trimStartTime: 1, trimEndTime: 2 },
            { id: 'b', name: 'B', audioFileId: b.id, relativePath: b.relativePath },
        ],
    });
    const cueId = created.cue.id;
    await t.trigger(cueId);
    // 1 s of item A, not 4.
    await waitForIndex(cueId, 1, 'playing', 2500);
    await t.stop(cueId);
});

test('continue: the playlist\'s volume applies to the item it moves on to', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'continue', volume: 0.3 }, 1);
    await t.trigger(cueId);
    await waitForIndex(cueId, 1);
    await t.waitFor(async () => (await t.voices(cueId)).length > 0);
    await sleep(200);
    const [voice] = await t.voices(cueId);
    assert.ok(Math.abs(voice.gain - 0.3) < 0.02, JSON.stringify(voice));
    await t.stop(cueId);
});

// --- Edits while playing -------------------------------------------------------------------

test('continue: changing the playlist while it plays does not stop it moving on', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'continue' }, 2);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await t.updateCue(cueId, { name: 'Renamed while playing', fadeOutTime: 500 });
    await waitForIndex(cueId, 1, 'playing', 4000);
    await t.stop(cueId);
});

test('continue: adding an item to a playing playlist lets it play on into the new item', async () => {
    const cueId = await t.createPlaylist(1, { playlistPlayMode: 'continue' }, 2);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    const extra = await t.upload(1);
    const cue = await t.getCue(cueId);
    await t.updateCue(cueId, {
        playlistItems: [...cue.playlistItems, { id: 'added', name: 'Added', audioFileId: extra.id, relativePath: extra.relativePath }],
    });
    await waitForIndex(cueId, 1, 'playing', 4000);
    await t.stop(cueId);
});

test('switching a playing playlist to stop_and_cue_next takes effect when the item ends', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'continue' }, 2);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await t.updateCue(cueId, { playlistPlayMode: 'stop_and_cue_next' });
    await waitForIndex(cueId, 1, 'cued_next', 4000);
});

test('switching a playing playlist to continue makes it move on by itself', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'stop_and_cue_next' }, 2);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await t.updateCue(cueId, { playlistPlayMode: 'continue' });
    await waitForIndex(cueId, 1, 'playing', 4000);
    await t.stop(cueId);
});

// --- Ducking across a hand-over --------------------------------------------------------------

async function duckGain(cueId) {
    const v = await t.voices(cueId);
    return v.length ? v[0].duckGain : null;
}

test('a ducking-trigger playlist keeps the bed ducked across its item hand-over', async () => {
    const bedId = await t.createCue({ enableDucking: true }, 20);
    const listId = await t.createPlaylist(2, { playlistPlayMode: 'continue', isDuckingTrigger: true, duckingLevel: 80 }, 2);
    await t.playing(bedId);
    await t.trigger(listId);
    await t.waitFor(async () => Math.abs((await duckGain(bedId)) - 0.2) < 0.01, 2500);
    // Across the hand-over at 2 s the bed never comes back up.
    const end = Date.now() + 1500;
    while (Date.now() < end) {
        const g = await duckGain(bedId);
        assert.ok(g < 0.5, `bed came back up to ${g} at item ${await index(listId)}`);
        await sleep(50);
    }
    assert.equal(await index(listId), 1);
    await t.stop(listId);
    await t.stop(bedId);
});

test('a ducked playlist bed: the item it moves on to starts ducked', async () => {
    const listId = await t.createPlaylist(2, { playlistPlayMode: 'continue', enableDucking: true }, 1);
    const trigId = await t.createCue({ isDuckingTrigger: true, duckingLevel: 80 }, 20);
    await t.playing(listId);
    await t.trigger(trigId);
    await t.waitFor(async () => Math.abs((await duckGain(listId)) - 0.2) < 0.01, 2500);
    await waitForIndex(listId, 1);
    await t.waitFor(async () => (await t.voices(listId)).length > 0);
    const g = await duckGain(listId);
    assert.ok(Math.abs(g - 0.2) < 0.05, `the next item started at duck gain ${g}`);
    await t.stop(trigId);
    await t.stop(listId);
});

// --- Retrigger behaviors on a playing playlist --------------------------------------------------

test('retrigger restart on a playlist plays the current item from its start', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'continue', retriggerBehavior: 'restart' }, 3);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
    await waitForIndex(cueId, 1);
    await sleep(1200);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    const c = await t.getCue(cueId);
    assert.ok([0, 1].includes(c.currentPlaylistIndex), `restart: index ${c.currentPlaylistIndex}`);
    await t.waitFor(async () => (await t.voices(cueId)).length > 0);
    const [voice] = await t.voices(cueId);
    assert.ok(voice.positionSec < 1, JSON.stringify(voice));
    await t.stop(cueId);
});

for (const behavior of ['stop', 'fade_out_and_stop']) {
    test(`retrigger ${behavior} on a playlist stops it, and it does not move on afterwards`, async () => {
        const cueId = await t.createPlaylist(3, { playlistPlayMode: 'continue', retriggerBehavior: behavior, fadeOutTime: 200 }, 2);
        await t.trigger(cueId);
        await t.waitForStatus(cueId, 'playing');
        await t.trigger(cueId);
        await t.waitFor(async () => (await t.status(cueId)) !== 'playing', 2000);
        await sleep(2500);
        assert.notEqual(await t.status(cueId), 'playing');
    });
}

test('retrigger do_nothing on a playlist leaves it playing on, and it still moves on', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'continue', retriggerBehavior: 'do_nothing' }, 1);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'playing');
    await t.trigger(cueId);
    await waitForIndex(cueId, 1, 'playing', 3000);
    await t.stop(cueId);
});
