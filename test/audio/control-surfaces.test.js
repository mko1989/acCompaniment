/**
 * Loopback suite: every way of driving the app makes the same sound - the
 * remote page's REST API (/api/remote), the browser UI's WebSocket
 * messages and the Companion module's. The feature tests use the main
 * REST API; these check the other surfaces reach the audio too.
 */

const assert = require('node:assert/strict');
const { loopbackSuite } = require('./lib/loopback');
const { connectWs, wsSend, waitForMessage } = require('../helpers/harness');
const { DEFAULT_AMPLITUDE: A } = require('./lib/signals');

const audio = loopbackSuite();
const { test, near } = audio;

const LONG = { band: 0, durationSec: 6.4, segmentSec: 0.2 };

/** A WebSocket client for the test, closed when it ends. */
async function socket(t) {
    const ws = await connectWs(audio.baseUrl());
    t.after(() => ws.close());
    return ws;
}

/** Sends a WebSocket command and waits for its reply message. */
async function command(ws, type, payload, replyType) {
    const reply = replyType ? waitForMessage(ws, (m) => m.type === replyType, 5000) : null;
    wsSend(ws, type, payload);
    return reply;
}

/** Records `start` then, 0.8 s later, `stop`; checks the cue was heard between them only. */
async function startsAndStops(t, cue, start, stop) {
    const take = await audio.record(t, async (mark) => {
        mark('start');
        await start();
        await audio.sleep(800);
        mark('stop');
        await stop();
        await audio.sleep(500);
    });
    const on = take.a.onset(0, { after: take.at('start') - 0.05 });
    audio.immediate(on - take.at('start'), 'start -> sound');
    near(take.a.level(0, on + 0.2, take.at('stop') - 0.1), A, 0.006, 'level');
    audio.immediate(take.a.offset(0, { after: take.at('stop') - 0.05 }) - take.at('stop'), 'stop -> silence');
    return take;
}

test('remote page API: trigger and stop', async (t) => {
    const cue = await audio.toneCue(LONG);
    await startsAndStops(
        t, cue,
        () => audio.post(`/api/remote/cues/${cue}/trigger`),
        () => audio.post(`/api/remote/cues/${cue}/stop`),
    );
});

test('remote page API: stop with fade uses the cue\'s fade-out time', async (t) => {
    const cue = await audio.toneCue(LONG, { fadeOutTime: 700 });
    const take = await audio.record(t, async (mark) => {
        await audio.post(`/api/remote/cues/${cue}/trigger`);
        await audio.sleep(700);
        mark('stop');
        await audio.post(`/api/remote/cues/${cue}/stop`, { fadeOut: true });
        await audio.sleep(1100);
    });
    near(take.a.offset(0, { after: take.at('stop') }) - take.at('stop'), 0.7, 0.08, 'fade length');
});

test('remote page API: plain Stop All silences everything at once', async (t) => {
    const a = await audio.toneCue(LONG);
    const b = await audio.toneCue({ ...LONG, band: 1 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(a);
        await audio.trigger(b);
        await audio.sleep(700);
        mark('stop-all');
        await audio.post('/api/remote/cues/stop-all', { behavior: 'stop' });
        await audio.sleep(500);
    });
    for (const band of [0, 1]) {
        audio.immediate(take.a.offset(band, { after: take.at('stop-all') - 0.05 }) - take.at('stop-all'), `band ${band} silenced`);
    }
});

test('remote page API: playlist navigate switches items', async (t) => {
    const cue = await audio.tonePlaylist([{ band: 0, durationSec: 3 }, { band: 1, durationSec: 3 }]);
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(700);
        mark('next');
        await audio.post(`/api/remote/cues/${cue}/playlist/navigate`, { direction: 'next' });
        await audio.sleep(700);
    });
    const next = take.at('next');
    audio.immediate(take.a.onset(1, { after: next - 0.05 }) - next, 'next item audible');
    assert.ok(take.a.level(0, next + 0.2, next + 0.6) < 0.001, 'first item still audible');
});

test('browser WebSocket: trigger_cue and stop_cue', async (t) => {
    const ws = await socket(t);
    const cue = await audio.toneCue(LONG);
    await startsAndStops(
        t, cue,
        () => command(ws, 'trigger_cue', { cueId: cue }),
        () => command(ws, 'stop_cue', { cueId: cue }, 'cue_stopped'),
    );
});

test('Companion: Trigger Cue (toggle_cue) follows the retrigger behavior', async (t) => {
    const ws = await socket(t);
    const cue = await audio.toneCue(LONG, { retriggerBehavior: 'toggle_pause_play' });
    const take = await audio.record(t, async (mark) => {
        mark('press');
        await command(ws, 'toggle_cue', { cueId: cue, fromCompanion: true });
        await audio.sleep(700);
        mark('press');
        await command(ws, 'toggle_cue', { cueId: cue, fromCompanion: true });
        await audio.sleep(500);
    });
    audio.immediate(take.a.onset(0, { after: take.at('press', 0) - 0.05 }) - take.at('press', 0), 'first press -> sound');
    audio.immediate(take.a.offset(0, { after: take.at('press', 1) - 0.05 }) - take.at('press', 1), 'second press -> paused');
    assert.equal(await audio.status(cue), 'paused');
});

test('Companion: Stop Cue with fade, Stop All, pause and master volume', async (t) => {
    const ws = await socket(t);
    const a = await audio.toneCue(LONG, { fadeOutTime: 500 });
    const b = await audio.toneCue({ ...LONG, band: 1 });
    const take = await audio.record(t, async (mark) => {
        await command(ws, 'play_cue', { cueId: a }, 'cue_played');
        await command(ws, 'play_cue', { cueId: b }, 'cue_played');
        await audio.sleep(600);
        mark('master');
        await command(ws, 'set_master_volume', { volume: 0.5 }, 'master_volume_set');
        await audio.sleep(600);
        mark('pause-b');
        await command(ws, 'toggle_pause_cue', { cueId: b }, 'cue_pause_toggled');
        await audio.sleep(500);
        mark('fade-a');
        await command(ws, 'stop_cue', { cueId: a, fadeOut: true }, 'cue_stopped');
        await audio.sleep(800);
        mark('resume-b');
        await command(ws, 'toggle_pause_cue', { cueId: b }, 'cue_pause_toggled');
        await audio.sleep(500);
        mark('stop-all');
        await command(ws, 'stop_all_cues', { behavior: 'stop' }, 'all_cues_stopped');
        await audio.sleep(400);
    });
    const at = (label) => take.at(label);
    near(take.a.level(0, at('master') + 0.2, at('pause-b') - 0.05), A * 0.5, 0.006, 'cue A at master 0.5');
    assert.ok(take.a.level(1, at('pause-b') + 0.15, at('resume-b') - 0.05) < 0.001, 'cue B audible while paused');
    near(take.a.offset(0, { after: at('fade-a') }) - at('fade-a'), 0.5, 0.08, 'cue A fade-out');
    near(take.a.level(1, at('resume-b') + 0.15, at('stop-all') - 0.05), A * 0.5, 0.006, 'cue B resumed');
    audio.immediate(take.a.offset(1, { after: at('stop-all') - 0.05 }) - at('stop-all'), 'Stop All -> silence');
});

test('Companion: Play Cue starts a cue, keeps a playing one playing, and resumes a paused one (WO-008)', async (t) => {
    // Play means "make it play", whatever the cue's retrigger behavior -
    // here toggle_pause_play, which a Trigger press would pause.
    const ws = await socket(t);
    const cue = await audio.toneCue(LONG, { retriggerBehavior: 'toggle_pause_play' });
    const take = await audio.record(t, async (mark) => {
        mark('play');
        await command(ws, 'play_cue', { cueId: cue }, 'cue_played');
        await audio.sleep(700);
        mark('play-again');
        await command(ws, 'play_cue', { cueId: cue }, 'cue_played');
        await audio.sleep(600);
        mark('pause');
        await command(ws, 'toggle_pause_cue', { cueId: cue }, 'cue_pause_toggled');
        await audio.sleep(500);
        mark('play-paused');
        await command(ws, 'play_cue', { cueId: cue }, 'cue_played');
        await audio.sleep(500);
    });
    audio.immediate(take.a.onset(0, { after: take.at('play') - 0.05 }) - take.at('play'), 'Play -> sound');
    const again = take.at('play-again');
    take.assertNoDropouts(again - 0.3, again + 0.5);
    near(take.a.level(0, again + 0.1, again + 0.5), A, 0.006, 'still playing after a second Play');
    const track = take.a.positions(0, again - 0.2, again + 0.4).map((p) => p.slot);
    assert.ok(track.every((slot, i) => i === 0 || slot >= track[i - 1]), `a second Play moved the position: ${track}`);
    const pause = take.at('pause');
    const resume = take.at('play-paused');
    assert.ok(take.a.level(0, pause + 0.15, resume - 0.05) < 0.001, 'audible while paused');
    const back = take.a.onset(0, { after: resume - 0.05 });
    audio.immediate(back - resume, 'Play on a paused cue -> sound');
    const pausedAt = take.a.slotAt(0, pause - 0.05);
    const resumedAt = take.a.slotAt(0, back + 0.05);
    assert.ok(Math.abs(resumedAt - pausedAt) <= 1, `paused at segment ${pausedAt}, Play resumed at ${resumedAt}`);
});
