/**
 * Loopback suite: every per-cue option, verified by what actually comes out
 * of the output - volume, master volume, fades, stop, trim, loop and output
 * routing. test/cue-properties.test.js checks the same options through the
 * engine's reported state; these check the sound.
 */

const assert = require('node:assert/strict');
const { loopbackSuite } = require('./lib/loopback');
const { DEFAULT_AMPLITUDE: A } = require('./lib/signals');

const audio = loopbackSuite();
const { test, near } = audio;

test('volume is linear gain: 1, 0.5, 0.25 and 0.1 play at those fractions of the file', async (t) => {
    const volumes = [1, 0.5, 0.25, 0.1];
    const cues = [];
    for (let band = 0; band < volumes.length; band++) {
        cues.push(await audio.toneCue({ band, durationSec: 2 }, { volume: volumes[band] }));
    }
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        for (const cue of cues) await audio.trigger(cue);
        await audio.sleep(1500);
    });
    const start = take.at('trigger');
    volumes.forEach((volume, band) => {
        near(take.a.level(band, start + 0.4, start + 1.3), A * volume, 0.006, `band ${band} at volume ${volume}`);
    });
});

test('volume 0 is silent, though the cue plays', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 2 }, { volume: 0 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForStatus(cue, 'playing');
        await audio.sleep(800);
        assert.equal(await audio.status(cue), 'playing');
    });
    assert.ok(take.a.level(0, take.at('trigger'), take.durationSec) < 0.001, 'audible at volume 0');
});

test('changing a playing cue\'s volume changes its level within a moment, without a gap', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(1000);
        mark('volume');
        await audio.updateCue(cue, { volume: 0.25 });
        await audio.sleep(1000);
    });
    const at = take.at('volume');
    near(take.a.level(0, at - 0.5, at - 0.1), A, 0.006, 'before');
    near(take.a.level(0, at + 0.2, at + 0.8), A * 0.25, 0.006, 'after');
    // Ramped, not cut: the level never drops out on the way.
    const dip = Math.min(...take.a.envelope(0, { t0: at - 0.1, t1: at + 0.3 }).map((p) => p.level));
    assert.ok(dip > A * 0.2, `level dipped to ${dip.toFixed(3)} during the change`);
    take.assertNoDropouts(at - 0.5, at + 0.8);
    // And the cue kept its place: positions continue across the change.
    const before = take.a.slotAt(0, at - 0.05);
    const after = take.a.slotAt(0, at + 0.15);
    assert.ok(after - before >= 1 && after - before <= 3, `position jumped ${before} -> ${after}`);
});

test('master volume scales everything playing, including above 1 (up to 2)', async (t) => {
    const a = await audio.toneCue({ band: 0, durationSec: 6.4, segmentSec: 0.2 }, { volume: 0.5 });
    const b = await audio.toneCue({ band: 1, durationSec: 6.4, segmentSec: 0.2 }, { volume: 1 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(a);
        await audio.trigger(b);
        await audio.sleep(800);
        mark('half');
        await audio.post('/api/remote/master-volume', { volume: 0.5 });
        await audio.sleep(800);
        mark('zero');
        await audio.post('/api/remote/master-volume', { volume: 0 });
        await audio.sleep(800);
        mark('boost');
        await audio.post('/api/remote/master-volume', { volume: 1.6 });
        await audio.sleep(800);
    });
    const span = (label) => [take.at(label) + 0.2, take.at(label) + 0.7];
    near(take.a.level(0, take.at('half') - 0.6, take.at('half') - 0.1), A * 0.5, 0.006, 'cue A at master 1');
    near(take.a.level(0, ...span('half')), A * 0.25, 0.006, 'cue A at master 0.5');
    near(take.a.level(1, ...span('half')), A * 0.5, 0.006, 'cue B at master 0.5');
    assert.ok(take.a.level(0, ...span('zero')) < 0.001 && take.a.level(1, ...span('zero')) < 0.001, 'audible at master 0');
    near(take.a.level(0, ...span('boost')), A * 0.5 * 1.6, 0.01, 'cue A at master 1.6');
    near(take.a.level(1, ...span('boost')), A * 1.6, 0.012, 'cue B at master 1.6');
});

test('fade in ramps linearly from silence to the cue volume over fadeInTime', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 }, { fadeInTime: 1000, volume: 0.8 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(1800);
    });
    const full = A * 0.8;
    const after = take.at('trigger');
    const begun = take.a.onset(0, { after });
    take.assertNoDropouts(begun + 0.05, begun + 1.6);
    const t10 = take.a.crossing(0, { after, fraction: 0.1, reference: full, direction: 'rising' });
    const t50 = take.a.crossing(0, { after, fraction: 0.5, reference: full, direction: 'rising' });
    const t90 = take.a.crossing(0, { after, fraction: 0.9, reference: full, direction: 'rising' });
    // A linear 1 s ramp crosses 10 % and 90 % 0.8 s apart, 50 % halfway.
    near(t90 - t10, 0.8, 0.05, '10%->90% rise time');
    near(t50 - t10, 0.4, 0.04, '10%->50% rise time');
    near(take.a.level(0, t90 + 0.25, t90 + 0.6), full, 0.006, 'level after the fade');
    // The position started at the top - the fade didn't skip the start.
    assert.ok(take.a.slotAt(0, t10) <= 2, `fade-in started at segment ${take.a.slotAt(0, t10)}`);
});

test('stop with fade ramps out over fadeOutTime, then the cue reports stopped', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 }, { fadeOutTime: 800 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(700);
        mark('stop');
        await audio.stop(cue, { fadeOut: true });
        assert.notEqual(await audio.status(cue), 'stopped', 'reported stopped while still fading');
        await audio.waitForStatus(cue, 'stopped', 3000);
        mark('reported-stopped');
    });
    const after = take.at('stop');
    take.assertNoDropouts(after - 0.4, after + 0.7);
    const t90 = take.a.crossing(0, { after, fraction: 0.9, reference: A });
    const t10 = take.a.crossing(0, { after, fraction: 0.1, reference: A });
    near(t10 - t90, 0.64, 0.05, '90%->10% fall time of an 800 ms fade');
    const silent = take.a.offset(0, { after });
    near(silent - after, 0.8, 0.08, 'stop to silence');
    // "stopped" comes once the fade has reached silence, not before it.
    assert.ok(take.at('reported-stopped') >= silent - 0.08, 'reported stopped before the fade finished');
});

test('stop without fade cuts to silence immediately, even with a fadeOutTime set', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 }, { fadeOutTime: 2000 });
    const take = await audio.record(t, async (mark) => {
        await audio.trigger(cue);
        await audio.sleep(700);
        mark('stop');
        await audio.stop(cue);
        await audio.sleep(400);
    });
    const silent = take.a.offset(0, { after: take.at('stop') - 0.05 });
    audio.immediate(silent - take.at('stop'), 'stop to silence');
});

test('trim start and end: plays only the trimmed region', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 }, { trimStartTime: 0.5, trimEndTime: 1.5 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 4000);
    });
    const start = take.a.onset(0, { after: take.at('trigger') });
    const end = take.a.offset(0, { after: start + 0.2 });
    near(end - start, 1.0, 0.06, 'played duration');
    assert.equal(take.a.slotAt(0, start + 0.05), 5, 'first segment heard');
    assert.equal(take.a.slotAt(0, end - 0.06), 14, 'last segment heard');
    assert.equal(await audio.status(cue), 'completed');
});

test('loop: plays the file again and again with no gap at the seam', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 1.2 }, { loop: true });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(3300);
        mark('stop');
        await audio.stop(cue);
    });
    const start = take.a.onset(0, { after: take.at('trigger') });
    const end = take.at('stop');
    // Never silent (nor dipping) while looping.
    take.assertNoDropouts(start + 0.05, end - 0.05);
    const lowest = Math.min(...take.a.envelope(0, { t0: start + 0.05, t1: end - 0.05 }).map((p) => p.level));
    assert.ok(lowest > A * 0.8, `level dipped to ${lowest.toFixed(3)} while looping`);
    // Position wraps 11 -> 0 at each 1.2 s seam.
    for (const pass of [1, 2]) {
        const seam = start + 1.2 * pass;
        assert.equal(take.a.slotAt(0, seam - 0.05), 11, `segment before seam ${pass}`);
        assert.equal(take.a.slotAt(0, seam + 0.05), 0, `segment after seam ${pass}`);
    }
});

test('trim + loop repeats just the trimmed region', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 }, { trimStartTime: 0.3, trimEndTime: 0.9, loop: true });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(2000);
    });
    const start = take.a.onset(0, { after: take.at('trigger') });
    take.assertNoDropouts(start + 0.05, start + 1.8);
    const heard = new Set(take.a.positions(0, start + 0.05, start + 1.8).map((p) => p.slot));
    assert.deepEqual([...heard].sort((x, y) => x - y), [3, 4, 5, 6, 7, 8], 'segments heard');
    assert.equal(take.a.slotAt(0, start + 0.6 + 0.05), 3, 'back at the trim start after one pass');
});

// Output routing: a stereo file with its left channel in band 0 and its
// right in band 2, so each output channel shows which input reached it.
//
// Both sides to one output ([0, 0] / [1, 1]) folds the file down: each side
// at half level (WO-005 - it used to drop the right channel).
for (const { patch, expect, level } of [
    { patch: [0, 1], expect: [[0], [2]], level: A },
    { patch: [1, 0], expect: [[2], [0]], level: A },
    { patch: [0, 0], expect: [[0, 2], []], level: A / 2 },
    { patch: [1, 1], expect: [[], [0, 2]], level: A / 2 },
]) {
    const name = `output patch [${patch}]: out L gets band(s) ${expect[0].join('+') || 'none'}, out R ${expect[1].join('+') || 'none'}`;
    test(name, async (t) => {
        const cue = await audio.toneCue({ band: 0, rightBand: 2, durationSec: 2 }, { outputPatch: patch });
        const take = await audio.record(t, async (mark) => {
            mark('trigger');
            await audio.trigger(cue);
            await audio.sleep(1200);
        });
        const t0 = take.at('trigger') + 0.3;
        const t1 = take.at('trigger') + 1.0;
        for (const channel of [0, 1]) {
            for (const band of [0, 2]) {
                const heard = take.a.level(band, t0, t1, { channel });
                if (expect[channel].includes(band)) {
                    near(heard, level, 0.01, `band ${band} on output ${channel}`);
                } else {
                    assert.ok(heard < 0.002, `band ${band} leaked onto output ${channel} (${heard.toFixed(4)})`);
                }
            }
        }
    });
}

test('a file with the same content in both channels keeps its level when routed to one output', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 2 }, { outputPatch: [0, 0] });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(1200);
    });
    const t0 = take.at('trigger') + 0.3;
    near(take.a.level(0, t0, t0 + 0.7, { channel: 0 }), A, 0.01, 'level on the one output');
    assert.ok(take.a.level(0, t0, t0 + 0.7, { channel: 1 }) < 0.002, 'the other output not silent');
});
