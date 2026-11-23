// The tray app's configuration window (rust/tray/ui/config.html), loaded in Chromium with
// Tauri's `window.__TAURI__.core.invoke` stubbed: what the page shows and which commands it
// sends. The tray's process supervision is tested in Rust (rust/tray/src/supervisor.rs).
// Ported from the Electron launcher's spec (test/electron/launcher.spec.js, removed in ADR-020).

const path = require('path');
const { test, expect } = require('@playwright/test');

const PAGE = 'file://' + path.resolve(__dirname, '../../rust/tray/ui/config.html');

/** Opens the page with a fake Tauri backend; `state` is what the commands answer. */
async function openWindow(page, state = {}) {
    const backend = {
        status: { isRunning: true, starting: false, port: 4321 },
        config: { httpRemotePort: 4321 },
        ...state,
    };
    await page.addInitScript((b) => {
        window.__calls = [];
        window.__TAURI__ = {
            core: {
                invoke: async (cmd, args) => {
                    window.__calls.push({ cmd, args: args ?? null });
                    switch (cmd) {
                        case 'get_server_status': return b.status;
                        case 'get_config': return b.config;
                        case 'update_config': return { success: true };
                        default: return null;
                    }
                },
            },
        };
    }, backend);
    await page.goto(PAGE);
    return page;
}

const calls = (page, cmd) => page.evaluate((c) => window.__calls.filter((x) => x.cmd === c), cmd);

test('shows the server status and its URL', async ({ page }) => {
    await openWindow(page);
    await expect(page.locator('#statusText')).toHaveText('Server Running');
    await expect(page.locator('#statusIndicator')).toHaveClass(/running/);
    await expect(page.locator('#serverPort')).toHaveValue('4321');
    await expect(page.locator('#serverUrl')).toHaveText('http://localhost:4321');
    await expect(page.locator('#openBrowserButton')).toBeEnabled();
});

test('a stopped or starting server is shown as such, and the browser UI cannot be opened', async ({ page }) => {
    await openWindow(page, { status: { isRunning: false, starting: true, port: 4321 } });
    await expect(page.locator('#statusText')).toHaveText('Server Starting…');
    await expect(page.locator('#openBrowserButton')).toBeDisabled();
});

test('Change Port saves the new port; the buttons call the tray', async ({ page }) => {
    await openWindow(page);
    await expect(page.locator('#serverPort')).toHaveValue('4321');
    await page.locator('#serverPort').fill('5000');
    await expect(page.locator('#serverUrl')).toHaveText('http://localhost:5000');
    await page.locator('#changePortButton').click();
    await expect.poll(async () => (await calls(page, 'update_config')).map((c) => c.args)).toEqual([
        { configData: { httpRemotePort: 5000 } },
    ]);
    await page.locator('#openBrowserButton').click();
    await page.locator('#openDataDirButton').click();
    await expect.poll(async () => (await calls(page, 'open_browser_ui')).length).toBe(1);
    await expect.poll(async () => (await calls(page, 'open_data_directory')).length).toBe(1);
});

test('has no Interface setting: the server always listens on every interface', async ({ page }) => {
    await openWindow(page);
    await expect(page.locator('#serverHost')).toHaveCount(0);
});

test('branding: app icon left of the name, Rewir font, app name as the title', async ({ page }) => {
    await openWindow(page);
    expect(await page.title()).toBe('acCompaniment');
    const title = page.locator('.top-bar .title-container');
    await expect(title.locator('h1')).toHaveText('acCompaniment');
    const icon = title.locator('img.app-icon-title');
    await expect(icon).toBeVisible();
    expect(await icon.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    const iconBox = await icon.boundingBox();
    const nameBox = await title.locator('h1').boundingBox();
    expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(nameBox.x);
    for (const selector of ['body', 'h1', '.config-section h2', 'label', '.button', '#serverUrl']) {
        const family = await page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);
        expect(family, selector).toMatch(/^"?Rewir"?/);
    }
});
