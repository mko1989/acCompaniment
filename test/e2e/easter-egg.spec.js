/**
 * The Ctrl+Alt+P easter egg (README-documented feature, restored in
 * FIX_PLAN.md G6): opens the self-contained game at
 * /easter_egg_game/game.html in a new window/tab.
 */

const { test, expect } = require('@playwright/test');

test('Ctrl+Alt+P opens the easter egg game in a new window', async ({ page, context }) => {
    await page.goto('/');

    const popupPromise = context.waitForEvent('page');
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press('KeyP');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');

    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toContain('/easter_egg_game/game.html');
    await expect(popup.locator('#gameCanvas')).toBeVisible();
});
