/**
 * Real-browser tests of the /remote page (src/frontend/remote_control/
 * remote.html) - the simplified cue grid meant for a phone/tablet on the
 * LAN. This is a separate, self-contained page from the main UI, with its
 * own WebSocket handling and REST calls (see FIX_PLAN.md G5).
 */

const { test, expect } = require('@playwright/test');
const { createTestCue, deleteCue } = require('./helpers');

test('loads the remote page and lists a cue created via the API', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Remote Page List Cue' });
    try {
        await page.goto('/remote');
        await expect(page).toHaveTitle('acCompaniment Remote');

        const button = page.locator(`#cue-btn-${cue.id}`);
        await expect(button).toBeVisible({ timeout: 5000 });
        await expect(button).toContainText('Remote Page List Cue');
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('clicking a cue on the remote page triggers playback', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Remote Page Trigger Cue' });
    try {
        await page.goto('/remote');
        const button = page.locator(`#cue-btn-${cue.id}`);
        await expect(button).toBeVisible();

        await button.click();
        await expect(button).toHaveClass(/playing/, { timeout: 5000 });

        // Confirm it's really playing server-side too, not just a stale
        // class flip in the DOM.
        const statusRes = await request.get(`/api/cues/${cue.id}`);
        const statusBody = await statusRes.json();
        expect(statusBody.cue.status).toBe('playing');

        await page.locator('#stopAllButtonRemote').click();
        await expect(button).not.toHaveClass(/playing/, { timeout: 5000 });
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('renders the connection-lost/engine-error banner', async ({ page }) => {
    await page.goto('/remote');
    // remote.html's <script> is a classic (non-module) script, so its
    // top-level function *declarations* - like setBanner, the same one
    // the WebSocket message handler calls on an 'audio-engine-error'
    // broadcast - are reachable as window.setBanner (its `let ws`
    // connection variable is not, since `let` at top level doesn't
    // attach to window even in a classic script). Actually triggering a
    // real audio-engine-error broadcast would mean unplugging real audio
    // hardware, so this calls the same rendering path directly instead.
    await expect(page.locator('#connectionBanner')).toBeEmpty();

    await page.evaluate(() => window.setBanner('Audio engine error: Test device error', 'engine-error'));
    await expect(page.locator('#connectionBanner')).toHaveClass('engine-error');
    await expect(page.locator('#connectionBanner')).toContainText('Test device error');

    await page.evaluate(() => window.setBanner('', ''));
    await expect(page.locator('#connectionBanner')).toBeEmpty();
});
