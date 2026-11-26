/**
 * What a playlist does on its own, as the browser shows it: an item ends and the next one plays
 * (continue), the list ends, loops round, re-cues the same item (repeat one) or waits for the
 * next press (stop after item). Nothing here clicks between items - the server moves the
 * playlist on, and the button, the properties sidebar and the remote page have to follow.
 * Short (1 s) items keep each test a few seconds long.
 */

const { test, expect } = require('./fixtures');
const {
    createTestCue, createTestPlaylist, openApp, enterShowMode, cueButton, getCue,
} = require('./helpers');

/**
 * Records every class the button had from now on, so a test can check the playlist never
 * looked stopped between items (a flicker an `expect` poll would miss).
 */
async function watchClasses(page, cueId) {
    await page.evaluate((id) => {
        const el = document.querySelector(`.cue-button[data-cue-id="${id}"]`);
        window.__classLog = [el.className];
        new MutationObserver(() => window.__classLog.push(el.className))
            .observe(el, { attributes: true, attributeFilter: ['class'] });
    }, cueId);
}

const classLog = (page) => page.evaluate(() => window.__classLog);

async function playInShowMode(page, cueId) {
    await openApp(page);
    await enterShowMode(page);
    await watchClasses(page, cueId);
    await cueButton(page, cueId).click();
    await expect(cueButton(page, cueId)).toHaveClass(/playing/);
}

test('continue: when an item ends the next one plays by itself, the button playing throughout', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 1, playlistPlayMode: 'continue' });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button).toContainText('Now: Item 2', { timeout: 4000 });
    await expect(button).toContainText('Now: Item 3', { timeout: 4000 });
    expect((await getCue(request, list.id)).currentPlaylistIndex).toBe(2);
    // From the first click to the start of the last item it never stopped.
    const log = await classLog(page);
    const firstPlaying = log.findIndex((c) => /\bplaying\b/.test(c));
    expect(log.slice(firstPlaying).every((c) => /\bplaying\b/.test(c)), log.join('\n')).toBe(true);
});

test('continue: after the last item the playlist stops and is ready to play from Item 1', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 1, playlistPlayMode: 'continue' });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button).toContainText('Now: Item 2', { timeout: 4000 });
    await expect(button).not.toHaveClass(/playing/, { timeout: 4000 });
    await expect(button).toContainText('Next: Item 1');
    expect((await getCue(request, list.id)).currentPlaylistIndex).toBe(0);
    // A click plays it from the top again.
    await button.click();
    await expect(button).toContainText('Now: Item 1');
});

test('continue + loop: after the last item it goes on playing Item 1', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 1, playlistPlayMode: 'continue', loop: true });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button).toContainText('Now: Item 2', { timeout: 4000 });
    await expect(button).toContainText('Now: Item 1', { timeout: 4000 });
    await expect(button).toHaveClass(/playing/);
    await page.locator('#stopAllButton').click();
});

test('the playlist\'s time display starts over with each item', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 3, playlistPlayMode: 'continue' });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:02/, { timeout: 4000 });
    await expect(button).toContainText('Now: Item 2', { timeout: 4000 });
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:0[01]/);
    await page.locator('#stopAllButton').click();
});

test('stop after item: the button shows the next item cued, and a click plays it', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 1, playlistPlayMode: 'stop_and_cue_next' });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button).toHaveClass(/cued/, { timeout: 4000 });
    await expect(button).not.toHaveClass(/playing/);
    expect((await getCue(request, list.id)).currentPlaylistIndex).toBe(1);
    await button.click();
    await expect(button).toContainText('Now: Item 2');
    await expect(button).toHaveClass(/playing/);
});

test('repeat one: after the item ends the same item is cued, and a click replays it', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 1, playlistPlayMode: 'continue', repeatOnePlaylistItem: true });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button).toHaveClass(/cued/, { timeout: 4000 });
    expect((await getCue(request, list.id)).currentPlaylistIndex).toBe(0);
    await button.click();
    await expect(button).toContainText('Now: Item 1');
});

test('shuffle: Now and Next follow the order the server plays in', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 4, itemDurationSec: 1, playlistPlayMode: 'continue', shufflePlaylist: true });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    for (let step = 0; step < 3; step++) {
        const { currentPlaylistIndex: index } = await getCue(request, list.id);
        await expect(button).toContainText(`Now: Item ${index + 1}`);
        await expect.poll(async () => (await getCue(request, list.id)).currentPlaylistIndex, { timeout: 4000 }).not.toBe(index);
    }
    await page.locator('#stopAllButton').click();
});

test('Toggle Pause on a playlist: a click pauses, the next resumes, and it still goes on to the next item', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 2, playlistPlayMode: 'continue', retriggerBehavior: 'toggle_pause_play' });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await button.click();
    await expect(button).toHaveClass(/paused/);
    await page.waitForTimeout(2500); // longer than the item: paused means it doesn't end
    expect((await getCue(request, list.id)).currentPlaylistIndex).toBe(0);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await expect(button).toContainText('Now: Item 2', { timeout: 4000 });
    await page.locator('#stopAllButton').click();
});

test('Stop All in the middle of a continue playlist: stopped, and a click starts it again', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 2, playlistPlayMode: 'continue' });
    await playInShowMode(page, list.id);
    const button = cueButton(page, list.id);
    await expect(button).toContainText('Now: Item 2', { timeout: 4000 });
    await page.locator('#stopAllButton').click();
    await expect(button).not.toHaveClass(/playing/);
    await page.waitForTimeout(2500); // nothing advances once stopped
    await expect(button).not.toHaveClass(/playing/);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await page.locator('#stopAllButton').click();
});

test('the properties sidebar highlight follows the playlist as it moves on by itself', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 1, playlistPlayMode: 'continue' });
    await openApp(page);
    await cueButton(page, list.id).click(); // edit mode: opens the sidebar
    await expect(page.locator('#propCueId')).toHaveValue(list.id);
    await request.post(`/api/cues/${list.id}/trigger`);
    const items = page.locator('#propPlaylistItems li.playlist-item');
    await expect(items.nth(0)).toHaveClass(/playlist-item-playing/);
    await expect(items.nth(1)).toHaveClass(/playlist-item-playing/, { timeout: 4000 });
    await expect(items.nth(2)).toHaveClass(/playlist-item-playing/, { timeout: 4000 });
    await expect(page.locator('#propPlaylistItems .playlist-item-playing')).toHaveCount(0, { timeout: 4000 });
});

test('changing the advance behavior while a playlist plays applies when the playing item ends', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 2, playlistPlayMode: 'continue' });
    await openApp(page);
    await cueButton(page, list.id).click();
    await request.post(`/api/cues/${list.id}/trigger`);
    await page.locator('#propPlaylistPlayModeSelect').selectOption('stop_and_cue_next');
    await expect.poll(async () => (await getCue(request, list.id)).playlistPlayMode).toBe('stop_and_cue_next');
    await expect.poll(async () => (await getCue(request, list.id)).status, { timeout: 5000 }).toBe('cued_next');
    expect((await getCue(request, list.id)).currentPlaylistIndex).toBe(1);
});

test('DUCK clears when the ducking trigger ends by itself', async ({ page, request }) => {
    const bed = await createTestCue(request, { name: 'Bed', enableDucking: true, durationSec: 20 });
    const trigger = await createTestCue(request, { name: 'Voice', isDuckingTrigger: true, duckingLevel: 70, durationSec: 1 });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, bed.id).click();
    await cueButton(page, trigger.id).click();
    await expect(cueButton(page, bed.id)).toHaveClass(/ducked/);
    await expect(cueButton(page, bed.id)).not.toHaveClass(/ducked/, { timeout: 5000 });
    await expect(cueButton(page, bed.id)).toHaveClass(/playing/);
    await page.locator('#stopAllButton').click();
});

test('a ducking playlist keeps the bed ducked across its item hand-over', async ({ page, request }) => {
    const bed = await createTestCue(request, { name: 'Bed', enableDucking: true, durationSec: 20 });
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 1, playlistPlayMode: 'continue', isDuckingTrigger: true, duckingLevel: 70 });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, bed.id).click();
    await watchClasses(page, bed.id);
    await cueButton(page, list.id).click();
    await expect(cueButton(page, bed.id)).toHaveClass(/ducked/);
    await expect(cueButton(page, list.id)).toContainText('Now: Item 2', { timeout: 4000 });
    await expect(cueButton(page, bed.id)).not.toHaveClass(/ducked/, { timeout: 4000 });
    // Ducked from the first item's start to the end of the list without a gap.
    const log = await classLog(page);
    const first = log.findIndex((c) => /\bducked\b/.test(c));
    const last = log.findLastIndex((c) => /\bducked\b/.test(c));
    expect(log.slice(first, last + 1).every((c) => /\bducked\b/.test(c)), log.join('\n')).toBe(true);
    await page.locator('#stopAllButton').click();
});

test('a looping single cue stays playing past the end of its file', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 1, loop: true });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, cue.id).click();
    await expect(cueButton(page, cue.id)).toHaveClass(/playing/);
    await page.waitForTimeout(2500);
    await expect(cueButton(page, cue.id)).toHaveClass(/playing/);
    await page.locator('#stopAllButton').click();
});

test('remote page: a continue playlist stays playing across its items and goes idle at the end', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 1, playlistPlayMode: 'continue' });
    await page.goto('/remote');
    const tile = page.locator(`#cue-btn-${list.id}`);
    await expect(tile).toBeVisible();
    await tile.click();
    await expect(tile).toHaveClass(/playing/);
    await expect.poll(async () => (await getCue(request, list.id)).currentPlaylistIndex, { timeout: 4000 }).toBe(1);
    await expect(tile).toHaveClass(/playing/);
    await expect(tile).not.toHaveClass(/playing/, { timeout: 4000 });
});
