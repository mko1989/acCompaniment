/**
 * The loopback suites' Take (test/audio/lib/capture.js): telling a recording the recorder itself
 * lost input from one the app got wrong.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Take } = require('../audio/lib/capture');

const RATE = 48000;
const BUFFER = 1024;

/** A take of `buffers` input buffers that arrived every period, except where `late` says. */
function take({ buffers = 100, late = {} } = {}) {
    const arrivals = [];
    let at = 1_000_000;
    for (let i = 1; i <= buffers; i++) {
        at += (BUFFER / RATE) * 1000 + (late[i] || 0);
        arrivals.push([i * BUFFER, at]);
    }
    return new Take(
        { samples: new Float32Array(buffers * BUFFER * 2), arrivals, overflows: 0 },
        { channels: 2, sampleRate: RATE, marks: [], name: 'synthetic' }
    );
}

test('a late input callback is reported: the recorder lost input there (WO-031)', () => {
    const t = take({ late: { 40: 43 } }); // one buffer 43 ms late: ~2 periods of input gone
    const found = t.lateInput();
    assert.equal(found.length, 1);
    assert.ok(Math.abs(found[0].atSec - (39 * BUFFER) / RATE) < 0.001, `at ${found[0].atSec}`);
    assert.ok(found[0].gapMs > 60, `gap ${found[0].gapMs}`);
});

test('ordinary scheduling jitter is not reported (WO-031)', () => {
    assert.deepEqual(take({ late: { 10: 5, 20: 12, 30: 8 } }).lateInput(), []);
});
