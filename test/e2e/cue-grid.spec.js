/**
 * Cue buttons: what they show (name, duration, time counting, retrigger
 * badge) and every playback state they can be in - playing, paused,
 * fading in/out, cued, ducked, several instances - plus playlist
 * navigation arrows and drag-to-reorder.
 */

const { test, expect } = require('./fixtures');
const {
    createTestCue, createTestPlaylist, openApp, enterShowMode, cueButton, getCue, engineVoices,
} = require('./helpers');

test('a cue button shows its name and duration', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Named Cue', durationSec: 4 });
    await openApp(page);
    const button = cueButton(page, cue.id);
    await expect(button.locator('.cue-button-main-name')).toHaveText('Named Cue');
    await expect(button.locator('.cue-time-total')).toHaveText(/0:04/);
});

test('the time display counts up while a cue plays and resets after it stops', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const current = cueButton(page, cue.id).locator('.cue-time-current');
    await cueButton(page, cue.id).click();
    await expect(current).toHaveText(/0?0:0[1-9]/, { timeout: 4000 });
    await expect(cueButton(page, cue.id).locator('.cue-time-remaining')).toHaveText(/^-0?0:0\d/);
    await page.locator('#stopAllButton').click();
    await expect(cueButton(page, cue.id)).not.toHaveClass(/playing/);
    await expect(current).toHaveText(/0:00/);
});

const BADGES = [
    ['restart', '↻', 'Restart', 'restart'],
    ['toggle_pause_play', '⏯', 'Toggle Pause/Play', 'pause-resume'],
    ['stop', '■', 'Stop', 'stop'],
    ['fade_out_and_stop', '⤵', 'Fade Out and Stop', 'fade-stop'],
    ['do_nothing', '–', 'Do Nothing', 'do-nothing'],
    ['play_new_instance', '+', 'Play New Instance', 'new-instance'],
    ['replay_current_item', '⟲', 'Replay Current Item', 'replay'],
    ['play_next_item', '⏭', 'Play Next Item', 'next-item'],
];

test('every retrigger behavior gets its own badge', async ({ page, request }) => {
    const cues = [];
    for (const [behavior] of BADGES) {
        cues.push(await createTestCue(request, { name: `Badge ${behavior}`, retriggerBehavior: behavior }));
    }
    await openApp(page);
    for (let i = 0; i < BADGES.length; i++) {
        const [, glyph, label, key] = BADGES[i];
        const badge = page.locator(`#cue-retrigger-badge-${cues[i].id}`);
        await expect(badge).toHaveText(glyph);
        await expect(badge).toHaveAttribute('title', label);
        await expect(badge).toHaveClass(new RegExp(`cue-retrigger-badge-${key}`));
    }
});

test('Toggle Pause/Play: clicking pauses (paused style), clicking again resumes', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'toggle_pause_play', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await button.click();
    await expect(button).toHaveClass(/paused/);
    await expect(button).not.toHaveClass(/playing/);
    expect((await getCue(request, cue.id)).status).toBe('paused');
    await button.click();
    await expect(button).toHaveClass(/playing/);
    expect((await getCue(request, cue.id)).status).toBe('playing');
});

test('Stop: clicking a playing cue stops it', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'stop', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await button.click();
    await expect(button).not.toHaveClass(/playing/);
});

// A human click holds the mouse down for a while; the name text under it is
// rebuilt on every playback-time update, and a click whose press target was
// replaced before release used to be dropped - so a second click on a playing
// cue did nothing. (Playwright's own click is too fast to hit this.)
test('a human-length press on a playing cue\'s name still retriggers it', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'stop', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    const pressName = async () => {
        const box = await button.locator('.cue-button-main-name').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(150);
        await page.mouse.up();
    };
    await pressName();
    await expect(button).toHaveClass(/playing/);
    await page.waitForTimeout(1000); // let several time updates redraw the name
    await pressName();
    await expect(button).not.toHaveClass(/playing/);
});

test('Restart: clicking a playing cue starts it over', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'restart', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:02/, { timeout: 5000 });
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:0[01]/);
    await expect(button).toHaveClass(/playing/);
});

test('Do Nothing: clicking a playing cue changes nothing', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'do_nothing', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:01/, { timeout: 5000 });
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:0[2-9]/, { timeout: 5000 });
    await expect(button).toHaveClass(/playing/);
});

test('Fade Out and Stop: the button shows the fade-out, then stops', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'fade_out_and_stop', fadeOutTime: 2000, durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await button.click();
    await expect(button).toHaveClass(/fading-out/);
    await expect(button).toContainText('Fading:');
    await expect(button).not.toHaveClass(/playing/, { timeout: 5000 });
    await expect(button).not.toHaveClass(/fading/);
});

test('Play New Instance: each click layers another copy, shown as ×N', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'play_new_instance', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    const badge = page.locator(`#cue-instance-badge-${cue.id}`);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await expect(badge).not.toBeVisible();

    await button.click();
    await expect(badge).toHaveText('×2');
    await expect(badge).toBeVisible();
    await button.click();
    await expect(badge).toHaveText('×3');
    expect(await engineVoices(request, cue.id)).toHaveLength(3);

    await page.locator('#stopAllButton').click();
    await expect(button).not.toHaveClass(/playing/);
    await expect(badge).not.toBeVisible();
});

test('Replay Current Item: clicking a playing cue replays it from the top', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'replay_current_item', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:02/, { timeout: 5000 });
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:0[01]/);
});

test('Play Next Item: clicking a playing playlist skips to its next item', async ({ page, request }) => {
    const cue = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 10, retriggerBehavior: 'play_next_item' });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button).toContainText('Now: Item 1');
    await button.click();
    await expect(button).toContainText('Now: Item 2');
    expect((await getCue(request, cue.id)).currentPlaylistIndex).toBe(1);
});

test('a fade-in shows on the button while the cue rises', async ({ page, request }) => {
    const cue = await createTestCue(request, { fadeInTime: 2000, durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, cue.id).click();
    await expect(cueButton(page, cue.id)).toHaveClass(/fading-in/);
    await expect(cueButton(page, cue.id)).not.toHaveClass(/fading-in/, { timeout: 5000 });
});

test('a ducked cue shows DUCK while a ducking trigger plays, and loses it after', async ({ page, request }) => {
    const bed = await createTestCue(request, { name: 'Bed', enableDucking: true, durationSec: 20 });
    const trigger = await createTestCue(request, { name: 'Voice', isDuckingTrigger: true, duckingLevel: 70, durationSec: 20 });
    await openApp(page);
    await enterShowMode(page);
    const bedButton = cueButton(page, bed.id);
    await bedButton.click();
    await expect(bedButton).toHaveClass(/playing/);
    await expect(page.locator(`#cue-duck-badge-${bed.id}`)).not.toBeVisible();

    await cueButton(page, trigger.id).click();
    await expect(bedButton).toHaveClass(/ducked/);
    await expect(page.locator(`#cue-duck-badge-${bed.id}`)).toBeVisible();
    await expect(cueButton(page, trigger.id)).not.toHaveClass(/ducked/);

    await request.post(`/api/cues/${trigger.id}/stop`);
    await expect(bedButton).not.toHaveClass(/ducked/);
    await expect(page.locator(`#cue-duck-badge-${bed.id}`)).not.toBeVisible();
});

test('crossfade mode: starting a cue shows the old one fading out and the new one fading in', async ({ page, request }) => {
    await request.put('/api/config', { data: { crossfadeTime: 2500 } });
    const a = await createTestCue(request, { name: 'Outgoing', durationSec: 20 });
    const b = await createTestCue(request, { name: 'Incoming', durationSec: 20 });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, a.id).click();
    await expect(cueButton(page, a.id)).toHaveClass(/playing/);

    await page.locator('#crossfadeToggleBtn').click();
    await expect(page.locator('#crossfadeToggleBtn')).toHaveClass(/crossfade-enabled/);
    await cueButton(page, b.id).click();
    await expect(cueButton(page, a.id)).toHaveClass(/fading-out/);
    await expect(cueButton(page, b.id)).toHaveClass(/fading-in/);
    await expect(cueButton(page, a.id)).not.toHaveClass(/playing/, { timeout: 6000 });
    await expect(cueButton(page, b.id)).toHaveClass(/playing/);
});

test('a playlist button shows the item playing now and the one coming next', async ({ page, request }) => {
    const cue = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 10 });
    await openApp(page);
    const button = cueButton(page, cue.id);
    await expect(button).toContainText('Next: Item 1');
    await enterShowMode(page);
    await button.click();
    await expect(button).toContainText('Now: Item 1');
    await expect(button).toContainText('Next: Item 2');
});

test('playlist ◀ ▶ arrows appear for playlists with several items and change the item', async ({ page, request }) => {
    const single = await createTestPlaylist(request, { itemCount: 1, name: 'One Item' });
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 10, name: 'Three Items' });
    await openApp(page);
    const singleWrapper = page.locator('.cue-wrapper', { has: cueButton(page, single.id) });
    await expect(singleWrapper.locator('.playlist-nav-btn')).toHaveCount(0);

    const wrapper = page.locator('.cue-wrapper', { has: cueButton(page, list.id) });
    await expect(wrapper.locator('.playlist-next-btn')).toBeVisible();
    await wrapper.locator('.playlist-next-btn').click();
    await expect.poll(async () => (await getCue(request, list.id)).currentPlaylistIndex).toBe(1);
    await expect(cueButton(page, list.id)).toContainText('Next: Item 2');

    await page.waitForTimeout(250); // arrows ignore clicks closer than 200ms apart
    await wrapper.locator('.playlist-prev-btn').click();
    await expect.poll(async () => (await getCue(request, list.id)).currentPlaylistIndex).toBe(0);
});

test('▶ on a playing playlist plays the next item straight away', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, list.id).click();
    await expect(cueButton(page, list.id)).toContainText('Now: Item 1');
    await page.locator('.cue-wrapper', { has: cueButton(page, list.id) }).locator('.playlist-next-btn').click();
    await expect(cueButton(page, list.id)).toContainText('Now: Item 2');
    await expect(cueButton(page, list.id)).toHaveClass(/playing/);
});

test('"stop after item, cue next": the button shows it cued on the next item; clicking plays it', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 3, itemDurationSec: 1, playlistPlayMode: 'stop_and_cue_next' });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, list.id);
    await button.click();
    await expect(button).toHaveClass(/cued/, { timeout: 5000 });
    await expect(button).not.toHaveClass(/playing/);
    await expect(button).toContainText('Next: Item 2');

    await button.click();
    await expect(button).toHaveClass(/playing/);
    await expect(button).toContainText('Now: Item 2');
});

test('a cued playlist still shows as cued after a page reload', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 2, itemDurationSec: 1, playlistPlayMode: 'stop_and_cue_next' });
    await request.post(`/api/cues/${list.id}/trigger`);
    await expect.poll(async () => (await getCue(request, list.id)).status, { timeout: 5000 }).toBe('cued_next');
    await openApp(page);
    await expect(cueButton(page, list.id)).toHaveClass(/cued/);
});

test('a paused cue still shows as paused after a page reload', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 10 });
    await request.post(`/api/cues/${cue.id}/trigger`);
    await request.post(`/api/cues/${cue.id}/toggle-pause`);
    await openApp(page);
    await expect(cueButton(page, cue.id)).toHaveClass(/paused/);
});

test('edit mode: dragging a cue onto another reorders them, and the order is saved', async ({ page, request }) => {
    const a = await createTestCue(request, { name: 'Order A' });
    const b = await createTestCue(request, { name: 'Order B' });
    const c = await createTestCue(request, { name: 'Order C' });
    await openApp(page);
    const names = () => page.locator('.cue-button .cue-button-main-name').allTextContents();
    await expect.poll(names).toEqual(['Order A', 'Order B', 'Order C']);

    const target = page.locator('.cue-wrapper', { has: cueButton(page, a.id) });
    const box = await target.boundingBox();
    await cueButton(page, c.id).dragTo(target, { targetPosition: { x: 5, y: box.height / 2 } });

    await expect.poll(names).toEqual(['Order C', 'Order A', 'Order B']);
    await expect.poll(async () => {
        const { cues } = await (await request.get('/api/cues')).json();
        return cues.map((cue) => cue.name);
    }).toEqual(['Order C', 'Order A', 'Order B']);

    await page.reload();
    await expect.poll(names).toEqual(['Order C', 'Order A', 'Order B']);
    void b;
});

test('Play New Instance on a paused cue plays it from the top', async ({ page, request }) => {
    const cue = await createTestCue(request, { retriggerBehavior: 'play_new_instance', durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:02/, { timeout: 5000 });
    await request.post(`/api/cues/${cue.id}/toggle-pause`);
    await expect(button).toHaveClass(/paused/);

    await button.click();
    await expect(button).toHaveClass(/playing/);
    await expect(button.locator('.cue-time-current')).toHaveText(/0?0:0[01]/);
    await expect(page.locator(`#cue-instance-badge-${cue.id}`)).not.toBeVisible();
    const voices = await engineVoices(request, cue.id);
    expect(voices).toHaveLength(1);
});

test('Fade Out and Stop with a fade-out time of 0 stops instantly', async ({ page, request }) => {
    await request.put('/api/config', { data: { defaultStopAllFadeOutTime: 3000 } });
    const cue = await createTestCue(request, { retriggerBehavior: 'fade_out_and_stop', fadeOutTime: 0, durationSec: 10 });
    await openApp(page);
    await enterShowMode(page);
    const button = cueButton(page, cue.id);
    await button.click();
    await expect(button).toHaveClass(/playing/);
    await button.click();
    await expect(button).not.toHaveClass(/playing/, { timeout: 1000 });
    await expect(button).not.toHaveClass(/fading/);
});
