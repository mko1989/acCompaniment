/**
 * The waveform editor in the properties sidebar (and its expanded bottom
 * panel): it loads the cue's audio, clicking seeks, Set Start / Set End save
 * trim points that playback then honours, Clear removes them, and the local
 * play/pause/stop controls work.
 */

const { test, expect } = require('./fixtures');
const {
    createTestCue, openApp, cueButton, getCue, engineVoices,
} = require('./helpers');

const DURATION = 4;

async function openWaveform(page, request, overrides = {}) {
    const cue = await createTestCue(request, { durationSec: DURATION, ...overrides });
    await openApp(page);
    await cueButton(page, cue.id).click();
    await expect(page.locator('#wfTotalDuration')).toHaveText(/0:04\.0\d\d/, { timeout: 10000 });
    return cue;
}

/**
 * Clicks the waveform at a fraction (0-1) of its width, i.e. seeks there.
 * Waits for the layout to settle first - the sidebar and bottom panel slide
 * in, and a box measured mid-animation puts the click in the wrong place.
 */
async function clickAt(page, fraction, container = '#waveformDisplay') {
    const locator = page.locator(container);
    let box = await locator.boundingBox();
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(50);
        const next = await locator.boundingBox();
        if (next && box && next.x === box.x && next.width === box.width && next.y === box.y) break;
        box = next;
    }
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
}

function secondsOf(text) {
    const [m, s] = text.split(':');
    return Number(m) * 60 + Number(s);
}

test('loads the waveform and total duration for a single-file cue', async ({ page, request }) => {
    await openWaveform(page, request);
    await expect(page.locator('#waveformDisplay canvas, #waveformDisplay wave').first()).toBeVisible();
    await expect(page.locator('#wfCurrentTime')).toHaveText('0:00.000');
});

test('clicking the waveform moves the playhead there', async ({ page, request }) => {
    await openWaveform(page, request);
    await clickAt(page, 0.5);
    await expect.poll(async () => secondsOf(await page.locator('#wfCurrentTime').innerText())).toBeGreaterThan(1.6);
    expect(secondsOf(await page.locator('#wfCurrentTime').innerText())).toBeLessThan(2.4);
});

test('Set Start and Set End save trim points at the playhead', async ({ page, request }) => {
    const cue = await openWaveform(page, request);
    await clickAt(page, 0.25);
    await page.locator('#wfSetStartBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimStartTime).toBeGreaterThan(0.7);
    expect((await getCue(request, cue.id)).trimStartTime).toBeLessThan(1.3);

    await clickAt(page, 0.75);
    await page.locator('#wfSetEndBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimEndTime ?? 0).toBeGreaterThan(2.7);
    expect((await getCue(request, cue.id)).trimEndTime).toBeLessThan(3.3);
});

test('playback honours trim points set in the waveform', async ({ page, request }) => {
    const cue = await openWaveform(page, request);
    await clickAt(page, 0.5);
    await page.locator('#wfSetStartBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimStartTime).toBeGreaterThan(1.5);
    const { trimStartTime } = await getCue(request, cue.id);

    await request.post(`/api/cues/${cue.id}/trigger`);
    const [voice] = await engineVoices(request, cue.id);
    expect(voice.trimStartSec).toBeCloseTo(trimStartTime, 1);
});

test('the cue button shows the trimmed length', async ({ page, request }) => {
    const cue = await openWaveform(page, request);
    await clickAt(page, 0.6); // ~2.4s: clear of the 2s boundary the display rounds down across
    await page.locator('#wfSetEndBtn').click();
    await expect(cueButton(page, cue.id).locator('.cue-time-total')).toHaveText(/0:02/);
});

test('Clear removes both trim points', async ({ page, request }) => {
    const cue = await openWaveform(page, request, { trimStartTime: 1, trimEndTime: 3 });
    await page.locator('#wfClearTrimBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimStartTime).toBe(0);
    expect((await getCue(request, cue.id)).trimEndTime || null).toBeNull();
});

test('play/pause previews locally and swaps its icon; stop returns to the start', async ({ page, request }) => {
    const cue = await openWaveform(page, request);
    const icon = page.locator('#wfPlayPauseBtn img');
    await expect(icon).toHaveAttribute('src', /play\.png/);
    await page.locator('#wfPlayPauseBtn').click();
    await expect(icon).toHaveAttribute('src', /pause\.png/);
    await expect.poll(async () => secondsOf(await page.locator('#wfCurrentTime').innerText())).toBeGreaterThan(0.2);
    // Local preview only - the cue itself is not playing on the server.
    expect(await engineVoices(request, cue.id)).toHaveLength(0);

    await page.locator('#wfPlayPauseBtn').click();
    await expect(icon).toHaveAttribute('src', /play\.png/);

    await page.locator('#wfStopBtn').click();
    await expect(page.locator('#wfCurrentTime')).toHaveText('0:00.000');
});

test('the expand button opens the bottom editor, and × closes it', async ({ page, request }) => {
    await openWaveform(page, request);
    const panel = page.locator('#bottomWaveformPanel');
    await expect(panel).not.toHaveClass(/expanded/);
    await page.locator('#expandWaveformBtn').click();
    await expect(panel).toHaveClass(/expanded/);
    await expect(page.locator('#expandedWfTotalDuration')).toHaveText(/0:04\.0\d\d/, { timeout: 10000 });
    await page.locator('#collapseBottomPanelBtn').click();
    await expect(panel).not.toHaveClass(/expanded/);
});

test('the expanded editor\'s Set Start / Set End save trim points too', async ({ page, request }) => {
    const cue = await openWaveform(page, request);
    await page.locator('#expandWaveformBtn').click();
    await expect(page.locator('#expandedWfTotalDuration')).toHaveText(/0:04\.0\d\d/, { timeout: 10000 });
    await clickAt(page, 0.5, '#expandedWaveformDisplay');
    await page.locator('#expandedWfSetStartBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimStartTime).toBeGreaterThan(1.5);
    await clickAt(page, 0.75, '#expandedWaveformDisplay');
    await page.locator('#expandedWfSetEndBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimEndTime ?? 0).toBeGreaterThan(2.5);
    await page.locator('#expandedWfClearTrimBtn').click();
    await expect.poll(async () => (await getCue(request, cue.id)).trimStartTime).toBe(0);
});

test('reopening a trimmed cue shows its trim region again', async ({ page, request }) => {
    await openWaveform(page, request, { trimStartTime: 1, trimEndTime: 3 });
    // WaveSurfer v7 renders regions in its shadow DOM, marked part="region".
    await expect(page.locator('#waveformDisplay [part~="region"]').first()).toBeAttached();
});

test('dragging the trim region saves the moved trim points', async ({ page, request }) => {
    // Region drags are reported by WaveSurfer v7's Regions plugin; the editor
    // used to listen for them on the WaveSurfer instance, so they never saved.
    const cue = await openWaveform(page, request, { trimStartTime: 1, trimEndTime: 3 });
    const region = page.locator('#waveformDisplay [part~="region"]').first();
    await expect(region).toBeAttached();
    const container = await page.locator('#waveformDisplay').boundingBox();
    const box = await region.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + container.width * 0.1, y, { steps: 10 });
    await page.mouse.up();
    // The waveform is drawn wider than its visible box (it scrolls), so
    // pixels don't map 1:1 onto the container - check direction, not size.
    await expect.poll(async () => (await getCue(request, cue.id)).trimStartTime).toBeGreaterThan(1.05);
    const moved = await getCue(request, cue.id);
    expect(moved.trimEndTime - moved.trimStartTime).toBeCloseTo(2, 1);
});

async function playheadSeconds(page) {
    return secondsOf(await page.locator('#wfCurrentTime').innerText());
}

test('keyboard: → / ← move the playhead 1s; Home and End jump to the ends', async ({ page, request }) => {
    await openWaveform(page, request);
    await page.locator('#propertiesSidebar h2').click(); // focus away from form fields
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => playheadSeconds(page)).toBeCloseTo(2, 1);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => playheadSeconds(page)).toBeCloseTo(1, 1);
    await page.keyboard.press('End');
    await expect.poll(() => playheadSeconds(page)).toBeCloseTo(DURATION, 1);
    await page.keyboard.press('Home');
    await expect.poll(() => playheadSeconds(page)).toBe(0);
});

test('keyboard: Shift+→ moves 10ms and Ctrl+→ moves 100ms, as the hints say', async ({ page, request }) => {
    await openWaveform(page, request);
    await page.locator('#propertiesSidebar h2').click();
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => playheadSeconds(page)).toBeCloseTo(0.01, 2);
    await page.keyboard.press('Control+ArrowRight');
    await expect.poll(() => playheadSeconds(page)).toBeCloseTo(0.11, 2);
});

test('keyboard: Space plays and pauses the local preview', async ({ page, request }) => {
    await openWaveform(page, request);
    await page.locator('#propertiesSidebar h2').click();
    const icon = page.locator('#wfPlayPauseBtn img');
    await page.keyboard.press(' ');
    await expect(icon).toHaveAttribute('src', /pause\.png/);
    await page.keyboard.press(' ');
    await expect(icon).toHaveAttribute('src', /play\.png/);
});

test('keyboard shortcuts leave text fields alone', async ({ page, request }) => {
    await openWaveform(page, request);
    await page.locator('#propCueName').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press(' ');
    await expect(page.locator('#wfCurrentTime')).toHaveText('0:00.000');
});

test('arrow keys on a focused dropdown change the dropdown, not the playhead', async ({ page, request }) => {
    await openWaveform(page, request);
    await page.locator('#propRetriggerBehavior').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await expect(page.locator('#wfCurrentTime')).toHaveText('0:00.000');
});

// --- The expanded editor shows the same trim points as the sidebar one ------

/** Where the trim region is drawn in a waveform, as % of its width (or null). */
async function trimRegionPct(page, container) {
    return page.evaluate((sel) => {
        const host = document.querySelector(sel);
        let found = null;
        const walk = (root) => root.querySelectorAll('*').forEach((el) => {
            if (!found && (el.getAttribute('part') || '').split(' ').includes('trimRegion')) found = el.getBoundingClientRect();
            if (el.shadowRoot) walk(el.shadowRoot);
        });
        walk(host);
        if (!found) return null;
        const box = host.getBoundingClientRect();
        return { start: Math.round(((found.left - box.left) / box.width) * 100), end: Math.round(((found.right - box.left) / box.width) * 100) };
    }, container);
}

async function openExpanded(page) {
    await page.locator('#expandWaveformBtn').click();
    await expect(page.locator('#expandedWfTotalDuration')).toHaveText(/0:04\.0\d\d/, { timeout: 10000 });
}

test('in/out points set in the sidebar waveform show in the expanded editor', async ({ page, request }) => {
    await openWaveform(page, request);
    await clickAt(page, 0.25);
    await page.locator('#wfSetStartBtn').click();
    await clickAt(page, 0.75);
    await page.locator('#wfSetEndBtn').click();
    await expect.poll(() => trimRegionPct(page, '#waveformDisplay')).toEqual({ start: 25, end: 75 });

    await openExpanded(page);
    await expect.poll(() => trimRegionPct(page, '#expandedWaveformDisplay')).toEqual({ start: 25, end: 75 });
});

test('in/out points set in the expanded editor show there and in the sidebar waveform', async ({ page, request }) => {
    await openWaveform(page, request);
    await openExpanded(page);
    await clickAt(page, 0.5, '#expandedWaveformDisplay');
    await page.locator('#expandedWfSetStartBtn').click();
    await expect.poll(() => trimRegionPct(page, '#expandedWaveformDisplay')).toEqual({ start: 50, end: 100 });
    await expect.poll(() => trimRegionPct(page, '#waveformDisplay')).toEqual({ start: 50, end: 100 });
});

test('closing and reopening the expanded editor keeps showing the points', async ({ page, request }) => {
    await openWaveform(page, request);
    await clickAt(page, 0.5);
    await page.locator('#wfSetStartBtn').click();
    await openExpanded(page);
    await page.locator('#collapseBottomPanelBtn').click();
    await openExpanded(page);
    await expect.poll(() => trimRegionPct(page, '#expandedWaveformDisplay')).toEqual({ start: 50, end: 100 });
});

test('points saved earlier show in the expanded editor', async ({ page, request }) => {
    await openWaveform(page, request, { trimStartTime: 1, trimEndTime: 3 });
    await openExpanded(page);
    await expect.poll(() => trimRegionPct(page, '#expandedWaveformDisplay')).toEqual({ start: 25, end: 75 });
});

test('Clear removes the points from both editors', async ({ page, request }) => {
    await openWaveform(page, request, { trimStartTime: 1, trimEndTime: 3 });
    await openExpanded(page);
    await page.locator('#expandedWfClearTrimBtn').click();
    await expect.poll(() => trimRegionPct(page, '#expandedWaveformDisplay')).toBeNull();
    await expect.poll(() => trimRegionPct(page, '#waveformDisplay')).toBeNull();
});

// --- The expanded editor follows the same playhead as the sidebar one ------

/** Where a waveform's playhead cursor is drawn, as % of its width (or null). */
async function cursorPct(page, container) {
    return page.evaluate((sel) => {
        const host = document.querySelector(sel);
        let found = null;
        const walk = (root) => root.querySelectorAll('*').forEach((el) => {
            if (!found && (el.getAttribute('part') || '').split(' ').includes('cursor')) found = el.getBoundingClientRect();
            if (el.shadowRoot) walk(el.shadowRoot);
        });
        walk(host);
        if (!found) return null;
        const box = host.getBoundingClientRect();
        return Math.round(((found.left - box.left) / box.width) * 100);
    }, container);
}

test('keyboard shortcuts move the expanded editor\'s playhead', async ({ page, request }) => {
    await openWaveform(page, request);
    await openExpanded(page);
    await page.locator('#bottomPanelCueName').click(); // focus away from form fields
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => cursorPct(page, '#expandedWaveformDisplay')).toBe(50);
    await page.keyboard.press('Control+ArrowRight');
    await expect.poll(async () => secondsOf(await page.locator('#expandedWfCurrentTime').innerText())).toBeCloseTo(2.1, 2);
    await page.keyboard.press('End');
    await expect.poll(() => cursorPct(page, '#expandedWaveformDisplay')).toBe(100);
    await page.keyboard.press('Home');
    await expect.poll(() => cursorPct(page, '#expandedWaveformDisplay')).toBe(0);
});

test('Space in the expanded editor plays the preview and moves its playhead', async ({ page, request }) => {
    await openWaveform(page, request);
    await openExpanded(page);
    await page.locator('#bottomPanelCueName').click();
    await page.keyboard.press(' ');
    await expect(page.locator('#expandedWfPlayPauseBtn img')).toHaveAttribute('src', /pause\.png/);
    await expect.poll(() => cursorPct(page, '#expandedWaveformDisplay')).toBeGreaterThan(5);
    await page.keyboard.press(' ');
    await expect(page.locator('#expandedWfPlayPauseBtn img')).toHaveAttribute('src', /play\.png/);
});

test('clicking the expanded editor moves the sidebar playhead too', async ({ page, request }) => {
    await openWaveform(page, request);
    await openExpanded(page);
    await clickAt(page, 0.5, '#expandedWaveformDisplay');
    await expect.poll(() => cursorPct(page, '#waveformDisplay')).toBe(50);
    await expect.poll(() => playheadSeconds(page)).toBeCloseTo(2, 1);
});
