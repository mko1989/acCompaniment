/**
 * Shared setup for the smoke test suite. Every test file boots its own
 * server instance (own free port, own isolated temp data directory) so
 * files can run independently and in parallel without colliding.
 */

const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const net = require('node:net');
const WebSocket = require('ws');

const REPO_ROOT = path.join(__dirname, '..', '..');
const READY_TIMEOUT_MS = 15000;

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
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

/** Minimal but valid mono 16-bit PCM WAV file (a few seconds of a 440Hz tone). */
function makeTestWav(durationSec = 3) {
    const sampleRate = 44100;
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

/**
 * Uploads a generated test WAV and returns the resulting audioFile record
 * ({id, relativePath, duration, ...}). Shared by every file that needs a
 * real audio file to build a cue against.
 */
async function uploadTestAudio(baseUrl, { name = 'Smoke Test Tone', durationSec = 3, filename = 'smoke-test-tone.wav' } = {}) {
    const wav = makeTestWav(durationSec);
    const formData = new FormData();
    formData.append('audioFile', new Blob([wav], { type: 'audio/wav' }), filename);
    formData.append('name', name);
    const res = await fetch(`${baseUrl}/api/audio/upload`, { method: 'POST', body: formData });
    const body = await res.json();
    if (!body.success) {
        throw new Error(`uploadTestAudio failed: ${body.error}`);
    }
    return body.audioFile;
}

/**
 * Boots a server in before(), tears it down (with SIGKILL escalation - see
 * FIX_PLAN.md Track G8 for why) in after(). Call at the top level of a test
 * file; returns accessors that resolve once before() has run.
 */
function useServer(extraEnv = {}) {
    const state = {};

    before(async () => {
        state.tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-smoke-'));
        state.port = await getFreePort();
        state.baseUrl = `http://127.0.0.1:${state.port}`;
        state.serverProcess = spawnServer({
            PORT: String(state.port),
            HOST: '127.0.0.1',
            ACCOMPANIMENT_DATA_DIR: state.tempDataDir,
            ...extraEnv,
        });
        state.serverExitPromise = waitForExit(state.serverProcess);
        await waitForHealth(state.baseUrl, READY_TIMEOUT_MS);
    });

    after(async () => {
        if (state.serverProcess && state.serverProcess.exitCode === null) {
            state.serverProcess.kill('SIGTERM');
            let result = await Promise.race([
                state.serverExitPromise,
                new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 12000)),
            ]);

            if (result.code === 'timeout') {
                // See FIX_PLAN.md Track G8: a rare, pre-existing deadlock in
                // the third-party rtaudio.js binding's stopStream() can
                // freeze the whole JS event loop during shutdown. SIGKILL
                // is unconditional at the OS level and doesn't need the
                // frozen process's cooperation.
                console.error('Test harness: server did not exit within 12s of SIGTERM - force killing.');
                state.serverProcess.kill('SIGKILL');
                result = await Promise.race([
                    state.serverExitPromise,
                    new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout-after-sigkill' }), 5000)),
                ]);
            }

            await fs.rm(state.tempDataDir, { recursive: true, force: true }).catch(() => {});

            assert.notEqual(
                result.code,
                'timeout-after-sigkill',
                'Server did not exit even after SIGKILL (unexpected - investigate, this is not the known deadlock)'
            );
            assert.notEqual(
                result.signal,
                'SIGKILL',
                'Graceful SIGTERM shutdown hung and had to be force-killed. This is a known, rare, pre-existing '
                + 'deadlock inside the third-party @hamitzor/rtaudio.js binding - see FIX_PLAN.md Track G8. The '
                + 'server process itself was cleaned up correctly (no orphan left behind); an occasional failure '
                + 'here is expected until upstream fixes it, but frequent failures warrant investigation.'
            );
            assert.equal(result.code, 0, `Server should exit 0 on graceful SIGTERM shutdown, got ${result.code}`);
            return;
        }
        await fs.rm(state.tempDataDir, { recursive: true, force: true }).catch(() => {});
    });

    return {
        baseUrl: () => state.baseUrl,
        tempDataDir: () => state.tempDataDir,
        port: () => state.port,
    };
}

// --- WebSocket helpers ---------------------------------------------------

function connectWs(baseUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(baseUrl.replace('http', 'ws'));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

/** Resolves with the first message for which predicate(parsed) is truthy. */
function waitForMessage(ws, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.removeListener('message', handler);
            reject(new Error(`waitForMessage: no matching message within ${timeoutMs}ms`));
        }, timeoutMs);
        function handler(data) {
            let parsed;
            try {
                parsed = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (predicate(parsed)) {
                clearTimeout(timeout);
                ws.removeListener('message', handler);
                resolve(parsed);
            }
        }
        ws.on('message', handler);
    });
}

function waitForType(ws, type, timeoutMs = 5000) {
    return waitForMessage(ws, (m) => m.type === type, timeoutMs);
}

let requestIdCounter = 0;

/** Sends an invoke-style {type, requestId, payload} message and waits for the matching `${type}_response`. */
function wsInvoke(ws, type, payload, timeoutMs = 5000) {
    const requestId = `test-${Date.now()}-${++requestIdCounter}`;
    const responsePromise = waitForMessage(
        ws,
        (m) => m.type === `${type}_response` && m.requestId === requestId,
        timeoutMs
    );
    ws.send(JSON.stringify({ type, requestId, payload }));
    return responsePromise;
}

function wsSend(ws, type, payload) {
    ws.send(JSON.stringify({ type, payload }));
}

module.exports = {
    getFreePort,
    spawnServer,
    waitForHealth,
    waitForExit,
    makeTestWav,
    uploadTestAudio,
    pollUntil,
    useServer,
    connectWs,
    waitForMessage,
    waitForType,
    wsInvoke,
    wsSend,
};
