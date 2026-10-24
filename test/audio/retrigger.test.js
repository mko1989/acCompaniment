/**
 * Loopback suite: every retrigger behavior, heard. Pressing a cue that is
 * already playing (or paused) does what its retriggerBehavior says - this
 * records each press and checks the sound across it: where playback is in
 * the file (position-encoded tones, signals.js), and how loud.
 *
 * test/retrigger.test.js covers the same table through the engine's state;
 * playlist-only behaviors (replay_current_item, play_next_item) are in
 * playlists.test.js.
 */

const assert = require('node:assert/strict');
const { loopbackSuite } = require('./lib/loopback');
const { DEFAULT_AMPLITUDE: A } = require('./lib/signals');

const audio = loopbackSuite();
const { test, near } = audio;

// A 3.2 s tone in 32 segments of 100 ms: segment n plays at n * 0.1 s.
const TONE = { band: 0, durationSec: 3.2 };

/** Starts the cue, waits `atSec`, presses it again; records it all. */
async function pressTwice(t, cue, { atSec = 1.0, thenSec = 1.2, between } = {}) {
    return audio.record(t, async (mark) => {
        mark('first');
        await audio.trigger(cue);
        await audio.sleep(atSec * 1000);
        await between?.(mark);
        mark('again');
        await audio.trigger(cue);
        await audio.sleep(thenSec * 1000);
    });
}

test('restart: plays from the top again, without a gap', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'restart' });
    const take = await pressTwice(t, cue);
    const again = take.at('again');
    const before = take.a.slotAt(0, again - 0.05);
    assert.ok(before >= 8, `was at segment ${before} when pressed again`);
    // Back to the start within one segment of the press.
    const restartAt = take.a.positions(0, again - 0.05, again + 0.3).find((p) => p.slot !== null && p.slot <= 1)?.t;
    assert.ok(restartAt != null, 'never went back to the start');
    near(restartAt - again, 0.03, 0.06, 'press -> back at segment 0');
    // ...and carries on from there.
    assert.equal(take.a.slotAt(0, restartAt + 0.55), 5, 'half a second after restarting');
    take.assertNoDropouts(again - 0.3, again + 1.0);
});

test('toggle_pause_play: pauses, then resumes where it paused', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'toggle_pause_play' });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(1000);
        mark('pause');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'paused');
        await audio.sleep(1000);
        mark('resume');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'playing');
        await audio.sleep(800);
    });
    const pause = take.at('pause');
    const resume = take.at('resume');
    const lastBefore = take.a.slotAt(0, pause - 0.03);
    audio.immediate(take.a.offset(0, { after: pause - 0.05 }) - pause, 'press -> silence');
    assert.ok(take.a.level(0, pause + 0.15, resume - 0.05) < 0.001, 'audible while paused');
    const back = take.a.onset(0, { after: resume - 0.05 });
    audio.immediate(back - resume, 'press -> sound again');
    const firstAfter = take.a.slotAt(0, back + 0.03);
    assert.ok(Math.abs(firstAfter - lastBefore) <= 1, `paused at segment ${lastBefore}, resumed at ${firstAfter}`);
    near(take.a.level(0, back + 0.1, back + 0.6), A, 0.006, 'level after resuming');
});

test('stop: silence at once, and the cue reports stopped', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'stop', fadeOutTime: 1500 });
    const take = await pressTwice(t, cue, { thenSec: 0.5 });
    audio.immediate(take.a.offset(0, { after: take.at('again') - 0.05 }) - take.at('again'), 'press -> silence');
    assert.equal(await audio.status(cue), 'stopped');
});

test('fade_out_and_stop: fades over the cue\'s fadeOutTime', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'fade_out_and_stop', fadeOutTime: 600 });
    const take = await pressTwice(t, cue, { thenSec: 1.0 });
    const again = take.at('again');
    const t90 = take.a.crossing(0, { after: again - 0.02, fraction: 0.9, reference: A });
    const t10 = take.a.crossing(0, { after: again - 0.02, fraction: 0.1, reference: A });
    near(t10 - t90, 0.48, 0.05, '90%->10% of a 600 ms fade');
    // It keeps playing through the file while it fades (not frozen).
    const s1 = take.a.slotAt(0, t90 + 0.02);
    const s2 = take.a.slotAt(0, t10 - 0.02);
    assert.ok(s2 - s1 >= 3, `position ${s1} -> ${s2} during the fade`);
    await audio.waitForStatus(cue, 'stopped', 2000);
});

test('fade_out_and_stop with a fadeOutTime of 0 stops at once', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'fade_out_and_stop', fadeOutTime: 0 });
    const take = await pressTwice(t, cue, { thenSec: 0.5 });
    audio.immediate(take.a.offset(0, { after: take.at('again') - 0.05 }) - take.at('again'), 'press -> silence');
});

test('do_nothing: the press changes nothing you can hear', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'do_nothing' });
    const take = await pressTwice(t, cue, { thenSec: 1.0 });
    const again = take.at('again');
    take.assertNoDropouts(again - 0.5, again + 0.9);
    // Position keeps climbing straight through the press.
    const track = take.a.positions(0, again - 0.3, again + 0.8).map((p) => p.slot);
    for (let i = 1; i < track.length; i++) {
        assert.ok(track[i] >= track[i - 1], `position went back ${track[i - 1]} -> ${track[i]}`);
    }
    near(take.a.level(0, again - 0.4, again + 0.8), A, 0.006, 'level');
});

test('play_new_instance: a second copy layers over the first, which plays on', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'play_new_instance' });
    const take = await pressTwice(t, cue, { atSec: 1.0, thenSec: 3.0 });
    const first = take.a.onset(0, { after: take.at('first') });
    const again = take.at('again');
    assert.equal(take.a.voicesAt(0, again - 0.2), 1, 'one voice before the second press');
    // Two positions at once, ~1 s (10 segments) apart, each at full level.
    const both = take.a.slotsAt(0, again + 0.55).map((s) => s.slot).sort((x, y) => x - y);
    assert.equal(both.length, 2, `positions heard: ${both}`);
    near(both[1] - both[0], 10, 1, 'segments between the two copies');
    near(take.a.level(0, again + 0.2, again + 1.5), Math.SQRT2 * A, 0.02, 'two copies together');
    // The first ends at its own end; the second carries on alone.
    const firstEnds = first + 3.2;
    assert.equal(take.a.voicesAt(0, firstEnds + 0.3), 1, 'one voice after the first copy ended');
    near(take.a.level(0, firstEnds + 0.2, firstEnds + 0.6), A, 0.01, 'level of the remaining copy');
});

// --- Pressing a paused cue ---------------------------------------------------

/** Plays, pauses (toggle-pause), waits, presses with `behavior`. */
async function pressWhilePaused(t, behavior) {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: behavior });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(1000);
        mark('pause');
        await audio.post(`/api/cues/${cue}/toggle-pause`);
        await audio.waitForStatus(cue, 'paused');
        await audio.sleep(500);
        mark('press');
        await audio.trigger(cue);
        await audio.sleep(800);
    });
    return { cue, take, pausedAt: take.a.slotAt(0, take.at('pause') - 0.03) };
}

for (const behavior of ['restart', 'play_new_instance']) {
    test(`paused + ${behavior}: plays once more from the top (one copy)`, async (t) => {
        const { take } = await pressWhilePaused(t, behavior);
        const back = take.a.onset(0, { after: take.at('press') - 0.05 });
        assert.ok(take.a.slotAt(0, back + 0.03) <= 1, `restarted at segment ${take.a.slotAt(0, back + 0.03)}`);
        assert.equal(take.a.voicesAt(0, back + 0.4), 1, 'voices after the press');
    });
}

test('paused + toggle_pause_play: resumes where it paused', async (t) => {
    const { take, pausedAt } = await pressWhilePaused(t, 'toggle_pause_play');
    const back = take.a.onset(0, { after: take.at('press') - 0.05 });
    const resumedAt = take.a.slotAt(0, back + 0.03);
    assert.ok(Math.abs(resumedAt - pausedAt) <= 1, `paused at ${pausedAt}, resumed at ${resumedAt}`);
});

for (const behavior of ['do_nothing', 'stop', 'fade_out_and_stop']) {
    test(`paused + ${behavior}: stays silent`, async (t) => {
        const { cue, take } = await pressWhilePaused(t, behavior);
        assert.ok(take.a.level(0, take.at('press'), take.durationSec) < 0.001, 'audible after the press');
        assert.equal(await audio.status(cue), behavior === 'do_nothing' ? 'paused' : 'stopped');
    });
}

test('a retrigger behavior sent with the press overrides the cue\'s own', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'restart' });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(1000);
        mark('again');
        await audio.trigger(cue, { retriggerBehavior: 'stop' });
        await audio.sleep(500);
    });
    audio.immediate(take.a.offset(0, { after: take.at('again') - 0.05 }) - take.at('again'), 'press -> silence');
});

test('rapid presses (restart x5 in 250 ms) end with one clean copy from the top', async (t) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'restart' });
    const take = await audio.record(t, async (mark) => {
        for (let i = 0; i < 5; i++) {
            mark('press');
            audio.trigger(cue); // not awaited: as fast as a finger can
            await audio.sleep(50);
        }
        await audio.sleep(1200);
    });
    const last = take.at('press', 4);
    assert.equal(take.a.voicesAt(0, last + 0.6), 1, 'voices after the burst');
    const slot = take.a.slotAt(0, last + 0.6);
    assert.ok(slot >= 4 && slot <= 7, `0.6 s after the last press playback is at segment ${slot}`);
    near(take.a.level(0, last + 0.3, last + 1.0), A, 0.006, 'level after the burst');
});
