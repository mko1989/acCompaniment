/**
 * Playlist shuffle, and how it combines with loop, "stop and cue next",
 * manual navigation and live edits. Each "playing" broadcast announces the
 * item playing (playlistIndex) and the one that will follow
 * (nextPlaylistIndex), which lets these tests check the order is honoured.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer, waitForMessage } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

/** Collects every item a playlist plays, in order, until it stops playing. */
function recordItems(socket, cueId) {
    const items = [];
    const announcedNext = [];
    socket.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'cue_status' && m.payload?.cueId === cueId && m.payload.status === 'playing'
            && typeof m.payload.playlistIndex === 'number') {
            items.push(m.payload.playlistIndex);
            announcedNext.push(m.payload.nextPlaylistIndex);
        }
    });
    return { items, announcedNext };
}

const isPermutation = (arr, n) => arr.length === n && [...arr].sort((a, b) => a - b).every((v, i) => v === i);

test('a shuffled playlist plays every item exactly once, then finishes', async () => {
    const cueId = await t.createPlaylist(4, { shufflePlaylist: true }, 0.5);
    const socket = await t.ws();
    try {
        const rec = recordItems(socket, cueId);
        const finished = t.waitForCueStatus(socket, cueId, 'completed', 8000);
        await t.trigger(cueId);
        await finished;
        assert.ok(isPermutation(rec.items, 4), `played ${rec.items}`);
        for (let i = 0; i < rec.items.length - 1; i++) {
            assert.equal(rec.announcedNext[i], rec.items[i + 1], 'each item announced what really came next');
        }
        assert.equal(rec.announcedNext[rec.items.length - 1], null, 'the last item announces nothing next');
    } finally {
        socket.close();
    }
});

test('shuffle really shuffles: across several playlists, not every one starts in list order', async () => {
    const socket = await t.ws();
    const starts = [];
    try {
        for (let i = 0; i < 4; i++) {
            const cueId = await t.createPlaylist(6, { shufflePlaylist: true }, 10);
            const msg = t.waitForCueStatus(socket, cueId, 'playing');
            await t.trigger(cueId);
            const { payload } = await msg;
            starts.push([payload.playlistIndex, payload.nextPlaylistIndex]);
            await t.stop(cueId);
        }
    } finally {
        socket.close();
    }
    // Probability all four begin 0 -> 1 by chance: (1/30)^4.
    assert.ok(starts.some(([first, next]) => !(first === 0 && next === 1)), `starts: ${JSON.stringify(starts)}`);
});

test('the UI\'s "shuffle" field name enables shuffle too', async () => {
    const cueId = await t.createPlaylist(3, { shuffle: true }, 10);
    const cue = await t.getCue(cueId);
    assert.equal(cue.shufflePlaylist, true);
    assert.equal('shuffle' in cue, false);
});

test('shuffle with loop keeps going past the end, playing every item again', async () => {
    const cueId = await t.createPlaylist(3, { shufflePlaylist: true, loop: true }, 0.5);
    const socket = await t.ws();
    try {
        const rec = recordItems(socket, cueId);
        await t.trigger(cueId);
        await t.waitFor(() => rec.items.length >= 6, 8000);
        assert.ok(isPermutation(rec.items.slice(0, 3), 3));
        assert.ok(isPermutation(rec.items.slice(3, 6), 3), 'the second pass is a full (reshuffled) pass');
        assert.equal(await t.status(cueId), 'playing');
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('shuffle with "stop and cue next" cues the item the order says comes next', async () => {
    const cueId = await t.createPlaylist(4, { shufflePlaylist: true, playlistPlayMode: 'stop_and_cue_next' }, 0.5);
    const socket = await t.ws();
    try {
        const started = t.waitForCueStatus(socket, cueId, 'playing');
        await t.trigger(cueId);
        const { payload } = await started;
        const cued = await t.waitForCueStatus(socket, cueId, 'cued_next', 3000);
        assert.equal(cued.payload.playlistIndex, payload.nextPlaylistIndex);
        assert.equal((await t.getCue(cueId)).currentPlaylistIndex, payload.nextPlaylistIndex);

        const next = t.waitForCueStatus(socket, cueId, 'playing');
        await t.trigger(cueId);
        assert.equal((await next).payload.playlistIndex, payload.nextPlaylistIndex, 'pressing again plays the cued item');
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('the ▶ button on a shuffled playlist goes to the next item in shuffle order', async () => {
    const cueId = await t.createPlaylist(5, { shufflePlaylist: true }, 10);
    const socket = await t.ws();
    try {
        const started = t.waitForCueStatus(socket, cueId, 'playing');
        await t.trigger(cueId);
        const { payload } = await started;

        const moved = t.waitForCueStatus(socket, cueId, 'playing');
        const nav = await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
        assert.equal(nav.newIndex, payload.nextPlaylistIndex);
        assert.equal((await moved).payload.playlistIndex, payload.nextPlaylistIndex);

        const back = await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'previous' });
        assert.equal(back.newIndex, payload.playlistIndex, '◀ goes back along the same order');
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('stopping and restarting a shuffled playlist continues its order rather than reshuffling', async () => {
    const cueId = await t.createPlaylist(5, { shufflePlaylist: true }, 10);
    const socket = await t.ws();
    try {
        const first = t.waitForCueStatus(socket, cueId, 'playing');
        await t.trigger(cueId);
        const a = (await first).payload;
        await t.stop(cueId);

        const again = t.waitForCueStatus(socket, cueId, 'playing');
        await t.trigger(cueId);
        const b = (await again).payload;
        assert.equal(b.playlistIndex, a.playlistIndex);
        assert.equal(b.nextPlaylistIndex, a.nextPlaylistIndex);
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('turning shuffle off mid-playlist goes back to list order', async () => {
    const cueId = await t.createPlaylist(5, { shufflePlaylist: true }, 10);
    await t.playing(cueId);
    await t.updateCue(cueId, { shufflePlaylist: false });
    const current = (await t.getCue(cueId)).currentPlaylistIndex;
    const nav = await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
    assert.equal(nav.newIndex, Math.min(current + 1, 4));
    await t.stop(cueId);
});

test('editing a shuffled playlist\'s items draws a fresh order that covers the new items', async () => {
    const cueId = await t.createPlaylist(2, { shufflePlaylist: true }, 0.5);
    const extra = await t.upload(0.5);
    const cue = await t.getCue(cueId);
    await t.updateCue(cueId, {
        playlistItems: [...cue.playlistItems, { id: 'item-x', name: 'X', audioFileId: extra.id, relativePath: extra.relativePath }],
    });
    const socket = await t.ws();
    try {
        const rec = recordItems(socket, cueId);
        const finished = t.waitForCueStatus(socket, cueId, 'completed', 6000);
        await t.trigger(cueId);
        await finished;
        assert.ok(isPermutation(rec.items, 3), `played ${rec.items}`);
    } finally {
        socket.close();
    }
});

test('playback-time-update carries the playing and next playlist item', async () => {
    const cueId = await t.createPlaylist(3, {}, 10);
    const socket = await t.ws();
    try {
        await t.trigger(cueId);
        const update = await t.waitForTimeUpdate(socket, cueId);
        assert.equal(update.payload.playlistIndex, 0);
        assert.equal(update.payload.nextPlaylistIndex, 1);
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('a playlist cued on its next item is shown as cued to a newly connected page, and Stop All clears it', async () => {
    const cueId = await t.createPlaylist(2, { playlistPlayMode: 'stop_and_cue_next' }, 0.5);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'cued_next', 3000);

    const socket = await t.ws();
    try {
        await t.waitForInitialCueStatus(socket, cueId, 'cued_next', 2000);
        const cleared = t.waitForCueStatus(socket, cueId, 'stopped');
        await t.stopAll();
        await cleared;
        assert.equal(await t.status(cueId), 'stopped');
    } finally {
        socket.close();
    }
});

test('the ▶ button on a cued playlist moves the cue without starting it', async () => {
    const cueId = await t.createPlaylist(3, { playlistPlayMode: 'stop_and_cue_next' }, 0.5);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'cued_next', 3000);
    await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
    assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 2);
    assert.equal(await t.status(cueId), 'cued_next');
    await sleep(200);
    assert.equal((await t.voices(cueId)).length, 0);
    await t.stopAll();
});
