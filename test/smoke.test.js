/**
 * Core end-to-end smoke tests: basic HTTP surface, upload + path-traversal
 * guard, the single-file cue lifecycle, WebSocket connectivity, workspace
 * export, and crash/hardening regressions (EADDRINUSE, UUID validation).
 *
 * See test/helpers/harness.js for the shared server-boot/teardown setup,
 * and the other test/*.test.js files for playlists, config, workspaces,
 * audio file management, and the WebSocket message protocol.
 *
 * Run with: npm run test:smoke  (or `node --test test/`)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const WebSocket = require('ws');

const {
    spawnServer,
    waitForExit,
    makeTestWav,
    pollUntil,
    useServer,
} = require('./helpers/harness');

const server = useServer();

// --- Basic HTTP surface ------------------------------------------------

test('health check responds ok', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
});

test('serves the main browser UI', async () => {
    const res = await fetch(`${server.baseUrl()}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html/i);
});

test('serves the HTTP remote control page', async () => {
    const res = await fetch(`${server.baseUrl()}/remote`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /acCompaniment Remote/);
});

test('rejects a malformed UUID in a route param', async () => {
    const res = await fetch(`${server.baseUrl()}/api/audio/not-a-uuid`);
    assert.equal(res.status, 400);
});

test('lists cues on a fresh workspace (empty)', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/cues`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.cues, []);
});

// --- Audio upload + path-traversal guard --------------------------------

let uploadedAudioFile;

test('uploads an audio file', async () => {
    const wav = makeTestWav();
    const formData = new FormData();
    formData.append('audioFile', new Blob([wav], { type: 'audio/wav' }), 'smoke-test-tone.wav');
    formData.append('name', 'Smoke Test Tone');

    const res = await fetch(`${server.baseUrl()}/api/audio/upload`, { method: 'POST', body: formData });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.audioFile.id, 'uploaded audio file should have an id');
    assert.ok(body.audioFile.relativePath, 'uploaded audio file should have a relativePath');
    uploadedAudioFile = body.audioFile;
});

test('a path-traversal "subdirectory" in an upload cannot write outside the library', async () => {
    // The library is flat now - the old `subdirectory` field is ignored - so
    // an upload carrying a hostile one simply lands in the library. The
    // field still comes first in the stream, so it would reach any code
    // that tried to use it (multer only sees fields that precede the file).
    const wav = makeTestWav();
    const formData = new FormData();
    formData.append('subdirectory', '../../escaped');
    formData.append('audioFile', new Blob([wav], { type: 'audio/wav' }), 'evil.wav');

    const res = await fetch(`${server.baseUrl()}/api/audio/upload`, { method: 'POST', body: formData });
    const body = await res.json();
    assert.equal(body.audioFile?.relativePath, 'evil.wav', 'stored flat in the library');

    const escapedDir = path.join(server.tempDataDir(), '..', 'escaped');
    assert.equal(fssync.existsSync(escapedDir), false, 'upload must not have written outside the audio directory');
    assert.equal(fssync.existsSync(path.join(server.tempDataDir(), 'escaped')), false);
});

// --- Cue lifecycle -------------------------------------------------------

let createdCueId;

test('creates a single_file cue from the uploaded audio', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Smoke Test Cue',
            type: 'single_file',
            audioFileId: uploadedAudioFile.id,
            relativePath: uploadedAudioFile.relativePath,
            volume: 0.05, // keep it quiet - this actually plays through the real audio device
        }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.cue.id);
    createdCueId = body.cue.id;
});

test('the created cue was persisted to disk', async () => {
    // Workspace saves are debounced (cueManager.js's _saveDebounceMs, 300ms)
    // rather than written synchronously on every mutation, so poll instead
    // of checking immediately.
    const workspacesDir = path.join(server.tempDataDir(), 'cues', 'workspaces');
    await pollUntil(async () => {
        const files = await fs.readdir(workspacesDir).catch(() => []);
        if (files.length === 0) return null;
        const contents = await Promise.all(files.map((f) => fs.readFile(path.join(workspacesDir, f), 'utf8')));
        return contents.some((c) => c.includes(createdCueId)) ? true : null;
    }, { timeoutMs: 3000 });
});

test('triggers cue playback', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${createdCueId}/trigger`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await pollUntil(async () => {
        const statusRes = await fetch(`${server.baseUrl()}/api/cues/${createdCueId}`);
        const statusBody = await statusRes.json();
        return statusBody.cue?.status === 'playing' ? statusBody : null;
    }, { timeoutMs: 5000 });
});

test('stops cue playback', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${createdCueId}/stop`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await pollUntil(async () => {
        const statusRes = await fetch(`${server.baseUrl()}/api/cues/${createdCueId}`);
        const statusBody = await statusRes.json();
        return statusBody.cue?.status === 'stopped' ? statusBody : null;
    }, { timeoutMs: 5000 });
});

// --- WebSocket -------------------------------------------------------------

test('accepts a WebSocket connection and broadcasts the cue list', async () => {
    const ws = new WebSocket(server.baseUrl().replace('http', 'ws'));
    try {
        const message = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for cues-updated')), 5000);
            ws.on('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (parsed.type === 'cues-updated') {
                    clearTimeout(timeout);
                    resolve(parsed);
                }
            });
            ws.on('error', reject);
        });
        const cues = message.payload?.cues || [];
        assert.ok(cues.some((c) => c.id === createdCueId), 'initial cues-updated payload should include the created cue');
    } finally {
        ws.close();
    }
});

// --- Workspace export with bundled audio --------------------------------

test('exports the current workspace with bundled audio files', async () => {
    const currentRes = await fetch(`${server.baseUrl()}/api/workspaces/current`);
    assert.equal(currentRes.status, 200);
    const currentBody = await currentRes.json();
    const workspaceId = currentBody.workspace.id;

    const exportRes = await fetch(`${server.baseUrl()}/api/workspaces/${workspaceId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeAudioFiles: true }),
    });
    assert.equal(exportRes.status, 200);
    const exportBody = await exportRes.json();
    assert.equal(exportBody.success, true);
    assert.ok(fssync.existsSync(exportBody.exportPath), 'exported workspace JSON should exist on disk');

    const exportedAudioDir = path.join(
        path.dirname(exportBody.exportPath),
        `${path.basename(exportBody.exportPath, '.json')}_audio`
    );
    assert.ok(fssync.existsSync(exportedAudioDir), 'exported audio directory should exist when includeAudioFiles is true');
    const copiedFiles = await fs.readdir(exportedAudioDir, { recursive: true });
    assert.ok(copiedFiles.length > 0, 'at least one audio file should have been copied into the export');
});

// --- Cleanup of created cue ------------------------------------------------

test('deletes the created cue', async () => {
    const res = await fetch(`${server.baseUrl()}/api/cues/${createdCueId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
});

// --- Crash/hardening regressions -----------------------------------------

test('a second instance on the same port fails cleanly instead of crashing raw', async () => {
    const secondDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-smoke-second-'));
    try {
        const second = spawnServer({
            PORT: String(server.port()),
            HOST: '127.0.0.1',
            ACCOMPANIMENT_DATA_DIR: secondDataDir,
        });
        const { code } = await waitForExit(second);
        const { stderr } = second.getOutput();

        assert.equal(code, 1, 'a port conflict should exit non-zero');
        assert.match(stderr, /already in use/i, 'should print a clear "port already in use" message');
        assert.doesNotMatch(stderr, /at Server\.setupListenHandle/, 'should not dump a raw Node internals stack trace');
    } finally {
        await fs.rm(secondDataDir, { recursive: true, force: true }).catch(() => {});
    }
});
