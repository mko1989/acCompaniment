/**
 * Loopback suite: file formats and the audio engine's settings, heard.
 * Every format must come out at the right level, in tune (no sample-rate
 * mix-up anywhere between file, decoder, engine and device), for its full
 * length; and changing the output device or channel count while running
 * must move the sound where it's told to.
 */

const assert = require('node:assert/strict');
const { loopbackSuite, findLoopback } = require('./lib/loopback');
const { connectWs, wsInvoke } = require('../helpers/harness');
const { DEFAULT_AMPLITUDE: A, slotFrequency } = require('./lib/signals');

const audio = loopbackSuite();
const { test, near } = audio;

/** Plays a tone cue to its end; checks level, pitch, position and length. */
async function playsCleanly(t, tone, { level = A, levelTolerance = 0.01, durationTolerance = 0.06 } = {}) {
    const cue = await audio.toneCue({ band: 0, durationSec: 2, ...tone });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 5000);
    });
    const start = take.a.onset(0, { after: take.at('trigger') });
    assert.ok(start != null, 'never audible');
    const end = take.a.offset(0, { after: start + 0.2 });
    near(end - start, tone.durationSec ?? 2, durationTolerance, 'played length');
    near(take.a.level(0, start + 0.3, end - 0.3), level, levelTolerance, 'level');
    for (const slot of [3, 11, 17]) {
        assert.equal(take.a.slotAt(0, start + slot * 0.1 + 0.05), slot, `segment ${slot} heard on time`);
    }
    near(take.a.frequencyAt(0, start + 1.15), slotFrequency(0, 11), 3, 'pitch');
    take.assertNoDropouts(start + 0.05, end - 0.05);
    return take;
}

for (const format of ['wav', 'wav24', 'wavf32']) {
    test(`${format} (48 kHz stereo) plays bit-exact in level, pitch and length`, (t) => playsCleanly(t, { format }));
}

// MP3 is lossy and LAME pads the start: allow some level and length slack,
// but pitch and position must still be exact. (The level slack is the
// encoder's: decoded offline, the 128k file measures 0.475 too.)
for (const [bitrate, levelTolerance] of [['128k', 0.035], ['320k', 0.015]]) {
    test(`MP3 ${bitrate} plays at the right level, pitch and length`, (t) => playsCleanly(
        t,
        { format: 'mp3', mp3: { bitrate } },
        { levelTolerance, durationTolerance: 0.08 }
    ));
}

for (const sampleRate of [44100, 96000]) {
    test(`a ${sampleRate / 1000} kHz file is resampled to the engine rate, in tune`, (t) => playsCleanly(t, { sampleRate }));
}

test('a 44.1 kHz MP3 (the commonest file there is) plays in tune', (t) => playsCleanly(
    t,
    { format: 'mp3', sampleRate: 44100 },
    { levelTolerance: 0.025, durationTolerance: 0.08 }
));

test('a mono file plays on both outputs at the file\'s level (WO-004)', (t) => playsCleanly(t, { channels: 1 }));

test('a mono MP3 plays on both outputs at the file\'s level (WO-004)', (t) => playsCleanly(
    t,
    { channels: 1, format: 'mp3' },
    { levelTolerance: 0.025, durationTolerance: 0.08 }
));

test('a very short file (50 ms) plays whole', async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 0.05, segmentSec: 0.05 });
    const take = await audio.record(t, async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await audio.waitForIdle(cue, 3000);
    });
    const start = take.a.onset(0, { after: take.at('trigger'), holdSec: 0.01 });
    assert.ok(start != null, 'never audible');
    // Sample-accurate: count the non-silent samples.
    let sounding = 0;
    for (let i = 0; i < take.samples.length; i += 2) if (Math.abs(take.samples[i]) > 1e-4) sounding++;
    near(sounding / take.sampleRate, 0.05, 0.003, 'seconds of sound');
});

// --- Engine settings, changed while the server runs ----------------------

// The way the settings panel saves (WebSocket save-app-config), which
// re-opens the engine when an audio setting changed.
async function saveConfigLikeTheUi(updates) {
    const ws = await connectWs(audio.baseUrl());
    try {
        const res = await wsInvoke(ws, 'save-app-config', updates, 10000);
        assert.equal(res.payload.success, true, 'save-app-config failed');
    } finally {
        ws.close();
    }
}

test('channel count 1: everything comes out of the first output only', async (t) => {
    await saveConfigLikeTheUi({ audioOutputChannelCount: 1 });
    try {
        const cue = await audio.toneCue({ band: 0, durationSec: 2 });
        const take = await audio.record(t, async (mark) => {
            mark('trigger');
            await audio.trigger(cue);
            await audio.sleep(1200);
        });
        const t0 = take.at('trigger') + 0.3;
        near(take.a.level(0, t0, t0 + 0.7, { channel: 0 }), A, 0.01, 'first output');
        assert.ok(take.a.level(0, t0, t0 + 0.7, { channel: 1 }) < 0.001, 'second output not silent');
    } finally {
        await saveConfigLikeTheUi({ audioOutputChannelCount: 2 });
    }
});

// Needs a second loopback-style device to switch to, so that nothing ever
// plays out of real speakers during the test.
const other = (() => {
    if (audio.skip) return null;
    const devices = JSON.parse(require('node:child_process').execFileSync(
        process.execPath, [require('node:path').join(__dirname, 'lib', 'listDevices.js')], { encoding: 'utf8' }
    ));
    const primary = findLoopback().output;
    return devices.find((d) => d.id !== primary.id && d.outputChannels >= 1
        && /BlackHole|Loopback|NoMachine|Teams|VB-|CABLE|Soundflower/i.test(d.name)) || null;
})();

test('changing the output device moves playback there, and back', {
    skip: other ? false : 'needs a second virtual output device to switch to (so nothing plays on speakers)',
}, async (t) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 6.4, segmentSec: 0.2 }, { loop: true });
    const take = await audio.record(t, async (mark) => {
        mark('elsewhere');
        await saveConfigLikeTheUi({ audioOutputDeviceId: other.name });
        await audio.trigger(cue);
        await audio.sleep(1000);
        mark('back');
        await saveConfigLikeTheUi({ audioOutputDeviceId: audio.device.output.name });
        await audio.trigger(cue);
        await audio.sleep(1200);
    });
    t.diagnostic(`switched to "${other.name}" and back`);
    const back = take.at('back');
    assert.ok(take.a.level(0, take.at('elsewhere') + 0.2, back - 0.05) < 0.001, `heard on the loopback while routed to ${other.name}`);
    const heard = take.a.onset(0, { after: back });
    assert.ok(heard != null && heard - back < 0.8, 'not heard after switching back');
    near(take.a.level(0, heard + 0.2, heard + 0.8), A, 0.01, 'level after switching back');
});

test('changing an audio setting over REST (PUT /api/config) applies it too (WO-002)', async (t) => {
    await audio.setConfig({ audioOutputChannelCount: 1 });
    try {
        const cue = await audio.toneCue({ band: 0, durationSec: 2 });
        const take = await audio.record(t, async (mark) => {
            mark('trigger');
            await audio.trigger(cue);
            await audio.sleep(1000);
        });
        const t0 = take.at('trigger') + 0.3;
        assert.ok(take.a.level(0, t0, t0 + 0.5, { channel: 1 }) < 0.001, 'still playing on the second output');
    } finally {
        await saveConfigLikeTheUi({ audioOutputChannelCount: 2 });
    }
});
