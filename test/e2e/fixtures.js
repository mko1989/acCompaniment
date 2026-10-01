/**
 * Playwright fixtures: every worker gets its own acCompaniment server (own
 * free port, own temporary data directory), and every test starts from a
 * clean slate on it - nothing playing, crossfade off, master volume 1,
 * config as it was at boot, and no cues.
 *
 * Stop All, crossfade mode and app config are server-wide. When all specs
 * shared one server, a Stop All in one test stopped the cue another test
 * running in parallel was in the middle of checking - so specs had to
 * tiptoe around each other. Per-worker servers make each test's world its
 * own; tests within a worker run one after another.
 */

const base = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const REPO_ROOT = path.join(__dirname, '..', '..');

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

async function waitForHealth(baseURL, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseURL}/api/remote/health`);
            if (res.ok) return;
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`e2e server at ${baseURL} did not become healthy within ${timeoutMs}ms`);
}

async function json(baseURL, method, urlPath, body) {
    const res = await fetch(`${baseURL}${urlPath}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
}

const test = base.test.extend({
    appServer: [async ({}, use) => {
        const port = await getFreePort();
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-e2e-'));
        const baseURL = `http://127.0.0.1:${port}`;
        const child = spawn(process.execPath, [path.join(REPO_ROOT, 'start-nodejs.js')], {
            cwd: REPO_ROOT,
            env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        const exited = new Promise((resolve) => child.on('exit', resolve));

        try {
            await waitForHealth(baseURL);
        } catch (error) {
            child.kill('SIGKILL');
            throw new Error(`${error.message}\n${stderr}`);
        }
        const initialConfig = (await json(baseURL, 'GET', '/api/config')).config;

        await use({ baseURL, port, dataDir, initialConfig });

        child.kill('SIGTERM');
        const timedOut = await Promise.race([
            exited.then(() => false),
            new Promise((r) => setTimeout(() => r(true), 10000)),
        ]);
        if (timedOut) {
            // Known rtaudio.js shutdown deadlock (FIX_PLAN.md G8).
            child.kill('SIGKILL');
            await exited;
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
    }, { scope: 'worker', timeout: 60000 }],

    baseURL: async ({ appServer }, use) => {
        await use(appServer.baseURL);
    },

    // Runs around every test automatically.
    cleanSlate: [async ({ appServer }, use) => {
        await use();
        const { baseURL, initialConfig } = appServer;
        await json(baseURL, 'POST', '/api/cues/stop-all', { behavior: 'stop' });
        await json(baseURL, 'POST', '/api/remote/crossfade', { enabled: false });
        await json(baseURL, 'POST', '/api/remote/master-volume', { volume: 1 });
        await json(baseURL, 'PUT', '/api/config', initialConfig);
        const { cues = [] } = await json(baseURL, 'GET', '/api/cues');
        for (const cue of cues) {
            await json(baseURL, 'DELETE', `/api/cues/${cue.id}`);
        }
    }, { auto: true }],
});

module.exports = { test, expect: base.expect };
