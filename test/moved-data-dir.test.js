/**
 * A data dir that has moved (restored on a new computer, a renamed home
 * folder, a different ACCOMPANIMENT_DATA_DIR) must still play its cues: the
 * library's audio files moved with it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {
    getFreePort, spawnServer, waitForHealth, waitForExit, uploadTestAudio,
} = require('./helpers/harness');

async function startServer(dataDir) {
    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawnServer({ PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir });
    const exited = waitForExit(child);
    await waitForHealth(base, 15000);
    return {
        base,
        async stop() { child.kill('SIGTERM'); await exited; },
    };
}

test('cues still play after the data dir has moved',
    { todo: 'WO-015: audio files are looked up at their old absolute path after the data dir moves' },
    async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-moved-'));
        const before = path.join(root, 'before');
        const after = path.join(root, 'after');
        try {
            const first = await startServer(before);
            const audioFile = await uploadTestAudio(first.base, { durationSec: 3 });
            const created = await (await fetch(`${first.base}/api/cues`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Moved', type: 'single_file', audioFileId: audioFile.id,
                    relativePath: audioFile.relativePath, volume: 0.05,
                }),
            })).json();
            await first.stop();

            await fs.rename(before, after);

            const second = await startServer(after);
            try {
                const res = await fetch(`${second.base}/api/cues/${created.cue.id}/trigger`, { method: 'POST' });
                const body = await res.json();
                assert.equal(body.success, true, `trigger failed: ${body.error}`);
                await fetch(`${second.base}/api/cues/${created.cue.id}/stop`, { method: 'POST' });
            } finally {
                await second.stop();
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
