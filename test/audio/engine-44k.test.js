/**
 * Loopback suite: the audio engine running at 44.1 kHz (audioSampleRate)
 * instead of the default 48 kHz. Everything time-based in the mixer counts
 * samples, so a stray 48000 anywhere shows up here as a file out of tune,
 * a fade of the wrong length or a trim in the wrong place.
 */

const assert = require('node:assert/strict');
const { loopbackSuite } = require('./lib/loopback');
const { DEFAULT_AMPLITUDE: A, slotFrequency } = require('./lib/signals');

const RATE = 44100;
const audio = loopbackSuite({ sampleRate: RATE });
const { test, near } = audio;

test('the engine runs at 44.1 kHz', async () => {
    const config = (await audio.get('/api/config')).config;
    assert.equal(config.audioSampleRate, RATE);
});

for (const tone of [
    { sampleRate: 48000, format: 'wav' },
    { sampleRate: 44100, format: 'wav' },
    { sampleRate: 44100, format: 'mp3' },
]) {
    test(`a ${tone.sampleRate / 1000} kHz ${tone.format} plays in tune and on time`, async (t) => {
        const cue = await audio.toneCue({ band: 0, durationSec: 2, ...tone });
        const take = await audio.record(t, async (mark) => {
            mark('trigger');
            await audio.trigger(cue);
            await audio.waitForIdle(cue, 5000);
        });
        assert.equal(take.sampleRate, RATE);
        const start = take.a.onset(0, { after: take.at('trigger') });
        near(take.a.offset(0, { after: start + 0.2 }) - start, 2, 0.08, 'played length');
        near(take.a.frequencyAt(0, start + 1.15), slotFrequency(0, 11), 4, 'pitch');
        for (const slot of [4, 12, 18]) {
            assert.equal(take.a.slotAt(0, start + slot * 0.1 + 0.05), slot, `segment ${slot} on time`);
        }
        near(take.a.level(0, start + 0.3, start + 1.7), A, tone.format === 'mp3' ? 0.035 : 0.01, 'level');
    });
}

test('fades and trims keep their times at 44.1 kHz', async (t) => {
    const cue = await audio.toneCue(
        { band: 0, durationSec: 3.2 },
        { fadeInTime: 1000, trimStartTime: 0.5, trimEndTime: 2.5 }
    );
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 5000);
    });
    const after = take.at('trigger');
    const t10 = take.a.crossing(0, { after, fraction: 0.1, reference: A, direction: 'rising' });
    const t90 = take.a.crossing(0, { after, fraction: 0.9, reference: A, direction: 'rising' });
    near(t90 - t10, 0.8, 0.05, '10%->90% of a 1 s fade in');
    const start = take.a.onset(0, { after });
    // Early in the fade: onset reads a little late while the level is tiny.
    assert.equal(take.a.slotAt(0, start + 0.03), 5, 'starts at the trim start (0.5 s)');
    near(take.a.offset(0, { after: start + 0.5 }) - start, 2.0, 0.08, 'trimmed length');
});
