/**
 * Real-browser tests of Stop All in "fade out and stop" mode and the
 * button's fading state - the two reported symptoms "after clicking Stop
 * All, cues stay in playing state visually" and "there is no visual fading
 * state".
 *
 * These change server-wide config (Stop All behavior and fade time); the
 * clean-slate fixture puts it back after each test.
 */

const { test, expect } = require('./fixtures');
const { createTestCue, deleteCue } = require('./helpers');

async function setStopAll(request, behavior, fadeMs) {
    const res = await request.put('/api/config', {
        data: { defaultStopAllBehavior: behavior, defaultStopAllFadeOutTime: fadeMs },
    });
    expect((await res.json()).success).toBe(true);
}

async function playInShowMode(page, cueId) {
    await page.goto('/');
    await page.locator('#modeToggleBtn').click();
    await expect(page.locator('#appContainer')).toHaveClass(/show-mode/);
    const button = page.locator(`.cue-button[data-cue-id="${cueId}"]`);
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toHaveClass(/playing/, { timeout: 5000 });
    return button;
}

test('Stop All (fade) on a cue with no fade of its own shows a fading state, then clears "playing"', async ({ page, request }) => {
    await setStopAll(request, 'fade_out_and_stop', 2500);
    const cue = await createTestCue(request, { name: 'Stop All Fade Visual Cue', fadeOutTime: 0, durationSec: 10 });
    try {
        const button = await playInShowMode(page, cue.id);

        await page.locator('#stopAllButton').click();
        await expect(button).toHaveClass(/fading-out/, { timeout: 2000 });
        await expect(button).toContainText('Fading:');

        await expect(button).not.toHaveClass(/playing/, { timeout: 6000 });
        await expect(button).not.toHaveClass(/fading/);
        await expect(button).not.toContainText('Fading:');
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('Stop All (fade) with a Stop All fade time of 0 clears "playing" right away', async ({ page, request }) => {
    await setStopAll(request, 'fade_out_and_stop', 0);
    const cue = await createTestCue(request, { name: 'Stop All Zero Fade Cue', fadeOutTime: 0, durationSec: 10 });
    try {
        const button = await playInShowMode(page, cue.id);
        await page.locator('#stopAllButton').click();
        await expect(button).not.toHaveClass(/playing/, { timeout: 2000 });
    } finally {
        await deleteCue(request, cue.id);
    }
});

test('a cue with a fade-in shows a fading-in state while it ramps up', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Fade In Visual Cue', fadeInTime: 3000, durationSec: 10 });
    try {
        const button = await playInShowMode(page, cue.id);
        await expect(button).toHaveClass(/fading-in/, { timeout: 2000 });
        await expect(button).not.toHaveClass(/fading-in/, { timeout: 6000 });
        await expect(button).toHaveClass(/playing/);
    } finally {
        await request.post(`/api/cues/${cue.id}/stop`).catch(() => {});
        await deleteCue(request, cue.id);
    }
});

test('Esc stops everything, like the Stop All button - even while typing in a field', async ({ page, request }) => {
    await setStopAll(request, 'stop', 0);
    const cue = await createTestCue(request, { name: 'Esc Stop All Cue', durationSec: 10 });
    try {
        const button = await playInShowMode(page, cue.id);
        await page.keyboard.press('Escape');
        await expect(button).not.toHaveClass(/playing/, { timeout: 2000 });

        await button.click();
        await expect(button).toHaveClass(/playing/, { timeout: 5000 });
        await page.locator('#configToggleBtn').click();
        await page.locator('#projectNameInput').focus();
        await expect(page.locator('#projectNameInput')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(button).not.toHaveClass(/playing/, { timeout: 2000 });
    } finally {
        await deleteCue(request, cue.id);
    }
});
