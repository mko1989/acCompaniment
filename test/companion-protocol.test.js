/**
 * The WebSocket contract the Bitfocus Companion module relies on
 * (companion-module-highpass-accompaniment): the commands it sends and the
 * events it reads. Changing any of this breaks the module - update both.
 *
 * Commands:  toggle_cue, play_cue, stop_cue, stop_all_cues, toggle_pause_cue,
 *            playlist_navigate, playlist_jump, set_crossfade_mode,
 *            set_master_volume
 * Events:    cues-updated, cue_status, playback-time-update,
 *            crossfade-mode-updated, workspace-updated, master-volume-updated
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer, wsSend, waitForMessage, waitForReceived } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

async function withSocket(fn) {
    const socket = await t.ws();
    try {
        return await fn(socket);
    } finally {
        socket.close();
    }
}

const reply = (socket, type) => waitForMessage(socket, (m) => m.type === type);

test('on connect: the cue list, open project, crossfade mode, master volume and active cues arrive unasked', async () => {
    const cueId = await t.createCue({ name: 'On Connect' });
    await t.playing(cueId);
    await withSocket(async (socket) => {
        const cues = await waitForReceived(socket, (m) => m.type === 'cues-updated');
        const cue = cues.payload.cues.find((c) => c.id === cueId);
        assert.equal(cue.name, 'On Connect');
        assert.equal(cue.type, 'single_file');
        assert.ok((await waitForReceived(socket, (m) => m.type === 'workspace-updated')).payload.workspace.name);
        assert.equal(typeof (await waitForReceived(socket, (m) => m.type === 'crossfade-mode-updated')).payload.enabled, 'boolean');
        assert.equal(typeof (await waitForReceived(socket, (m) => m.type === 'master-volume-updated')).payload.volume, 'number');
        await waitForReceived(socket, (m) => m.type === 'cue_status' && m.payload.cueId === cueId && m.payload.status === 'playing');
    });
    await t.stop(cueId);
});

test('toggle_cue (from Companion) plays a cue, then applies its retrigger behavior', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'stop' });
    await withSocket(async (socket) => {
        const playing = t.waitForCueStatus(socket, cueId, 'playing');
        wsSend(socket, 'toggle_cue', { cueId, fromCompanion: true });
        await playing;
        const stopped = t.waitForCueStatus(socket, cueId, 'stopped');
        wsSend(socket, 'toggle_cue', { cueId, fromCompanion: true });
        await stopped;
    });
});

test('play_cue starts a cue', async () => {
    const cueId = await t.createCue();
    await withSocket(async (socket) => {
        const playing = t.waitForCueStatus(socket, cueId, 'playing');
        wsSend(socket, 'play_cue', { cueId });
        await playing;
        assert.equal((await reply(socket, 'cue_played')).payload.success, true);
    });
    await t.stop(cueId);
});

test('stop_cue stops a cue, with or without its fade-out', async () => {
    const cueId = await t.createCue({ fadeOutTime: 800 });
    await t.playing(cueId);
    await withSocket(async (socket) => {
        wsSend(socket, 'stop_cue', { cueId, fadeOut: true });
        await sleep(300);
        assert.equal((await t.voices(cueId))[0]?.isFadingOut, true);
        await t.waitForCueStatus(socket, cueId, 'stopped', 3000);

        await t.playing(cueId);
        const stopped = t.waitForCueStatus(socket, cueId, 'stopped', 1000);
        wsSend(socket, 'stop_cue', { cueId });
        await stopped;
    });
});

test('stop_all_cues: an explicit behavior, or the app\'s configured one when omitted', async () => {
    const cueId = await t.createCue();
    await t.setConfig({ defaultStopAllBehavior: 'fade_out_and_stop', defaultStopAllFadeOutTime: 700 });
    try {
        await withSocket(async (socket) => {
            await t.playing(cueId);
            wsSend(socket, 'stop_all_cues', {});
            await sleep(200);
            assert.equal((await t.voices(cueId))[0]?.isFadingOut, true, 'uses the configured fade');
            await t.waitForCueStatus(socket, cueId, 'stopped', 3000);

            await t.playing(cueId);
            const stopped = t.waitForCueStatus(socket, cueId, 'stopped', 1000);
            wsSend(socket, 'stop_all_cues', { behavior: 'stop' });
            await stopped;
        });
    } finally {
        await t.setConfig({ defaultStopAllBehavior: 'stop' });
    }
});

test('toggle_pause_cue pauses and resumes a playing cue, and does nothing to a stopped one', async () => {
    const cueId = await t.createCue();
    await withSocket(async (socket) => {
        wsSend(socket, 'toggle_pause_cue', { cueId });
        assert.equal((await reply(socket, 'cue_pause_toggled')).payload.success, false);
        assert.equal(await t.status(cueId), 'stopped');

        await t.playing(cueId);
        const paused = t.waitForCueStatus(socket, cueId, 'paused');
        wsSend(socket, 'toggle_pause_cue', { cueId });
        await paused;
        const resumed = t.waitForCueStatus(socket, cueId, 'playing');
        wsSend(socket, 'toggle_pause_cue', { cueId });
        await resumed;
    });
    await t.stop(cueId);
});

test('playlist_navigate moves a playlist to its next / previous item', async () => {
    const cueId = await t.createPlaylist(3, {}, 10);
    await withSocket(async (socket) => {
        wsSend(socket, 'playlist_navigate', { cueId, direction: 'next' });
        await reply(socket, 'playlist_navigated');
        assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 1);
        wsSend(socket, 'playlist_navigate', { cueId, direction: 'previous' });
        await reply(socket, 'playlist_navigated');
        assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 0);
    });
});

test('playlist_jump plays the chosen item of a playing playlist', async () => {
    const cueId = await t.createPlaylist(4, {}, 10);
    await t.playing(cueId);
    await withSocket(async (socket) => {
        const nowOnThird = waitForMessage(socket, (m) => m.type === 'cue_status' && m.payload.cueId === cueId
            && m.payload.status === 'playing' && m.payload.playlistIndex === 2);
        wsSend(socket, 'playlist_jump', { cueId, index: 2 });
        assert.deepEqual((await reply(socket, 'playlist_jumped')).payload, { cueId, success: true, newIndex: 2 });
        await nowOnThird;
    });
    await t.stop(cueId);
});

test('playlist_jump on an idle playlist only selects the item; out-of-range indices are refused', async () => {
    const cueId = await t.createPlaylist(2, {}, 10);
    await withSocket(async (socket) => {
        wsSend(socket, 'playlist_jump', { cueId, index: 1 });
        await reply(socket, 'playlist_jumped');
        assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 1);
        assert.equal(await t.status(cueId), 'stopped');

        wsSend(socket, 'playlist_jump', { cueId, index: 5 });
        const refused = await reply(socket, 'playlist_jumped');
        assert.equal(refused.payload.success, false);
        assert.match(refused.payload.error, /0-1/);
    });
    const single = await t.createCue();
    await withSocket(async (socket) => {
        wsSend(socket, 'playlist_jump', { cueId: single, index: 0 });
        assert.equal((await reply(socket, 'playlist_jumped')).payload.success, false);
    });
});

test('playlist_jump also works over REST', async () => {
    const cueId = await t.createPlaylist(3, {}, 10);
    const res = await t.post(`/api/cues/${cueId}/playlist/jump`, { index: 2 });
    assert.equal(res.success, true);
    assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 2);
});

test('set_crossfade_mode switches crossfade and is broadcast', async () => {
    await withSocket(async (socket) => {
        const on = waitForMessage(socket, (m) => m.type === 'crossfade-mode-updated' && m.payload.enabled === true);
        wsSend(socket, 'set_crossfade_mode', { enabled: true });
        await on;
        const off = waitForMessage(socket, (m) => m.type === 'crossfade-mode-updated' && m.payload.enabled === false);
        wsSend(socket, 'set_crossfade_mode', { enabled: false });
        await off;
    });
});

test('set_master_volume sets the master volume and is broadcast', async () => {
    await withSocket(async (socket) => {
        const told = waitForMessage(socket, (m) => m.type === 'master-volume-updated' && m.payload.volume === 0.6);
        wsSend(socket, 'set_master_volume', { volume: 0.6 });
        assert.deepEqual((await reply(socket, 'master_volume_set')).payload, { success: true, volume: 0.6 });
        await told;
        wsSend(socket, 'set_master_volume', { volume: 'loud' });
        assert.equal((await reply(socket, 'master_volume_set')).payload.success, false);
        wsSend(socket, 'set_master_volume', { volume: 1 });
    });
});

test('playback-time-update carries what the module shows: times, fades, playlist position', async () => {
    const cueId = await t.createPlaylist(2, { fadeInTime: 1500 }, 10);
    await withSocket(async (socket) => {
        wsSend(socket, 'toggle_cue', { cueId, fromCompanion: true });
        const { payload } = await t.waitForTimeUpdate(socket, cueId, (p) => p.isFadingIn);
        for (const key of ['cueName', 'currentTimeSec', 'totalDurationSec', 'remainingTimeSec', 'currentTimeFormatted',
            'totalDurationFormatted', 'remainingTimeFormatted', 'status', 'isFadingIn', 'isFadingOut', 'fadeTimeRemainingMs',
            'playlistIndex', 'nextPlaylistIndex']) {
            assert.ok(key in payload, `missing ${key}`);
        }
        assert.equal(payload.status, 'playing');
        assert.equal(payload.playlistIndex, 0);
        assert.equal(payload.nextPlaylistIndex, 1);
    });
    await t.stop(cueId);
});

test('renaming the project and changing cues are pushed to connected clients', async () => {
    await withSocket(async (socket) => {
        const renamed = waitForMessage(socket, (m) => m.type === 'workspace-updated' && m.payload.workspace.name === 'Companion Show');
        await t.put('/api/projects/current', { name: 'Companion Show' });
        await renamed;
        const listed = waitForMessage(socket, (m) => m.type === 'cues-updated' && m.payload.cues.some((c) => c.name === 'Pushed Cue'));
        await t.createCue({ name: 'Pushed Cue' });
        await listed;
    });
});
