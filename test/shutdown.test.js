/**
 * A second shutdown signal while the first is still being handled (Ctrl+C
 * in a terminal reaches both the launcher and the server, and the launcher
 * then sends its own SIGTERM) must still end the process. It used to call
 * process.exit() with the audio stream open, which deadlocked joining the
 * audio engine's worker thread: the server hung forever, still holding its
 * port, and every later launch failed with EADDRINUSE.
 *
 * The servers run on Electron's bundled Node, as the launcher runs them: the
 * hang reproduced there every time, but not under a plain Node.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {
    getFreePort, spawnServer, waitForHealth, waitForExit, uploadTestAudio, pollUntil,
} = require('./helpers/harness');

// The electron package exports its binary's path when required from Node.
const ELECTRON = require('electron');

async function startPlayingServer() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-shutdown-'));
    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawnServer({
        PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: '1',
    }, ELECTRON);
    const exited = waitForExit(child);
    await waitForHealth(base, 15000);

    const audioFile = await uploadTestAudio(base, { durationSec: 10 });
    const created = await (await fetch(`${base}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Shutdown test', type: 'single_file', audioFileId: audioFile.id,
            relativePath: audioFile.relativePath, volume: 0.05,
        }),
    })).json();
    const cueId = created.cue.id;
    await fetch(`${base}/api/cues/${cueId}/trigger`, { method: 'POST' });
    // Playing means the output stream is open - the state the hang needs.
    await pollUntil(async () => {
        const res = await (await fetch(`${base}/api/cues/${cueId}`)).json();
        return res.cue?.status === 'playing';
    }, { timeoutMs: 5000, intervalMs: 50 });

    return { child, exited, dataDir };
}

async function expectExit(child, exited, dataDir) {
    const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve('hung'), 15000)),
    ]);
    if (result === 'hung') {
        child.kill('SIGKILL');
        await exited;
    }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    assert.notEqual(result, 'hung', 'Server hung after a second shutdown signal');
}

test('SIGTERM then SIGINT while a cue plays still exits', async () => {
    const { child, exited, dataDir } = await startPlayingServer();
    child.kill('SIGTERM');
    child.kill('SIGINT');
    await expectExit(child, exited, dataDir);
});

test('a single SIGTERM while a cue plays exits cleanly with code 0', async () => {
    const { child, exited, dataDir } = await startPlayingServer();
    child.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 15000))]);
    if (result === 'hung') child.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    assert.deepEqual(result, { code: 0, signal: null });
});
