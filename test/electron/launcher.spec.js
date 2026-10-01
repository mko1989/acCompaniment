/**
 * The Electron tray launcher (electron-launcher/): it starts and stops the
 * server, uses the configured data directory and port, adopts a server
 * already running on its port, keeps its log quiet (no periodic health
 * check), and is branded like the main UI.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
    test, expect, isServerUp, waitFor, launcherEnv, REPO_ROOT,
} = require('./fixtures');

/** Evaluates `fn(launcher, arg)` in the Electron main process. */
function inMain(app, fn, arg) {
    return app.evaluate(({ app: electronApp }, [source, a]) => {
        // eslint-disable-next-line no-new-func
        const f = new Function('launcher', 'app', 'arg', `return (${source})(launcher, app, arg);`);
        return f(global.accompanimentLauncher, electronApp, a);
    }, [fn.toString(), arg]);
}

async function waitForRunning(launcher) {
    const ok = await waitFor(async () => inMain(launcher.app, (l) => l.isNodeRunning === true), 45000);
    expect(ok, 'launcher reports its server running').toBe(true);
}

async function openConfigWindow(launcher) {
    const windowPromise = launcher.app.waitForEvent('window');
    await inMain(launcher.app, (l) => l.showConfigWindow());
    const win = await windowPromise;
    await win.waitForLoadState('domcontentloaded');
    return win;
}

test('starts its server on the configured port, from the configured data directory', async ({ launcher }) => {
    await waitForRunning(launcher);
    expect(await isServerUp(launcher.port)).toBe(true);
    expect(await inMain(launcher.app, (l) => l.nodePort)).toBe(launcher.port);
    expect(await inMain(launcher.app, (l) => l.dataDir)).toBe(launcher.dataDir);
    // The server really uses the same data directory: it creates its folders there.
    expect(fs.existsSync(path.join(launcher.dataDir, 'cues'))).toBe(true);
});

test('writes the server log into the data directory', async ({ launcher }) => {
    await waitForRunning(launcher);
    const log = path.join(launcher.dataDir, 'logs', 'accompaniment-server.log');
    await expect.poll(() => fs.existsSync(log) && fs.readFileSync(log, 'utf-8')).toContain('acCompaniment server starting');
});

test('quitting the launcher stops its server', async ({ launcher }) => {
    await waitForRunning(launcher);
    await launcher.app.close();
    expect(await waitFor(async () => !(await isServerUp(launcher.port)), 15000)).toBe(true);
});

test('has no periodic health check, and does not log health probes', async ({ launcher }) => {
    await waitForRunning(launcher);
    expect(await inMain(launcher.app, (l) => l.heartbeatTimer ?? null)).toBeNull();
    await new Promise((r) => setTimeout(r, 3000));
    const healthLines = launcher.output.filter((line) => /health check|running and healthy/i.test(line));
    expect(healthLines).toEqual([]);
    const started = launcher.output.filter((line) => line.includes('Server started successfully'));
    expect(started.length).toBeLessThanOrEqual(1);
});

test('the config window shows status, URL, and the data directory it uses', async ({ launcher }) => {
    await waitForRunning(launcher);
    const win = await openConfigWindow(launcher);
    await expect(win.locator('#statusText')).toHaveText('Server Running', { timeout: 10000 });
    await expect(win.locator('#statusIndicator')).toHaveClass(/running/);
    await expect(win.locator('#serverUrl')).toHaveText(`http://localhost:${launcher.port}`);
    await expect(win.locator('#openBrowserButton')).toBeEnabled();
    const dataDir = await win.evaluate(() => require('electron').ipcRenderer.invoke('get-data-directory'));
    expect(dataDir).toBe(launcher.dataDir);
});

test('branding: app icon left of the name, Rewir font, app name as the window title', async ({ launcher }) => {
    const win = await openConfigWindow(launcher);
    expect(await win.title()).toBe('acCompaniment');
    const title = win.locator('.top-bar .title-container');
    await expect(title.locator('h1')).toHaveText('acCompaniment');
    const icon = title.locator('img.app-icon-title');
    await expect(icon).toBeVisible();
    expect(await icon.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    const iconBox = await icon.boundingBox();
    const nameBox = await title.locator('h1').boundingBox();
    expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(nameBox.x);

    for (const selector of ['body', 'h1', '.config-section h2', 'label', '.button', '#serverUrl']) {
        const family = await win.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);
        expect(family, selector).toMatch(/^"?Rewir"?/);
    }
});

test('the dock shows the app icon, not Electron\'s', async ({ launcher }) => {
    test.skip(process.platform !== 'darwin', 'macOS only');
    const iconPath = await inMain(launcher.app, (l) => l.dockIconPath);
    expect(iconPath).toBe(path.join(REPO_ROOT, 'electron-launcher', 'assets', 'icon.png'));
    expect(fs.existsSync(iconPath)).toBe(true);
});

test('adopts a server that is already running on its port instead of starting a second one', async ({ env }) => {
    const { _electron } = require('@playwright/test');
    const existing = spawn(process.execPath, [path.join(REPO_ROOT, 'start-nodejs.js')], {
        cwd: REPO_ROOT,
        env: { ...process.env, PORT: String(env.port), ACCOMPANIMENT_DATA_DIR: env.dataDir },
        stdio: 'ignore',
    });
    try {
        expect(await waitFor(() => isServerUp(env.port), 30000)).toBe(true);
        const app = await _electron.launch({
            args: [REPO_ROOT], cwd: REPO_ROOT, env: launcherEnv(env.dataDir),
        });
        try {
            expect(await waitFor(async () => inMain(app, (l) => l.isNodeRunning === true), 30000)).toBe(true);
            expect(await inMain(app, (l) => l.nodeProcess === null || l.nodeProcess === undefined)).toBe(true);
        } finally {
            await app.close();
        }
    } finally {
        existing.kill('SIGTERM');
        await waitFor(async () => !(await isServerUp(env.port)), 15000);
    }
});
