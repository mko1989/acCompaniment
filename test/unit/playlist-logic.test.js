/**
 * Unit tests for src/backend/playlistLogic.js - every decision a playlist
 * makes, with a seeded RNG so shuffle results are reproducible.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    shuffledOrder, isValidOrder, effectiveOrder, decideItemEnd, stepIndex, peekNextIndex,
} = require('../../src/backend/playlistLogic');

/** Small deterministic PRNG (mulberry32). */
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// --- shuffledOrder / isValidOrder -----------------------------------------

test('shuffledOrder returns a permutation of every index', () => {
    for (let n = 0; n <= 12; n++) {
        const order = shuffledOrder(n, seeded(n + 1));
        assert.equal(order.length, n);
        assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
    }
});

test('shuffledOrder is deterministic for a given RNG and actually reorders', () => {
    assert.deepEqual(shuffledOrder(8, seeded(42)), shuffledOrder(8, seeded(42)));
    const identity = [0, 1, 2, 3, 4, 5, 6, 7];
    const differsForSomeSeed = [1, 2, 3, 4, 5].some((s) => shuffledOrder(8, seeded(s)).join() !== identity.join());
    assert.ok(differsForSomeSeed);
});

test('shuffledOrder spreads first items roughly evenly (no bias toward index 0)', () => {
    const counts = [0, 0, 0, 0];
    const rng = seeded(7);
    for (let i = 0; i < 4000; i++) counts[shuffledOrder(4, rng)[0]]++;
    for (const c of counts) assert.ok(c > 850 && c < 1150, `first-item counts should be ~1000 each, got ${counts}`);
});

test('isValidOrder rejects wrong length, duplicates and out-of-range entries', () => {
    assert.equal(isValidOrder([2, 0, 1], 3), true);
    assert.equal(isValidOrder([0, 1], 3), false);
    assert.equal(isValidOrder([0, 0, 1], 3), false);
    assert.equal(isValidOrder([0, 1, 3], 3), false);
    assert.equal(isValidOrder([0, 1.5, 2], 3), false);
    assert.equal(isValidOrder(null, 0), false);
});

test('effectiveOrder uses the shuffle order only when shuffle is on and the order is valid', () => {
    assert.deepEqual(effectiveOrder({ itemCount: 3, shuffle: true, order: [2, 0, 1] }), [2, 0, 1]);
    assert.deepEqual(effectiveOrder({ itemCount: 3, shuffle: false, order: [2, 0, 1] }), [0, 1, 2]);
    assert.deepEqual(effectiveOrder({ itemCount: 3, shuffle: true, order: [2, 0] }), [0, 1, 2]);
});

// --- decideItemEnd ----------------------------------------------------------

test('continue mode plays the next item', () => {
    assert.deepEqual(
        decideItemEnd({ itemCount: 3, currentIndex: 0 }),
        { action: 'play', nextIndex: 1, order: null }
    );
});

test('continue mode finishes and resets to the first item after the last', () => {
    assert.deepEqual(
        decideItemEnd({ itemCount: 3, currentIndex: 2 }),
        { action: 'finish', nextIndex: 0, order: null }
    );
});

test('continue mode with loop wraps to the first item and keeps playing', () => {
    assert.deepEqual(
        decideItemEnd({ itemCount: 3, currentIndex: 2, loop: true }),
        { action: 'play', nextIndex: 0, order: null }
    );
});

test('stop_and_cue_next cues the next item instead of playing it', () => {
    assert.deepEqual(
        decideItemEnd({ itemCount: 3, currentIndex: 1, mode: 'stop_and_cue_next' }),
        { action: 'cue', nextIndex: 2, order: null }
    );
});

test('stop_and_cue_next finishes after the last item, or cues the first with loop', () => {
    assert.equal(decideItemEnd({ itemCount: 2, currentIndex: 1, mode: 'stop_and_cue_next' }).action, 'finish');
    assert.deepEqual(
        decideItemEnd({ itemCount: 2, currentIndex: 1, mode: 'stop_and_cue_next', loop: true }),
        { action: 'cue', nextIndex: 0, order: null }
    );
});

test('repeatOne cues the same item, whatever the mode or position', () => {
    for (const mode of ['continue', 'stop_and_cue_next']) {
        for (const currentIndex of [0, 2]) {
            const d = decideItemEnd({ itemCount: 3, currentIndex, mode, repeatOne: true });
            assert.equal(d.action, 'cue');
            assert.equal(d.nextIndex, currentIndex);
        }
    }
});

test('shuffle follows the given order', () => {
    const order = [2, 0, 3, 1];
    assert.deepEqual(
        decideItemEnd({ itemCount: 4, currentIndex: 0, shuffle: true, order }),
        { action: 'play', nextIndex: 3, order }
    );
});

test('shuffle finishes at the end of its order (not the end of the list)', () => {
    const d = decideItemEnd({ itemCount: 4, currentIndex: 1, shuffle: true, order: [2, 0, 3, 1] });
    assert.equal(d.action, 'finish');
    assert.equal(d.order, null);
});

test('shuffle with loop reshuffles at the end of its order', () => {
    const rng = seeded(3);
    const d = decideItemEnd({ itemCount: 4, currentIndex: 1, shuffle: true, loop: true, order: [2, 0, 3, 1], rng });
    assert.equal(d.action, 'play');
    assert.ok(isValidOrder(d.order, 4));
    assert.equal(d.nextIndex, d.order[0]);
});

test('shuffle with a missing or stale order draws a fresh one', () => {
    const d = decideItemEnd({ itemCount: 3, currentIndex: 0, shuffle: true, loop: true, order: [0, 1], rng: seeded(9) });
    assert.ok(isValidOrder(d.order, 3));
});

test('a whole shuffled run visits every item exactly once', () => {
    const rng = seeded(11);
    let order = shuffledOrder(6, rng);
    let index = order[0];
    const visited = [index];
    for (;;) {
        const d = decideItemEnd({ itemCount: 6, currentIndex: index, shuffle: true, order, rng });
        if (d.action === 'finish') break;
        order = d.order;
        index = d.nextIndex;
        visited.push(index);
    }
    assert.deepEqual([...visited].sort(), [0, 1, 2, 3, 4, 5]);
});

test('an empty playlist finishes immediately', () => {
    assert.equal(decideItemEnd({ itemCount: 0 }).action, 'finish');
});

// --- stepIndex / peekNextIndex ---------------------------------------------

test('stepIndex moves by one and clamps at both ends', () => {
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 0, direction: 'next' }), 1);
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 2, direction: 'next' }), 2);
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 1, direction: 'previous' }), 0);
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 0, direction: 'previous' }), 0);
    assert.equal(stepIndex({ itemCount: 0, currentIndex: 0, direction: 'next' }), 0);
});

test('stepIndex follows the shuffle order', () => {
    const order = [2, 0, 1];
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 2, direction: 'next', shuffle: true, order }), 0);
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 0, direction: 'previous', shuffle: true, order }), 2);
    assert.equal(stepIndex({ itemCount: 3, currentIndex: 1, direction: 'next', shuffle: true, order }), 1);
});

test('peekNextIndex reports what plays next, wrapping only with loop', () => {
    assert.equal(peekNextIndex({ itemCount: 3, currentIndex: 0 }), 1);
    assert.equal(peekNextIndex({ itemCount: 3, currentIndex: 2 }), null);
    assert.equal(peekNextIndex({ itemCount: 3, currentIndex: 2, loop: true }), 0);
    assert.equal(peekNextIndex({ itemCount: 3, currentIndex: 2, shuffle: true, order: [2, 1, 0] }), 1);
    assert.equal(peekNextIndex({ itemCount: 0 }), null);
});
