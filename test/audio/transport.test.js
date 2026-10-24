/**
 * Loopback suite: the show-wide controls, heard - pause/resume, Stop All
 * (both behaviors), crossfade mode and ducking. Each cue plays in its own
 * band, so the recording shows every cue's level through every transition.
 */

const assert = require('node:assert/strict');
const { loopbackSuite } = require('./lib/loopback');
const { DEFAULT_AMPLITUDE: A } = require('./lib/signals');

const audio = loopbackSuite();
const { test, near } = audio;

// Long enough to outlast every transition below; 200 ms segments.
const LONG = { durationSec: 6.4, segmentSec: 0.2 };

test('pause / resume (toggle-pause): silent while paused, picks up at the same place', async (t) => {
    const cue = await audio.toneCue({ band: 0, ...LONG });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(1100);
        mark('pause');
        await audio.post(`/api/cues/${cue}/toggle-pause`);
        await audio.sleep(1000);
        mark('resume');
        await audio.post(`/api/cues/${cue}/toggle-pause`);
        await audio.sleep(800);
    });
    const pause = take.at('pause');
    const resume = take.at('resume');
    audio.immediate(take.a.offset(0, { after: pause - 0.05 }) - pause, 'pause -> silence');
    assert.ok(take.a.level(0, pause + 0.15, resume - 0.05) < 0.001, 'audible while paused');
    const back = take.a.onset(0, { after: resume - 0.05 });
    audio.immediate(back - resume, 'resume -> sound');
    const pausedAt = take.a.slotAt(0, pause - 0.05);
    const resumedAt = take.a.slotAt(0, back + 0.05);
    assert.ok(Math.abs(resumedAt - pausedAt) <= 1, `paused at segment ${pausedAt}, resumed at ${resumedAt}`);
});

test('Stop All (stop): every cue goes silent at once', async (t) => {
    const cues = [];
    for (const band of [0, 1, 2]) cues.push(await audio.toneCue({ band, ...LONG }, { fadeOutTime: 2000 }));
    const take = await audio.record(t, async (mark) => {
        for (const cue of cues) await audio.trigger(cue);
        await audio.sleep(800);
        mark('stop-all');
        await audio.post('/api/cues/stop-all', { behavior: 'stop' });
        await audio.sleep(500);
    });
    const at = take.at('stop-all');
    for (const band of [0, 1, 2]) {
        audio.immediate(take.a.offset(band, { after: at - 0.05 }) - at, `band ${band}: Stop All -> silence`);
    }
    for (const cue of cues) assert.equal(await audio.status(cue), 'stopped');
});

test('Stop All (fade): every cue fades together over defaultStopAllFadeOutTime, not its own fadeOutTime', async (t) => {
    await audio.setConfig({ defaultStopAllFadeOutTime: 1000 });
    const a = await audio.toneCue({ band: 0, ...LONG }, { fadeOutTime: 0 });
    const b = await audio.toneCue({ band: 1, ...LONG }, { fadeOutTime: 3000, volume: 0.5 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(a);
        await audio.trigger(b);
        await audio.sleep(800);
        mark('stop-all');
        await audio.post('/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
        await audio.waitForStatus(b, 'stopped', 3000);
        mark('stopped');
    });
    const at = take.at('stop-all');
    for (const [band, level] of [[0, A], [1, A * 0.5]]) {
        const t90 = take.a.crossing(band, { after: at - 0.02, fraction: 0.9, reference: level });
        const t10 = take.a.crossing(band, { after: at - 0.02, fraction: 0.1, reference: level });
        near(t10 - t90, 0.8, 0.05, `band ${band}: 90%->10% of a 1 s fade`);
        near(take.a.offset(band, { after: at }) - at, 1.0, 0.08, `band ${band}: Stop All -> silence`);
    }
    await audio.setConfig({ defaultStopAllFadeOutTime: 1500 });
});

test('Stop All with no behavior given follows the configured defaultStopAllBehavior', async (t) => {
    await audio.setConfig({ defaultStopAllBehavior: 'fade_out_and_stop', defaultStopAllFadeOutTime: 600 });
    const cue = await audio.toneCue({ band: 0, ...LONG });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(700);
        mark('stop-all');
        await audio.post('/api/cues/stop-all', {});
        await audio.sleep(1000);
    });
    near(take.a.offset(0, { after: take.at('stop-all') }) - take.at('stop-all'), 0.6, 0.08, 'faded over 600 ms');
    await audio.setConfig({ defaultStopAllBehavior: 'stop', defaultStopAllFadeOutTime: 1500 });
});

test('crossfade mode: the new cue fades in while the playing one fades out, over crossfadeTime', async (t) => {
    await audio.setConfig({ crossfadeTime: 1500 });
    const outgoing = await audio.toneCue({ band: 0, ...LONG });
    const incoming = await audio.toneCue({ band: 1, ...LONG });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(outgoing);
        await audio.sleep(700);
        await audio.post('/api/remote/crossfade', { enabled: true });
        mark('go');
        await audio.trigger(incoming);
        await audio.sleep(2200);
    });
    const go = take.at('go');
    // Out: 90%->10% in 0.8 of the fade; in: 10%->90% the same.
    const out90 = take.a.crossing(0, { after: go - 0.02, fraction: 0.9, reference: A });
    const out10 = take.a.crossing(0, { after: go - 0.02, fraction: 0.1, reference: A });
    const in10 = take.a.crossing(1, { after: go - 0.02, fraction: 0.1, reference: A, direction: 'rising' });
    const in90 = take.a.crossing(1, { after: go - 0.02, fraction: 0.9, reference: A, direction: 'rising' });
    near(out10 - out90, 1.2, 0.06, 'outgoing 90%->10%');
    near(in90 - in10, 1.2, 0.06, 'incoming 10%->90%');
    // Together: they start and end together, so they cross at the midpoint.
    near(in10 - out90, 0, 0.06, 'fade out and fade in begin together');
    const mid = go + 0.75;
    near(take.a.levelAt(0, mid), A / 2, 0.03, 'outgoing at the midpoint');
    near(take.a.levelAt(1, mid), A / 2, 0.03, 'incoming at the midpoint');
    assert.equal(await audio.status(outgoing), 'stopped');
    near(take.a.level(1, go + 1.7, go + 2.1), A, 0.006, 'incoming at full level after');
    await audio.setConfig({ crossfadeTime: 2000 });
});

test('crossfade mode off: starting a cue leaves the others playing untouched', async (t) => {
    const a = await audio.toneCue({ band: 0, ...LONG });
    const b = await audio.toneCue({ band: 1, ...LONG });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(a);
        await audio.sleep(600);
        mark('go');
        await audio.trigger(b);
        await audio.sleep(1000);
    });
    const go = take.at('go');
    take.assertNoDropouts(go - 0.4, go + 0.9);
    near(take.a.level(0, go + 0.2, go + 0.9), A, 0.006, 'first cue level after the second starts');
    near(take.a.level(1, go + 0.2, go + 0.9), A, 0.006, 'second cue level');
});

test('ducking: a trigger cue lowers ducked cues to (100 - duckingLevel)% over duckingFadeTime, and restores them', async (t) => {
    await audio.setConfig({ duckingFadeTime: 500 });
    const bed = await audio.toneCue({ band: 0, ...LONG }, { enableDucking: true });
    const other = await audio.toneCue({ band: 2, ...LONG }); // not ducked
    const voice = await audio.toneCue({ band: 1, durationSec: 1.6 }, { isDuckingTrigger: true, duckingLevel: 75 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(bed);
        await audio.trigger(other);
        await audio.sleep(600);
        mark('voice');
        await audio.trigger(voice);
        await audio.waitForIdle(voice, 4000);
        mark('voice-ended');
        await audio.sleep(1000);
    });
    const v = take.at('voice');
    const end = take.at('voice-ended');
    near(take.a.level(0, v - 0.4, v - 0.05), A, 0.006, 'bed before');
    near(take.a.level(0, v + 0.7, v + 1.4), A * 0.25, 0.01, 'bed while ducked (75% duck)');
    near(take.a.level(2, v + 0.7, v + 1.4), A, 0.006, 'a cue without ducking is untouched');
    near(take.a.level(1, v + 0.2, v + 1.4), A, 0.006, 'the trigger itself is not ducked');
    // Ramps rather than steps, over ~duckingFadeTime.
    const d90 = take.a.crossing(0, { after: v - 0.02, fraction: 0.9, reference: A });
    const d40 = take.a.crossing(0, { after: v - 0.02, fraction: 0.4, reference: A });
    near(d40 - d90, 0.5 * (0.5 / 0.75), 0.06, 'duck ramp from 90% to 40%');
    near(take.a.level(0, end + 0.6, end + 0.95), A, 0.006, 'bed restored after the trigger ends');
    await audio.setConfig({ duckingFadeTime: 1000 });
});

test('ducking: pausing the trigger restores the ducked cue; resuming ducks it again', async (t) => {
    await audio.setConfig({ duckingFadeTime: 300 });
    const bed = await audio.toneCue({ band: 0, ...LONG }, { enableDucking: true });
    const voice = await audio.toneCue({ band: 1, ...LONG }, { isDuckingTrigger: true, duckingLevel: 50 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(bed);
        await audio.trigger(voice);
        await audio.sleep(800);
        mark('pause');
        await audio.post(`/api/cues/${voice}/toggle-pause`);
        await audio.sleep(800);
        mark('resume');
        await audio.post(`/api/cues/${voice}/toggle-pause`);
        await audio.sleep(800);
    });
    const pause = take.at('pause');
    const resume = take.at('resume');
    near(take.a.level(0, pause - 0.4, pause - 0.05), A * 0.5, 0.01, 'ducked while the trigger plays');
    near(take.a.level(0, pause + 0.45, resume - 0.05), A, 0.01, 'restored while the trigger is paused');
    near(take.a.level(0, resume + 0.45, resume + 0.75), A * 0.5, 0.01, 'ducked again once it resumes');
    await audio.setConfig({ duckingFadeTime: 1000 });
});

test('a cue started while a trigger plays starts already ducked (no blast at full level)', async (t) => {
    const voice = await audio.toneCue({ band: 1, ...LONG }, { isDuckingTrigger: true, duckingLevel: 80 });
    const bed = await audio.toneCue({ band: 0, ...LONG }, { enableDucking: true });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(voice);
        await audio.sleep(500);
        mark('bed');
        await audio.trigger(bed);
        await audio.sleep(800);
    });
    const start = take.a.onset(0, { after: take.at('bed') });
    const loudest = Math.max(...take.a.envelope(0, { t0: start, t1: start + 0.7 }).map((p) => p.level));
    assert.ok(loudest < A * 0.25, `bed peaked at ${loudest.toFixed(3)} on entry (expected ~${(A * 0.2).toFixed(2)})`);
    near(take.a.level(0, start + 0.1, start + 0.7), A * 0.2, 0.01, 'bed level');
});
