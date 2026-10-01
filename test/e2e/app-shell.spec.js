/**
 * The main window's frame: layout, empty state, the top-bar buttons
 * (Stop All, XFADE, mode toggle), the Shift temporary-mode override, and
 * live sync between two open pages.
 */

const { test, expect } = require('./fixtures');
const {
    createTestCue, openApp, enterShowMode, cueButton, getCue,
} = require('./helpers');

test('shows an empty-state hint when there are no cues', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.empty-state-message')).toContainText('No cues yet');
    await expect(page.locator('.cue-button')).toHaveCount(0);
});

test('the empty-state hint goes away once a cue exists', async ({ page, request }) => {
    await openApp(page);
    await expect(page.locator('.empty-state-message')).toBeVisible();
    await createTestCue(request, { name: 'First Cue' });
    await expect(page.locator('.empty-state-message')).toHaveCount(0);
    await expect(page.locator('.cue-button')).toHaveCount(1);
});

test('mode toggle switches between edit and show mode, and swaps its icon', async ({ page }) => {
    await openApp(page);
    const app = page.locator('#appContainer');
    const icon = page.locator('#modeToggleIcon');
    await expect(app).toHaveClass(/edit-mode/);
    await expect(icon).toHaveAttribute('src', /show_light\.png/);

    await page.locator('#modeToggleBtn').click();
    await expect(app).toHaveClass(/show-mode/);
    await expect(app).not.toHaveClass(/edit-mode/);
    await expect(icon).toHaveAttribute('src', /edit\.png/);
    await expect(page.locator('#modeToggleBtn')).toHaveClass(/show-mode-active/);

    await page.locator('#modeToggleBtn').click();
    await expect(app).toHaveClass(/edit-mode/);
    await expect(icon).toHaveAttribute('src', /show_light\.png/);
});

test('holding Shift temporarily flips the mode, releasing it flips back', async ({ page }) => {
    await openApp(page);
    const app = page.locator('#appContainer');
    await page.keyboard.down('Shift');
    await expect(app).toHaveClass(/show-mode/);
    await page.keyboard.up('Shift');
    await expect(app).toHaveClass(/edit-mode/);

    await enterShowMode(page);
    await page.keyboard.down('Shift');
    await expect(app).toHaveClass(/edit-mode/);
    await page.keyboard.up('Shift');
    await expect(app).toHaveClass(/show-mode/);
});

test('Shift-click in show mode opens a cue\'s properties instead of playing it', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Shift Click Cue' });
    await openApp(page);
    await enterShowMode(page);
    await page.keyboard.down('Shift');
    await cueButton(page, cue.id).click();
    await page.keyboard.up('Shift');
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
    expect((await getCue(request, cue.id)).status).not.toBe('playing');
});

test('the config sidebar opens and closes from its gear button', async ({ page }) => {
    await openApp(page);
    const sidebar = page.locator('#configSidebar');
    await expect(sidebar).toHaveClass(/collapsed/);
    await page.locator('#configToggleBtn').click();
    await expect(sidebar).toHaveClass(/expanded/);
    await expect(page.locator('#configSidebar h2')).toHaveText('App Configuration');
    await page.locator('#configToggleBtn').click();
    await expect(sidebar).toHaveClass(/collapsed/);
});

test('XFADE toggles crossfade mode on the server and lights up while on', async ({ page, request }) => {
    await openApp(page);
    const xfade = page.locator('#crossfadeToggleBtn');
    await expect(xfade).toHaveClass(/crossfade-disabled/);
    await expect(xfade).toHaveAttribute('aria-pressed', 'false');

    await xfade.click();
    await expect(xfade).toHaveClass(/crossfade-enabled/);
    await expect(xfade).toHaveAttribute('aria-pressed', 'true');
    await expect(xfade).toHaveAttribute('title', /is on/);
    expect((await (await request.get('/api/remote/crossfade')).json()).enabled).toBe(true);

    await xfade.click();
    await expect(xfade).toHaveClass(/crossfade-disabled/);
    expect((await (await request.get('/api/remote/crossfade')).json()).enabled).toBe(false);
});

test('XFADE state is shared: another open page follows it, and a reload shows it', async ({ page, context, request }) => {
    await openApp(page);
    const other = await context.newPage();
    await openApp(other);

    await page.locator('#crossfadeToggleBtn').click();
    await expect(other.locator('#crossfadeToggleBtn')).toHaveClass(/crossfade-enabled/);

    await page.reload();
    await expect(page.locator('#crossfadeToggleBtn')).toHaveClass(/crossfade-enabled/);

    await request.post('/api/remote/crossfade', { data: { enabled: false } });
    await expect(page.locator('#crossfadeToggleBtn')).toHaveClass(/crossfade-disabled/);
    await expect(other.locator('#crossfadeToggleBtn')).toHaveClass(/crossfade-disabled/);
});

test('Stop All stops every playing cue', async ({ page, request }) => {
    const a = await createTestCue(request, { name: 'Stop All A', durationSec: 10 });
    const b = await createTestCue(request, { name: 'Stop All B', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, a.id).click();
    await cueButton(page, b.id).click();
    await expect(cueButton(page, a.id)).toHaveClass(/playing/);
    await expect(cueButton(page, b.id)).toHaveClass(/playing/);

    await page.locator('#stopAllButton').click();
    await expect(cueButton(page, a.id)).not.toHaveClass(/playing/);
    await expect(cueButton(page, b.id)).not.toHaveClass(/playing/);
    expect((await getCue(request, a.id)).status).toBe('stopped');
    expect((await getCue(request, b.id)).status).toBe('stopped');
});

test('playback started on one page shows on another, live', async ({ page, context, request }) => {
    const cue = await createTestCue(request, { name: 'Two Pages Cue', durationSec: 10 });
    await openApp(page);
    const other = await context.newPage();
    await openApp(other);

    await enterShowMode(page);
    await cueButton(page, cue.id).click();
    await expect(cueButton(other, cue.id)).toHaveClass(/playing/);
    await page.locator('#stopAllButton').click();
    await expect(cueButton(other, cue.id)).not.toHaveClass(/playing/);
});

test('a page opened while a cue is playing shows it playing straight away', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Already Playing Cue', durationSec: 10 });
    await request.post(`/api/cues/${cue.id}/trigger`);
    await openApp(page);
    await expect(cueButton(page, cue.id)).toHaveClass(/playing/);
});

test('a cue edited from another page updates here, live', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Before Rename' });
    await openApp(page);
    await expect(cueButton(page, cue.id)).toContainText('Before Rename');
    await request.put(`/api/cues/${cue.id}`, { data: { name: 'After Rename' } });
    await expect(cueButton(page, cue.id)).toContainText('After Rename');
});

test('a cue deleted from elsewhere disappears here, live', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Soon Gone' });
    await openApp(page);
    await expect(cueButton(page, cue.id)).toBeVisible();
    await request.delete(`/api/cues/${cue.id}`);
    await expect(cueButton(page, cue.id)).toHaveCount(0);
});
