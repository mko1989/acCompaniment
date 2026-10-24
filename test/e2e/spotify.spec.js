/**
 * Spotify in the browser UI: connecting an account from the settings,
 * making cues from Spotify links (pasted, dropped, typed into a cue's
 * properties), and playing one. The server talks to a fake Spotify
 * (test/helpers/fakeSpotify.js).
 */

const base = require('./fixtures');
const { expect } = base;
const { openApp, enterShowMode, cueButton, getCue, createTestCue } = require('./helpers');
const { startFakeSpotify } = require('../helpers/fakeSpotify');

const test = base.test.extend({
    fakeSpotify: [async ({}, use) => {
        const fake = await startFakeSpotify();
        await use(fake);
        await fake.close();
    }, { scope: 'worker' }],
    serverEnv: [async ({ fakeSpotify }, use) => {
        await use({
            SPOTIFY_ACCOUNTS_URL: fakeSpotify.accountsUrl,
            SPOTIFY_API_URL: fakeSpotify.apiUrl,
            SPOTIFY_POLL_MS: '200',
        });
    }, { scope: 'worker' }],
});

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const LONG_SONG_LINK = 'https://open.spotify.com/track/7ouMYWpwJ422jRcDASZB7P?si=e2e';
const LONG_SONG = 'spotify:track:7ouMYWpwJ422jRcDASZB7P';
const PLAYLIST_LINK = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

// Every test starts disconnected (clearing the client ID drops the login).
test.beforeEach(async ({ request }) => {
    await request.put('/api/spotify/settings', { data: { clientId: '', deviceId: null } });
});

async function connect(request, fakeSpotify) {
    await request.put('/api/spotify/settings', { data: { clientId: CLIENT_ID } });
    const login = await request.get('/api/spotify/login', { maxRedirects: 0 });
    const approval = fakeSpotify.approve(login.headers().location);
    const res = await request.get(`/api/spotify/callback?code=${approval.code}&state=${approval.state}`);
    expect(res.status()).toBe(200);
}

async function openConfig(page) {
    await page.locator('#configToggleBtn').click();
    await expect(page.locator('#configSidebar')).toHaveClass(/expanded/);
}

async function cuesNamed(request, name) {
    const { cues = [] } = await (await request.get('/api/cues')).json();
    return cues.filter((c) => c.name === name);
}

test('settings: enter a client ID, connect, and pick a player', async ({ page, request, fakeSpotify, baseURL }) => {
    await openApp(page);
    await openConfig(page);
    await expect(page.locator('#spotifyConnectionStatus')).toContainText('Enter your Spotify app');
    await expect(page.locator('#spotifyConnectButton')).toBeDisabled();
    await expect(page.locator('#spotifyRedirectUri')).toHaveText(`${baseURL}/api/spotify/callback`);

    await page.locator('#spotifyClientId').fill(CLIENT_ID);
    await page.locator('#spotifyClientId').press('Tab');
    await expect(page.locator('#spotifyConnectButton')).toBeEnabled();

    // The login finishes in another tab; this page hears about it.
    await connect(request, fakeSpotify);
    await expect(page.locator('#spotifyConnectionStatus')).toContainText('Connected as Test User');
    await expect(page.locator('#spotifyConnectButton')).toBeHidden();
    await expect(page.locator('#spotifyDevice option')).toHaveText([
        'Whichever Spotify player is active', 'This Computer (active)', 'Kitchen Speaker',
    ]);

    await page.locator('#spotifyDevice').selectOption('speaker-1');
    await expect.poll(async () => (await (await request.get('/api/spotify/status')).json()).status.deviceName).toBe('Kitchen Speaker');

    await page.locator('#spotifyDisconnectButton').click();
    await expect(page.locator('#spotifyConnectionStatus')).toContainText('Not connected');
});

test('pasting a Spotify link makes a cue named after the track', async ({ page, request, fakeSpotify }) => {
    await connect(request, fakeSpotify);
    await openApp(page);
    await page.evaluate((link) => {
        const data = new DataTransfer();
        data.setData('text/plain', link);
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, LONG_SONG_LINK);

    await expect.poll(async () => (await cuesNamed(request, 'Long Song')).length).toBe(1);
    const [cue] = await cuesNamed(request, 'Long Song');
    expect(cue.type).toBe('spotify');
    expect(cue.spotifyUri).toBe(LONG_SONG);
    expect(cue.knownDuration).toBe(600);
    await expect(cueButton(page, cue.id).locator('.cue-source-badge')).toHaveText('SPOTIFY');
    await expect(cueButton(page, cue.id)).toContainText('10:00');
});

test('dropping a Spotify playlist onto the grid makes a cue with playlist arrows', async ({ page, request, fakeSpotify }) => {
    await connect(request, fakeSpotify);
    await createTestCue(request, { name: 'Existing' });
    await openApp(page);
    await page.evaluate((link) => {
        const data = new DataTransfer();
        data.setData('text/uri-list', link);
        const target = document.querySelector('.cue-wrapper') || document.getElementById('cueGridContainer');
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, PLAYLIST_LINK);

    await expect.poll(async () => (await cuesNamed(request, 'Show Music')).length).toBe(1);
    const [cue] = await cuesNamed(request, 'Show Music');
    expect(cue.spotifyType).toBe('playlist');
    expect(cue.spotifyTrackCount).toBe(2);
    await expect(page.locator(`.playlist-next-btn[data-cue-id="${cue.id}"]`)).toBeVisible();
});

test('a cue switched to Spotify takes a pasted link in its properties', async ({ page, request, fakeSpotify }) => {
    await connect(request, fakeSpotify);
    const cue = await createTestCue(request, { name: 'New Cue' });
    await openApp(page);
    await cueButton(page, cue.id).click();
    await expect(page.locator('#propertiesSidebar')).not.toHaveClass(/hidden/);

    await page.locator('#propCueType').selectOption('spotify');
    await expect(page.locator('#propSpotifyConfig')).toBeVisible();
    await expect(page.locator('#propSingleFileConfig')).toBeHidden();
    await expect(page.locator('#previewCueButton')).toBeHidden();
    await expect(page.locator('#replaceCueFileButton')).toBeHidden();
    await expect.poll(async () => (await getCue(request, cue.id)).type).toBe('spotify');

    await page.locator('#propSpotifyLink').fill(PLAYLIST_LINK);
    await page.locator('#propSpotifyLink').press('Tab');
    await expect(page.locator('#propSpotifyInfo')).toContainText('Show Music · Test User · 2 tracks');
    await expect(page.locator('#propCueName')).toHaveValue('Show Music');
    await expect(page.locator('#propSpotifyShuffleGroup')).toBeVisible();

    await page.locator('#propSpotifyShuffle').check();
    await expect.poll(async () => (await getCue(request, cue.id)).shufflePlaylist).toBe(true);
    const saved = await getCue(request, cue.id);
    expect(saved.spotifyUri).toBe('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    expect(saved.name).toBe('Show Music');
});

test('a Spotify cue plays from the grid and shows the track', async ({ page, request, fakeSpotify }) => {
    await connect(request, fakeSpotify);
    const created = await (await request.post('/api/cues', {
        data: { name: 'Walk-in', type: 'spotify', spotifyUri: LONG_SONG_LINK, retriggerBehavior: 'stop' },
    })).json();
    const cueId = created.cue.id;
    await openApp(page);
    await enterShowMode(page);

    await cueButton(page, cueId).click();
    await expect(cueButton(page, cueId)).toHaveClass(/playing/);
    await expect(cueButton(page, cueId)).toContainText('Now: Long Song - Other Artist');
    expect(fakeSpotify.state.player.isPlaying).toBe(true);

    await cueButton(page, cueId).click();
    await expect(cueButton(page, cueId)).not.toHaveClass(/playing/);
    expect(fakeSpotify.state.player.isPlaying).toBe(false);
});

test('a Spotify cue that cannot play says why', async ({ page, request }) => {
    const created = await (await request.post('/api/cues', {
        data: { name: 'Not yet', type: 'spotify', spotifyUri: LONG_SONG },
    })).json();
    await openApp(page);
    await enterShowMode(page);
    await cueButton(page, created.cue.id).click();
    await expect(page.locator('#errorBanner')).toContainText('Spotify is not connected');
    await expect(cueButton(page, created.cue.id)).not.toHaveClass(/playing/);
});
