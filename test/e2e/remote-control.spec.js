/**
 * Real-browser tests of the /remote page (src/frontend/remote_control/
 * remote.html) - the simplified cue grid meant for a phone/tablet on the
 * LAN. This is a separate, self-contained page from the main UI, with its
 * own WebSocket handling and REST calls (see FIX_PLAN.md G5).
 */

const { test, expect } = require('./fixtures');
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

// --- States, XFADE and Stop All -------------------------------------------

const { createTestPlaylist, getCue } = require('./helpers');

async function openRemote(page) {
    await page.goto('/remote');
    await expect(page).toHaveTitle('acCompaniment Remote');
}

const remoteButton = (page, cueId) => page.locator(`#cue-btn-${cueId}`);

test('remote: a cue that is already playing shows as playing on load', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 10 });
    await request.post(`/api/cues/${cue.id}/trigger`);
    await openRemote(page);
    await expect(remoteButton(page, cue.id)).toHaveClass(/playing/);
});

test('remote: playing state survives the cue list being re-sent (another cue edited)', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 10 });
    const other = await createTestCue(request, { name: 'Other' });
    await openRemote(page);
    await remoteButton(page, cue.id).click();
    await expect(remoteButton(page, cue.id)).toHaveClass(/playing/);
    await request.put(`/api/cues/${other.id}`, { data: { name: 'Other Renamed' } });
    await expect(remoteButton(page, other.id)).toContainText('Other Renamed');
    await expect(remoteButton(page, cue.id)).toHaveClass(/playing/);
});

test('remote: the time display counts while playing', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 10 });
    await openRemote(page);
    await remoteButton(page, cue.id).click();
    await expect(remoteButton(page, cue.id).locator('.current-time')).toHaveText(/0?0:0[1-9]/, { timeout: 4000 });
    await expect(remoteButton(page, cue.id).locator('.remaining')).toHaveText(/^-/);
});

test('remote: pressing follows the cue\'s retrigger behavior (pause, then resume)', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'toggle_pause_play', durationSec: 10 });
    await openRemote(page);
    const button = remoteButton(page, cue.id);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await page.waitForTimeout(450); // the remote ignores repeat presses within 400ms
    await button.click();
    await expect(button).toHaveClass(/paused/);
    expect((await getCue(request, cue.id)).status).toBe('paused');
    await page.waitForTimeout(450);
    await button.click();
    await expect(button).toHaveClass(/playing/);
});

test('remote: a fading cue shows as fading', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'fade_out_and_stop', fadeOutTime: 2500, durationSec: 10 });
    await openRemote(page);
    await remoteButton(page, cue.id).click();
    await expect(remoteButton(page, cue.id)).toHaveClass(/playing/);
    await page.waitForTimeout(450);
    await remoteButton(page, cue.id).click();
    await expect(remoteButton(page, cue.id)).toHaveClass(/fading/);
    await expect(remoteButton(page, cue.id)).not.toHaveClass(/fading|playing/, { timeout: 6000 });
});

test('remote: a cued playlist shows as cued', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 1, playlistPlayMode: 'stop_and_cue_next' });
    await openRemote(page);
    await remoteButton(page, list.id).click();
    await expect(remoteButton(page, list.id)).toHaveClass(/cued/, { timeout: 5000 });
});

test('remote: ducked cues show DUCK, and several instances show ×N', async ({ page, request }) => {
    const bed = await createTestCue(request, { enableDucking: true, retriggerBehavior: 'play_new_instance', durationSec: 20 });
    const voice = await createTestCue(request, { isDuckingTrigger: true, durationSec: 20 });
    await openRemote(page);
    await remoteButton(page, bed.id).click();
    await request.post(`/api/cues/${bed.id}/trigger`);
    await expect(remoteButton(page, bed.id).locator('.badge.instances')).toHaveText('×2');
    await request.post(`/api/cues/${voice.id}/trigger`);
    await expect(remoteButton(page, bed.id)).toHaveClass(/ducked/);
    await expect(remoteButton(page, bed.id).locator('.badge.duck')).toBeVisible();
    await request.post(`/api/cues/${voice.id}/stop`);
    await expect(remoteButton(page, bed.id)).not.toHaveClass(/ducked/);
});

test('remote: XFADE shows and switches crossfade mode', async ({ page, request }) => {
    await openRemote(page);
    const xfade = page.locator('#crossfadeButtonRemote');
    await expect(xfade).toHaveAttribute('aria-pressed', 'false');
    await xfade.click();
    await expect(xfade).toHaveClass(/enabled/);
    expect((await (await request.get('/api/remote/crossfade')).json()).enabled).toBe(true);
    await request.post('/api/remote/crossfade', { data: { enabled: false } });
    await expect(xfade).not.toHaveClass(/enabled/);
});

test('remote: Stop All follows the configured Stop All behavior (fade)', async ({ page, request }) => {
    await request.put('/api/config', { data: { defaultStopAllBehavior: 'fade_out_and_stop', defaultStopAllFadeOutTime: 2000 } });
    const cue = await createTestCue(request, { durationSec: 10 });
    await openRemote(page);
    await remoteButton(page, cue.id).click();
    await expect(remoteButton(page, cue.id)).toHaveClass(/playing/);
    await page.locator('#stopAllButtonRemote').click();
    await expect(remoteButton(page, cue.id)).toHaveClass(/fading/);
    await expect(remoteButton(page, cue.id)).not.toHaveClass(/fading|playing/, { timeout: 5000 });
});

test('remote: cues added, renamed and deleted elsewhere update live', async ({ page, request }) => {
    await openRemote(page);
    const cue = await createTestCue(request, { name: 'Live Remote' });
    await expect(remoteButton(page, cue.id)).toContainText('Live Remote');
    await request.put(`/api/cues/${cue.id}`, { data: { name: 'Live Remote 2' } });
    await expect(remoteButton(page, cue.id)).toContainText('Live Remote 2');
    await request.delete(`/api/cues/${cue.id}`);
    await expect(remoteButton(page, cue.id)).toHaveCount(0);
});

test('remote: shows a message when there are no cues', async ({ page }) => {
    await openRemote(page);
    await expect(page.locator('#cueGridRemote')).toContainText('No cues available');
});
