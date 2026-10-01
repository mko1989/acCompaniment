/**
 * The app configuration sidebar: every setting saves itself to the server,
 * dependent fields show and hide, zero values survive, and the defaults it
 * sets are what new cues get.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { test, expect } = require('./fixtures');
const { openApp, getConfig, makeTestWav, cueButton } = require('./helpers');

async function openConfig(page) {
    await openApp(page);
    await page.locator('#configToggleBtn').click();
    await expect(page.locator('#configSidebar')).toHaveClass(/expanded/);
}

/** Types into a number field and leaves it (config fields save on change). */
async function setNumber(page, selector, value) {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).press('Tab');
}

const savedConfig = (request, key) => async () => (await getConfig(request))[key];

test('shows the current configuration', async ({ page, request }) => {
    await request.put('/api/config', { data: { defaultFadeInTime: 120, crossfadeTime: 3300, defaultStopAllBehavior: 'fade_out_and_stop' } });
    await openConfig(page);
    await expect(page.locator('#defaultFadeIn')).toHaveValue('120');
    await expect(page.locator('#crossfadeTime')).toHaveValue('3300');
    await expect(page.locator('#defaultStopAllBehavior')).toHaveValue('fade_out_and_stop');
});

test('default fade in and fade out save', async ({ page, request }) => {
    await openConfig(page);
    await setNumber(page, '#defaultFadeIn', 250);
    await expect.poll(savedConfig(request, 'defaultFadeInTime')).toBe(250);
    await setNumber(page, '#defaultFadeOut', 750);
    await expect.poll(savedConfig(request, 'defaultFadeOutTime')).toBe(750);
});

test('default loop saves', async ({ page, request }) => {
    await openConfig(page);
    await page.locator('#defaultLoop').check();
    await expect.poll(savedConfig(request, 'defaultLoopSingleCue')).toBe(true);
    await page.locator('#defaultLoop').uncheck();
    await expect.poll(savedConfig(request, 'defaultLoopSingleCue')).toBe(false);
});

test('default retrigger behavior saves', async ({ page, request }) => {
    await openConfig(page);
    await page.locator('#retriggerBehavior').selectOption('toggle_pause_play');
    await expect.poll(savedConfig(request, 'defaultRetriggerBehavior')).toBe('toggle_pause_play');
});

test('Stop All behavior saves; its fade time field shows only for "fade out and stop"', async ({ page, request }) => {
    await openConfig(page);
    const fadeGroup = page.locator('#defaultStopAllFadeOutGroup');
    await page.locator('#defaultStopAllBehavior').selectOption('stop');
    await expect(fadeGroup).toBeHidden();
    await expect.poll(savedConfig(request, 'defaultStopAllBehavior')).toBe('stop');

    await page.locator('#defaultStopAllBehavior').selectOption('fade_out_and_stop');
    await expect(fadeGroup).toBeVisible();
    await expect.poll(savedConfig(request, 'defaultStopAllBehavior')).toBe('fade_out_and_stop');
});

test('Stop All fade time saves - including 0, which used to snap back to 1500', async ({ page, request }) => {
    await request.put('/api/config', { data: { defaultStopAllBehavior: 'fade_out_and_stop' } });
    await openConfig(page);
    await setNumber(page, '#defaultStopAllFadeOut', 2200);
    await expect.poll(savedConfig(request, 'defaultStopAllFadeOutTime')).toBe(2200);
    await setNumber(page, '#defaultStopAllFadeOut', 0);
    await expect.poll(savedConfig(request, 'defaultStopAllFadeOutTime')).toBe(0);

    await page.reload();
    await page.locator('#configToggleBtn').click();
    await expect(page.locator('#defaultStopAllFadeOut')).toHaveValue('0');
    // Saving some other setting must not overwrite the 0.
    await page.locator('#defaultLoop').check();
    await expect.poll(savedConfig(request, 'defaultLoopSingleCue')).toBe(true);
    expect((await getConfig(request)).defaultStopAllFadeOutTime).toBe(0);
});

test('crossfade time saves (its changes used to be ignored)', async ({ page, request }) => {
    await openConfig(page);
    await setNumber(page, '#crossfadeTime', 4500);
    await expect.poll(savedConfig(request, 'crossfadeTime')).toBe(4500);
});

test('ducking fade time saves', async ({ page, request }) => {
    await openConfig(page);
    await expect(page.locator('#duckingFadeTime')).toHaveValue('1000');
    await setNumber(page, '#duckingFadeTime', 300);
    await expect.poll(savedConfig(request, 'duckingFadeTime')).toBe(300);
});

test('clearing a number field does not save a broken value', async ({ page, request }) => {
    await request.put('/api/config', { data: { defaultFadeInTime: 90 } });
    await openConfig(page);
    await setNumber(page, '#defaultFadeIn', '');
    await page.locator('#defaultLoop').check();
    await expect.poll(savedConfig(request, 'defaultLoopSingleCue')).toBe(true);
    expect((await getConfig(request)).defaultFadeInTime).toBe(90);
});

test('HTTP remote: always on - no enable switch, links and port always shown', async ({ page }) => {
    // The remote page is always served, so a switch that only hid these
    // settings made no sense.
    await openConfig(page);
    await expect(page.locator('#configHttpRemoteEnabled')).toHaveCount(0);
    await expect(page.locator('#httpRemoteLinksGroup')).toBeVisible();
    await expect(page.locator('#httpRemotePortGroup')).toBeVisible();
    await expect(page.locator('#httpRemotePortGroup')).toContainText('takes effect when the server restarts');
});

test('HTTP remote: links point at the /remote page on the port actually in use', async ({ page, baseURL, request }) => {
    const livePort = new URL(baseURL).port;
    expect((await getConfig(request)).httpRemotePort).not.toBe(Number(livePort)); // config says 3333; the test server runs elsewhere
    await openConfig(page);
    const links = page.locator('#httpRemoteLinksDiv');
    await expect(links).not.toBeEmpty();
    const urls = await links.locator('.remote-link-url').allTextContents();
    if (urls.length === 0) {
        await expect(links).toContainText('No network interfaces found');
        return;
    }
    for (const url of urls) {
        expect(url).toMatch(new RegExp(`^http://[\\d.]+:${livePort}/remote$`));
    }
    await expect(links.locator('.remote-link-copy').first()).toHaveText('Copy');
    // The Copy button fits inside the sidebar (long URLs wrap instead).
    // (After the sidebar's opening animation - it slides to 280px wide.)
    await expect.poll(async () => (await page.locator('#configSidebar').boundingBox()).width).toBeGreaterThan(270);
    const sidebar = await page.locator('#configSidebar').boundingBox();
    const copy = await links.locator('.remote-link-copy').first().boundingBox();
    expect(copy.x + copy.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    // ...and stays a small button, leaving the URL room to be read.
    const url = await links.locator('.remote-link-url').first().boundingBox();
    expect(copy.width).toBeLessThan(80);
    expect(url.width).toBeGreaterThan(copy.width * 2);
});

test('HTTP remote: the /remote link opens the remote page', async ({ page, baseURL }) => {
    await openConfig(page);
    const url = (await page.locator('#httpRemoteLinksDiv .remote-link-url').allTextContents())[0];
    test.skip(!url, 'no network interface on this machine');
    const remote = await page.context().newPage();
    await remote.goto(`${baseURL}${new URL(url).pathname}`);
    await expect(remote).toHaveTitle('acCompaniment Remote');
});

test('HTTP remote port saves', async ({ page, request }) => {
    await openConfig(page);
    await setNumber(page, '#configHttpRemotePort', 4455);
    await expect.poll(savedConfig(request, 'httpRemotePort')).toBe(4455);
});

test('audio output: lists "System Default" plus the server\'s devices, and channel counts', async ({ page }) => {
    await openConfig(page);
    const devices = page.locator('#configAudioOutputDevice option');
    await expect(devices.first()).toHaveText(/System Default/);
    const channelOptions = await page.locator('#configAudioOutputChannelCount option').allTextContents();
    expect(channelOptions[0]).toBe('2 channels');
});

test('a change made from another page shows up here', async ({ page, request }) => {
    await openConfig(page);
    await request.put('/api/config', { data: { crossfadeTime: 6100 } });
    await expect(page.locator('#crossfadeTime')).toHaveValue('6100');
});

test('new cues are created with the default fades, loop and retrigger behavior', async ({ page, request }) => {
    await request.put('/api/config', {
        data: { defaultFadeInTime: 111, defaultFadeOutTime: 222, defaultLoopSingleCue: true, defaultRetriggerBehavior: 'stop' },
    });
    await openApp(page);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-')), 'Defaults Test.wav');
    fs.writeFileSync(file, makeTestWav(1));
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#addFilesButton').click();
    await (await chooser).setFiles(file);

    const button = page.locator('.cue-button', { hasText: 'Defaults Test' });
    await expect(button).toBeVisible();
    const cueId = await button.getAttribute('data-cue-id');
    const { cue } = await (await request.get(`/api/cues/${cueId}`)).json();
    expect(cue.fadeInTime).toBe(111);
    expect(cue.fadeOutTime).toBe(222);
    expect(cue.loop).toBe(true);
    expect(cue.retriggerBehavior).toBe('stop');
    await expect(cueButton(page, cueId).locator('.cue-retrigger-badge')).toHaveAttribute('title', 'Stop');
});
