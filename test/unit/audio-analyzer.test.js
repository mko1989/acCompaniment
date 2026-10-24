/**
 * The loopback suite's signal generator and analyzer (test/audio/lib/),
 * checked against synthetic signals - no audio device needed. If these
 * are off, every measurement in test/audio/ is.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderTone, encodeWav, slotFrequency } = require('../audio/lib/signals');
const { analyze } = require('../audio/lib/analyzer');

const RATE = 48000;

/** A silent stereo buffer of `seconds`, with tones mixed in: [{ at, tone, channel? }]. */
function mix(seconds, parts) {
    const out = new Float32Array(Math.round(seconds * RATE) * 2);
    for (const { at, tone, channel } of parts) {
        const offset = Math.round(at * RATE);
        for (let i = 0; i < tone.frames; i++) {
            const v = tone.samples[i * tone.channels];
            for (const c of channel == null ? [0, 1] : [channel]) out[(offset + i) * 2 + c] += v;
        }
    }
    return { samples: out, channels: 2, sampleRate: RATE };
}

test('reads a tone\'s peak amplitude exactly, whatever segment is playing', () => {
    for (const amplitude of [0.5, 0.1, 0.02]) {
        const a = analyze(mix(2, [{ at: 0, tone: renderTone({ durationSec: 2, amplitude }) }]));
        assert.ok(Math.abs(a.level(0, 0.2, 1.8) - amplitude) < amplitude * 0.01, `amplitude ${amplitude}`);
    }
});

test('decodes playback position from the segment frequencies', () => {
    const a = analyze(mix(3.2, [{ at: 0, tone: renderTone({ durationSec: 3.2 }) }]));
    for (const slot of [0, 7, 19, 31]) assert.equal(a.slotAt(0, slot * 0.1 + 0.05), slot);
    assert.ok(Math.abs(a.frequencyAt(0, 1.05) - slotFrequency(0, 10)) < 0.5);
});

test('onset and offset land within a few ms of the true edges', () => {
    for (const amplitude of [0.5, 0.05]) {
        const a = analyze(mix(3, [{ at: 1, tone: renderTone({ durationSec: 1, amplitude }) }]));
        assert.ok(Math.abs(a.onset(0) - 1) < 0.004, `onset ${a.onset(0)} at amplitude ${amplitude}`);
        assert.ok(Math.abs(a.offset(0, { after: 1.5 }) - 2) < 0.004, `offset ${a.offset(0, { after: 1.5 })}`);
    }
});

test('separates bands, channels and two copies of the same file', () => {
    const a = analyze(mix(3.2, [
        { at: 0, tone: renderTone({ durationSec: 3.2, band: 0 }), channel: 0 },
        { at: 1.5, tone: renderTone({ durationSec: 1.7, band: 0 }), channel: 0 },
        { at: 1, tone: renderTone({ durationSec: 2, band: 1, amplitude: 0.25 }), channel: 1 },
    ]));
    assert.equal(a.level(0, 0.2, 0.8, { channel: 1 }), 0, 'band 0 on the right');
    assert.ok(Math.abs(a.level(1, 1.2, 1.8, { channel: 1 }) - 0.25) < 0.003, 'band 1 on the right');
    assert.equal(a.voicesAt(0, 1.0, { channel: 0 }), 1);
    assert.equal(a.voicesAt(0, 2.05, { channel: 0 }), 2);
    assert.deepEqual(a.slotsAt(0, 2.05, { channel: 0 }).map((s) => s.slot).sort((x, y) => x - y), [5, 20]);
});

test('times a linear fade from its 90% and 10% crossings', () => {
    const tone = renderTone({ durationSec: 2 });
    for (let i = 0; i < tone.frames; i++) {
        const t = i / RATE;
        tone.samples[i] *= t < 0.5 ? 1 : Math.max(0, 1 - (t - 0.5) / 1.0); // 1 s fade from 0.5 s
    }
    const a = analyze(mix(2.5, [{ at: 0, tone }]));
    const t90 = a.crossing(0, { fraction: 0.9, reference: 0.5 });
    const t10 = a.crossing(0, { fraction: 0.1, reference: 0.5 });
    assert.ok(Math.abs(t10 - t90 - 0.8) < 0.02, `90%->10% took ${(t10 - t90).toFixed(3)} s`);
});

test('WAV encoding round-trips 16-bit, 24-bit and float samples', () => {
    const tone = renderTone({ durationSec: 0.1, channels: 2, rightBand: 1 });
    for (const [format, tolerance] of [['pcm16', 1 / 32767], ['pcm24', 1 / 8388607], ['float32', 0]]) {
        const wav = encodeWav(tone, format);
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        const width = { pcm16: 2, pcm24: 3, float32: 4 }[format];
        const read = (i) => (format === 'float32' ? wav.readFloatLE(44 + i * 4)
            : wav.readIntLE(44 + i * width, width) / (format === 'pcm16' ? 32767 : 8388607));
        for (const i of [0, 101, 2001, tone.samples.length - 1]) {
            assert.ok(Math.abs(read(i) - tone.samples[i]) <= tolerance + 1e-7, `${format} sample ${i}`);
        }
    }
});
