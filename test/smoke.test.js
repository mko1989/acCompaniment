/**
 * End-to-end smoke tests for the acCompaniment Node.js server.
 *
 * Spawns the real production entry point (start-nodejs.js) as a child
 * process against an isolated temp data directory (ACCOMPANIMENT_DATA_DIR),
 * then exercises it exactly as a real client would: HTTP, WebSocket, file
 * upload, cue lifecycle, and the crash/hardening paths added in the
 * production-readiness pass (EADDRINUSE handling, path-traversal guard on
 * upload subdirectories, UUID validation).
 *
 * Run with: npm run test:smoke  (or `node --test test/`)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const net = require('node:net');
const WebSocket = require('ws');

const REPO_ROOT = path.join(__dirname, '..');
const READY_TIMEOUT_MS = 15000;

let tempDataDir;
let port;
let baseUrl;
let serverProcess;
let serverExitPromise;

// --- Helpers ---------------------------------------------------------

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port: p } = srv.address();
            srv.close(() => resolve(p));
        });
    });
}

function spawnServer(env) {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'start-nodejs.js')], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.getOutput = () => ({ stdout, stderr });
    return child;
}

async function waitForHealth(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${url}/api/remote/health`);
            if (res.ok) return true;
        } catch (error) {
            lastError = error;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Server did not become healthy within ${timeoutMs}ms: ${lastError?.message || 'timeout'}`);
}

function waitForExit(child) {
    return new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
    });
}

/**
 * Minimal but valid mono 16-bit PCM WAV file (a few seconds of a 440Hz
 * tone). Kept long enough that the "stop cue playback" test always has a
 * comfortable window to stop it before it completes naturally.
 */
function makeTestWav() {
    const sampleRate = 44100;
    const durationSec = 3;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
        buffer.writeInt16LE(sample, 44 + i * 2);
    }
    return buffer;
}

async function pollUntil(fn, { timeoutMs = 5000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastResult;
    while (Date.now() < deadline) {
        lastResult = await fn();
        if (lastResult) return lastResult;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`);
}

// --- Suite setup / teardown ------------------------------------------

before(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-smoke-'));
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    serverProcess = spawnServer({
        PORT: String(port),
        HOST: '127.0.0.1',
        ACCOMPANIMENT_DATA_DIR: tempDataDir,
    });
    serverExitPromise = waitForExit(serverProcess);

    await waitForHealth(baseUrl, READY_TIMEOUT_MS);
});

after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
        serverProcess.kill('SIGTERM');
        let result = await Promise.race([
            serverExitPromise,
            new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 12000)),
        ]);

        if (result.code === 'timeout') {
            // A graceful SIGTERM handler stuck deep in a synchronous
            // native call (observed in practice: RtAudio's stopStream()
            // can deadlock against its own audio I/O thread) freezes the
            // whole JS event loop, so nothing in that process - including
            // its own shutdown timeout - can run. SIGKILL is unconditional
            // at the OS level and doesn't need the frozen process's
            // cooperation. Always escalate so a rare deadlock can't leave
            // an orphaned server (holding the port and audio device)
            // behind after the test run, even though it still fails the
            // assertion below to surface the underlying problem.
            console.error('Smoke test: server did not exit within 12s of SIGTERM - force killing and failing loudly.');
            serverProcess.kill('SIGKILL');
            result = await Promise.race([
                serverExitPromise,
                new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout-after-sigkill' }), 5000)),
            ]);
        }

        await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
        assert.notEqual(
            result.code,
            'timeout-after-sigkill',
            'Server did not exit even after SIGKILL (unexpected - investigate, this is not the known deadlock)'
        );
        assert.notEqual(
            result.signal,
            'SIGKILL',
            'Graceful SIGTERM shutdown hung and had to be force-killed. This is a known, rare, pre-existing '
            + 'deadlock inside the third-party @hamitzor/rtaudio.js binding (RtAudio\'s stopStream() can block '
            + 'against its own CoreAudio I/O thread mid-callback) - see FIX_PLAN.md Track G8. The server process '
            + 'itself was cleaned up correctly (no orphan left behind); this failure exists to surface the '
            + 'underlying rarity/frequency, not to indicate broken cleanup. If this starts failing often, that '
            + 'warrants investigation; an occasional failure here is expected until upstream fixes it.'
        );
        assert.equal(result.code, 0, `Server should exit 0 on graceful SIGTERM shutdown, got ${result.code}`);
        return;
    }
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
});

// --- Basic HTTP surface ------------------------------------------------

test('health check responds ok', async () => {
    const res = await fetch(`${baseUrl}/api/remote/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
});

test('serves the main browser UI', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html/i);
});

test('serves the HTTP remote control page', async () => {
    const res = await fetch(`${baseUrl}/remote`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /acCompaniment Remote/);
});

test('serves the easter egg game', async () => {
    const res = await fetch(`${baseUrl}/easter_egg_game/game.html`);
    assert.equal(res.status, 200);
});

test('rejects a malformed UUID in a route param', async () => {
    const res = await fetch(`${baseUrl}/api/audio/not-a-uuid`);
    assert.equal(res.status, 400);
});

test('lists cues on a fresh workspace (empty)', async () => {
    const res = await fetch(`${baseUrl}/api/remote/cues`);
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

    const res = await fetch(`${baseUrl}/api/audio/upload`, { method: 'POST', body: formData });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.audioFile.id, 'uploaded audio file should have an id');
    assert.ok(body.audioFile.relativePath, 'uploaded audio file should have a relativePath');
    uploadedAudioFile = body.audioFile;
});

test('rejects an upload with a path-traversal subdirectory', async () => {
    const wav = makeTestWav();
    const formData = new FormData();
    // multer's destination/filename callbacks fire while the multipart
    // stream is still being parsed, so req.body is only populated with
    // fields that appeared BEFORE the file field in the stream. The
    // 'subdirectory' field must come first, or this test would pass
    // trivially by never reaching the vulnerable code path at all
    // (req.body.subdirectory would still be undefined when the
    // destination callback runs, silently falling back to the safe
    // 'imported' default rather than actually exercising the guard).
    formData.append('subdirectory', '../../escaped');
    formData.append('audioFile', new Blob([wav], { type: 'audio/wav' }), 'evil.wav');

    const res = await fetch(`${baseUrl}/api/audio/upload`, { method: 'POST', body: formData });
    assert.notEqual(res.status, 200, 'a path-traversal subdirectory must not be accepted');

    const escapedDir = path.join(tempDataDir, '..', 'escaped');
    const exists = fssync.existsSync(escapedDir);
    assert.equal(exists, false, 'upload must not have written outside the audio directory');
});

// --- Cue lifecycle -------------------------------------------------------

let createdCueId;

test('creates a single_file cue from the uploaded audio', async () => {
    const res = await fetch(`${baseUrl}/api/cues`, {
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
    const workspacesDir = path.join(tempDataDir, 'cues', 'workspaces');
    await pollUntil(async () => {
        const files = await fs.readdir(workspacesDir).catch(() => []);
        if (files.length === 0) return null;
        const contents = await Promise.all(files.map((f) => fs.readFile(path.join(workspacesDir, f), 'utf8')));
        return contents.some((c) => c.includes(createdCueId)) ? true : null;
    }, { timeoutMs: 3000 });
});

test('triggers cue playback', async () => {
    const res = await fetch(`${baseUrl}/api/cues/${createdCueId}/trigger`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await pollUntil(async () => {
        const statusRes = await fetch(`${baseUrl}/api/cues/${createdCueId}`);
        const statusBody = await statusRes.json();
        return statusBody.cue?.status === 'playing' ? statusBody : null;
    }, { timeoutMs: 5000 });
});

test('stops cue playback', async () => {
    const res = await fetch(`${baseUrl}/api/cues/${createdCueId}/stop`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await pollUntil(async () => {
        const statusRes = await fetch(`${baseUrl}/api/cues/${createdCueId}`);
        const statusBody = await statusRes.json();
        return statusBody.cue?.status === 'stopped' ? statusBody : null;
    }, { timeoutMs: 5000 });
});

// --- WebSocket -------------------------------------------------------------

test('accepts a WebSocket connection and broadcasts the cue list', async () => {
    const ws = new WebSocket(baseUrl.replace('http', 'ws'));
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
    const currentRes = await fetch(`${baseUrl}/api/workspaces/current`);
    assert.equal(currentRes.status, 200);
    const currentBody = await currentRes.json();
    const workspaceId = currentBody.workspace.id;

    const exportRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/export`, {
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
    const res = await fetch(`${baseUrl}/api/cues/${createdCueId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
});

// --- Crash/hardening regressions -----------------------------------------

test('a second instance on the same port fails cleanly instead of crashing raw', async () => {
    const secondDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-smoke-second-'));
    try {
        const second = spawnServer({
            PORT: String(port),
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
