/**
 * Real-browser tests of the main soundboard UI (src/frontend/index.html):
 * loading, live WebSocket-driven rendering of a cue created via the API
 * while the page is already open, edit-mode vs show-mode click behavior,
 * playback reflected in the DOM, and the config sidebar toggle.
 */

const { test, expect } = require('@playwright/test');
const { createTestCue, deleteCue } = require('./helpers');

test('loads the main UI with the expected title and layout', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('acCompaniment');
    await expect(page.locator('#cueGridContainer')).toBeVisible();
    await expect(page.locator('#appContainer')).toHaveClass(/edit-mode/, {
        // starts in edit mode by default
    });
});

test('a cue created via the API while the page is open appears live, via WebSocket', async ({ page, request }) => {
    await page.goto('/');
    const cue = await createTestCue(request, { name: 'Live WS Render Cue' });
    try {
        const button = page.locator(`.cue-button[data-cue-id="${cue.id}"]`);
        await expect(button).toBeVisible({ timeout: 5000 });
        await expect(button).toContainText('Live WS Render Cue');
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('edit mode (default): clicking a cue opens the properties sidebar', async ({ page, request }) => {
    await page.goto('/');
    const cue = await createTestCue(request, { name: 'Edit Mode Click Cue' });
    try {
        const button = page.locator(`.cue-button[data-cue-id="${cue.id}"]`);
        await expect(button).toBeVisible();

        await expect(page.locator('#propertiesSidebar')).toHaveClass(/hidden/);
        await button.click();
        await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
        await expect(page.locator('#propCueName')).toHaveValue('Edit Mode Click Cue');

        await page.locator('#closePropertiesSidebarBtn').click();
        await expect(page.locator('#propertiesSidebar')).toHaveClass(/hidden/);
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('show mode: clicking a cue plays it, and Stop All stops it', async ({ page, request }) => {
    await page.goto('/');
    const cue = await createTestCue(request, { name: 'Show Mode Playback Cue' });
    try {
        // Switch to show mode (default is edit mode, where a click opens
        // properties instead of playing).
        await page.locator('#modeToggleBtn').click();
        await expect(page.locator('#appContainer')).toHaveClass(/show-mode/);

        const button = page.locator(`.cue-button[data-cue-id="${cue.id}"]`);
        await expect(button).toBeVisible();
        await button.click();
        await expect(button).toHaveClass(/playing/, { timeout: 5000 });

        await page.locator('#stopAllButton').click();
        await expect(button).not.toHaveClass(/playing/, { timeout: 5000 });
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('config sidebar toggles open and closed', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('#configSidebar');
    await expect(sidebar).toHaveClass(/collapsed/);

    await page.locator('#configToggleBtn').click();
    await expect(sidebar).toHaveClass(/expanded/);
    await expect(sidebar).not.toHaveClass(/collapsed/);

    await page.locator('#configToggleBtn').click();
    await expect(sidebar).toHaveClass(/collapsed/);
});

test('adds a cue through the file picker (the drag-and-drop alternative)', async ({ page }) => {
    await page.goto('/');

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#addFilesButton').click();
    const fileChooser = await fileChooserPromise;

    // A single file selected via the picker creates the cue directly (no
    // modal) - see handleSingleFileDrop in ui.js. Build a small valid WAV
    // in-memory and feed it straight to the native file input Playwright
    // intercepted; no real file needs to exist on disk for this.
    const uniqueStem = `picker-test-${Date.now()}`;
    const { makeTestWav } = require('./helpers');
    await fileChooser.setFiles({
        name: `${uniqueStem}.wav`,
        mimeType: 'audio/wav',
        buffer: makeTestWav(2),
    });

    // Cue name is the filename minus its extension.
    await expect(page.locator('.cue-button', { hasText: uniqueStem })).toBeVisible({ timeout: 10000 });
});
