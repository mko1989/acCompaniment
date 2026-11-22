/**
 * ACCOMPANIMENT_DATA_DIR may be a relative path (resolved against the working directory). The
 * library must behave exactly as with an absolute one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const {
    getFreePort, spawnServer, waitForHealth, waitForExit, uploadTestAudio, makeTestWav,
} = require('./helpers/harness');

const REPO_ROOT = path.join(__dirname, '..');

// WO-023: with a relative data dir, "replace file" used to compare a relative new path with the
// record's absolute one, and so deleted the file it had just moved in.
test('replacing a file\'s audio keeps the file when the data dir is relative', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-relative-'));
    const relativeDir = path.relative(REPO_ROOT, path.join(root, 'data'));
    assert.ok(!path.isAbsolute(relativeDir));
    // spawnServer runs with cwd = the repository root, so the relative dir resolves to root/data.
    async function start() {
        const port = await getFreePort();
        const base = `http://127.0.0.1:${port}`;
        const child = spawnServer({ PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: relativeDir });
        const exited = waitForExit(child);
        await waitForHealth(base, 15000);
        return { base, stop: async () => { child.kill('SIGTERM'); await exited; } };
    }
    try {
        // Added in one session, replaced in the next: records loaded from disk get absolute paths.
        const first = await start();
        const original = await uploadTestAudio(first.base, { durationSec: 2, filename: 'keep-me.wav' });
        await first.stop();

        const second = await start();
        try {
            const form = new FormData();
            form.append('audioFile', new Blob([makeTestWav(3)]), 'replacement.wav');
            const replaced = await (await fetch(`${second.base}/api/audio/${original.id}/replace`, { method: 'POST', body: form })).json();
            assert.equal(replaced.success, true, `replace failed: ${replaced.error}`);

            const onDisk = path.join(root, 'data', 'audio', replaced.audioFile.relativePath);
            assert.ok(fssync.existsSync(onDisk), `${replaced.audioFile.relativePath} is gone from the library folder`);
        } finally {
            await second.stop();
        }
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
