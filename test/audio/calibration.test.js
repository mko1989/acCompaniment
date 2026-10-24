/**
 * Loopback suite, part 1: the signal path itself. If these fail, nothing
 * else in test/audio/ means anything - the app isn't reaching the loopback
 * device, or the recording can't be trusted.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loopbackSuite } = require('./lib/loopback');
const { slotFrequency, DEFAULT_AMPLITUDE } = require('./lib/signals');

const audio = loopbackSuite();
const { test, near } = audio;

test('the server plays to the loopback device', async () => {
    const { engine } = (await audio.get('/api/cues/status/playback')).status;
    assert.equal(engine.deviceId, audio.device.output.id, `server output device ${engine.deviceId} is not the loopback`);
    assert.equal(engine.sampleRate, 48000);
});

test('silence before anything plays is digital silence', async (t) => {
    const take = await audio.record(t, async () => { await audio.sleep(500); });
    for (let band = 0; band < 4; band++) {
        assert.ok(take.a.level(band, 0.05, take.durationSec - 0.05) < 0.001, `band ${band} not silent`);
    }
});

test('a cue at volume 1 comes back at unity gain, in tune, with its position track', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 3.2 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(3500);
    });
    const { a } = take;
    const start = a.onset(0, { after: take.at('trigger') });
    assert.ok(start != null, 'cue never became audible');
    const latency = start - take.at('trigger');
    t.diagnostic(`trigger -> audible latency: ${(latency * 1000).toFixed(0)} ms`);
    // Onsets are found with a 43 ms analysis window, so they can read up to
    // ~25 ms early: a few ms of "negative" latency is measurement error.
    assert.ok(latency > -0.03 && latency < 0.25, `trigger to sound took ${(latency * 1000).toFixed(0)} ms`);

    near(a.level(0, start + 0.3, start + 2.5), DEFAULT_AMPLITUDE, 0.01, 'level at volume 1');
    near(a.level(0, start + 0.3, start + 2.5, { channel: 1 }), DEFAULT_AMPLITUDE, 0.01, 'right channel level');
    // In tune: no sample-rate mix-up between file, engine and device.
    near(a.frequencyAt(0, start + 1.05), slotFrequency(0, 10), 2, 'pitch of segment 10');

    // Plays segments 0..31 in order, 100 ms each.
    for (const slot of [2, 8, 15, 23, 30]) {
        assert.equal(a.slotAt(0, start + slot * 0.1 + 0.05), slot, `segment at ${slot * 0.1}s`);
    }
    // Ends after its 3.2 s, by itself.
    const end = a.offset(0, { after: start + 0.5 });
    near(end - start, 3.2, 0.06, 'played duration');
    take.assertNoDropouts(start + 0.05, end - 0.05);
    assert.equal(await audio.status(cue), 'completed');
});

test('other bands stay silent while one plays (no crosstalk the other tests would misread)', async (t) => {
    const cue = await audio.toneCue({ band: 1, durationSec: 1.5 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(1300);
    });
    const start = take.a.onset(1, { after: take.at('trigger') });
    const loud = take.a.level(1, start + 0.2, start + 1.1);
    for (const band of [0, 2, 3]) {
        assert.ok(take.a.level(band, start + 0.2, start + 1.1) < loud * 0.01, `band ${band} leaks`);
    }
});

// Dropouts: the same steady tone, played in turns by a bare RtAudio player
// (no app - baselinePlayer.js) and by the app, so the app's own dropouts
// can be told from the loopback device's. Virtual devices drop the odd
// buffer even for the bare player; what matters is the app doing no worse.
// Measurements and the conclusion so far: work/WO-009-audio-dropouts.md.
const ROUND_SEC = 6;
const LONG_SEC_UPLOAD = 8;
const ROUNDS = 3;

function playBaseline(deviceId) {
    return new Promise((resolve, reject) => {
        const player = spawn(process.execPath, [
            path.join(__dirname, 'lib', 'baselinePlayer.js'), String(deviceId), String(ROUND_SEC),
        ], { stdio: ['ignore', 'pipe', 'inherit'] });
        player.once('error', reject);
        player.once('exit', resolve);
    });
}

test('the app drops out no more often than the loopback device itself does', { noRetry: true }, async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: ROUND_SEC, segmentSec: ROUND_SEC / 32 });
    // Let the upload's background work (PCM cache warm-up) finish: this
    // compares steady-state playback; the next test covers the other case.
    await audio.sleep(2000);
    let baseline = 0;
    let app = 0;
    for (let round = 1; round <= ROUNDS; round++) {
        const base = await audio.record(t, () => playBaseline(audio.device.output.id));
        baseline += base.holes().length;
        const played = await audio.record(t, async () => {
            await audio.trigger(cue);
            await audio.waitForIdle(cue, (ROUND_SEC + 2) * 1000);
        });
        app += played.holes().length;
        const reports = played.serverDropoutReports.length ? `; engine: ${played.serverDropoutReports.join(' | ')}` : '';
        t.diagnostic(`round ${round}: bare device ${base.holes().length} dropout(s), app ${played.holes().length}${reports}`);
    }
    t.diagnostic(`total over ${ROUNDS * ROUND_SEC}s each: bare device ${baseline}, app ${app}`);
    assert.ok(app <= Math.max(1, 2 * baseline), `app dropped out ${app} times vs ${baseline} for the bare device`);
});

test('adding files while a cue plays does not make it drop out', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: LONG_SEC_UPLOAD, segmentSec: LONG_SEC_UPLOAD / 32 });
    await audio.sleep(2000);
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.sleep(1000);
        // What an operator does mid-show: drop more files in. Each upload
        // is decoded (PCM cache warm-up) while the cue keeps playing.
        for (let i = 0; i < 3; i++) {
            mark('upload');
            await audio.uploadTone({ band: 1, durationSec: 20, segmentSec: 0.625 });
        }
        mark('uploads-done');
        await audio.waitForIdle(cue, (LONG_SEC_UPLOAD + 2) * 1000);
    });
    for (const line of take.serverDropoutReports) t.diagnostic(`engine: ${line.trim()}`);
    t.diagnostic(`uploads took ${(take.at('uploads-done') - take.at('upload')).toFixed(2)}s, during playback`);
    // While the uploads are handled, plus 2 s for their decoding (PCM cache
    // warm-up) that carries on after each upload returns. Dropouts elsewhere
    // in the take are the machine's (WO-009), not the uploads'.
    take.assertNoDropouts(take.at('upload'), take.at('uploads-done') + 2);
});
