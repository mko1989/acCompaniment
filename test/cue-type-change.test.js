/**
 * Turning a single-file cue into a playlist keeps its file: it becomes the
 * playlist's first item, and plays as one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer } = require('./helpers/harness');
const { api } = require('./helpers/api');

const server = useServer();
const t = api(server);

test('changing a cue to a playlist makes its file the first item', async () => {
    const cueId = await t.createCue({ name: 'Intro', trimStartTime: 0.5, trimEndTime: 2 }, 3);
    const before = await t.getCue(cueId);
    await t.updateCue(cueId, { type: 'playlist' });
    const after = await t.getCue(cueId);
    assert.equal(after.type, 'playlist');
    assert.equal(after.playlistItems.length, 1);
    const [item] = after.playlistItems;
    assert.equal(item.audioFileId, before.audioFileId);
    assert.equal(item.relativePath, before.relativePath);
    assert.equal(item.name, 'Intro');
    assert.equal(item.trimStartTime, 0.5);
    assert.equal(item.trimEndTime, 2);
    assert.ok(item.id);

    await t.playing(cueId);
    const voices = await t.voices(cueId);
    assert.equal(voices.length, 1);
    await t.stop(cueId);
});

test('items sent with the change are kept, after the cue\'s own file', async () => {
    const cueId = await t.createCue({ name: 'Own' });
    const other = await t.upload(1);
    await t.updateCue(cueId, {
        type: 'playlist',
        playlistItems: [{ id: 'other', name: 'Other', audioFileId: other.id, relativePath: other.relativePath }],
    });
    const { playlistItems } = await t.getCue(cueId);
    assert.deepEqual(playlistItems.map((i) => i.name), ['Own', 'Other']);
});

test('the cue\'s file is not added twice if the change already includes it', async () => {
    const cueId = await t.createCue({ name: 'Once' });
    const { audioFileId, relativePath } = await t.getCue(cueId);
    await t.updateCue(cueId, {
        type: 'playlist',
        playlistItems: [{ id: 'mine', name: 'Mine', audioFileId, relativePath }],
    });
    const { playlistItems } = await t.getCue(cueId);
    assert.deepEqual(playlistItems.map((i) => i.id), ['mine']);
});

test('saving an existing playlist does not add anything to it', async () => {
    const cueId = await t.createCue({ name: 'Converted' });
    await t.updateCue(cueId, { type: 'playlist' });
    await t.updateCue(cueId, { type: 'playlist', playlistItems: [] });
    assert.deepEqual((await t.getCue(cueId)).playlistItems, []);
});

test('the trim moves with the file: onto the item, and back onto the cue (WO-003)', async () => {
    const cueId = await t.createCue({ name: 'Trimmed', trimStartTime: 0.5, trimEndTime: 2 }, 3);
    await t.updateCue(cueId, { type: 'playlist' });
    const playlist = await t.getCue(cueId);
    assert.equal(playlist.trimStartTime, 0, 'a playlist cue keeps no trim of its own');
    assert.equal(playlist.trimEndTime, null);
    assert.equal(playlist.playlistItems[0].trimStartTime, 0.5);

    // Plays the item with the item's trim.
    await t.playing(cueId);
    const [voice] = await t.voices(cueId);
    assert.ok(Math.abs(voice.trimStartSec - 0.5) < 0.01, `item played from ${voice.trimStartSec}s`);
    assert.ok(Math.abs(voice.trimEndSec - 2) < 0.01, `item played to ${voice.trimEndSec}s`);
    await t.stop(cueId);

    await t.updateCue(cueId, { type: 'single_file' });
    const single = await t.getCue(cueId);
    assert.equal(single.trimStartTime, 0.5, 'back to a single cue, its trim comes back');
    assert.equal(single.trimEndTime, 2);
});
