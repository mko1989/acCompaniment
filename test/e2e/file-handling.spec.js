/**
 * Getting audio in: the + button's file picker (one file, or several via the
 * "Multiple Files Dropped" dialog), dragging files onto the grid, onto an
 * open playlist, and onto an open single-file cue to replace its audio.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { test, expect } = require('./fixtures');
const {
    openApp, makeTestWav, createTestCue, createTestPlaylist, cueButton, getCue, engineVoices,
} = require('./helpers');

function writeWavFiles(names, durationSec = 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-files-'));
    return names.map((name) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, makeTestWav(durationSec));
        return file;
    });
}

async function pickFiles(page, files) {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#addFilesButton').click();
    await (await chooser).setFiles(files);
}

/** Dispatches a real drag-and-drop of WAV files onto the element matching `selector`. */
async function dropFiles(page, selector, names, durationSec = 1) {
    const payload = names.map((name) => ({ name, b64: makeTestWav(durationSec).toString('base64') }));
    await page.evaluate(({ selector: sel, payload: files }) => {
        const dt = new DataTransfer();
        for (const f of files) {
            const bin = atob(f.b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], f.name, { type: 'audio/wav' }));
        }
        const target = document.querySelector(sel);
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { selector, payload });
}

async function cueNames(request) {
    const { cues } = await (await request.get('/api/cues')).json();
    return cues.map((c) => c.name).sort();
}

test('+ with one file creates a cue named after the file', async ({ page, request }) => {
    await openApp(page);
    await pickFiles(page, writeWavFiles(['Solo Track.wav']));
    await expect(page.locator('.cue-button', { hasText: 'Solo Track' })).toBeVisible();
    expect(await cueNames(request)).toEqual(['Solo Track']);
});

test('+ with several files asks how to add them', async ({ page }) => {
    await openApp(page);
    await pickFiles(page, writeWavFiles(['A.wav', 'B.wav']));
    await expect(page.locator('#multipleFilesDropModal')).toBeVisible();
    await expect(page.locator('#modalAddAsSeparateCues')).toBeVisible();
    await expect(page.locator('#modalAddAsPlaylistCue')).toBeVisible();
});

test('"Add as Separate Cues" makes one cue per file', async ({ page, request }) => {
    await openApp(page);
    await pickFiles(page, writeWavFiles(['One.wav', 'Two.wav', 'Three.wav']));
    await page.locator('#modalAddAsSeparateCues').click();
    await expect(page.locator('#multipleFilesDropModal')).toBeHidden();
    await expect(page.locator('.cue-button')).toHaveCount(3);
    await expect.poll(() => cueNames(request)).toEqual(['One', 'Three', 'Two']);
});

test('"Add as Single Playlist Cue" makes one playlist containing every file', async ({ page, request }) => {
    await openApp(page);
    await pickFiles(page, writeWavFiles(['First Song.wav', 'Second Song.wav']));
    await page.locator('#modalAddAsPlaylistCue').click();
    await expect(page.locator('#multipleFilesDropModal')).toBeHidden();
    await expect(page.locator('.cue-button')).toHaveCount(1);
    const { cues } = await (await request.get('/api/cues')).json();
    expect(cues[0].type).toBe('playlist');
    expect(cues[0].playlistItems.map((i) => i.name).sort()).toEqual(['First Song', 'Second Song']);
});

test('Cancel closes the dialog without adding anything', async ({ page, request }) => {
    await openApp(page);
    await pickFiles(page, writeWavFiles(['X.wav', 'Y.wav']));
    await page.locator('#modalCancelMultipleFilesDrop').click();
    await expect(page.locator('#multipleFilesDropModal')).toBeHidden();
    await page.waitForTimeout(300);
    expect(await cueNames(request)).toEqual([]);
});

test('clicking outside the dialog closes it too', async ({ page, request }) => {
    await openApp(page);
    await pickFiles(page, writeWavFiles(['P.wav', 'Q.wav']));
    await page.locator('#multipleFilesDropModal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#multipleFilesDropModal')).toBeHidden();
    expect(await cueNames(request)).toEqual([]);
});

test('dragging a file over the window shows the drop overlay', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'x.wav', { type: 'audio/wav' }));
        document.getElementById('cueGridContainer')
            .dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('#dragOverlay')).toHaveCSS('opacity', '1');
    await page.evaluate(() => {
        document.getElementById('cueGridContainer')
            .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    });
    await expect(page.locator('#dragOverlay')).toHaveCSS('opacity', '0');
});

test('dropping one file on the grid creates a cue', async ({ page, request }) => {
    await openApp(page);
    await dropFiles(page, '#cueGridContainer', ['Dropped.wav']);
    await expect(page.locator('.cue-button', { hasText: 'Dropped' })).toBeVisible();
    expect(await cueNames(request)).toEqual(['Dropped']);
});

test('dropping several files on the grid asks how to add them', async ({ page, request }) => {
    await openApp(page);
    await dropFiles(page, '#cueGridContainer', ['D1.wav', 'D2.wav']);
    await expect(page.locator('#multipleFilesDropModal')).toBeVisible();
    await page.locator('#modalAddAsSeparateCues').click();
    await expect.poll(() => cueNames(request)).toEqual(['D1', 'D2']);
});

test('dropping files on an open playlist\'s item list adds them to it', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 1 });
    await openApp(page);
    await cueButton(page, list.id).click();
    await expect(page.locator('#propPlaylistItems li.playlist-item')).toHaveCount(1);
    await dropFiles(page, '#propPlaylistItems', ['Added A.wav', 'Added B.wav']);
    await expect(page.locator('#propPlaylistItems li.playlist-item')).toHaveCount(3);
    await expect.poll(async () => (await getCue(request, list.id)).playlistItems.length).toBe(3);
});

test('dropping a file on an open single-file cue replaces its audio', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Replace My Audio', durationSec: 2 });
    const before = await getCue(request, cue.id);
    await openApp(page);
    await cueButton(page, cue.id).click();
    await dropFiles(page, '#propertiesSidebar .sidebar-content', ['Replacement.wav'], 3);
    await expect.poll(async () => (await getCue(request, cue.id)).audioFileId, { timeout: 5000 }).not.toBe(before.audioFileId);
    const after = await getCue(request, cue.id);
    expect(after.relativePath).toContain('Replacement');
    expect(after.knownDuration).toBeCloseTo(3, 0);
    await expect(page.locator('#propFilePath')).toHaveValue(/Replacement/);

    // And it's the new (3s) file that plays, not the old (2s) one.
    await request.post(`/api/cues/${cue.id}/trigger`);
    await expect.poll(async () => (await engineVoices(request, cue.id))[0]?.trimEndSec).toBeCloseTo(3, 1);
});

// --- The "drop audio files here" overlay always goes away on drop ----------

async function expectOverlayHidden(page) {
    await expect(page.locator('#dragOverlay')).toHaveCSS('opacity', '0');
}

test('dropping a file on a cue button adds it and hides the overlay', async ({ page, request }) => {
    const cue = await createTestCue(request, { name: 'Existing' });
    await openApp(page);
    await dropFiles(page, `.cue-button[data-cue-id="${cue.id}"]`, ['On A Cue.wav']);
    await expectOverlayHidden(page);
    await expect.poll(() => cueNames(request)).toEqual(['Existing', 'On A Cue']);
});

test('dropping a file between cues in the grid adds it and hides the overlay', async ({ page, request }) => {
    await createTestCue(request, { name: 'Existing' });
    await openApp(page);
    await dropFiles(page, '#cueGridContainer', ['On The Grid.wav']);
    await expectOverlayHidden(page);
    await expect.poll(() => cueNames(request)).toEqual(['Existing', 'On The Grid']);
});

test('dropping files on a playlist\'s item list hides the overlay', async ({ page, request }) => {
    const list = await createTestPlaylist(request, { itemCount: 1 });
    await openApp(page);
    await cueButton(page, list.id).click();
    await dropFiles(page, '#propPlaylistItems', ['Into List.wav']);
    await expect(page.locator('#propPlaylistItems li.playlist-item')).toHaveCount(2);
    await expectOverlayHidden(page);
});

test('a file drag that leaves the window or is cancelled hides the overlay', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'x.wav', { type: 'audio/wav' }));
        document.getElementById('cueGridContainer')
            .dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('#dragOverlay')).toHaveCSS('opacity', '1');
    // Chrome reports a drag leaving the window (or Esc) as a dragleave with
    // no relatedTarget at its last position.
    await page.evaluate(() => {
        document.getElementById('cueGridContainer')
            .dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: null }));
    });
    await expectOverlayHidden(page);
});
