#!/usr/bin/env node
/**
 * Builds a pre-library data dir (no audio/library.json) for the `legacy` fixture of
 * rust/scripts/diff-data.js: timestamped upload names, byte-identical copies in two folders, a
 * case-only name clash, metadata records with stale absolute paths, a record whose file is gone,
 * and a project referencing old ids and paths (plus a Spotify cue that must stay untouched).
 *
 * Usage: node rust/scripts/make-legacy-fixture.js <dir>
 */

const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
const FIX = path.join(__dirname, '..', 'app-fixtures');
const tone = fs.readFileSync(path.join(FIX, 'incoming', 'import.wav'));
const other = fs.readFileSync(path.join(FIX, 'data', 'audio', 'tone-mono-44k.wav'));
const clash = fs.readFileSync(path.join(FIX, 'data', 'audio', 'zażółć-🎵.wav'));

const audio = path.join(dir, 'audio');
const files = [
    ['imported/Song_1761152917380.wav', tone, 1_700_000_000],
    ['user/Song_1761152917999.wav', tone, 1_700_000_100],
    ['imported/Other_1761152918000.wav', other, 1_700_000_050],
    ['user/song.wav', clash, 1_700_000_200],
    ['imported/notes.txt', Buffer.from('not audio'), 1_700_000_300],
];
for (const [rel, bytes, mtime] of files) {
    const p = path.join(audio, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
    fs.utimesSync(p, mtime, mtime);
}
fs.mkdirSync(path.join(audio, 'empty-dir'), { recursive: true });
fs.writeFileSync(path.join(audio, 'empty-dir', '.DS_Store'), '');

const md = path.join(audio, 'metadata');
fs.mkdirSync(md, { recursive: true });
const ids = {
    song: '11111111-1111-4111-8111-111111111111',
    songCopy: '22222222-2222-4222-8222-222222222222',
    other: '33333333-3333-4333-8333-333333333333',
    gone: '44444444-4444-4444-8444-444444444444',
};
const records = [
    { id: ids.song, path: '/old/place/audio/imported/Song_1761152917380.wav', relativePath: 'imported/Song_1761152917380.wav', filename: 'Song_1761152917380.wav', name: 'Song', originalPath: '/Users/someone/Song.wav', tags: ['a'] },
    { id: ids.songCopy, path: '/old/place/audio/user/Song_1761152917999.wav', relativePath: 'user/Song_1761152917999.wav', name: 'Song copy', duration: 1, size: tone.length },
    { id: ids.other, path: '/old/place/audio/imported/Other_1761152918000.wav', name: 'Other', duration: 10 },
    { id: ids.gone, path: '/old/place/audio/imported/Gone.wav', relativePath: 'imported/Gone.wav', name: 'Gone' },
];
for (const r of records) fs.writeFileSync(path.join(md, `${r.id}.json`), JSON.stringify(r, null, 2));
fs.writeFileSync(path.join(md, 'broken.json'), '{ not json');

const ws = path.join(dir, 'cues', 'workspaces');
fs.mkdirSync(ws, { recursive: true });
const project = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Legacy show',
    description: '',
    cues: [
        { id: '66666666-6666-4666-8666-666666666661', name: 'By id', type: 'single_file', audioFileId: ids.songCopy, relativePath: 'user/Song_1761152917999.wav', filePath: '/old/x.wav', volume: 1 },
        { id: '66666666-6666-4666-8666-666666666662', name: 'Spotify', type: 'spotify', audioFileId: ids.song, relativePath: 'imported/Song_1761152917380.wav' },
        {
            id: '66666666-6666-4666-8666-666666666663', name: 'List', type: 'playlist', playlistItems: [
                { id: 'i1', relativePath: 'imported/Other_1761152918000.wav' },
                { id: 'i2', audioFileId: ids.gone, relativePath: 'imported/Gone.wav' },
                { id: 'i3', relativePath: 'user/song.wav', filePath: 'x' },
            ],
        },
    ],
    layout: { gridColumns: 4, gridRows: 4, cuePositions: {} },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
};
fs.writeFileSync(path.join(ws, `${project.id}.json`), JSON.stringify(project, null, 2));
