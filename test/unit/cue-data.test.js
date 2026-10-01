/**
 * Unit tests for cue data normalisation in src/backend/cueDataManager.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-cue-data-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const CueDataManager = require('../../src/backend/cueDataManager');
const { normalizeCueFieldAliases } = CueDataManager;

test('shuffle / repeatOne are stored as shufflePlaylist / repeatOnePlaylistItem', () => {
    assert.deepEqual(normalizeCueFieldAliases({ shuffle: true, repeatOne: 1 }), {
        shufflePlaylist: true, repeatOnePlaylistItem: true,
    });
});

test('the canonical name wins when both spellings are present', () => {
    assert.deepEqual(normalizeCueFieldAliases({ shuffle: true, shufflePlaylist: false }), { shufflePlaylist: false });
});

test('objects without aliases pass through unchanged, and null is tolerated', () => {
    assert.deepEqual(normalizeCueFieldAliases({ name: 'x' }), { name: 'x' });
    assert.equal(normalizeCueFieldAliases(null), null);
});

// Only the in-memory cue methods are exercised; the manager still creates
// its directories on construction, so wait for that before tests run.
let shared;
before(async () => {
    shared = new CueDataManager({ cuesDir: tmpDir });
    await shared.ensureDirectories();
});

function manager() {
    return shared;
}

test('creating a playlist cue with legacy field names enables shuffle / repeat-one', () => {
    const cue = manager().createCue({ type: 'playlist', shuffle: true, repeatOne: true, playlistItems: [] });
    assert.equal(cue.shufflePlaylist, true);
    assert.equal(cue.repeatOnePlaylistItem, true);
    assert.equal('shuffle' in cue, false);
});

test('updating a cue with legacy field names updates the canonical fields', () => {
    const m = manager();
    const cue = m.createCue({ type: 'playlist', playlistItems: [] });
    m.addCue(cue);
    const { cue: updated } = m.updateCue(cue.id, { shuffle: true });
    assert.equal(updated.shufflePlaylist, true);
});

test('loading a legacy workspace cue migrates its field names', () => {
    const validated = manager().validateCue({ id: 'x', type: 'playlist', shuffle: true, repeatOne: false });
    assert.equal(validated.shufflePlaylist, true);
    assert.equal(validated.repeatOnePlaylistItem, false);
});

test('a volume of 0 is kept (not replaced by the default of 1)', () => {
    assert.equal(manager().createCue({ volume: 0 }).volume, 0);
    assert.equal(manager().validateCue({ id: 'x', volume: 0 }).volume, 0);
});

test('reorderCues puts listed cues first, keeps the rest, and ignores unknown or repeated ids', () => {
    const m = manager();
    m.cues.splice(0, m.cues.length);
    for (const id of ['a', 'b', 'c', 'd']) m.addCue(m.createCue({ id, name: id }));
    assert.deepEqual(m.reorderCues(['c', 'a', 'c', 'zzz']), { success: true, order: ['c', 'a', 'b', 'd'] });
    assert.deepEqual(m.cues.map((c) => c.id), ['c', 'a', 'b', 'd']);
    assert.equal(m.reorderCues('nope').success, false);
});
