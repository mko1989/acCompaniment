/**
 * Unit tests for the small backend helpers in src/backend/utils/.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { normalizeOutputPatch } = require('../../src/backend/utils/outputPatch');
const { LruCache } = require('../../src/backend/utils/lruCache');
const { isValidUuid, validateUuidOrError, requireUuid } = require('../../src/backend/utils/idValidation');
const { writeJsonAtomic } = require('../../src/backend/utils/atomicWrite');

// --- normalizeOutputPatch --------------------------------------------------

test('normalizeOutputPatch keeps a valid patch as-is', () => {
    assert.deepEqual(normalizeOutputPatch([0, 1], 2), [0, 1]);
    assert.deepEqual(normalizeOutputPatch([2, 3], 4), [2, 3]);
});

test('normalizeOutputPatch keeps channel 0 as a right-side target (swapped stereo)', () => {
    // Regression: `Number(right) || left` treated channel 0 as missing,
    // so [1, 0] became [1, 1] - both sides of the cue on one output.
    assert.deepEqual(normalizeOutputPatch([1, 0], 2), [1, 0]);
    assert.deepEqual(normalizeOutputPatch([3, 0], 4), [3, 0]);
});

test('normalizeOutputPatch defaults to stereo 1/2 when no patch is given', () => {
    assert.deepEqual(normalizeOutputPatch(undefined, 2), [0, 1]);
    assert.deepEqual(normalizeOutputPatch(null, 8), [0, 1]);
});

test('normalizeOutputPatch uses the left channel for a mono (single-entry) patch', () => {
    assert.deepEqual(normalizeOutputPatch([2], 4), [2, 2]);
});

test('normalizeOutputPatch clamps channels beyond the device and rejects garbage', () => {
    assert.deepEqual(normalizeOutputPatch([5, 7], 2), [1, 1]);
    assert.deepEqual(normalizeOutputPatch([-3, 1], 2), [0, 1]);
    assert.deepEqual(normalizeOutputPatch([NaN, 'x'], 4), [0, 0]);
    assert.deepEqual(normalizeOutputPatch(undefined, 1), [0, 0]);
});

// --- LruCache --------------------------------------------------------------

test('LruCache evicts the least recently used entry past maxEntries', () => {
    const cache = new LruCache({ maxEntries: 2, maxBytes: 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a is now most recent
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('c'), 3);
});

test('LruCache evicts by total byte size and keeps its byte count accurate', () => {
    const cache = new LruCache({ maxEntries: 0, maxBytes: 100 });
    cache.set('a', 'A', 60);
    cache.set('b', 'B', 30);
    assert.equal(cache.totalBytes, 90);
    cache.set('c', 'C', 30);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.totalBytes, 60);

    cache.set('b', 'B2', 10); // replacing an entry replaces its size
    assert.equal(cache.totalBytes, 40);
    cache.delete('c');
    assert.equal(cache.totalBytes, 10);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.totalBytes, 0);
});

test('LruCache drops a single entry larger than maxBytes instead of looping', () => {
    const cache = new LruCache({ maxEntries: 10, maxBytes: 100 });
    cache.set('small', 1, 10);
    cache.set('huge', 2, 500);
    assert.equal(cache.size, 0);
    assert.equal(cache.totalBytes, 0);
});

// --- idValidation ----------------------------------------------------------

test('isValidUuid accepts UUIDs and rejects everything else', () => {
    assert.equal(isValidUuid('0ae9801a-84d0-449f-98ea-c39c24dd2628'), true);
    assert.equal(isValidUuid('0AE9801A-84D0-449F-98EA-C39C24DD2628'), true);
    for (const bad of ['', 'nope', '../etc/passwd', '0ae9801a-84d0-449f-98ea', null, undefined, 42]) {
        assert.equal(isValidUuid(bad), false, `${String(bad)} should be rejected`);
    }
});

test('validateUuidOrError names the offending field', () => {
    assert.deepEqual(validateUuidOrError('x', 'cueId'), { valid: false, error: 'Invalid cueId: must be a UUID' });
});

test('requireUuid middleware 400s on a bad id and passes a good one through', () => {
    const mw = requireUuid('id');
    let statusCode;
    let body;
    let nextCalled = false;
    const res = { status(code) { statusCode = code; return this; }, json(b) { body = b; } };

    mw({ params: { id: 'bad' } }, res, () => { nextCalled = true; });
    assert.equal(statusCode, 400);
    assert.equal(body.success, false);
    assert.equal(nextCalled, false);

    mw({ params: { id: '0ae9801a-84d0-449f-98ea-c39c24dd2628' } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
});

// --- writeJsonAtomic -------------------------------------------------------

test('writeJsonAtomic writes the file, creates parent dirs, and leaves no temp files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-unit-'));
    try {
        const target = path.join(dir, 'nested', 'deeper', 'data.json');
        await writeJsonAtomic(target, { a: 1 });
        await writeJsonAtomic(target, { a: 2, b: [1, 2] });
        assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf-8')), { a: 2, b: [1, 2] });
        assert.deepEqual(await fs.readdir(path.dirname(target)), ['data.json']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('concurrent writeJsonAtomic calls always leave a complete, parseable file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-unit-'));
    try {
        const target = path.join(dir, 'data.json');
        const payloads = Array.from({ length: 20 }, (_, i) => ({ i, filler: 'x'.repeat(5000) }));
        await Promise.all(payloads.map((p) => writeJsonAtomic(target, p)));
        const final = JSON.parse(await fs.readFile(target, 'utf-8'));
        assert.ok(final.i >= 0 && final.i < 20);
        assert.equal(final.filler.length, 5000);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
