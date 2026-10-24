/**
 * The browser UI, heard: every playback control on the main page, the
 * sidebars and the remote page is clicked for real, and the loopback
 * recording (not the engine's state) says whether it did the right thing.
 * test/e2e/ checks the same controls save and display correctly; the
 * server-side behaviors themselves are covered in depth by test/audio/.
 */

const { test, expect } = require('./fixtures');
const { openApp, enterShowMode, cueButton } = require('../e2e/helpers');
const { DEFAULT_AMPLITUDE: A } = require('../audio/lib/signals');

const LONG = { band: 0, durationSec: 6.4, segmentSec: 0.2 };
const TONE = { band: 0, durationSec: 3.2 }; // 100 ms segments

async function openProperties(page, cueId) {
    await cueButton(page, cueId).click();
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);
    await expect(page.locator('#propCueId')).toHaveValue(cueId);
}

async function openConfig(page) {
    await page.locator('#configToggleBtn').click();
    await expect(page.locator('#configSidebar')).toHaveClass(/expanded/);
}

/** Types into a number field and leaves it (the sidebars save on change). */
async function setNumber(page, selector, value) {
    await page.locator(selector).fill(String(value));
    await page.locator(selector).press('Tab');
}

const savedCue = (audio, cueId, field) => async () => (await audio.request('GET', `/api/cues/${cueId}`)).cue[field];
const savedConfig = (audio, key) => async () => (await audio.request('GET', '/api/config')).config[key];

// --- Cue buttons --------------------------------------------------------------

test('show mode: clicking a cue plays it from the top; clicking again restarts it', async ({ page, audio }) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'restart' });
    await openApp(page);
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        mark('click');
        await cueButton(page, cue).click();
        await page.waitForTimeout(1000);
        mark('again');
        await cueButton(page, cue).click();
        await page.waitForTimeout(800);
    });
    const start = take.a.onset(0, { after: take.at('click') - 0.05 });
    audio.immediate(start - take.at('click'), 'click -> sound');
    expect(take.a.slotAt(0, start + 0.03)).toBeLessThanOrEqual(1);
    audio.near(take.a.level(0, start + 0.2, take.at('again') - 0.1), A, 0.006, 'level');
    const again = take.at('again');
    expect(take.a.slotAt(0, again - 0.05)).toBeGreaterThanOrEqual(8);
    expect(take.a.slotAt(0, again + 0.15)).toBeLessThanOrEqual(2);
});

test('show mode: toggle_pause_play - click pauses, click resumes where it paused', async ({ page, audio }) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'toggle_pause_play' });
    await openApp(page);
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        await cueButton(page, cue).click();
        await page.waitForTimeout(1000);
        mark('pause');
        await cueButton(page, cue).click();
        await expect(cueButton(page, cue)).toHaveClass(/paused/);
        await page.waitForTimeout(800);
        mark('resume');
        await cueButton(page, cue).click();
        await page.waitForTimeout(600);
    });
    const pause = take.at('pause');
    const resume = take.at('resume');
    audio.immediate(take.a.offset(0, { after: pause - 0.05 }) - pause, 'click -> paused');
    expect(take.a.level(0, pause + 0.15, resume - 0.05)).toBeLessThan(0.001);
    const back = take.a.onset(0, { after: resume - 0.05 });
    audio.immediate(back - resume, 'click -> resumed');
    expect(Math.abs(take.a.slotAt(0, back + 0.03) - take.a.slotAt(0, pause - 0.03))).toBeLessThanOrEqual(1);
});

test('show mode: play_new_instance - a second click layers a second copy', async ({ page, audio }) => {
    const cue = await audio.toneCue(TONE, { retriggerBehavior: 'play_new_instance' });
    await openApp(page);
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        await cueButton(page, cue).click();
        await page.waitForTimeout(1000);
        mark('again');
        await cueButton(page, cue).click();
        await page.waitForTimeout(800);
    });
    expect(take.a.voicesAt(0, take.at('again') + 0.5)).toBe(2);
});

// --- Stop All, Esc, XFADE -----------------------------------------------------

test('Stop All button and the Esc key silence everything at once', async ({ page, audio }) => {
    const a = await audio.toneCue(LONG);
    const b = await audio.toneCue({ ...LONG, band: 1 });
    await openApp(page);
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        await cueButton(page, a).click();
        await cueButton(page, b).click();
        await page.waitForTimeout(600);
        mark('button');
        await page.locator('#stopAllButton').click();
        await page.waitForTimeout(500);
        await cueButton(page, a).click();
        await page.waitForTimeout(600);
        mark('esc');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    });
    for (const band of [0, 1]) {
        audio.immediate(take.a.offset(band, { after: take.at('button') - 0.05 }) - take.at('button'), `band ${band}: Stop All`);
    }
    audio.immediate(take.a.offset(0, { after: take.at('esc') - 0.05 }) - take.at('esc'), 'Esc');
});

test('Stop All set to fade in the config sidebar fades everything over the time set there', async ({ page, audio }) => {
    const a = await audio.toneCue(LONG);
    const b = await audio.toneCue({ ...LONG, band: 1 }, { volume: 0.5 });
    await openApp(page);
    await openConfig(page);
    await page.locator('#defaultStopAllBehavior').selectOption('fade_out_and_stop');
    await setNumber(page, '#defaultStopAllFadeOut', 800);
    await expect.poll(savedConfig(audio, 'defaultStopAllFadeOutTime')).toBe(800);
    await page.locator('#configToggleBtn').click();
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        await cueButton(page, a).click();
        await cueButton(page, b).click();
        await page.waitForTimeout(600);
        mark('stop-all');
        await page.locator('#stopAllButton').click();
        await page.waitForTimeout(1200);
    });
    const at = take.at('stop-all');
    for (const [band, level] of [[0, A], [1, A * 0.5]]) {
        const t90 = take.a.crossing(band, { after: at - 0.02, fraction: 0.9, reference: level });
        const t10 = take.a.crossing(band, { after: at - 0.02, fraction: 0.1, reference: level });
        audio.near(t10 - t90, 0.64, 0.05, `band ${band}: 90%->10% of an 800 ms fade`);
    }
});

test('XFADE button: the next cue clicked crossfades with the one playing, over the crossfade time set in config', async ({ page, audio }) => {
    const a = await audio.toneCue(LONG);
    const b = await audio.toneCue({ ...LONG, band: 1 });
    await openApp(page);
    await openConfig(page);
    await setNumber(page, '#crossfadeTime', 1000);
    await expect.poll(savedConfig(audio, 'crossfadeTime')).toBe(1000);
    await page.locator('#configToggleBtn').click();
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        await cueButton(page, a).click();
        await page.waitForTimeout(600);
        await page.locator('#crossfadeToggleBtn').click();
        await page.waitForTimeout(100);
        mark('go');
        await cueButton(page, b).click();
        await page.waitForTimeout(1500);
    });
    const go = take.at('go');
    const out90 = take.a.crossing(0, { after: go - 0.02, fraction: 0.9, reference: A });
    const out10 = take.a.crossing(0, { after: go - 0.02, fraction: 0.1, reference: A });
    const in10 = take.a.crossing(1, { after: go - 0.02, fraction: 0.1, reference: A, direction: 'rising' });
    const in90 = take.a.crossing(1, { after: go - 0.02, fraction: 0.9, reference: A, direction: 'rising' });
    audio.near(out10 - out90, 0.8, 0.06, 'outgoing 90%->10%');
    audio.near(in90 - in10, 0.8, 0.06, 'incoming 10%->90%');
    audio.near(in10 - out90, 0, 0.06, 'out and in begin together');
});

// --- Properties sidebar ---------------------------------------------------------

test('properties sidebar: moving the volume slider of a playing cue changes what you hear', async ({ page, audio }) => {
    const cue = await audio.toneCue(LONG);
    await openApp(page);
    await openProperties(page, cue);
    const take = await audio.record(async (mark) => {
        await audio.trigger(cue);
        await page.waitForTimeout(700);
        mark('slider');
        await page.locator('#propVolume').fill('0.25');
        await page.waitForTimeout(900);
    });
    const at = take.at('slider');
    audio.near(take.a.level(0, at - 0.5, at - 0.05), A, 0.006, 'before');
    audio.near(take.a.level(0, at + 0.4, at + 0.85), A * 0.25, 0.006, 'after');
});

test('properties sidebar: fade in, loop and retrigger set there are what the cue does', async ({ page, audio }) => {
    const cue = await audio.toneCue({ band: 0, durationSec: 1.2 });
    await openApp(page);
    await openProperties(page, cue);
    await setNumber(page, '#propFadeInTime', 600);
    await page.locator('#propLoop').check();
    await page.locator('#propRetriggerBehavior').selectOption('do_nothing');
    await expect.poll(savedCue(audio, cue, 'fadeInTime')).toBe(600);
    await expect.poll(savedCue(audio, cue, 'loop')).toBe(true);
    await expect.poll(savedCue(audio, cue, 'retriggerBehavior')).toBe('do_nothing');
    await page.locator('#closePropertiesSidebarBtn').click();
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        mark('click');
        await cueButton(page, cue).click();
        await page.waitForTimeout(1800);
        mark('again');
        await cueButton(page, cue).click();
        await page.waitForTimeout(1200);
    });
    const after = take.at('click');
    const t10 = take.a.crossing(0, { after, fraction: 0.1, reference: A, direction: 'rising' });
    const t90 = take.a.crossing(0, { after, fraction: 0.9, reference: A, direction: 'rising' });
    audio.near(t90 - t10, 0.48, 0.05, '10%->90% of a 600 ms fade in');
    // Looping: still sounding well past the 1.2 s file, wrapping 11 -> 0.
    const start = take.a.onset(0, { after });
    expect(take.a.slotAt(0, start + 1.25)).toBeLessThanOrEqual(1);
    // do_nothing: the second click changes nothing.
    const again = take.at('again');
    take.assertNoDropouts(again - 0.3, again + 1.0);
    audio.near(take.a.level(0, again - 0.3, again + 1.0), A, 0.01, 'level across the second click');
});

test('properties sidebar: ducking set there ducks the bed while the trigger plays', async ({ page, audio }) => {
    const bed = await audio.toneCue(LONG, { name: 'Bed' });
    const voice = await audio.toneCue({ band: 1, durationSec: 2 }, { name: 'Voice' });
    await audio.request('PUT', '/api/config', { duckingFadeTime: 300 });
    await openApp(page);
    await openProperties(page, bed);
    await page.locator('#propEnableDucking').check();
    await expect.poll(savedCue(audio, bed, 'enableDucking')).toBe(true);
    await openProperties(page, voice);
    await page.locator('#propIsDuckingTrigger').check();
    await page.locator('#propDuckingLevel').fill('50');
    await expect.poll(savedCue(audio, voice, 'duckingLevel')).toBe(50);
    await page.locator('#closePropertiesSidebarBtn').click();
    await enterShowMode(page);
    const take = await audio.record(async (mark) => {
        await cueButton(page, bed).click();
        await page.waitForTimeout(600);
        mark('voice');
        await cueButton(page, voice).click();
        await page.waitForTimeout(1400);
    });
    const v = take.at('voice');
    audio.near(take.a.level(0, v - 0.4, v - 0.05), A, 0.006, 'bed before');
    audio.near(take.a.level(0, v + 0.5, v + 1.3), A * 0.5, 0.01, 'bed while the trigger plays');
});

test('Preview (local) plays in the browser, never through the show output', async ({ page, audio }) => {
    const cue = await audio.toneCue(LONG);
    await openApp(page);
    await openProperties(page, cue);
    const take = await audio.record(async () => {
        await page.locator('#previewCueButton').click();
        await page.waitForTimeout(1000);
    });
    await page.evaluate(() => window.audioController.stopPreview());
    expect(take.a.level(0, 0, take.durationSec)).toBeLessThan(0.001);
    expect(await audio.status(cue)).not.toBe('playing');
});

// --- Playlists --------------------------------------------------------------------

test('playlist ▶ and ◀ on a playing playlist switch the item you hear', async ({ page, audio }) => {
    const list = await audio.tonePlaylist([
        { band: 0, durationSec: 4 }, { band: 1, durationSec: 4 },
    ]);
    await openApp(page);
    await enterShowMode(page);
    const wrapper = page.locator('.cue-wrapper', { has: cueButton(page, list) });
    const take = await audio.record(async (mark) => {
        await cueButton(page, list).click();
        await page.waitForTimeout(700);
        mark('next');
        await wrapper.locator('.playlist-next-btn').click();
        await page.waitForTimeout(700);
        mark('prev');
        await wrapper.locator('.playlist-prev-btn').click();
        await page.waitForTimeout(700);
    });
    const next = take.at('next');
    const prev = take.at('prev');
    audio.immediate(take.a.onset(1, { after: next - 0.05 }) - next, '▶ -> item 2');
    expect(take.a.level(0, next + 0.2, prev - 0.05)).toBeLessThan(0.001);
    audio.immediate(take.a.onset(0, { after: prev - 0.05 }) - prev, '◀ -> item 1');
    expect(take.a.level(1, prev + 0.2, prev + 0.6)).toBeLessThan(0.001);
});

// --- Remote page ------------------------------------------------------------------

test('remote page: tapping a tile plays the cue; its Stop All stops it', async ({ page, audio }) => {
    const cue = await audio.toneCue(LONG);
    await page.goto('/remote');
    const tile = page.locator(`#cue-btn-${cue}`);
    await expect(tile).toBeVisible();
    const take = await audio.record(async (mark) => {
        mark('tap');
        await tile.click();
        await page.waitForTimeout(800);
        mark('stop-all');
        await page.locator('#stopAllButtonRemote').click();
        await page.waitForTimeout(500);
    });
    audio.immediate(take.a.onset(0, { after: take.at('tap') - 0.05 }) - take.at('tap'), 'tap -> sound');
    audio.immediate(take.a.offset(0, { after: take.at('stop-all') - 0.05 }) - take.at('stop-all'), 'Stop All -> silence');
});

test('remote page: XFADE crossfades the next tile tapped', async ({ page, audio }) => {
    await audio.request('PUT', '/api/config', { crossfadeTime: 800 });
    const a = await audio.toneCue(LONG);
    const b = await audio.toneCue({ ...LONG, band: 1 });
    await page.goto('/remote');
    const take = await audio.record(async (mark) => {
        await page.locator(`#cue-btn-${a}`).click();
        await page.waitForTimeout(500);
        await page.locator('#crossfadeButtonRemote').click();
        await expect(page.locator('#crossfadeButtonRemote')).toHaveAttribute('aria-pressed', 'true');
        mark('go');
        await page.locator(`#cue-btn-${b}`).click();
        await page.waitForTimeout(1200);
    });
    const go = take.at('go');
    const out90 = take.a.crossing(0, { after: go - 0.02, fraction: 0.9, reference: A });
    const out10 = take.a.crossing(0, { after: go - 0.02, fraction: 0.1, reference: A });
    audio.near(out10 - out90, 0.64, 0.06, 'outgoing fade');
    audio.near(take.a.level(1, go + 0.95, go + 1.15), A, 0.01, 'incoming at full level');
});

// --- Config sidebar: output device ------------------------------------------------

test('config sidebar: choosing another output device moves the sound there, and back', async ({ page, audio }) => {
    const options = await (await page.request.get('/api/audio/output-devices')).json();
    const devices = options.devices || options.outputDevices || [];
    const other = devices.find((d) => d.id !== audio.device.output.id
        && /BlackHole|Loopback|NoMachine|Teams|VB-|CABLE|Soundflower/i.test(d.name));
    test.skip(!other, 'needs a second virtual output device to switch to (so nothing plays on speakers)');

    const cue = await audio.toneCue(LONG, { loop: true });
    await openApp(page);
    await openConfig(page);
    const select = page.locator('#configAudioOutputDevice');
    try {
        const take = await audio.record(async (mark) => {
            await select.selectOption(other.name);
            await expect.poll(savedConfig(audio, 'audioOutputDeviceId')).toBe(other.name);
            await page.waitForTimeout(300);
            mark('elsewhere');
            await audio.trigger(cue);
            await page.waitForTimeout(800);
            await select.selectOption(audio.device.output.name);
            await expect.poll(savedConfig(audio, 'audioOutputDeviceId')).toBe(audio.device.output.name);
            await page.waitForTimeout(300);
            mark('back');
            await audio.trigger(cue);
            await page.waitForTimeout(1000);
        });
        expect(take.a.level(0, take.at('elsewhere'), take.at('back') - 0.4)).toBeLessThan(0.001);
        audio.near(take.a.level(0, take.at('back') + 0.3, take.at('back') + 0.9), A, 0.01, 'back on the loopback');
    } finally {
        await select.selectOption(audio.device.output.name).catch(() => {});
    }
});

test('saving an unrelated setting in the config sidebar leaves the output device alone (WO-001)', async ({ page, audio }) => {
    // The sidebar used to show nothing selected for a device it couldn't
    // match, and save '' (the system default) with the next change.
    await audio.request('PUT', '/api/config', { audioOutputDeviceId: audio.device.output.name });
    const cue = await audio.toneCue(LONG);
    await openApp(page);
    await openConfig(page);
    await expect(page.locator('#configAudioOutputDevice')).toHaveValue(audio.device.output.name);
    await setNumber(page, '#crossfadeTime', 1234);
    await expect.poll(savedConfig(audio, 'crossfadeTime')).toBe(1234);
    expect(await savedConfig(audio, 'audioOutputDeviceId')()).toBe(audio.device.output.name);
    const take = await audio.record(async (mark) => {
        mark('trigger');
        await audio.trigger(cue);
        await page.waitForTimeout(800);
    });
    audio.near(take.a.level(0, take.at('trigger') + 0.2, take.at('trigger') + 0.7), A, 0.01, 'still on the loopback');
});
