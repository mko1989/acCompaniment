/**
 * Unit tests for src/backend/mediaLibrary.js: naming rules, hashing,
 * reference rewriting, and the one-time migration of old libraries
 * (timestamped duplicates in several folders) into one file per content.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    hashFile, sanitizeFilename, withCopyNumber, cleanLegacyName, findExistingName,
    isSupportedAudio, rewriteCueReferences, migrateLibrary,
} = require('../../src/backend/mediaLibrary');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-medialib-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let dirCounter = 0;
const freshDir = () => fs.mkdtempSync(path.join(tmpRoot, `t${++dirCounter}-`));

// --- naming ---------------------------------------------------------------

test('sanitizeFilename keeps a normal name and strips paths and unsafe characters', () => {
    assert.equal(sanitizeFilename('RJD2 - Ghostwriter.mp3'), 'RJD2 - Ghostwriter.mp3');
    assert.equal(sanitizeFilename('Żywiec — ąę.mp3'), 'Żywiec — ąę.mp3');
    assert.equal(sanitizeFilename('../../etc/passwd.mp3'), 'passwd.mp3');
    assert.equal(sanitizeFilename('C:\\Users\\me\\song.wav'), 'song.wav');
    assert.equal(sanitizeFilename('a:b*c?"d<e>f|g.mp3'), 'a_b_c__d_e_f_g.mp3');
    assert.equal(sanitizeFilename('bad\u0000\u0007name.mp3'), 'badname.mp3');
});

test('sanitizeFilename never returns a hidden or empty name', () => {
    assert.equal(sanitizeFilename('.hidden.mp3'), 'hidden.mp3');
    assert.equal(sanitizeFilename('.mp3'), 'audio.mp3');
    assert.equal(sanitizeFilename(''), 'audio');
    assert.equal(sanitizeFilename(undefined), 'audio');
});

test('withCopyNumber numbers copies before the extension', () => {
    assert.equal(withCopyNumber('Song.mp3', 1), 'Song.mp3');
    assert.equal(withCopyNumber('Song.mp3', 2), 'Song (2).mp3');
    assert.equal(withCopyNumber('My.Song.v2.wav', 3), 'My.Song.v2 (3).wav');
});

test('cleanLegacyName removes the old upload timestamp only', () => {
    assert.equal(cleanLegacyName('RJD2 - 2 More Dead_1761152917380.mp3'), 'RJD2 - 2 More Dead.mp3');
    assert.equal(cleanLegacyName('track_2024.mp3'), 'track_2024.mp3', 'not a 13-digit timestamp');
    assert.equal(cleanLegacyName('plain.wav'), 'plain.wav');
});

test('findExistingName matches regardless of case', async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'Song.MP3'), 'x');
    assert.equal(await findExistingName(dir, 'song.mp3'), 'Song.MP3');
    assert.equal(await findExistingName(dir, 'other.mp3'), null);
    assert.equal(await findExistingName(path.join(dir, 'nope'), 'song.mp3'), null);
});

test('isSupportedAudio accepts the app\'s formats in any case', () => {
    for (const name of ['a.mp3', 'a.WAV', 'a.m4a', 'a.aac', 'a.ogg', 'a.FLAC']) assert.equal(isSupportedAudio(name), true, name);
    for (const name of ['a.txt', 'a', '.DS_Store', 'a.mp4']) assert.equal(isSupportedAudio(name), false, name);
});

test('hashFile gives the same hash for the same bytes and a different one otherwise', async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'a'), 'hello');
    fs.writeFileSync(path.join(dir, 'b'), 'hello');
    fs.writeFileSync(path.join(dir, 'c'), 'hello!');
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((f) => hashFile(path.join(dir, f))));
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
});

// --- reference rewriting ---------------------------------------------------

test('rewriteCueReferences updates single-file cues and playlist items, dropping stale URLs', () => {
    const cues = [
        { type: 'single_file', audioFileId: 'old', relativePath: 'x.mp3', filePath: '/api/audio/serve/old' },
        { type: 'playlist', playlistItems: [{ audioFileId: 'old', relativePath: 'x.mp3' }, { audioFileId: 'keep', relativePath: 'y.mp3' }] },
        { type: 'single_file', audioFileId: 'keep', relativePath: 'y.mp3' },
    ];
    const n = rewriteCueReferences(cues, (ref) => (ref.audioFileId === 'old' ? { audioFileId: 'new', relativePath: 'z.mp3' } : null));
    assert.equal(n, 2);
    assert.deepEqual(cues[0], { type: 'single_file', audioFileId: 'new', relativePath: 'z.mp3' });
    assert.equal(cues[1].playlistItems[0].audioFileId, 'new');
    assert.equal(cues[1].playlistItems[1].audioFileId, 'keep');
    assert.equal(cues[2].audioFileId, 'keep');
});

// --- migration -------------------------------------------------------------

function makeLibrary() {
    const dataDir = freshDir();
    const dirs = {
        audioDir: path.join(dataDir, 'audio'),
        metadataDir: path.join(dataDir, 'audio', 'metadata'),
        workspacesDir: path.join(dataDir, 'cues', 'workspaces'),
        backupsDir: path.join(dataDir, 'cues', 'backups'),
        pcmCacheDir: path.join(dataDir, 'pcm-cache'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const put = (rel, content, mtime) => {
        const full = path.join(dirs.audioDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        if (mtime) fs.utimesSync(full, mtime, mtime);
    };
    const meta = (id, rel, extra = {}) => fs.writeFileSync(
        path.join(dirs.metadataDir, `${id}.json`),
        // Absolute paths deliberately point somewhere else: data folders get
        // moved, and the migration must not depend on them.
        JSON.stringify({ id, relativePath: rel, path: `/elsewhere/audio/${rel}`, ...extra })
    );
    const project = (id, cues) => fs.writeFileSync(path.join(dirs.workspacesDir, `${id}.json`), JSON.stringify({ id, name: id, cues }));
    const readProject = (id) => JSON.parse(fs.readFileSync(path.join(dirs.workspacesDir, `${id}.json`), 'utf-8'));
    return { dataDir, dirs, put, meta, project, readProject };
}

test('migration keeps one file per content under its clean name and rewrites every project', async () => {
    const lib = makeLibrary();
    const old = new Date('2025-01-01');
    lib.put('Song_1761152917380.mp3', 'SONG', old);
    lib.put('imported/Song_1761152917380.mp3', 'SONG');
    lib.put('Song_1761999999999.mp3', 'SONG');
    lib.put('imported/Other_1761152917381.wav', 'OTHER');
    lib.put('.DS_Store', 'junk');
    lib.meta('id-a', 'Song_1761152917380.mp3', { duration: 12.5, name: 'Song' });
    lib.meta('id-b', 'imported/Song_1761152917380.mp3');
    lib.meta('id-c', 'Song_1761999999999.mp3');
    lib.meta('id-o', 'imported/Other_1761152917381.wav');
    lib.meta('id-gone', 'missing_1761152917382.mp3');
    lib.project('p1', [
        { type: 'single_file', audioFileId: 'id-b', relativePath: 'imported/Song_1761152917380.mp3', filePath: '/api/audio/serve/id-b' },
        { type: 'playlist', playlistItems: [{ audioFileId: 'id-c', relativePath: 'Song_1761999999999.mp3' }, { relativePath: 'imported/Other_1761152917381.wav' }] },
    ]);
    lib.project('p2', [{ type: 'single_file', audioFileId: 'id-gone', relativePath: 'missing_1761152917382.mp3' }]);
    fs.writeFileSync(path.join(lib.dirs.pcmCacheDir, 'stale.f32'), 'x');

    const result = await migrateLibrary({ ...lib.dirs, log: { log() {} } });
    assert.equal(result.migrated, true);
    assert.equal(result.files, 4);
    assert.equal(result.unique, 2);
    assert.equal(result.removed, 2);

    const audioFiles = fs.readdirSync(lib.dirs.audioDir).filter((f) => f !== 'metadata' && f !== 'library.json' && f !== '.DS_Store').sort();
    assert.deepEqual(audioFiles, ['Other.wav', 'Song.mp3']);
    assert.equal(fs.readFileSync(path.join(lib.dirs.audioDir, 'Song.mp3'), 'utf-8'), 'SONG');
    assert.equal(fs.existsSync(path.join(lib.dirs.audioDir, 'imported')), false, 'emptied folder removed');

    // One record per file; the duplicates' ids are merged into one.
    const records = fs.readdirSync(lib.dirs.metadataDir).map((f) => JSON.parse(fs.readFileSync(path.join(lib.dirs.metadataDir, f), 'utf-8')));
    const song = records.find((r) => r.relativePath === 'Song.mp3');
    const other = records.find((r) => r.relativePath === 'Other.wav');
    assert.equal(song.id, 'id-a', 'keeps the id of the record with the most complete data');
    assert.equal(song.duration, 12.5);
    assert.match(song.hash, /^[0-9a-f]{64}$/);
    assert.equal(song.path, path.join(lib.dirs.audioDir, 'Song.mp3'));
    assert.equal(other.id, 'id-o');
    assert.ok(records.find((r) => r.id === 'id-gone'), 'a record for a file that never existed is left alone');
    assert.equal(records.length, 3);

    const p1 = lib.readProject('p1');
    assert.deepEqual(p1.cues[0], { type: 'single_file', audioFileId: 'id-a', relativePath: 'Song.mp3' });
    assert.equal(p1.cues[1].playlistItems[0].audioFileId, 'id-a');
    assert.equal(p1.cues[1].playlistItems[1].audioFileId, 'id-o', 'a reference with only a path is resolved too');
    assert.equal(p1.cues[1].playlistItems[1].relativePath, 'Other.wav');
    assert.equal(lib.readProject('p2').cues[0].audioFileId, 'id-gone', 'unrelated references untouched');

    assert.deepEqual(fs.readdirSync(lib.dirs.pcmCacheDir), [], 'decoded-audio cache cleared');
});

test('migration backs everything up first and writes a mapping log', async () => {
    const lib = makeLibrary();
    lib.put('A_1761152917380.mp3', 'A');
    lib.put('A_1761152917381.mp3', 'A');
    lib.meta('m1', 'A_1761152917380.mp3');
    lib.project('p', [{ type: 'single_file', audioFileId: 'm1', relativePath: 'A_1761152917380.mp3' }]);

    const result = await migrateLibrary({ ...lib.dirs, log: { log() {} } });
    const backup = result.backupDir;
    assert.ok(fs.existsSync(path.join(backup, 'workspaces', 'p.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'workspaces', 'p.json'), 'utf-8')).cues[0].relativePath, 'A_1761152917380.mp3', 'backup has the original');
    assert.ok(fs.existsSync(path.join(backup, 'metadata', 'm1.json')));
    const log = JSON.parse(fs.readFileSync(path.join(backup, 'migration-log.json'), 'utf-8'));
    assert.deepEqual(log.mapping[0].from.sort(), ['A_1761152917380.mp3', 'A_1761152917381.mp3']);
    assert.equal(log.mapping[0].file, 'A.mp3');
});

test('migration gives different files that would share a name distinct names', async () => {
    const lib = makeLibrary();
    lib.put('Take_1761152917380.mp3', 'FIRST', new Date('2025-01-01'));
    lib.put('Take_1761152917999.mp3', 'SECOND', new Date('2025-06-01'));
    await migrateLibrary({ ...lib.dirs, log: { log() {} } });
    assert.equal(fs.readFileSync(path.join(lib.dirs.audioDir, 'Take.mp3'), 'utf-8'), 'FIRST', 'the older file gets the plain name');
    assert.equal(fs.readFileSync(path.join(lib.dirs.audioDir, 'Take (2).mp3'), 'utf-8'), 'SECOND');
});

test('migration creates records for files that had none', async () => {
    const lib = makeLibrary();
    lib.put('Orphan_1761152917380.wav', 'O');
    await migrateLibrary({ ...lib.dirs, log: { log() {} } });
    const records = fs.readdirSync(lib.dirs.metadataDir).map((f) => JSON.parse(fs.readFileSync(path.join(lib.dirs.metadataDir, f), 'utf-8')));
    assert.equal(records.length, 1);
    assert.equal(records[0].relativePath, 'Orphan.wav');
    assert.match(records[0].id, /^[0-9a-f-]{36}$/);
});

test('migration runs once: a second run changes nothing', async () => {
    const lib = makeLibrary();
    lib.put('X_1761152917380.mp3', 'X');
    lib.put('X_1761152917381.mp3', 'X');
    assert.equal((await migrateLibrary({ ...lib.dirs, log: { log() {} } })).migrated, true);
    lib.put('Y_1761152917380.mp3', 'Y'); // added after migration: left as-is
    assert.equal((await migrateLibrary({ ...lib.dirs, log: { log() {} } })).migrated, false);
    assert.ok(fs.existsSync(path.join(lib.dirs.audioDir, 'Y_1761152917380.mp3')));
});

test('migration of an empty library just marks it current', async () => {
    const lib = makeLibrary();
    const result = await migrateLibrary({ ...lib.dirs, log: { log() {} } });
    assert.equal(result.files, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lib.dirs.audioDir, 'library.json'), 'utf-8')).version, 2);
});
