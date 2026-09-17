/**
 * Audio file management: listing, get-by-id, metadata updates, search,
 * stats, output device enumeration, streaming (including Range requests),
 * deletion, and upload rejections (unsupported format, oversized file).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeTestWav, uploadTestAudio, useServer } = require('./helpers/harness');

const server = useServer();

let audioFile;

test('uploads an audio file to manage', async () => {
    audioFile = await uploadTestAudio(server.baseUrl(), { name: 'Manageable File', filename: 'manageable.wav' });
    assert.ok(audioFile.id);
});

test('lists audio files and includes the uploaded one', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.audioFiles.some((f) => f.id === audioFile.id));
    assert.equal(body.total, body.audioFiles.length);
});

test('paginates the audio file listing', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio?limit=1&offset=0`);
    const body = await res.json();
    assert.equal(body.audioFiles.length, 1);
    assert.equal(body.limit, 1);
});

test('gets a single audio file by id', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/${audioFile.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.audioFile.id, audioFile.id);
});

test('404s for a well-formed but nonexistent audio file id', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/00000000-0000-4000-8000-000000000000`);
    assert.equal(res.status, 404);
});

test('updates audio file metadata (name and tags)', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/${audioFile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed File', tags: ['smoke', 'test'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.audioFile.name, 'Renamed File');
    assert.deepEqual(body.audioFile.tags, ['smoke', 'test']);
});

test('ignores metadata fields that are not on the update allowlist', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/${audioFile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/tmp/hijacked', id: 'not-the-real-id' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.audioFile.id, audioFile.id, 'id must not be overwritable via metadata update');
    assert.notEqual(body.audioFile.path, '/tmp/hijacked', 'path must not be overwritable via metadata update');
});

test('finds the renamed file via search', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/search/Renamed`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.results.some((f) => f.id === audioFile.id));
});

test('reports stats that include the uploaded file', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/stats/overview`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.stats.totalFiles >= 1);
    assert.ok(body.stats.totalSize > 0);
});

test('lists real RtAudio output devices', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/output-devices`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.devices));
    assert.ok(body.devices.length > 0, 'expected at least one real output device on this machine');
    assert.ok(body.devices[0].outputChannels >= 1);
});

test('streams the full audio file', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/serve/${audioFile.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^audio\//);
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 1000, 'streamed file should have real content');
});

test('honors a Range request with a 206 partial response', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/serve/${audioFile.id}`, {
        headers: { Range: 'bytes=0-99' },
    });
    assert.equal(res.status, 206, 'a Range request should get 206 Partial Content, not the full 200 body');
    assert.equal(res.headers.get('content-length'), '100');
    assert.match(res.headers.get('content-range') || '', /^bytes 0-99\//);
});

test('deletes the audio file', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/${audioFile.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    const getRes = await fetch(`${server.baseUrl()}/api/audio/${audioFile.id}`);
    assert.equal(getRes.status, 404, 'deleted audio file should 404 afterwards');
});

// --- Upload rejections ----------------------------------------------------

test('rejects an upload with an unsupported file extension', async () => {
    const formData = new FormData();
    formData.append('audioFile', new Blob([Buffer.from('not audio')], { type: 'text/plain' }), 'notes.txt');

    const res = await fetch(`${server.baseUrl()}/api/audio/upload`, { method: 'POST', body: formData });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /unsupported/i);
});

test('rejects an upload that exceeds the configured max file size', async () => {
    // Set a tiny limit so the normal-sized test WAV trips it, then restore
    // the default afterwards so later tests in this process aren't affected.
    const configureRes = await fetch(`${server.baseUrl()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxAudioFileSize: 1000 }),
    });
    assert.equal(configureRes.status, 200);

    try {
        const wav = makeTestWav(3);
        const formData = new FormData();
        formData.append('audioFile', new Blob([wav], { type: 'audio/wav' }), 'too-big.wav');

        const res = await fetch(`${server.baseUrl()}/api/audio/upload`, { method: 'POST', body: formData });
        assert.equal(res.status, 413);
    } finally {
        await fetch(`${server.baseUrl()}/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxAudioFileSize: 100 * 1024 * 1024 }),
        });
    }
});
