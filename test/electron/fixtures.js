/**
 * Launches the real Electron tray launcher (electron-launcher/main.js) for a
 * test, fully isolated from a real installation: its own temporary data
 * directory (ACCOMPANIMENT_DATA_DIR, honoured by both launcher and server)
 * and its own free port (written into that directory's config).
 */

const base = require('@playwright/test');
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

/**
 * Environment for launching Electron as an app. ELECTRON_RUN_AS_NODE makes
 * the Electron binary behave as plain Node (no `app`, no windows); it's set
 * in some environments (e.g. processes spawned by VS Code's extension host)
 * and must not leak into the launcher - which sets it itself, only for the
 * server it spawns.
 */
function launcherEnv(dataDir) {
    const env = { ...process.env, ACCOMPANIMENT_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}

async function isServerUp(port) {
    try {
        return (await fetch(`http://127.0.0.1:${port}/api/remote/health`)).ok;
    } catch {
        return false;
    }
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

const test = base.test.extend({
    // A fresh, isolated data directory and port for each test.
    env: async ({}, use) => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-launcher-'));
        const port = await getFreePort();
        fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'config', 'appConfig.json'), JSON.stringify({ httpRemotePort: port }));
        await use({ dataDir, port });
        fs.rmSync(dataDir, { recursive: true, force: true });
    },

    // Starts the launcher; collects its console output in `launcher.output`.
    launcher: async ({ env }, use) => {
        const app = await base._electron.launch({
            args: [REPO_ROOT],
            cwd: REPO_ROOT,
            env: launcherEnv(env.dataDir),
        });
        const output = [];
        app.process().stdout.on('data', (d) => output.push(...d.toString().split('\n').filter(Boolean)));
        app.process().stderr.on('data', (d) => output.push(...d.toString().split('\n').filter(Boolean)));

        await use({ app, output, ...env });

        await app.close().catch(() => {});
        // The launcher stops its server on quit; make sure nothing is left.
        await waitFor(async () => !(await isServerUp(env.port)), 15000);
    },
});

module.exports = {
    test, expect: base.expect, isServerUp, waitFor, getFreePort, launcherEnv, REPO_ROOT,
};
