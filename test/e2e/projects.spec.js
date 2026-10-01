/**
 * Projects in the settings sidebar: the project name at the top (saved as
 * you type), and New Project / Load Project / Download Bundle / Import
 * Bundle at the bottom.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { test, expect } = require('./fixtures');
const {
    openApp, createTestCue, cueButton, enterShowMode,
} = require('./helpers');

async function openSettings(page) {
    await openApp(page);
    await page.locator('#configToggleBtn').click();
    await expect(page.locator('#configSidebar')).toHaveClass(/expanded/);
}

const currentProject = async (request) => (await (await request.get('/api/projects/current')).json()).project;
const nameInput = (page) => page.locator('#projectNameInput');

async function rename(request, name) {
    await request.put('/api/projects/current', { data: { name } });
}

test('the project name sits at the top of the settings, the project buttons at the bottom', async ({ page, request }) => {
    await rename(request, 'Layout Check');
    await openSettings(page);
    await expect(nameInput(page)).toHaveValue('Layout Check');
    const nameBox = await nameInput(page).boundingBox();
    const headingBox = await page.locator('#configSidebar h2', { hasText: 'App Configuration' }).boundingBox();
    expect(nameBox.y).toBeLessThan(headingBox.y);

    const remoteBox = await page.locator('#httpRemoteLinksGroup').boundingBox();
    for (const id of ['newProjectButton', 'loadProjectButton', 'downloadBundleButton', 'importBundleButton']) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.y, id).toBeGreaterThan(remoteBox.y);
    }
    await expect(page.locator('#configSidebar button', { hasText: /^Save/ })).toHaveCount(0);
});

test('typing a project name saves it - no Save button', async ({ page, request }) => {
    await openSettings(page);
    await nameInput(page).fill('Saturday Matinee');
    await expect.poll(async () => (await currentProject(request)).name).toBe('Saturday Matinee');
});

test('renaming does not reset the rest of the screen', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Still Open' });
    await openSettings(page);
    await cueButton(page, cue.id).click();
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
    await nameInput(page).fill('Renamed While Editing');
    await expect.poll(async () => (await currentProject(request)).name).toBe('Renamed While Editing');
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
    await expect(page.locator('#propCueName')).toHaveValue('Still Open');
});

test('clearing the name and leaving the field puts the saved name back', async ({ page, request }) => {
    await rename(request, 'Keep This Name');
    await openSettings(page);
    await nameInput(page).fill('');
    await nameInput(page).press('Tab');
    await expect(nameInput(page)).toHaveValue('Keep This Name');
    expect((await currentProject(request)).name).toBe('Keep This Name');
});

test('a rename made on another page shows up here', async ({ page, request }) => {
    await openSettings(page);
    await rename(request, 'Renamed Elsewhere');
    await expect(nameInput(page)).toHaveValue('Renamed Elsewhere');
});

test('New Project starts an empty project, ready to be named; the old one is kept', async ({ page, request }) => {
    await rename(request, 'Before New');
    const previous = await currentProject(request);
    const cue = await createTestCue(request, { name: 'Belongs To Before' });
    await openSettings(page);
    await expect(cueButton(page, cue.id)).toBeVisible();

    await page.locator('#newProjectButton').click();
    await expect(page.locator('.cue-button')).toHaveCount(0);
    await expect(page.locator('.empty-state-message')).toBeVisible();
    await expect(nameInput(page)).toHaveValue('Untitled Project');
    await expect(nameInput(page)).toBeFocused();
    await page.keyboard.type('Sunday Show');
    await expect.poll(async () => (await currentProject(request)).name).toBe('Sunday Show');
    expect((await currentProject(request)).id).not.toBe(previous.id);

    const { projects } = await (await request.get('/api/projects')).json();
    expect(projects.find((p) => p.id === previous.id).cueCount).toBeGreaterThan(0);
});

test('New Project stops anything playing', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 10 });
    await openSettings(page);
    await enterShowMode(page);
    await cueButton(page, cue.id).click();
    await expect(cueButton(page, cue.id)).toHaveClass(/playing/);
    await page.locator('#newProjectButton').click();
    await expect(page.locator('.cue-button')).toHaveCount(0);
    const { status } = await (await request.get('/api/cues/status/playback')).json();
    expect(status.voices).toEqual([]);
});

test('Load Project lists projects, marks the open one, and opens another', async ({ page, request }) => {
    await rename(request, 'Loader Target');
    const target = await currentProject(request);
    const targetCue = await createTestCue(request, { name: 'Target Cue' });
    await request.post('/api/projects', { data: { name: 'Loader Current' } });

    await openSettings(page);
    await page.locator('#loadProjectButton').click();
    const dialog = page.locator('#loadProjectModal');
    await expect(dialog).toBeVisible();

    const currentRow = dialog.locator('li.current');
    await expect(currentRow).toContainText('Loader Current');
    await expect(currentRow).toContainText('open now');
    await expect(currentRow.locator('.project-open-btn')).toBeDisabled();
    await expect(currentRow.locator('.project-delete-btn')).toHaveCount(0);

    const targetRow = dialog.locator(`li[data-project-id="${target.id}"]`);
    await expect(targetRow).toContainText('Loader Target');
    // Layout: the name is readable and the buttons are compact (a generic
    // modal rule once stretched them over the whole row, hiding the name).
    await expect(targetRow.locator('.project-name')).toBeVisible();
    const rowBox = await targetRow.boundingBox();
    const openBox = await targetRow.locator('.project-open-btn').boundingBox();
    const nameBox = await targetRow.locator('.project-name').boundingBox();
    expect(openBox.width).toBeLessThan(rowBox.width / 3);
    expect(nameBox.width).toBeGreaterThan(rowBox.width / 3);
    await expect(targetRow).toContainText('1 cue');
    await targetRow.locator('.project-open-btn').click();

    await expect(dialog).toBeHidden();
    await expect(cueButton(page, targetCue.id)).toBeVisible();
    await expect(nameInput(page)).toHaveValue('Loader Target');
});

test('Load Project can delete a saved project, after asking', async ({ page, request }) => {
    await request.post('/api/projects', { data: { name: 'Delete From Dialog' } });
    const doomed = await currentProject(request);
    await request.post('/api/projects', { data: { name: 'Stays Open' } });

    await openSettings(page);
    await page.locator('#loadProjectButton').click();
    const row = page.locator(`#projectList li[data-project-id="${doomed.id}"]`);

    page.once('dialog', (d) => d.dismiss());
    await row.locator('.project-delete-btn').click();
    await expect(row).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await row.locator('.project-delete-btn').click();
    await expect(row).toHaveCount(0);
    const { projects } = await (await request.get('/api/projects')).json();
    expect(projects.find((p) => p.id === doomed.id)).toBeUndefined();
});

test('the Load Project dialog closes with × and by clicking outside it', async ({ page }) => {
    await openSettings(page);
    await page.locator('#loadProjectButton').click();
    await page.locator('#closeLoadProjectModal').click();
    await expect(page.locator('#loadProjectModal')).toBeHidden();
    await page.locator('#loadProjectButton').click();
    await page.locator('#loadProjectModal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#loadProjectModal')).toBeHidden();
});

test('Download Bundle, then Import Bundle, gives back the same show', async ({ page, request }) => {
    await request.post('/api/projects', { data: { name: 'Bundle Roundtrip' } });
    const cueA = await createTestCue(request, { name: 'Roundtrip A', durationSec: 1 });
    const cueB = await createTestCue(request, { name: 'Roundtrip B', durationSec: 2, loop: true });
    await openSettings(page);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadBundleButton').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Bundle Roundtrip.zip');
    const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-bundle-')), download.suggestedFilename());
    await download.saveAs(saved);
    expect(fs.statSync(saved).size).toBeGreaterThan(1000);

    await page.locator('#newProjectButton').click();
    await expect(page.locator('.cue-button')).toHaveCount(0);

    const chooser = page.waitForEvent('filechooser');
    await page.locator('#importBundleButton').click();
    await (await chooser).setFiles(saved);
    await expect(page.locator('#projectStatus')).toContainText('Imported "Bundle Roundtrip"');
    await expect(page.locator('#projectStatus')).toContainText('already here');
    await expect(cueButton(page, cueA.id)).toContainText('Roundtrip A');
    await expect(cueButton(page, cueB.id)).toContainText('Roundtrip B');
    await expect(nameInput(page)).toHaveValue('Bundle Roundtrip');
    const { cues } = await (await request.get('/api/cues')).json();
    expect(cues.find((c) => c.id === cueB.id).loop).toBe(true);
});

test('importing something that is not a bundle says so', async ({ page }) => {
    await openSettings(page);
    const bogus = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-bogus-')), 'not-a-bundle.zip');
    fs.writeFileSync(bogus, 'definitely not a zip');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#importBundleButton').click();
    await (await chooser).setFiles(bogus);
    await expect(page.locator('#projectStatus')).toContainText('Import failed');
    await expect(page.locator('#importBundleButton')).toBeEnabled();
});

test('another open page follows a project switch', async ({ page, context, request }) => {
    const cue = await createTestCue(request, { name: 'Other Page Cue' });
    await openSettings(page);
    const other = await context.newPage();
    await openApp(other);
    await expect(cueButton(other, cue.id)).toBeVisible();

    await page.locator('#newProjectButton').click();
    await expect(other.locator('.cue-button')).toHaveCount(0);
    await other.locator('#configToggleBtn').click();
    await expect(other.locator('#projectNameInput')).toHaveValue('Untitled Project');
});

test('the project name is the same size as the other settings fields', async ({ page }) => {
    await openSettings(page);
    const size = (selector) => page.locator(selector).evaluate((el) => getComputedStyle(el).fontSize);
    expect(await size('#projectNameInput')).toBe(await size('#defaultFadeIn'));
});
