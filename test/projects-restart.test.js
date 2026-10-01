/**
 * After a restart the server reopens the project that was open - even one
 * that was only opened, not edited (it used to open whichever project file
 * was changed most recently). Starts and stops its own servers.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    spawnServer, getFreePort, waitForHealth, waitForExit,
} = require('./helpers/harness');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-restart-'));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function withServer(fn) {
    const port = await getFreePort();
    const child = spawnServer({ PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir });
    const exited = waitForExit(child);
    const base = `http://127.0.0.1:${port}`;
    try {
        await waitForHealth(base, 15000);
        return await fn(base);
    } finally {
        child.kill('SIGTERM');
        const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 12000))]);
        if (result === 'timeout') {
            child.kill('SIGKILL');
            await exited;
        }
    }
}

const json = async (base, method, url, body) => (await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
})).json();

test('the project that was open is reopened after a restart', async () => {
    const ids = await withServer(async (base) => {
        const older = (await json(base, 'POST', '/api/projects', { name: 'Older Show' })).project;
        const newer = (await json(base, 'POST', '/api/projects', { name: 'Newer Show' })).project;
        await json(base, 'PUT', '/api/projects/current', { name: 'Newer Show (edited)' });
        // Open the older one without changing it: it is now the least
        // recently modified project, but the one that should come back.
        await json(base, 'POST', `/api/projects/${older.id}/open`);
        return { older: older.id, newer: newer.id };
    });

    const reopened = await withServer(async (base) => (await json(base, 'GET', '/api/projects/current')).project);
    assert.equal(reopened.id, ids.older);
    assert.equal(reopened.name, 'Older Show');
});

test('if the last opened project was deleted, the most recently changed one opens', async () => {
    const newest = await withServer(async (base) => {
        const doomed = (await json(base, 'POST', '/api/projects', { name: 'Doomed' })).project;
        const keeper = (await json(base, 'POST', '/api/projects', { name: 'Keeper' })).project;
        await json(base, 'POST', `/api/projects/${doomed.id}/open`);
        await json(base, 'POST', `/api/projects/${keeper.id}/open`);
        await json(base, 'PUT', '/api/projects/current', { name: 'Keeper (latest)' });
        await json(base, 'DELETE', `/api/projects/${doomed.id}`);
        // Last opened is Keeper anyway; point config at the deleted one.
        const configPath = path.join(dataDir, 'config', 'appConfig.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return { keeper: keeper.id, doomed: doomed.id, configPath, config };
    });
    fs.writeFileSync(newest.configPath, JSON.stringify({ ...newest.config, lastOpenedProjectId: newest.doomed }));

    const reopened = await withServer(async (base) => (await json(base, 'GET', '/api/projects/current')).project);
    assert.equal(reopened.id, newest.keeper);
});
