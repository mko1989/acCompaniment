/**
 * Every cue property that affects sound, checked against what the audio
 * engine actually does with it: volume (including 0 and live edits),
 * fade in, fade out, loop, trim start/end and output routing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

const voice = async (cueId) => (await t.voices(cueId))[0] || null;

test('a cue plays at its own volume', async () => {
    const cueId = await t.createCue({ volume: 0.3 });
    await t.playing(cueId);
    const v = await voice(cueId);
    assert.equal(v.volume, 0.3);
    assert.equal(v.gain, 0.3);
    await t.stop(cueId);
});

test('a cue with volume 0 plays silently (not at full volume)', async () => {
    const cueId = await t.createCue({ volume: 0 });
    assert.equal((await t.getCue(cueId)).volume, 0);
    await t.playing(cueId);
    const v = await voice(cueId);
    assert.equal(v.volume, 0);
    assert.equal(v.gain, 0);
    await t.stop(cueId);
});

test('changing the volume of a playing cue takes effect immediately', async () => {
    const cueId = await t.createCue({ volume: 0.8 });
    await t.playing(cueId);
    await t.updateCue(cueId, { volume: 0.2 });
    await t.waitFor(async () => Math.abs((await voice(cueId)).gain - 0.2) < 1e-6, 1000);
    await t.stop(cueId);
});

test('fade in: the cue starts silent and rises to its volume over fadeInTime', async () => {
    const cueId = await t.createCue({ volume: 0.5, fadeInTime: 1000 });
    await t.playing(cueId);
    const start = await voice(cueId);
    assert.equal(start.isFadingIn, true);
    assert.ok(start.gain < 0.2);
    // It ramps rather than jumps: some reading lands strictly in between.
    await t.waitFor(async () => {
        const { gain } = await voice(cueId);
        return gain > 0.1 && gain < 0.45;
    }, 2000);
    await t.waitFor(async () => (await voice(cueId)).gain === 0.5, 2500);
    assert.equal((await voice(cueId)).isFadingIn, false);
    await t.stop(cueId);
});

test('fade out: stopping with fadeOut fades over the cue\'s fadeOutTime', async () => {
    const cueId = await t.createCue({ fadeOutTime: 1000 });
    await t.playing(cueId);
    await t.post(`/api/cues/${cueId}/stop`, { fadeOut: true });
    assert.equal((await voice(cueId)).isFadingOut, true);
    await sleep(400);
    assert.equal(await t.status(cueId), 'playing');
    await t.waitForStatus(cueId, 'stopped', 2000);
});

test('stop without fadeOut is immediate, even for a cue with a fade-out time', async () => {
    const cueId = await t.createCue({ fadeOutTime: 3000 });
    await t.playing(cueId);
    await t.stop(cueId);
    assert.equal(await t.status(cueId), 'stopped');
    assert.equal((await t.voices(cueId)).length, 0);
});

test('loop: a looping single-file cue keeps playing past its end', async () => {
    const cueId = await t.createCue({ loop: true }, 0.6);
    await t.playing(cueId);
    await sleep(1500);
    assert.equal(await t.status(cueId), 'playing');
    assert.ok((await voice(cueId)).positionSec < 0.6, 'wrapped back to the start');
    await t.stop(cueId);
});

test('without loop, a cue completes at its end', async () => {
    const cueId = await t.createCue({ loop: false }, 0.6);
    await t.playing(cueId);
    await t.waitForStatus(cueId, 'completed', 2000);
});

test('trim start: playback begins at trimStartTime', async () => {
    const cueId = await t.createCue({ trimStartTime: 2 });
    await t.playing(cueId);
    const v = await voice(cueId);
    assert.equal(v.trimStartSec, 2);
    assert.ok(v.positionSec >= 2 && v.positionSec < 2.5);
    await t.stop(cueId);
});

test('trim end: playback ends at trimEndTime, not the end of the file', async () => {
    const cueId = await t.createCue({ trimStartTime: 1, trimEndTime: 1.6 });
    await t.playing(cueId);
    assert.equal((await voice(cueId)).trimEndSec, 1.6);
    await t.waitForStatus(cueId, 'completed', 1500);
});

test('trim + loop: loops the trimmed region only', async () => {
    const cueId = await t.createCue({ trimStartTime: 3, trimEndTime: 3.5, loop: true });
    await t.playing(cueId);
    await sleep(1200);
    const v = await voice(cueId);
    assert.ok(v.positionSec >= 3 && v.positionSec < 3.5, `position ${v.positionSec} stays inside the region`);
    await t.stop(cueId);
});

test('the time display counts from the trim start and totals the trimmed length', async () => {
    const cueId = await t.createCue({ trimStartTime: 2, trimEndTime: 6 });
    const socket = await t.ws();
    try {
        await t.trigger(cueId);
        const u = await t.waitForTimeUpdate(socket, cueId);
        assert.equal(u.payload.totalDurationSec, 4);
        assert.ok(u.payload.currentTimeSec < 0.5);
    } finally {
        socket.close();
        await t.stop(cueId);
    }
});

test('output routing: the cue plays on its patched output channels', async () => {
    const cueId = await t.createCue({ outputPatch: [1, 0] });
    await t.playing(cueId);
    assert.deepEqual((await voice(cueId)).outputPatch, [1, 0], 'swapped stereo is kept, not collapsed to [1, 1]');
    await t.stop(cueId);
});

test('a playlist uses the playlist\'s volume and fades for every item', async () => {
    const cueId = await t.createPlaylist(2, { volume: 0.4, fadeInTime: 300 }, 0.8);
    await t.playing(cueId);
    assert.equal((await voice(cueId)).isFadingIn, true);
    await t.waitFor(async () => (await t.getCue(cueId)).currentPlaylistIndex === 1, 2500);
    await t.waitFor(async () => {
        const v = await voice(cueId);
        return v && v.volume === 0.4;
    }, 1000);
    await t.stop(cueId);
});

test('fade-stopping a volume-0 cue ends it (it used to stay "playing" forever)', async () => {
    const cueId = await t.createCue({ volume: 0, fadeOutTime: 500, retriggerBehavior: 'fade_out_and_stop' });
    await t.playing(cueId);
    await t.trigger(cueId);
    await t.waitForStatus(cueId, 'stopped', 2000);
    assert.equal((await t.voices(cueId)).length, 0);
});
