/**
 * Loopback suite: playlists, heard. Each item is a tone in a band of its
 * own, so the recording shows which item plays when - the order, the
 * hand-over from one item to the next, wrapping, cueing, shuffling and
 * navigating - and, within an item, where it plays from.
 */

const assert = require('node:assert/strict');
const { loopbackSuite } = require('./lib/loopback');
const { DEFAULT_AMPLITUDE: A } = require('./lib/signals');
const { SILENCE } = require('./lib/analyzer');

const audio = loopbackSuite();
const { test, near } = audio;

// Three 1 s items in bands 0, 1, 2 (ten 100 ms segments each).
// A gapless join of two test tones still has two zero samples in it: each
// tone starts and ends on one (signals.js's anti-click ramp). More than that
// is silence the app put there.
const JOIN_SILENCE = 3;
const ITEM_SEC = 1.0;
const ITEMS = [0, 1, 2].map((band) => ({ band, durationSec: ITEM_SEC }));

/** The item (band) loudest at time t, or null when silent. */
function itemAt(take, t) {
    const levels = [0, 1, 2].map((band) => take.a.levelAt(band, t));
    const max = Math.max(...levels);
    return max < SILENCE * 2 ? null : levels.indexOf(max);
}

/** The items heard over [t0, t1], in order, each once per stretch. */
function itemsHeard(take, t0, t1) {
    const order = [];
    for (let t = t0; t <= t1; t += 0.02) {
        const item = itemAt(take, t);
        if (item !== null && order[order.length - 1] !== item) order.push(item);
    }
    return order;
}

test('continue: plays every item in order, back to back, then completes', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS, { playlistPlayMode: 'continue' });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 6000);
    });
    const start = take.at('trigger');
    assert.deepEqual(itemsHeard(take, start, take.durationSec), [0, 1, 2]);
    // Each item plays whole, from its first segment.
    for (const band of [0, 1, 2]) {
        const on = take.a.onset(band, { after: start });
        assert.equal(take.a.slotAt(band, on + 0.03), 0, `item ${band} started at segment ${take.a.slotAt(band, on + 0.03)}`);
        near(take.a.offset(band, { after: on + 0.2 }) - on, ITEM_SEC, 0.06, `item ${band} duration`);
    }
    // Hand-over: the next item follows on (gapless is the todo test below).
    for (const band of [0, 1]) {
        const on = take.a.onset(band, { after: start });
        const end = take.a.offset(band, { after: on + 0.2 });
        const next = take.a.onset(band + 1, { after: end - 0.1 });
        const gap = next - end;
        t.diagnostic(`item ${band} -> ${band + 1}: ${(gap * 1000).toFixed(1)} ms apart`);
        assert.ok(gap < 0.1, `${(gap * 1000).toFixed(0)} ms of silence between items ${band} and ${band + 1}`);
    }
});

test('items hand over gaplessly: no silence at any join, positions continuous (WO-006)', async (t) => {
    // Items whose length isn't a whole number of output buffers - the case
    // that used to leave the rest of a buffer silent at each join.
    const cue = await audio.tonePlaylist(ITEMS, { playlistPlayMode: 'continue' });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 6000);
    });
    for (const band of [1, 2]) {
        const join = take.a.onset(band, { after: take.at('trigger') });
        const holes = take.dropouts(join - 0.05, join + 0.05, { minSamples: JOIN_SILENCE });
        assert.equal(holes.length, 0, `silence at the join into item ${band}: ${holes.map((h) => `${h.samples} samples`).join(', ')}`);
        assert.equal(take.a.slotAt(band - 1, join - 0.03), 9, `item ${band - 1} played to its last segment`);
        assert.equal(take.a.slotAt(band, join + 0.03), 0, `item ${band} started from its first segment`);
    }
});

test('gapless joins also when looping round, and each item\'s own trim is kept', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.slice(0, 2), { playlistPlayMode: 'continue', loop: true });
    const { playlistItems } = await audio.getCue(cue);
    playlistItems[1].trimStartTime = 0.3;
    await audio.updateCue(cue, { playlistItems });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(ITEM_SEC * 1000 + 0.7 * 1000 + 600);
        await audio.stop(cue);
    });
    const start = take.at('trigger');
    const intoSecond = take.a.onset(1, { after: start });
    assert.equal(take.a.slotAt(1, intoSecond + 0.03), 3, 'item 2 starts at its 0.3 s trim');
    const wrap = take.a.onset(0, { after: intoSecond + 0.2 });
    for (const join of [intoSecond, wrap]) {
        const holes = take.dropouts(join - 0.05, join + 0.05, { minSamples: JOIN_SILENCE });
        assert.equal(holes.length, 0, `silence at the join at ${join.toFixed(3)}s`);
    }
    near(wrap - intoSecond, 0.7, 0.03, 'item 2 played its trimmed 0.7 s');
});

test('loop: after the last item it goes round to the first again', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS, { playlistPlayMode: 'continue', loop: true });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(4 * ITEM_SEC * 1000 + 600);
        await audio.stop(cue);
    });
    assert.deepEqual(itemsHeard(take, take.at('trigger'), take.durationSec).slice(0, 5), [0, 1, 2, 0, 1]);
});

test('stop_and_cue_next: plays one item, stops, and the next press plays the next one', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS, { playlistPlayMode: 'stop_and_cue_next' });
    const take = await audio.record(t, async (mark) => {
        mark('first');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'cued_next', 4000);
        await audio.sleep(400);
        mark('second');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'cued_next', 4000);
    });
    assert.deepEqual(itemsHeard(take, take.at('first'), take.at('second')), [0]);
    assert.deepEqual(itemsHeard(take, take.at('second'), take.durationSec), [1]);
    assert.ok(take.a.level(0, take.at('second') - 0.3, take.at('second')) < 0.001, 'silent while cued');
});

test('stop_and_cue_next + loop: after the last item, the next press plays the first', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.slice(0, 2), { playlistPlayMode: 'stop_and_cue_next', loop: true });
    const take = await audio.record(t, async (mark) => {
        for (let i = 0; i < 3; i++) {
            mark('press');
            await audio.trigger(cue);
            await audio.waitForStatus(cue, 'cued_next', 4000);
        }
    });
    assert.deepEqual(itemsHeard(take, take.at('press', 0), take.durationSec), [0, 1, 0]);
});

test('repeat one: the item plays, then is cued again - the next press replays it', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS, { playlistPlayMode: 'continue', repeatOnePlaylistItem: true });
    const take = await audio.record(t, async (mark) => {
        mark('first');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'cued_next', 4000);
        mark('second');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'cued_next', 4000);
    });
    assert.deepEqual(itemsHeard(take, take.at('first'), take.at('second')), [0], 'first press');
    assert.deepEqual(itemsHeard(take, take.at('second'), take.durationSec), [0], 'second press played item 0 again');
});

test('shuffle: each item plays exactly once, in some order', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS, { playlistPlayMode: 'continue', shufflePlaylist: true });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 6000);
    });
    const heard = itemsHeard(take, take.at('trigger'), take.durationSec);
    t.diagnostic(`shuffled order heard: ${heard.join(', ')}`);
    assert.deepEqual([...heard].sort(), [0, 1, 2]);
});

for (const { direction, from, to } of [
    { direction: 'next', from: 0, to: 1 },
    { direction: 'previous', from: 1, to: 0 },
]) {
    test(`navigate ${direction} while playing: switches to item ${to} at once, from its start`, async (t) => {
        const cue = await audio.tonePlaylist(ITEMS.map((i) => ({ ...i, durationSec: 2 })), { playlistPlayMode: 'continue' });
        if (from > 0) await audio.post(`/api/cues/${cue}/playlist/jump`, { index: from });
        const take = await audio.record(t, async (mark) => {
            await audio.trigger(cue);
            await audio.sleep(800);
            mark('navigate');
            await audio.post(`/api/cues/${cue}/playlist/navigate`, { direction });
            await audio.sleep(700);
        });
        const at = take.at('navigate');
        assert.equal(itemAt(take, at - 0.1), from, 'item before');
        const on = take.a.onset(to, { after: at - 0.05 });
        audio.immediate(on - at, `${direction} -> item ${to} audible`);
        assert.ok(take.a.slotAt(to, on + 0.03) <= 1, `item ${to} started at segment ${take.a.slotAt(to, on + 0.03)}`);
        assert.ok(take.a.level(from, at + 0.15, at + 0.6) < 0.001, `item ${from} still audible`);
    });
}

test('jump to an item while playing: plays that item', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.map((i) => ({ ...i, durationSec: 2 })), { playlistPlayMode: 'continue' });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(600);
        mark('jump');
        await audio.post(`/api/cues/${cue}/playlist/jump`, { index: 2 });
        await audio.sleep(700);
    });
    const at = take.at('jump');
    assert.equal(itemAt(take, at + 0.3), 2);
});

test('retrigger replay_current_item: the current item starts over', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.map((i) => ({ ...i, durationSec: 2 })), { retriggerBehavior: 'replay_current_item' });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(1200);
        mark('again');
        await audio.trigger(cue);
        await audio.sleep(500);
    });
    const at = take.at('again');
    assert.ok(take.a.slotAt(0, at - 0.05) >= 10, 'item 0 was well under way');
    assert.ok(take.a.slotAt(0, at + 0.12) <= 1, `after the press item 0 is at segment ${take.a.slotAt(0, at + 0.12)}`);
    assert.equal(itemAt(take, at + 0.3), 0);
});

test('retrigger play_next_item: skips to the next item', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.map((i) => ({ ...i, durationSec: 2 })), { retriggerBehavior: 'play_next_item' });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(800);
        mark('again');
        await audio.trigger(cue);
        await audio.sleep(500);
    });
    const at = take.at('again');
    audio.immediate(take.a.onset(1, { after: at - 0.05 }) - at, 'press -> item 1');
    assert.equal(itemAt(take, at + 0.3), 1);
});

test('the playlist\'s volume and fade in apply to its items', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.slice(0, 2), { volume: 0.5, fadeInTime: 400 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 4000);
    });
    const start = take.at('trigger');
    const t10 = take.a.crossing(0, { after: start, fraction: 0.1, reference: A * 0.5, direction: 'rising' });
    const t90 = take.a.crossing(0, { after: start, fraction: 0.9, reference: A * 0.5, direction: 'rising' });
    near(t90 - t10, 0.32, 0.05, 'fade in of the first item');
    near(take.a.level(0, t90 + 0.15, t90 + 0.5), A * 0.5, 0.006, 'item 0 at the playlist volume');
    const second = take.a.onset(1, { after: start });
    near(take.a.level(1, second + 0.2, second + 0.7), A * 0.5, 0.006, 'item 1 at the playlist volume');
});

test('a trimmed single cue turned into a playlist: its file keeps its trim, other items play whole (WO-003)', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 2 }, { trimStartTime: 0.5 });
    const other = await audio.uploadTone({ band: 1, durationSec: 2 });
    await audio.updateCue(cue, { type: 'playlist' });
    const { playlistItems } = await audio.getCue(cue);
    assert.equal(playlistItems[0].trimStartTime, 0.5, 'the cue\'s trim went onto its own item');
    await audio.updateCue(cue, {
        playlistItems: [...playlistItems, { id: 'other', name: 'Other', audioFileId: other.id, relativePath: other.relativePath }],
    });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 6000);
    });
    const first = take.a.onset(0, { after: take.at('trigger') });
    assert.equal(take.a.slotAt(0, first + 0.03), 5, 'own item starts at its trim (0.5 s)');
    near(take.a.offset(0, { after: first + 0.2 }) - first, 1.5, 0.06, 'own item plays from its trim to its end');
    const second = take.a.onset(1, { after: take.at('trigger') });
    assert.ok(second != null, 'second item never played');
    assert.equal(take.a.slotAt(1, second + 0.03), 0, `the other item started at segment ${take.a.slotAt(1, second + 0.03)}, not its start`);
    near(take.a.offset(1, { after: second + 0.2 }) - second, 2, 0.06, 'other item plays whole');
});

test('a playlist reads as playing throughout the hand-over from one item to the next (WO-007)', async (t) => {
    const cue = await audio.tonePlaylist(ITEMS.slice(0, 2), { playlistPlayMode: 'continue' });
    const seen = [];
    await audio.record(t, async () => {
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'playing');
        // Poll as fast as a remote or Companion could, across the hand-over.
        const until = Date.now() + ITEM_SEC * 1000 + 400;
        while (Date.now() < until) seen.push(await audio.status(cue));
    });
    const notPlaying = seen.filter((s) => s !== 'playing');
    assert.equal(notPlaying.length, 0, `read ${[...new Set(notPlaying)]} ${notPlaying.length} time(s) mid-playlist`);
});
