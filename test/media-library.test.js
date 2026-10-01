/**
 * The shared media library, through the API: files are stored once under
 * their own name, re-adding the same file reuses it, a different file with
 * the same name gets its own name, and "Replace" swaps in a new version in
 * place for every cue in every project.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { useServer, makeTestWav } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

const audioDir = () => path.join(server.tempDataDir(), 'audio');
const libraryFiles = () => fs.readdirSync(audioDir()).filter((f) => !['metadata', 'library.json'].includes(f)).sort();

async function uploadBytes(filename, bytes, field = 'audioFile', url = '/api/audio/upload') {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: 'audio/wav' }), filename);
    const res = await fetch(`${server.baseUrl()}${url}`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
}

const upload = (filename, seconds) => uploadBytes(filename, makeTestWav(seconds));
const replace = (id, filename, bytes) => uploadBytes(filename, bytes, 'audioFile', `/api/audio/${id}/replace`);

async function cueFor(audioFile, extra = {}) {
    const body = await t.post('/api/cues', {
        name: `Cue for ${audioFile.filename}`, type: 'single_file', volume: 0.05,
        audioFileId: audioFile.id, relativePath: audioFile.relativePath, ...extra,
    });
    assert.equal(body.success, true);
    return body.cue.id;
}

test('an upload is stored under its own name - no timestamp, no subfolder', async () => {
    const { body } = await upload('Opening Theme.wav', 1);
    assert.equal(body.success, true);
    assert.equal(body.reused, false);
    assert.equal(body.audioFile.relativePath, 'Opening Theme.wav');
    assert.equal(body.audioFile.filename, 'Opening Theme.wav');
    assert.match(body.audioFile.hash, /^[0-9a-f]{64}$/);
    assert.ok(libraryFiles().includes('Opening Theme.wav'));
});

test('uploading the same file again reuses it: same id, still one file', async () => {
    const first = (await upload('Reused.wav', 1.5)).body;
    const second = (await upload('Reused.wav', 1.5)).body;
    assert.equal(second.reused, true);
    assert.equal(second.audioFile.id, first.audioFile.id);
    assert.equal(libraryFiles().filter((f) => f.startsWith('Reused')).length, 1);
});

test('the name match ignores case, as macOS does', async () => {
    const first = (await upload('Case Test.wav', 1.1)).body;
    const second = (await upload('case test.WAV', 1.1)).body;
    assert.equal(second.reused, true);
    assert.equal(second.audioFile.id, first.audioFile.id);
});

test('a different file with a taken name is added as "Name (2)", leaving the original alone', async () => {
    const original = (await upload('Clash.wav', 1)).body.audioFile;
    const other = (await upload('Clash.wav', 2)).body;
    assert.equal(other.renamed, true);
    assert.equal(other.audioFile.relativePath, 'Clash (2).wav');
    assert.notEqual(other.audioFile.id, original.id);
    const third = (await upload('Clash.wav', 3)).body;
    assert.equal(third.audioFile.relativePath, 'Clash (3).wav');
    // Re-adding the second version finds it under its numbered name.
    assert.equal((await upload('Clash.wav', 2)).body.audioFile.id, other.audioFile.id);
    // The original is untouched: still the 1-second file under the plain name.
    assert.deepEqual(fs.readFileSync(path.join(audioDir(), 'Clash.wav')), makeTestWav(1));
    assert.equal(original.relativePath, 'Clash.wav');
});

test('identical audio under a different name is a separate library file (the name is the identity)', async () => {
    const a = (await upload('Name A.wav', 1.3)).body.audioFile;
    const b = (await upload('Name B.wav', 1.3)).body.audioFile;
    assert.notEqual(a.id, b.id);
});

test('non-ASCII filenames are kept intact', async () => {
    const { body } = await upload('Żółć — ścieżka.wav', 1);
    assert.equal(body.audioFile.relativePath, 'Żółć — ścieżka.wav');
    assert.ok(libraryFiles().includes('Żółć — ścieżka.wav'));
});

test('unsafe filenames are sanitised, never escaping the library', async () => {
    const { body } = await upload('../../evil:name.wav', 1);
    assert.equal(body.success, true);
    assert.equal(body.audioFile.relativePath, 'evil_name.wav');
    assert.ok(fs.existsSync(path.join(audioDir(), 'evil_name.wav')));
});

test('uploads that are not audio are rejected and leave nothing behind', async () => {
    const bad = await uploadBytes('fake.wav', Buffer.from('not audio'));
    assert.equal(bad.status, 400);
    assert.ok(!libraryFiles().includes('fake.wav'));
    const unsupported = await uploadBytes('notes.txt', Buffer.from('x'));
    assert.equal(unsupported.status, 400);
});

test('upload temp files never linger', async () => {
    await upload('Temp Check.wav', 1);
    await upload('Temp Check.wav', 1);
    await uploadBytes('broken.wav', Buffer.from('nope'));
    const uploads = path.join(server.tempDataDir(), 'temp', 'uploads');
    assert.deepEqual(fs.existsSync(uploads) ? fs.readdirSync(uploads) : [], []);
});

test('two cues can share one library file; deleting a cue keeps the file', async () => {
    const file = (await upload('Shared.wav', 1)).body.audioFile;
    const a = await cueFor(file);
    const b = await cueFor(file);
    await t.request('DELETE', `/api/cues/${a}`);
    assert.ok(libraryFiles().includes('Shared.wav'));
    await t.playing(b);
    await t.stop(b);
});

// --- Replace ------------------------------------------------------------------

test('Replace swaps in a new version in place: same id, same name, new duration', async () => {
    const file = (await upload('Versioned.wav', 1)).body.audioFile;
    const cueId = await cueFor(file);
    const { status, body } = await replace(file.id, 'Versioned v2.wav', makeTestWav(3));
    assert.equal(status, 200);
    assert.equal(body.audioFile.id, file.id);
    assert.equal(body.audioFile.relativePath, 'Versioned.wav', 'keeps the library name');
    assert.ok(Math.abs(body.audioFile.duration - 3) < 0.05);
    assert.notEqual(body.audioFile.hash, file.hash);
    assert.ok(body.cuesUpdated >= 1);
    assert.equal(fs.statSync(path.join(audioDir(), 'Versioned.wav')).size, makeTestWav(3).length);
    assert.ok(!libraryFiles().includes('Versioned v2.wav'));

    const cue = await t.getCue(cueId);
    assert.ok(Math.abs(cue.knownDuration - 3) < 0.05, 'the cue shows the new length');
});

test('after Replace, playing the cue plays the new version (not a cached old one)', async () => {
    const file = (await upload('Cached.wav', 1)).body.audioFile;
    const cueId = await cueFor(file);
    await t.playing(cueId); // decodes and caches the 1s version
    await t.stop(cueId);
    await replace(file.id, 'Cached.wav', makeTestWav(4));
    await t.playing(cueId);
    const [voice] = await t.voices(cueId);
    assert.ok(Math.abs(voice.trimEndSec - 4) < 0.05, `plays the 4s version, got ${voice.trimEndSec}s`);
    await t.stop(cueId);
});

test('Replace updates cues in other projects too', async () => {
    const file = (await upload('Across Projects.wav', 1)).body.audioFile;
    const firstProject = (await t.get('/api/workspaces/current')).workspace;
    const cueInFirst = await cueFor(file);

    await t.post('/api/workspaces', { name: 'Second Project' });
    const cueInSecond = await cueFor(file);
    await sleep(500); // let the second project autosave

    const { body } = await replace(file.id, 'Across Projects.wav', makeTestWav(2));
    assert.equal(body.projectsUpdated, 2);
    assert.ok(Math.abs((await t.getCue(cueInSecond)).knownDuration - 2) < 0.05);

    await t.post(`/api/workspaces/${firstProject.id}/load`);
    assert.ok(Math.abs((await t.getCue(cueInFirst)).knownDuration - 2) < 0.05, 'the other project was updated on disk');
});

test('Replace with a different file type keeps the name with the new extension', async () => {
    const file = (await upload('Format Swap.wav', 1)).body.audioFile;
    const cueId = await cueFor(file);
    const flac = path.join(server.tempDataDir(), 'swap-source.flac');
    const wav = path.join(server.tempDataDir(), 'swap-source.wav');
    fs.writeFileSync(wav, makeTestWav(2));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, flac]);

    const { body } = await replace(file.id, 'anything.flac', fs.readFileSync(flac));
    assert.equal(body.success, true);
    assert.equal(body.audioFile.id, file.id);
    assert.equal(body.audioFile.relativePath, 'Format Swap.flac');
    assert.ok(!libraryFiles().includes('Format Swap.wav'), 'old version removed');
    assert.ok(libraryFiles().includes('Format Swap.flac'));

    const cue = await t.getCue(cueId);
    assert.equal(cue.relativePath, 'Format Swap.flac');
    await t.playing(cueId);
    await t.stop(cueId);
});

test('Replace refuses bad input and leaves the original untouched', async () => {
    const file = (await upload('Keep Me.wav', 1)).body.audioFile;
    const before = fs.readFileSync(path.join(audioDir(), 'Keep Me.wav'));

    assert.equal((await replace('9b2f4c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e', 'x.wav', makeTestWav(1))).status, 404);
    assert.equal((await replace('not-a-uuid', 'x.wav', makeTestWav(1))).status, 400);
    assert.equal((await replace(file.id, 'x.wav', Buffer.from('not audio'))).status, 400);
    assert.equal((await replace(file.id, 'x.txt', Buffer.from('text'))).status, 400);
    const noFile = await fetch(`${server.baseUrl()}/api/audio/${file.id}/replace`, { method: 'POST', body: new FormData() });
    assert.equal(noFile.status, 400);

    assert.deepEqual(fs.readFileSync(path.join(audioDir(), 'Keep Me.wav')), before);
    const uploads = path.join(server.tempDataDir(), 'temp', 'uploads');
    assert.deepEqual(fs.existsSync(uploads) ? fs.readdirSync(uploads) : [], []);
});

// --- Serving -----------------------------------------------------------------

test('audio is served with an ETag the browser revalidates, which changes on Replace', async () => {
    const file = (await upload('Etag.wav', 1)).body.audioFile;
    const url = `${server.baseUrl()}/api/audio/serve/${file.id}`;
    const first = await fetch(url);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    await first.arrayBuffer();

    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);

    await sleep(20);
    await replace(file.id, 'Etag.wav', makeTestWav(2));
    const after = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.get('etag'), etag);
    assert.equal(Number(after.headers.get('content-length')), makeTestWav(2).length);
    await after.arrayBuffer();
});
