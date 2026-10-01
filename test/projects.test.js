/**
 * Projects: the open project's name, new/open/delete, autosave across
 * switches, and bundles (download a project with its audio as a .zip,
 * import it - including into a second, empty installation, as when moving
 * to another machine).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yauzl = require('yauzl');
const yazl = require('yazl');

const {
    useServer, makeTestWav, spawnServer, getFreePort, waitForHealth, waitForExit, connectWs, waitForMessage,
} = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');

const server = useServer();
const t = api(server);

// --- helpers -----------------------------------------------------------------

async function uploadAs(base, filename, seconds) {
    const form = new FormData();
    form.append('audioFile', new Blob([makeTestWav(seconds)], { type: 'audio/wav' }), filename);
    return (await (await fetch(`${base}/api/audio/upload`, { method: 'POST', body: form })).json()).audioFile;
}

async function addCue(base, file, extra = {}) {
    const res = await fetch(`${base}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.filename, type: 'single_file', volume: 0.05, audioFileId: file.id, relativePath: file.relativePath, ...extra }),
    });
    return (await res.json()).cue;
}

async function download(base, id = 'current') {
    const res = await fetch(`${base}/api/projects/${id}/bundle`);
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

async function importBundle(base, bytes, filename = 'bundle.zip') {
    const form = new FormData();
    form.append('bundle', new Blob([bytes], { type: 'application/zip' }), filename);
    const res = await fetch(`${base}/api/projects/import`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
}

function zipEntries(bytes) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            const entries = {};
            zip.on('entry', (entry) => {
                zip.openReadStream(entry, (e, stream) => {
                    if (e) return reject(e);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => { entries[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
                });
            });
            zip.on('end', () => resolve(entries));
            zip.readEntry();
        });
    });
}

function makeZip(files) {
    return new Promise((resolve) => {
        const zip = new yazl.ZipFile();
        for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
        zip.end();
        const chunks = [];
        zip.outputStream.on('data', (c) => chunks.push(c));
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

const manifest = (cues = [], extra = {}) => JSON.stringify({ format: 'accompaniment-project', version: 1, project: { name: 'Hand Made', cues }, ...extra });
const current = async () => (await t.get('/api/projects/current')).project;
const tempLeft = (sub) => {
    const dir = path.join(server.tempDataDir(), 'temp', sub);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

// --- the open project --------------------------------------------------------

test('there is always an open project, listed as current', async () => {
    const project = await current();
    assert.ok(project.id);
    const { projects } = await t.get('/api/projects');
    assert.equal(projects.find((p) => p.isCurrent).id, project.id);
});

test('renaming the open project saves it and tells open pages', async () => {
    const socket = await t.ws();
    try {
        const told = waitForMessage(socket, (m) => m.type === 'workspace-updated' && m.payload.workspace.name === 'Friday Show');
        const res = await t.put('/api/projects/current', { name: '  Friday Show  ' });
        assert.equal(res.success, true);
        assert.equal(res.project.name, 'Friday Show');
        await told;
    } finally {
        socket.close();
    }
    const { projects } = await t.get('/api/projects');
    assert.equal(projects.find((p) => p.isCurrent).name, 'Friday Show');
});

test('a project name cannot be empty', async () => {
    const res = await t.request('PUT', '/api/projects/current', { name: '   ' });
    assert.equal(res.status, 400);
});

// --- new / open / delete ------------------------------------------------------

test('New Project opens an empty project; the previous one keeps its cues', async () => {
    const file = await uploadAs(server.baseUrl(), 'Keep Me.wav', 1);
    const kept = await addCue(server.baseUrl(), file);
    const previous = await current();

    const socket = await t.ws();
    try {
        const cuesCleared = waitForMessage(socket, (m) => m.type === 'cues-updated' && m.payload.cues.length === 0);
        const res = await t.post('/api/projects', { name: 'Brand New' });
        assert.equal(res.success, true);
        assert.equal(res.project.name, 'Brand New');
        assert.equal(res.project.cueCount, 0);
        await cuesCleared;
    } finally {
        socket.close();
    }
    assert.deepEqual((await t.get('/api/cues')).cues, []);

    await t.post(`/api/projects/${previous.id}/open`);
    assert.ok((await t.get('/api/cues')).cues.find((c) => c.id === kept.id));
});

test('New Project without a name is called "Untitled Project"', async () => {
    const res = await t.post('/api/projects', {});
    assert.equal(res.project.name, 'Untitled Project');
});

test('switching projects stops whatever is playing', async () => {
    const file = await uploadAs(server.baseUrl(), 'Playing.wav', 10);
    const cue = await addCue(server.baseUrl(), file);
    await t.playing(cue.id);
    await t.post('/api/projects', { name: 'Quiet' });
    assert.deepEqual((await t.playback()).voices, []);
});

test('an edit made just before switching project is not lost', async () => {
    const file = await uploadAs(server.baseUrl(), 'Last Edit.wav', 1);
    const cue = await addCue(server.baseUrl(), file);
    const original = await current();
    await t.updateCue(cue.id, { name: 'Edited Right Before Switching' });
    await t.post('/api/projects', { name: 'Elsewhere' }); // immediately - before the autosave delay
    await t.post(`/api/projects/${original.id}/open`);
    assert.equal((await t.getCue(cue.id)).name, 'Edited Right Before Switching');
});

test('Open lists and opens saved projects; unknown or malformed ids fail cleanly', async () => {
    const a = (await t.post('/api/projects', { name: 'List A' })).project;
    const b = (await t.post('/api/projects', { name: 'List B' })).project;
    const { projects } = await t.get('/api/projects');
    const names = projects.map((p) => p.name);
    assert.ok(names.includes('List A') && names.includes('List B'));
    assert.equal(projects.find((p) => p.isCurrent).id, b.id);

    const opened = await t.post(`/api/projects/${a.id}/open`);
    assert.equal(opened.project.id, a.id);
    assert.equal((await t.request('POST', '/api/projects/9b2f4c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e/open')).status, 404);
    assert.equal((await t.request('POST', '/api/projects/nope/open')).status, 400);
});

test('a saved project can be deleted, but not the open one', async () => {
    const doomed = (await t.post('/api/projects', { name: 'Doomed' })).project;
    const survivor = (await t.post('/api/projects', { name: 'Survivor' })).project;
    assert.equal((await t.request('DELETE', `/api/projects/${survivor.id}`)).status, 409);
    assert.equal((await t.request('DELETE', `/api/projects/${doomed.id}`)).status, 200);
    const { projects } = await t.get('/api/projects');
    assert.ok(!projects.find((p) => p.id === doomed.id));
    assert.equal((await t.request('DELETE', `/api/projects/${doomed.id}`)).status, 404);
});

test('autosave keeps only the newest 20 backups per project', async () => {
    const project = (await t.post('/api/projects', { name: 'Many Saves' })).project;
    for (let i = 0; i < 26; i++) {
        await t.put('/api/projects/current', { name: `Many Saves ${i}` });
    }
    const backups = fs.readdirSync(path.join(server.tempDataDir(), 'cues', 'backups')).filter((f) => f.endsWith(`_${project.id}.json`));
    assert.equal(backups.length, 20);
});

// --- bundles -------------------------------------------------------------------

test('Download Bundle gives a zip with the project and each audio file once', async () => {
    await t.post('/api/projects', { name: 'Bundle Me' });
    const shared = await uploadAs(server.baseUrl(), 'Shared In Bundle.wav', 1);
    const other = await uploadAs(server.baseUrl(), 'Other In Bundle.wav', 2);
    await addCue(server.baseUrl(), shared);
    await addCue(server.baseUrl(), shared, { name: 'Second use' });
    await t.post('/api/cues', {
        name: 'List', type: 'playlist', volume: 0.05,
        playlistItems: [{ id: 'i1', name: 'o', audioFileId: other.id, relativePath: other.relativePath }],
    });

    const { res, bytes } = await download(server.baseUrl());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Bundle Me\.zip"/);

    const entries = await zipEntries(bytes);
    assert.deepEqual(Object.keys(entries).sort(), ['audio/Other In Bundle.wav', 'audio/Shared In Bundle.wav', 'project.json']);
    assert.deepEqual(entries['audio/Shared In Bundle.wav'], makeTestWav(1));
    const json = JSON.parse(entries['project.json']);
    assert.equal(json.format, 'accompaniment-project');
    assert.equal(json.project.name, 'Bundle Me');
    assert.equal(json.project.cues.length, 3);
    assert.deepEqual(json.missingAudio, []);
});

test('the bundle filename keeps non-ASCII project names', async () => {
    await t.post('/api/projects', { name: 'Koncert: Łódź' });
    const { res } = await download(server.baseUrl());
    const header = res.headers.get('content-disposition');
    assert.match(header, /filename\*=UTF-8''Koncert_%20%C5%81%C3%B3d%C5%BA\.zip/);
});

test('a bundle includes unsaved-in-the-last-moment edits', async () => {
    await t.post('/api/projects', { name: 'Fresh Edits' });
    const file = await uploadAs(server.baseUrl(), 'Fresh.wav', 1);
    const cue = await addCue(server.baseUrl(), file);
    await t.updateCue(cue.id, { name: 'Renamed Just Now' });
    const json = JSON.parse((await zipEntries((await download(server.baseUrl())).bytes))['project.json']);
    assert.equal(json.project.cues[0].name, 'Renamed Just Now');
});

test('Import Bundle creates and opens a copy, reusing audio that is already here', async () => {
    const source = (await t.post('/api/projects', { name: 'Round Trip' })).project;
    const file = await uploadAs(server.baseUrl(), 'Round Trip Audio.wav', 1);
    const cue = await addCue(server.baseUrl(), file, { fadeInTime: 250, loop: true });
    const { bytes } = await download(server.baseUrl());
    const libraryBefore = (await t.get('/api/audio')).audioFiles.length;

    const { status, body } = await importBundle(server.baseUrl(), bytes);
    assert.equal(status, 201);
    assert.notEqual(body.project.id, source.id);
    assert.equal(body.project.name, 'Round Trip');
    assert.equal(body.audio.reused, 1);
    assert.equal(body.audio.added, 0);
    assert.equal((await t.get('/api/audio')).audioFiles.length, libraryBefore, 'no new library file');

    assert.equal((await current()).id, body.project.id, 'the imported project is open');
    const imported = (await t.get('/api/cues')).cues;
    assert.equal(imported.length, 1);
    assert.equal(imported[0].id, cue.id, 'cue ids kept (e.g. for Companion buttons)');
    assert.equal(imported[0].fadeInTime, 250);
    assert.equal(imported[0].loop, true);
    assert.equal(imported[0].audioFileId, file.id);
    assert.deepEqual(tempLeft('imports'), []);
    assert.deepEqual(tempLeft('uploads'), []);
});

test('importing a bundle whose audio clashes by name with different local audio keeps both', async () => {
    await t.post('/api/projects', { name: 'Clash Source' });
    const theirs = await uploadAs(server.baseUrl(), 'Clash Bundle.wav', 2);
    await addCue(server.baseUrl(), theirs);
    const { bytes } = await download(server.baseUrl());
    // Replace the local file with different audio, then import the old bundle.
    const form = new FormData();
    form.append('audioFile', new Blob([makeTestWav(3)], { type: 'audio/wav' }), 'x.wav');
    await fetch(`${server.baseUrl()}/api/audio/${theirs.id}/replace`, { method: 'POST', body: form });

    const { body } = await importBundle(server.baseUrl(), bytes);
    assert.equal(body.audio.renamed, 1);
    const [importedCue] = (await t.get('/api/cues')).cues;
    assert.equal(importedCue.relativePath, 'Clash Bundle (2).wav');
    await t.playing(importedCue.id);
    const [voice] = await t.voices(importedCue.id);
    assert.ok(Math.abs(voice.trimEndSec - 2) < 0.05, 'plays the bundle\'s 2s version, not the local 3s one');
    await t.stop(importedCue.id);
});

test('Import Bundle rejects things that are not bundles, and cleans up', async () => {
    assert.equal((await importBundle(server.baseUrl(), Buffer.from('not a zip'))).status, 400);
    assert.equal((await importBundle(server.baseUrl(), await makeZip({ 'readme.txt': 'hi' }))).status, 400);
    assert.equal((await importBundle(server.baseUrl(), await makeZip({ 'project.json': '{"format":"something-else"}' }))).status, 400);
    const newer = await importBundle(server.baseUrl(), await makeZip({ 'project.json': manifest([], { version: 99 }) }));
    assert.equal(newer.status, 400);
    assert.match(newer.body.error, /newer version/);
    const noFile = await fetch(`${server.baseUrl()}/api/projects/import`, { method: 'POST', body: new FormData() });
    assert.equal(noFile.status, 400);
    assert.deepEqual(tempLeft('imports'), []);
    assert.deepEqual(tempLeft('uploads'), []);
});

/**
 * A zip built by hand (stored, no compression), so a test can include entry
 * names that zip libraries refuse to write - like "../" escapes.
 */
function rawZip(files) {
    const zlib = require('node:zlib');
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content);
        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

test('Import Bundle refuses a bundle with an entry that tries to escape, writing nothing', async () => {
    const zip = rawZip({ 'project.json': manifest([]), 'audio/../../escape.wav': makeTestWav(1) });
    const { status } = await importBundle(server.baseUrl(), zip);
    assert.equal(status, 400);
    for (const dir of [server.tempDataDir(), path.join(server.tempDataDir(), '..'), path.join(server.tempDataDir(), 'temp')]) {
        assert.equal(fs.existsSync(path.join(dir, 'escape.wav')), false);
    }
    assert.deepEqual(tempLeft('imports'), []);
});

test('Import Bundle ignores nested folders, __MACOSX and other stray entries', async () => {
    const zip = await makeZip({
        'project.json': manifest([]),
        'audio/sub/nested.wav': makeTestWav(1),
        '__MACOSX/audio/._junk.wav': 'x',
        'notes.txt': 'hello',
    });
    const { status } = await importBundle(server.baseUrl(), zip);
    assert.equal(status, 201);
    const names = (await t.get('/api/audio')).audioFiles.map((f) => f.relativePath);
    assert.ok(!names.some((n) => /nested|junk|notes/.test(n)));
});

// --- moving to another machine ---------------------------------------------------

let otherServer;

before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-other-machine-'));
    const port = await getFreePort();
    const child = spawnServer({ PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir });
    const exited = waitForExit(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, 15000);
    otherServer = { child, exited, dataDir, baseUrl };
});

after(async () => {
    otherServer.child.kill('SIGTERM');
    await Promise.race([otherServer.exited, sleep(10000)]);
    if (otherServer.child.exitCode === null) otherServer.child.kill('SIGKILL');
    fs.rmSync(otherServer.dataDir, { recursive: true, force: true });
});

test('a bundle opened on another (empty) installation plays there', async () => {
    await t.post('/api/projects', { name: 'Touring Show' });
    const a = await uploadAs(server.baseUrl(), 'Tour Intro.wav', 1.5);
    const b = await uploadAs(server.baseUrl(), 'Tour Outro.wav', 2.5);
    const introCue = await addCue(server.baseUrl(), a, { name: 'Intro', volume: 0.3 });
    await t.post('/api/cues', {
        name: 'Set', type: 'playlist', volume: 0.05,
        playlistItems: [
            { id: 'p1', name: 'intro', audioFileId: a.id, relativePath: a.relativePath },
            { id: 'p2', name: 'outro', audioFileId: b.id, relativePath: b.relativePath },
        ],
    });
    const { bytes } = await download(server.baseUrl());

    const { status, body } = await importBundle(otherServer.baseUrl, bytes, 'Touring Show.zip');
    assert.equal(status, 201);
    assert.equal(body.audio.added, 2);
    const cues = (await (await fetch(`${otherServer.baseUrl}/api/cues`)).json()).cues;
    assert.deepEqual(cues.map((c) => c.name).sort(), ['Intro', 'Set']);
    assert.ok(fs.existsSync(path.join(otherServer.dataDir, 'audio', 'Tour Intro.wav')));
    assert.ok(fs.existsSync(path.join(otherServer.dataDir, 'audio', 'Tour Outro.wav')));

    const trigger = await (await fetch(`${otherServer.baseUrl}/api/cues/${introCue.id}/trigger`, { method: 'POST' })).json();
    assert.equal(trigger.status, 'playing');
    const status2 = (await (await fetch(`${otherServer.baseUrl}/api/cues/status/playback`)).json()).status;
    const voice = status2.voices.find((v) => v.cueId === introCue.id);
    assert.equal(voice.volume, 0.3);
    assert.ok(Math.abs(voice.trimEndSec - 1.5) < 0.05);
    await fetch(`${otherServer.baseUrl}/api/cues/stop-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"behavior":"stop"}' });
});

test('a bundle notes audio that was missing when it was made, and still imports', async () => {
    await t.post('/api/projects', { name: 'Missing Audio' });
    await t.post('/api/cues', { name: 'Ghost', type: 'single_file', audioFileId: '9b2f4c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e', relativePath: 'Ghost.wav' });
    const { bytes } = await download(server.baseUrl());
    const json = JSON.parse((await zipEntries(bytes))['project.json']);
    assert.deepEqual(json.missingAudio, ['Ghost.wav']);
    const { status, body } = await importBundle(otherServer.baseUrl, bytes);
    assert.equal(status, 201);
    assert.deepEqual(body.missingAudio, ['Ghost.wav']);
});

test('WebSocket clients are told when another page switches project', async () => {
    const socket = await connectWs(server.baseUrl());
    try {
        const told = waitForMessage(socket, (m) => m.type === 'workspace-updated' && m.payload.workspace.name === 'Switched Elsewhere');
        await t.post('/api/projects', { name: 'Switched Elsewhere' });
        await told;
    } finally {
        socket.close();
    }
});
