/**
 * Spotify was removed (ADR-003 in rust/DECISIONS.md). A project saved with
 * Spotify cues still opens: those cues are hidden from every API - acting on
 * one answers as for a cue that doesn't exist - and kept in the project file
 * exactly as they were and where they were (right after the nearest cue that
 * preceded them in the file and still exists, or first), through edits,
 * reorders, deletes, saves, bundles and imports. New Spotify cues can't be
 * made. Starts and stops its own server.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yauzl = require('yauzl');

const {
    spawnServer, getFreePort, waitForHealth, waitForExit, connectWs, waitForReceived,
} = require('./helpers/harness');

const PROJECT_ID = '6f1c2b0e-8a4d-4c1e-9f3a-2d5b7e8c9a01';
const INTRO_ID = '0a8f3c2d-5b6e-4f7a-8c9d-1e2f3a4b5c6d';
const OUTRO_ID = '1b9f4d3e-6c7f-4a8b-9d0e-2f3a4b5c6d7e';
const ENCORE_ID = '2c0a5e4f-7d8a-4b9c-8e1f-3a4b5c6d7e8f';
const SPOTIFY_CUE_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const SPOTIFY_FIRST_ID = '8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a';
const UNKNOWN_CUE_ID = '11111111-2222-4333-8444-555555555555';

// As the Spotify version of the app saved it - including fields this
// version knows nothing about.
const SPOTIFY_CUE = {
    id: SPOTIFY_CUE_ID,
    name: 'Walk-in playlist',
    type: 'spotify',
    status: 'stopped',
    currentTime: 0,
    totalTime: 0,
    volume: 0.8,
    fadeInTime: 2000,
    fadeOutTime: 0,
    loop: true,
    retriggerBehavior: 'restart',
    trimStartTime: 0,
    trimEndTime: null,
    isDuckingTrigger: false,
    enableDucking: true,
    duckingLevel: 80,
    outputPatch: [0, 1],
    spotifyUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    spotifyType: 'playlist',
    spotifyShuffle: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
};

// One that was first in the file, before any other cue.
const SPOTIFY_FIRST_CUE = {
    id: SPOTIFY_FIRST_ID,
    name: 'Doors open',
    type: 'spotify',
    volume: 1,
    spotifyUri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    spotifyType: 'track',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
};

const fileCue = (id, name) => ({
    id,
    name,
    type: 'single_file',
    status: 'stopped',
    volume: 0.05,
    filePath: '',
    relativePath: '',
    knownDuration: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-spotify-legacy-'));
const workspacesDir = path.join(dataDir, 'cues', 'workspaces');
let child;
let exited;
let base;

before(async () => {
    fs.mkdirSync(workspacesDir, { recursive: true });
    fs.writeFileSync(path.join(workspacesDir, `${PROJECT_ID}.json`), JSON.stringify({
        id: PROJECT_ID,
        name: 'Old Show',
        description: '',
        // The walk-in playlist sits between Outro and Encore.
        cues: [SPOTIFY_FIRST_CUE, fileCue(INTRO_ID, 'Intro'), fileCue(OUTRO_ID, 'Outro'), SPOTIFY_CUE, fileCue(ENCORE_ID, 'Encore')],
        layout: { gridColumns: 4, gridRows: 4, cuePositions: {} },
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-02T10:00:00.000Z',
    }, null, 2));

    const port = await getFreePort();
    child = spawnServer({ PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir });
    exited = waitForExit(child);
    base = `http://127.0.0.1:${port}`;
    await waitForHealth(base, 15000);
});

after(async () => {
    child.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 12000))]);
    if (result === 'timeout') {
        child.kill('SIGKILL');
        await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(method, url, body) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

function projectFileCues(id) {
    return JSON.parse(fs.readFileSync(path.join(workspacesDir, `${id}.json`), 'utf-8')).cues;
}

// The cues' order, and the Spotify ones byte for byte as they were.
function assertCuesKept(cues, expectedOrder) {
    assert.deepEqual(cues.map((c) => c.id), expectedOrder);
    for (const original of [SPOTIFY_FIRST_CUE, SPOTIFY_CUE]) {
        assert.equal(JSON.stringify(cues.find((c) => c.id === original.id)), JSON.stringify(original));
    }
}

function readZipEntry(bytes, name) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            zip.on('entry', (entry) => {
                if (entry.fileName !== name) return zip.readEntry();
                zip.openReadStream(entry, (e, stream) => {
                    if (e) return reject(e);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                });
            });
            zip.on('end', () => resolve(null));
            zip.readEntry();
        });
    });
}

test('a Spotify cue in a saved project is not listed anywhere', async () => {
    const cues = (await request('GET', '/api/cues')).body.cues;
    assert.deepEqual(cues.map((c) => c.id), [INTRO_ID, OUTRO_ID, ENCORE_ID]);

    const remote = JSON.stringify((await request('GET', '/api/remote/cues')).body);
    assert.ok(!remote.includes(SPOTIFY_CUE_ID) && !remote.includes(SPOTIFY_FIRST_ID));

    assert.equal((await request('GET', '/api/projects/current')).body.project.cueCount, 3);
    const listed = (await request('GET', '/api/projects')).body.projects.find((p) => p.id === PROJECT_ID);
    assert.equal(listed.cueCount, 3);

    const ws = await connectWs(base);
    try {
        const initial = await waitForReceived(ws, (m) => m.type === 'cues-updated');
        assert.deepEqual(initial.payload.cues.map((c) => c.id), [INTRO_ID, OUTRO_ID, ENCORE_ID]);
    } finally {
        ws.close();
    }
});

test('acting on a Spotify cue answers as for a cue that does not exist', async () => {
    const calls = [
        ['GET', (id) => `/api/cues/${id}`],
        ['PUT', (id) => `/api/cues/${id}`, { name: 'Renamed' }],
        ['POST', (id) => `/api/cues/${id}/trigger`, {}],
        ['POST', (id) => `/api/cues/${id}/stop`, {}],
        ['POST', (id) => `/api/cues/${id}/toggle-pause`, {}],
        ['POST', (id) => `/api/cues/${id}/playlist/navigate`, { direction: 'next' }],
        ['POST', (id) => `/api/remote/cues/${id}/trigger`, {}],
        ['POST', (id) => `/api/remote/cues/${id}/stop`, {}],
        ['DELETE', (id) => `/api/cues/${id}`],
    ];
    for (const [method, url, body] of calls) {
        const spotify = await request(method, url(SPOTIFY_CUE_ID), body);
        const unknown = await request(method, url(UNKNOWN_CUE_ID), body);
        assert.deepEqual(spotify, unknown, `${method} ${url(':id')}`);
    }
});

test('new Spotify cues cannot be made', async () => {
    const created = await request('POST', '/api/cues', { name: 'New', type: 'spotify', spotifyUri: 'spotify:track:abc' });
    assert.equal(created.status, 400);
    assert.equal(created.body.success, false);

    const changed = await request('PUT', `/api/cues/${INTRO_ID}`, { type: 'spotify' });
    assert.equal(changed.status, 400);
    assert.equal((await request('GET', `/api/cues/${INTRO_ID}`)).body.cue.type, 'single_file');
});

test('the Spotify cues stay in place and unchanged in the file as other cues are edited, reordered and deleted', async () => {
    // Unchanged project, saved: exactly as it was read.
    await request('GET', '/api/projects'); // saves what's pending
    assertCuesKept(projectFileCues(PROJECT_ID), [SPOTIFY_FIRST_ID, INTRO_ID, OUTRO_ID, SPOTIFY_CUE_ID, ENCORE_ID]);

    // Reordered and edited: the walk-in playlist follows Outro.
    assert.equal((await request('PUT', `/api/cues/${OUTRO_ID}`, { name: 'Outro (edited)' })).status, 200);
    assert.equal((await request('POST', '/api/cues/reorder', { cueIds: [ENCORE_ID, OUTRO_ID, INTRO_ID] })).status, 200);
    await request('GET', '/api/projects');
    let cues = projectFileCues(PROJECT_ID);
    assert.equal(cues.find((c) => c.id === OUTRO_ID).name, 'Outro (edited)');
    assertCuesKept(cues, [SPOTIFY_FIRST_ID, ENCORE_ID, OUTRO_ID, SPOTIFY_CUE_ID, INTRO_ID]);

    // Outro deleted: it follows the cue that was before Outro in the file.
    assert.equal((await request('DELETE', `/api/cues/${OUTRO_ID}`)).status, 200);
    await request('GET', '/api/projects');
    cues = projectFileCues(PROJECT_ID);
    assertCuesKept(cues, [SPOTIFY_FIRST_ID, ENCORE_ID, INTRO_ID, SPOTIFY_CUE_ID]);
    assert.deepEqual((await request('GET', '/api/cues')).body.cues.map((c) => c.id), [ENCORE_ID, INTRO_ID]);
});

test('a bundle carries the Spotify cues in place, and importing it keeps them hidden, in place and unchanged', async () => {
    const res = await fetch(`${base}/api/projects/current/bundle`);
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    const manifest = JSON.parse(await readZipEntry(bytes, 'project.json'));
    assertCuesKept(manifest.project.cues, [SPOTIFY_FIRST_ID, ENCORE_ID, INTRO_ID, SPOTIFY_CUE_ID]);

    const form = new FormData();
    form.append('bundle', new Blob([bytes], { type: 'application/zip' }), 'old-show.zip');
    const imported = await fetch(`${base}/api/projects/import`, { method: 'POST', body: form });
    assert.equal(imported.status, 201);
    const project = (await imported.json()).project;
    assert.notEqual(project.id, PROJECT_ID);
    assert.equal(project.cueCount, 2);

    const cues = (await request('GET', '/api/cues')).body.cues;
    assert.deepEqual(cues.map((c) => c.id), [ENCORE_ID, INTRO_ID]);
    assertCuesKept(projectFileCues(project.id), [SPOTIFY_FIRST_ID, ENCORE_ID, INTRO_ID, SPOTIFY_CUE_ID]);

    // Edited after the import: still in place.
    assert.equal((await request('POST', '/api/cues/reorder', { cueIds: [INTRO_ID, ENCORE_ID] })).status, 200);
    await request('GET', '/api/projects'); // saves what's pending
    assertCuesKept(projectFileCues(project.id), [SPOTIFY_FIRST_ID, INTRO_ID, SPOTIFY_CUE_ID, ENCORE_ID]);
});
