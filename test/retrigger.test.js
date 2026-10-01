/**
 * Every retrigger behavior the UI offers, pressed on a playing cue and on a
 * paused cue, checked against what the audio engine is actually doing
 * (voice positions and counts), not just the reported status.
 *
 * Three of the UI's options (toggle_pause_play, replay_current_item,
 * play_next_item) used to fall through to "trigger again", which recursed
 * forever; and pressing a paused cue restarted it instead of resuming.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer, wsSend } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

async function position(cueId) {
    const v = await t.voices(cueId);
    return v.length ? v[v.length - 1].positionSec : null;
}

async function playingFor(cueId, ms, overrides = {}) {
    await t.playing(cueId);
    await sleep(ms);
    return cueId;
}

async function pausedAfter(cueId, ms) {
    await playingFor(cueId, ms);
    const res = await t.post(`/api/cues/${cueId}/toggle-pause`);
    assert.equal(res.status, 'paused');
    return cueId;
}

// --- Pressing a playing cue ---------------------------------------------

test('playing + restart: starts over from the beginning', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'restart' }), 1200);
    assert.ok((await position(cueId)) > 1);
    assert.equal((await t.trigger(cueId)).success, true);
    assert.ok((await position(cueId)) < 0.6, 'position should be back near the start');
    assert.equal(await t.status(cueId), 'playing');
    await t.stop(cueId);
});

test('playing + toggle_pause_play: pauses, and pressing again resumes where it left off', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'toggle_pause_play' }), 800);
    assert.equal((await t.trigger(cueId)).status, 'paused');
    assert.equal(await t.status(cueId), 'paused');
    const pausedAt = await position(cueId);
    await sleep(400);
    assert.equal(await position(cueId), pausedAt, 'a paused cue does not advance');

    assert.equal((await t.trigger(cueId)).status, 'playing');
    await sleep(300);
    assert.ok((await position(cueId)) > pausedAt, 'resumed from the pause point, not the start');
    assert.ok((await position(cueId)) > 0.7);
    await t.stop(cueId);
});

test('playing + pause_resume (older spelling) behaves like toggle_pause_play', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'pause_resume' }), 200);
    assert.equal((await t.trigger(cueId)).status, 'paused');
    assert.equal((await t.trigger(cueId)).status, 'playing');
    await t.stop(cueId);
});

test('playing + stop: stops immediately', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'stop' }), 200);
    await t.trigger(cueId);
    assert.equal(await t.status(cueId), 'stopped');
    assert.equal((await t.voices(cueId)).length, 0);
});

test('playing + do_nothing: keeps playing without restarting', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'do_nothing' }), 800);
    const before = await position(cueId);
    await t.trigger(cueId);
    assert.ok((await position(cueId)) >= before, 'position did not reset');
    assert.equal(await t.status(cueId), 'playing');
    await t.stop(cueId);
});

test('playing + play_new_instance: layers a second copy on top of the first', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'play_new_instance' }), 1000);
    await t.trigger(cueId);
    const v = await t.voices(cueId);
    assert.equal(v.length, 2, 'two voices of the same cue');
    assert.ok(v[0].positionSec > 0.8, 'the first keeps going');
    assert.ok(v[1].positionSec < 0.5, 'the second starts from the top');
    assert.equal(await t.status(cueId), 'playing');

    await t.trigger(cueId);
    assert.equal((await t.voices(cueId)).length, 3, 'each press adds another');

    await t.stop(cueId);
    assert.equal((await t.voices(cueId)).length, 0, 'stop stops every instance');
    assert.equal(await t.status(cueId), 'stopped');
});

test('play_new_instance: the cue stays "playing" until its last instance ends', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'play_new_instance' }, 1.2);
    await t.playing(cueId);
    await sleep(700);
    await t.trigger(cueId); // second instance ends ~0.7s after the first
    await t.waitFor(async () => (await t.voices(cueId)).length === 1, 2000);
    assert.equal(await t.status(cueId), 'playing', 'first instance ended, second still playing');
    await t.waitForStatus(cueId, 'completed', 3000);
});

test('play_new_instance: the time display follows the newest instance', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'play_new_instance' }), 1500);
    const socket = await t.ws();
    try {
        await t.trigger(cueId);
        const update = await t.waitForTimeUpdate(socket, cueId, (p) => p.voiceCount === 2);
        assert.ok(update.payload.currentTimeSec < 0.8, `newest instance time, got ${update.payload.currentTimeSec}`);
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('playing + replay_current_item: starts the current item over', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'replay_current_item' }), 1200);
    await t.trigger(cueId);
    assert.ok((await position(cueId)) < 0.6);
    assert.equal(await t.status(cueId), 'playing');
    await t.stop(cueId);
});

test('playing + replay_current_item on a playlist replays the same item (does not go back to the first)', async () => {
    const cueId = await t.createPlaylist(3, { retriggerBehavior: 'replay_current_item' }, 10);
    await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
    await t.playing(cueId);
    await sleep(800);
    await t.trigger(cueId);
    assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 1);
    assert.ok((await position(cueId)) < 0.5);
    await t.stop(cueId);
});

test('playing + play_next_item on a playlist skips to the next item', async () => {
    const cueId = await t.createPlaylist(3, { retriggerBehavior: 'play_next_item' }, 10);
    await t.playing(cueId);
    await t.trigger(cueId);
    assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 1);
    assert.equal(await t.status(cueId), 'playing');
    await t.trigger(cueId);
    assert.equal((await t.getCue(cueId)).currentPlaylistIndex, 2);
    await t.stop(cueId);
});

test('play_next_item on the last item finishes the playlist (or wraps with loop)', async () => {
    const plain = await t.createPlaylist(2, { retriggerBehavior: 'play_next_item' }, 10);
    await t.playing(plain);
    await t.trigger(plain);
    await t.trigger(plain);
    assert.notEqual(await t.status(plain), 'playing');
    assert.equal((await t.getCue(plain)).currentPlaylistIndex, 0);

    const looping = await t.createPlaylist(2, { retriggerBehavior: 'play_next_item', loop: true }, 10);
    await t.playing(looping);
    await t.trigger(looping);
    await t.trigger(looping);
    assert.equal(await t.status(looping), 'playing');
    assert.equal((await t.getCue(looping)).currentPlaylistIndex, 0);
    await t.stop(looping);
});

test('playing + play_next_item on a single file restarts it', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'play_next_item' }), 1200);
    await t.trigger(cueId);
    assert.ok((await position(cueId)) < 0.6);
    await t.stop(cueId);
});

test('an unknown retrigger behavior restarts instead of hanging the server', async () => {
    const cueId = await playingFor(await t.createCue({ retriggerBehavior: 'not_a_real_behavior' }), 1200);
    const res = await t.trigger(cueId);
    assert.equal(res.success, true);
    assert.ok((await position(cueId)) < 0.6);
    await t.stop(cueId);
});

// --- Pressing a paused cue ------------------------------------------------

test('paused + toggle_pause_play: resumes from where it was paused', async () => {
    const cueId = await pausedAfter(await t.createCue({ retriggerBehavior: 'toggle_pause_play' }), 800);
    const pausedAt = await position(cueId);
    await t.trigger(cueId);
    assert.equal(await t.status(cueId), 'playing');
    assert.ok((await position(cueId)) >= pausedAt);
    await t.stop(cueId);
});

test('paused + restart: starts over from the beginning', async () => {
    const cueId = await pausedAfter(await t.createCue({ retriggerBehavior: 'restart' }), 1200);
    await t.trigger(cueId);
    assert.equal(await t.status(cueId), 'playing');
    assert.ok((await position(cueId)) < 0.6);
    await t.stop(cueId);
});

for (const behavior of ['stop', 'fade_out_and_stop']) {
    test(`paused + ${behavior}: stops at once (a paused cue has nothing to fade)`, async () => {
        const cueId = await pausedAfter(await t.createCue({ retriggerBehavior: behavior, fadeOutTime: 2000 }), 300);
        await t.trigger(cueId);
        assert.equal(await t.status(cueId), 'stopped');
        assert.equal((await t.voices(cueId)).length, 0);
    });
}

test('paused + do_nothing: stays paused', async () => {
    const cueId = await pausedAfter(await t.createCue({ retriggerBehavior: 'do_nothing' }), 300);
    await t.trigger(cueId);
    assert.equal(await t.status(cueId), 'paused');
    await t.stop(cueId);
});

test('paused + play_new_instance: plays it from the top, in place of the paused one', async () => {
    const cueId = await pausedAfter(await t.createCue({ retriggerBehavior: 'play_new_instance' }), 1200);
    await t.trigger(cueId);
    assert.equal(await t.status(cueId), 'playing');
    const v = await t.voices(cueId);
    assert.equal(v.length, 1, 'no paused copy left behind');
    assert.equal(v[0].isPaused, false);
    assert.ok(v[0].positionSec < 0.6, 'started over, not resumed');
    await t.stop(cueId);
});

test('paused + replay_current_item: starts over', async () => {
    const cueId = await pausedAfter(await t.createCue({ retriggerBehavior: 'replay_current_item' }), 1200);
    await t.trigger(cueId);
    assert.ok((await position(cueId)) < 0.6);
    assert.equal(await t.status(cueId), 'playing');
    await t.stop(cueId);
});

test('paused + play_next_item: playlists skip ahead, single files resume', async () => {
    const list = await t.createPlaylist(3, { retriggerBehavior: 'play_next_item' }, 10);
    await pausedAfter(list, 300);
    await t.trigger(list);
    assert.equal((await t.getCue(list)).currentPlaylistIndex, 1);
    assert.equal(await t.status(list), 'playing');
    await t.stop(list);

    const single = await pausedAfter(await t.createCue({ retriggerBehavior: 'play_next_item' }), 800);
    const pausedAt = await position(single);
    await t.trigger(single);
    assert.equal(await t.status(single), 'playing');
    assert.ok((await position(single)) >= pausedAt);
    await t.stop(single);
});

// --- The UI's path ------------------------------------------------------------

test('the UI\'s toggle_cue message honours a retrigger override', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'restart' });
    const socket = await t.ws();
    try {
        const playingMsg = t.waitForCueStatus(socket, cueId, 'playing');
        wsSend(socket, 'toggle_cue', { cueId, retriggerBehavior: null });
        await playingMsg;

        const pausedMsg = t.waitForCueStatus(socket, cueId, 'paused');
        wsSend(socket, 'toggle_cue', { cueId, retriggerBehavior: 'toggle_pause_play' });
        await pausedMsg;

        const resumedMsg = t.waitForCueStatus(socket, cueId, 'playing');
        wsSend(socket, 'toggle_cue', { cueId, retriggerBehavior: 'toggle_pause_play' });
        await resumedMsg;
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('a page that connects while a cue is paused sees it as paused, not playing or idle', async () => {
    const cueId = await pausedAfter(await t.createCue(), 200);
    const socket = await t.ws();
    try {
        const msg = await t.waitForInitialCueStatus(socket, cueId, 'paused', 2000);
        assert.equal(msg.payload.status, 'paused');
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

// --- Rapid presses ------------------------------------------------------------

test('two presses arriving together on a "play new instance" cue give two instances', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'play_new_instance' });
    await Promise.all([t.trigger(cueId), t.trigger(cueId)]);
    assert.equal((await t.voices(cueId)).length, 2);
    await t.stop(cueId);
});

test('two presses arriving together on a "toggle pause" cue start it and then pause it', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'toggle_pause_play' });
    await Promise.all([t.trigger(cueId), t.trigger(cueId)]);
    assert.equal(await t.status(cueId), 'paused');
    await t.stop(cueId);
});

test('a burst of presses is handled in order, one at a time', async () => {
    const cueId = await t.createCue({ retriggerBehavior: 'toggle_pause_play' });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => t.trigger(cueId)));
    // Requests may arrive in any order, but each one sees the previous one's
    // result: three starts/resumes and two pauses, ending up playing.
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, ['paused', 'paused', 'playing', 'playing', 'playing']);
    assert.equal(await t.status(cueId), 'playing');
    await t.stop(cueId);
});
