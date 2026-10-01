/**
 * The shared media library in the browser: adding the same file twice
 * reuses it, and the "Replace File" button in a cue's properties swaps in a
 * new version for every cue using it.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { test, expect } = require('./fixtures');
const {
    openApp, makeTestWav, createTestCue, createTestPlaylist, cueButton, getCue,
} = require('./helpers');

function wavFile(name, seconds) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-lib-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, makeTestWav(seconds));
    return file;
}

/** Library files whose name starts with `prefix` (the library persists across tests on a worker's server). */
async function libraryFiles(request, prefix) {
    const body = await (await request.get('/api/audio')).json();
    return body.audioFiles.map((f) => f.relativePath).filter((name) => name.startsWith(prefix)).sort();
}

async function openProperties(page, cueId) {
    await openApp(page);
    await cueButton(page, cueId).click();
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
}

test('adding the same file twice makes two cues sharing one library file', async ({ page, request }) => {
    await openApp(page);
    const file = wavFile('Twice.wav', 1);
    for (let i = 0; i < 2; i++) {
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#addFilesButton').click();
        await (await chooser).setFiles(file);
        await expect(page.locator('.cue-button', { hasText: 'Twice' })).toHaveCount(i + 1);
    }
    expect(await libraryFiles(request, 'Twice')).toEqual(['Twice.wav']);
    const { cues } = await (await request.get('/api/cues')).json();
    expect(new Set(cues.map((c) => c.audioFileId)).size).toBe(1);
});

test('the Replace File button shows for single-file cues only', async ({ page, request }) => {
    const single = await createTestCue(request, { name: 'Single' });
    const list = await createTestPlaylist(request, { itemCount: 2, name: 'List' });
    await openProperties(page, single.id);
    await expect(page.locator('#replaceCueFileButton')).toBeVisible();
    await cueButton(page, list.id).click();
    await expect(page.locator('#replaceCueFileButton')).toBeHidden();
});

test('Replace File asks first; cancelling changes nothing', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 1 });
    await openProperties(page, cue.id);
    let chooserOpened = false;
    page.on('filechooser', () => { chooserOpened = true; });
    let message = '';
    page.once('dialog', (dialog) => { message = dialog.message(); dialog.dismiss(); });
    await page.locator('#replaceCueFileButton').click();
    await page.waitForTimeout(300);
    expect(message).toContain('every project');
    expect(chooserOpened).toBe(false);
    expect((await getCue(request, cue.id)).knownDuration).toBeCloseTo(1, 1);
});

test('Replace File swaps in the new version: new length on the button and in the waveform', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'To Replace', durationSec: 1 });
    await openProperties(page, cue.id);
    await expect(page.locator('#wfTotalDuration')).toHaveText(/0:01\.0\d\d/, { timeout: 10000 });

    page.once('dialog', (dialog) => dialog.accept());
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#replaceCueFileButton').click();
    await (await chooser).setFiles(wavFile('New Version.wav', 3));

    await expect(page.locator('#replaceCueFileStatus')).toContainText('Replaced with New Version.wav');
    await expect.poll(async () => (await getCue(request, cue.id)).knownDuration).toBeCloseTo(3, 1);
    await expect(cueButton(page, cue.id).locator('.cue-time-total')).toHaveText(/0:03/);
    await expect(page.locator('#wfTotalDuration')).toHaveText(/0:03\.0\d\d/, { timeout: 10000 });
    // Same library entry, same name - just new audio.
    const after = await getCue(request, cue.id);
    expect(after.audioFileId).toBe(cue.audioFileId);
    expect(after.relativePath).toBe(cue.relativePath);
});

test('Replace File also updates other cues that share the file', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Original User', durationSec: 1 });
    const sibling = (await (await request.post('/api/cues', {
        data: { name: 'Sibling', type: 'single_file', audioFileId: cue.audioFileId, relativePath: cue.relativePath, volume: 0.05 },
    })).json()).cue;
    await openProperties(page, cue.id);
    page.once('dialog', (dialog) => dialog.accept());
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#replaceCueFileButton').click();
    await (await chooser).setFiles(wavFile('Shared v2.wav', 2));
    await expect(cueButton(page, sibling.id).locator('.cue-time-total')).toHaveText(/0:02/);
});

test('a failed Replace says why and leaves the cue as it was', async ({ page, request }) => {
    const cue = await createTestCue(request, { durationSec: 1 });
    await openProperties(page, cue.id);
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-bad-')), 'broken.wav');
    fs.writeFileSync(bad, 'this is not audio');
    page.once('dialog', (dialog) => dialog.accept());
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#replaceCueFileButton').click();
    await (await chooser).setFiles(bad);
    await expect(page.locator('#replaceCueFileStatus')).toContainText('Replace failed');
    expect((await getCue(request, cue.id)).knownDuration).toBeCloseTo(1, 1);
});

test('adding a different file with a taken name keeps both, as "Name (2)"', async ({ page, request }) => {
    await openApp(page);
    for (const seconds of [1, 2]) {
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#addFilesButton').click();
        await (await chooser).setFiles(wavFile('Same Name.wav', seconds));
    }
    await expect(page.locator('.cue-button')).toHaveCount(2);
    await expect.poll(() => libraryFiles(request, 'Same Name')).toEqual(['Same Name (2).wav', 'Same Name.wav']);
});
