/**
 * The cue properties sidebar: every field saves itself to the server (there
 * is no Save button), dependent controls show and hide, playlist items can
 * be removed, the cue can be deleted - and the form keeps up with edits made
 * elsewhere without clobbering what the user is typing.
 */

const { test, expect } = require('./fixtures');
const {
    createTestCue, createTestPlaylist, openApp, cueButton, getCue, engineVoices,
} = require('./helpers');

async function openProperties(page, cueId) {
    await openApp(page);
    await cueButton(page, cueId).click();
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
    await expect(page.locator('#propCueId')).toHaveValue(cueId);
}

const saved = (request, cueId, field) => async () => (await getCue(request, cueId))[field];

test('opens with the cue\'s current values', async ({ page, request }) => {
    const cue = await createTestCue(request, {
        name: 'Loaded Values', fadeInTime: 150, fadeOutTime: 250, loop: true,
        retriggerBehavior: 'stop', volume: 0.35, enableDucking: true,
    });
    await openProperties(page, cue.id);
    await expect(page.locator('#propCueName')).toHaveValue('Loaded Values');
    await expect(page.locator('#propCueType')).toHaveValue('single_file');
    await expect(page.locator('#propFadeInTime')).toHaveValue('150');
    await expect(page.locator('#propFadeOutTime')).toHaveValue('250');
    await expect(page.locator('#propLoop')).toBeChecked();
    await expect(page.locator('#propRetriggerBehavior')).toHaveValue('stop');
    await expect(page.locator('#propVolume')).toHaveValue('0.35');
    await expect(page.locator('#propVolumeValue')).toHaveText('0.35');
    await expect(page.locator('#propEnableDucking')).toBeChecked();
    await expect(page.locator('#propIsDuckingTrigger')).not.toBeChecked();
});

test('name: typing saves it and renames the button', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Old Name' });
    await openProperties(page, cue.id);
    await page.locator('#propCueName').fill('New Name');
    await expect.poll(saved(request, cue.id, 'name')).toBe('New Name');
    await expect(cueButton(page, cue.id)).toContainText('New Name');
});

test('fade in and fade out times save', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await page.locator('#propFadeInTime').fill('400');
    await expect.poll(saved(request, cue.id, 'fadeInTime')).toBe(400);
    await page.locator('#propFadeOutTime').fill('900');
    await expect.poll(saved(request, cue.id, 'fadeOutTime')).toBe(900);
});

test('loop saves when ticked and unticked', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await page.locator('#propLoop').check();
    await expect.poll(saved(request, cue.id, 'loop')).toBe(true);
    await page.locator('#propLoop').uncheck();
    await expect.poll(saved(request, cue.id, 'loop')).toBe(false);
});

test('every retrigger option saves, and the button badge follows', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    const options = await page.locator('#propRetriggerBehavior option').evaluateAll((els) => els.map((e) => e.value));
    expect(options).toHaveLength(8);
    for (const option of options) {
        await page.locator('#propRetriggerBehavior').selectOption(option);
        await expect.poll(saved(request, cue.id, 'retriggerBehavior')).toBe(option);
    }
    await expect(page.locator(`#cue-retrigger-badge-${cue.id}`)).toHaveAttribute('title', 'Play Next Item');
});

test('volume slider updates its label and saves', async ({ page, request }) => {
    const cue = await createTestCue(request, { volume: 1 });
    await openProperties(page, cue.id);
    await page.locator('#propVolume').fill('0.4');
    await expect(page.locator('#propVolumeValue')).toHaveText('0.40');
    await expect.poll(saved(request, cue.id, 'volume')).toBe(0.4);
});

test('moving the volume slider of a playing cue changes its level right away', async ({ page, request }) => {
    const cue = await createTestCue(request, { volume: 0.9, durationSec: 20 });
    await request.post(`/api/cues/${cue.id}/trigger`);
    await openProperties(page, cue.id);
    await page.locator('#propVolume').fill('0.2');
    await expect.poll(async () => (await engineVoices(request, cue.id))[0]?.gain).toBe(0.2);
});

test('ducking: "triggers ducking" reveals the level slider; both save', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    const levelGroup = page.locator('#duckingLevelGroup');
    await expect(levelGroup).toBeHidden();

    await page.locator('#propIsDuckingTrigger').check();
    await expect(levelGroup).toBeVisible();
    await expect.poll(saved(request, cue.id, 'isDuckingTrigger')).toBe(true);

    await page.locator('#propDuckingLevel').fill('55');
    await expect(page.locator('#propDuckingLevelValue')).toHaveText('55');
    await expect.poll(saved(request, cue.id, 'duckingLevel')).toBe(55);

    await page.locator('#propIsDuckingTrigger').uncheck();
    await expect(levelGroup).toBeHidden();
    await expect.poll(saved(request, cue.id, 'isDuckingTrigger')).toBe(false);
});

test('ducking: "enable ducking for this cue" saves', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await page.locator('#propEnableDucking').check();
    await expect.poll(saved(request, cue.id, 'enableDucking')).toBe(true);
    await page.locator('#propEnableDucking').uncheck();
    await expect.poll(saved(request, cue.id, 'enableDucking')).toBe(false);
});

test('output channel routing is hidden on a 2-channel output', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await expect(page.locator('#propOutputPatchGroup')).toBeHidden();
});

test('switching type to playlist shows the playlist settings and hides the file/waveform', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await expect(page.locator('#propPlaylistConfig')).toBeHidden();
    await expect(page.locator('#propSingleFileConfig')).toBeVisible();
    await page.locator('#propCueType').selectOption('playlist');
    await expect(page.locator('#propPlaylistConfig')).toBeVisible();
    await expect(page.locator('#propSingleFileConfig')).toBeHidden();
});

test('playlist: lists its items with names and durations', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 2 });
    await openProperties(page, list.id);
    const items = page.locator('#propPlaylistItems li.playlist-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).locator('.playlist-item-name')).toHaveText('Item 1');
    await expect(items.nth(2).locator('.playlist-item-name')).toHaveText('Item 3');
    await expect(items.nth(0).locator('.playlist-item-duration')).toContainText('0:02');
});

test('playlist: shuffle and repeat-current-item save under the names playback uses', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2 });
    await openProperties(page, list.id);
    await page.locator('#propShufflePlaylist').check();
    await expect.poll(saved(request, list.id, 'shufflePlaylist')).toBe(true);
    await page.locator('#propRepeatOnePlaylistItem').check();
    await expect.poll(saved(request, list.id, 'repeatOnePlaylistItem')).toBe(true);

    await page.reload();
    await page.waitForFunction(() => window.ui?.isUIFullyInitialized?.());
    await cueButton(page, list.id).click();
    await expect(page.locator('#propShufflePlaylist')).toBeChecked();
    await expect(page.locator('#propRepeatOnePlaylistItem')).toBeChecked();
});

test('playlist: advance behavior saves', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2 });
    await openProperties(page, list.id);
    await page.locator('#propPlaylistPlayModeSelect').selectOption('stop_and_cue_next');
    await expect.poll(saved(request, list.id, 'playlistPlayMode')).toBe('stop_and_cue_next');
    await page.locator('#propPlaylistPlayModeSelect').selectOption('continue');
    await expect.poll(saved(request, list.id, 'playlistPlayMode')).toBe('continue');
});

test('playlist: ✕ removes an item from the list and from the saved cue', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3 });
    await openProperties(page, list.id);
    const items = page.locator('#propPlaylistItems li.playlist-item');
    await items.nth(1).locator('.remove-playlist-item-btn').click();
    await expect(items).toHaveCount(2);
    await expect(items.nth(1).locator('.playlist-item-name')).toHaveText('Item 3');
    await expect.poll(async () => (await getCue(request, list.id)).playlistItems.map((i) => i.name)).toEqual(['Item 1', 'Item 3']);
});

test('playlist: the item playing is highlighted in the list, and follows the playlist', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 10 });
    await openProperties(page, list.id);
    await request.post(`/api/cues/${list.id}/trigger`);
    const items = page.locator('#propPlaylistItems li.playlist-item');
    await expect(items.nth(0)).toHaveClass(/playlist-item-playing/);
    await request.post(`/api/cues/${list.id}/playlist/navigate`, { data: { direction: 'next' } });
    await expect(items.nth(1)).toHaveClass(/playlist-item-playing/);
    await expect(items.nth(0)).not.toHaveClass(/playlist-item-playing/);
    await request.post(`/api/cues/${list.id}/stop`);
    await expect(page.locator('#propPlaylistItems .playlist-item-playing')).toHaveCount(0);
});

test('delete asks for confirmation; cancelling keeps the cue', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Keep Me' });
    await openProperties(page, cue.id);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#deleteCuePropertiesButton').click();
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
    expect(await getCue(request, cue.id)).toBeTruthy();
});

test('delete, confirmed, removes the cue and closes the sidebar', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Delete Me' });
    await openProperties(page, cue.id);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#deleteCuePropertiesButton').click();
    await expect(page.locator('#propertiesSidebar')).toHaveClass(/hidden/);
    await expect(cueButton(page, cue.id)).toHaveCount(0);
    expect((await request.get(`/api/cues/${cue.id}`)).status()).toBe(404);
});

test('deleting a playing cue stops it', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 20 });
    await request.post(`/api/cues/${cue.id}/trigger`);
    await openProperties(page, cue.id);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#deleteCuePropertiesButton').click();
    await expect.poll(async () => (await engineVoices(request, cue.id)).length).toBe(0);
});

test('the × button closes the sidebar', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await page.locator('#closePropertiesSidebarBtn').click();
    await expect(page.locator('#propertiesSidebar')).toHaveClass(/hidden/);
});

test('Preview plays locally in the browser only - the cue does not start on the server', async ({ page, request }) => {
    const cue = await createTestCue(request);
    await openProperties(page, cue.id);
    await page.locator('#previewCueButton').click();
    await page.waitForTimeout(500);
    expect((await getCue(request, cue.id)).status).not.toBe('playing');
    expect(await engineVoices(request, cue.id)).toHaveLength(0);
    await page.evaluate(() => window.audioController.stopPreview());
});

test('an edit made elsewhere to the open cue shows up in the form', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Original', fadeInTime: 0 });
    await openProperties(page, cue.id);
    await request.put(`/api/cues/${cue.id}`, { data: { name: 'Renamed Elsewhere', fadeInTime: 700 } });
    await expect(page.locator('#propCueName')).toHaveValue('Renamed Elsewhere');
    await expect(page.locator('#propFadeInTime')).toHaveValue('700');
});

test('what the user is typing survives other cues being updated meanwhile', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Typing Target' });
    const other = await createTestCue(request, { name: 'Other Cue' });
    await openProperties(page, cue.id);
    const name = page.locator('#propCueName');
    await name.fill('Half-typ');
    for (let i = 0; i < 3; i++) {
        await request.put(`/api/cues/${other.id}`, { data: { name: `Other ${i}` } });
    }
    await name.press('End');
    await name.pressSequentially('ed name');
    await expect(name).toHaveValue('Half-typed name');
    await expect.poll(saved(request, cue.id, 'name')).toBe('Half-typed name');
});

test('the form is not reset while a playlist plays (no reload on every advance)', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 0.8, name: 'Advancing' });
    await openProperties(page, list.id);
    // List items are re-created whenever the form is re-populated, so a
    // marker on one survives only if the form was left alone.
    await page.evaluate(() => { document.querySelector('#propPlaylistItems li.playlist-item').dataset.marker = 'untouched'; });
    await request.post(`/api/cues/${list.id}/trigger`);
    await expect.poll(async () => (await getCue(request, list.id)).currentPlaylistIndex, { timeout: 4000 }).toBe(2);
    await expect(page.locator('#propPlaylistItems li.playlist-item[data-marker="untouched"]')).toHaveCount(1);
    await expect(page.locator('#propCueName')).toHaveValue('Advancing');
});

test('switching a cue to playlist makes its file the first item, and saves', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Becomes A List' });
    const { audioFileId } = await getCue(request, cue.id);
    await openProperties(page, cue.id);
    await page.locator('#propCueType').selectOption('playlist');
    const items = page.locator('#propPlaylistItems li.playlist-item');
    await expect(items).toHaveCount(1);
    await expect(items.nth(0).locator('.playlist-item-name')).toHaveText('Becomes A List');
    await expect.poll(saved(request, cue.id, 'type')).toBe('playlist');
    const after = await getCue(request, cue.id);
    expect(after.playlistItems.map((i) => i.audioFileId)).toEqual([audioFileId]);

    // Back to single file and to playlist again: still just the one item.
    await page.locator('#propCueType').selectOption('single_file');
    await expect.poll(saved(request, cue.id, 'type')).toBe('single_file');
    await page.locator('#propCueType').selectOption('playlist');
    await expect.poll(saved(request, cue.id, 'type')).toBe('playlist');
    await expect(items).toHaveCount(1);
    expect((await getCue(request, cue.id)).playlistItems).toHaveLength(1);
});
