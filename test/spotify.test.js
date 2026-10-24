/**
 * Spotify cues: connecting a Spotify account, and cues that play a track
 * or playlist through Spotify Connect - start, stop, fades, pause, ducking,
 * playing to the end. Runs against a fake Spotify (helpers/fakeSpotify.js).
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { useServer } = require('./helpers/harness');
const { api, sleep } = require('./helpers/api');
const { startFakeSpotify } = require('./helpers/fakeSpotify');

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const SHORT_SONG = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const LONG_SONG_LINK = 'https://open.spotify.com/intl-de/track/7ouMYWpwJ422jRcDASZB7P?si=abc123';
const LONG_SONG = 'spotify:track:7ouMYWpwJ422jRcDASZB7P';
const SECOND_SONG = 'spotify:track:0eGsygTp906u18L0Oimnem';
const PLAYLIST_LINK = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const PLAYLIST = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';

const env = { SPOTIFY_POLL_MS: '200' };
let fake;
before(async () => {
    fake = await startFakeSpotify();
    env.SPOTIFY_ACCOUNTS_URL = fake.accountsUrl;
    env.SPOTIFY_API_URL = fake.apiUrl;
});
after(async () => {
    await fake?.close();
});

const server = useServer(env);
const t = api(server);

// Closed even when a test fails part-way: an open socket would hold up the
// server's shutdown.
const sockets = [];
afterEach(() => {
    while (sockets.length) sockets.pop().close();
});
async function ws() {
    const socket = await t.ws();
    sockets.push(socket);
    return socket;
}

async function connect() {
    await t.put('/api/spotify/settings', { clientId: CLIENT_ID });
    const login = await fetch(`${server.baseUrl()}/api/spotify/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const approval = fake.approve(login.headers.get('location'));
    const callback = new URL(approval.redirectUri);
    const res = await fetch(`${server.baseUrl()}${callback.pathname}?code=${approval.code}&state=${approval.state}`);
    assert.equal(res.status, 200, await res.text());
}

async function createSpotifyCue(overrides = {}) {
    const body = await t.post('/api/cues', {
        name: 'Spotify cue',
        type: 'spotify',
        spotifyUri: LONG_SONG,
        volume: 0.8,
        ...overrides,
    });
    assert.equal(body.success, true, body.error);
    return body.cue.id;
}

const last = (list) => list[list.length - 1];
const lastVolume = () => fake.state.volume;

test('before connecting, a Spotify cue says what to do', async () => {
    const status = (await t.get('/api/spotify/status')).status;
    assert.equal(status.connected, false);
    assert.match(status.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/api\/spotify\/callback$/);

    const cueId = await createSpotifyCue();
    const result = await t.trigger(cueId);
    assert.equal(result.success, false);
    assert.match(result.error, /not connected/i);
    assert.equal(await t.status(cueId), 'stopped');
    await t.request('DELETE', `/api/cues/${cueId}`);
});

test('a client ID that is not one is refused', async () => {
    const res = await t.request('PUT', '/api/spotify/settings', { clientId: 'not a client id!' });
    assert.equal(res.status, 400);
});

test('login goes through Spotify with PKCE and remembers the account', async () => {
    await t.put('/api/spotify/settings', { clientId: CLIENT_ID });
    const login = await fetch(`${server.baseUrl()}/api/spotify/login`, { redirect: 'manual' });
    const authorize = new URL(login.headers.get('location'));
    assert.equal(authorize.origin, fake.accountsUrl);
    assert.equal(authorize.pathname, '/authorize');
    assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${server.port()}/api/spotify/callback`);
    assert.match(authorize.searchParams.get('scope'), /user-modify-playback-state/);

    // A callback that didn't come from this login is turned away.
    const forged = await fetch(`${server.baseUrl()}/api/spotify/callback?code=x&state=forged`);
    assert.equal(forged.status, 400);

    const approval = fake.approve(authorize.href);
    const res = await fetch(`${server.baseUrl()}/api/spotify/callback?code=${approval.code}&state=${approval.state}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /connected to Spotify as Test User/);

    const status = (await t.get('/api/spotify/status')).status;
    assert.equal(status.connected, true);
    assert.equal(status.user.displayName, 'Test User');
    assert.equal(status.user.product, 'premium');
    assert.equal(JSON.stringify(status).includes('access-'), false, 'tokens never leave the server');
    assert.equal(fake.state.clientId, CLIENT_ID);
});

test('links are looked up and stored as Spotify URIs', async () => {
    const track = (await t.get(`/api/spotify/resolve?link=${encodeURIComponent(LONG_SONG_LINK)}`)).item;
    assert.equal(track.uri, LONG_SONG);
    assert.equal(track.name, 'Long Song');
    assert.equal(track.subtitle, 'Other Artist');
    assert.equal(track.durationSec, 600);

    const playlist = (await t.get(`/api/spotify/resolve?link=${encodeURIComponent(PLAYLIST_LINK)}`)).item;
    assert.equal(playlist.name, 'Show Music');
    assert.equal(playlist.trackCount, 2);

    const bad = await t.request('GET', `/api/spotify/resolve?link=${encodeURIComponent('https://example.com/track/x')}`);
    assert.equal(bad.status, 400);

    const cueId = await createSpotifyCue({ spotifyUri: LONG_SONG_LINK });
    const cue = await t.getCue(cueId);
    assert.equal(cue.spotifyUri, LONG_SONG);
    assert.equal(cue.spotifyType, 'track');
    await t.request('DELETE', `/api/cues/${cueId}`);
});

test('the devices Spotify knows are listed, and one can be chosen', async () => {
    const { devices } = await t.get('/api/spotify/devices');
    assert.deepEqual(devices.map((d) => d.name), ['This Computer', 'Kitchen Speaker']);
    const status = (await t.put('/api/spotify/settings', { deviceId: 'speaker-1', deviceName: 'Kitchen Speaker' })).status;
    assert.equal(status.deviceId, 'speaker-1');

    const cueId = await createSpotifyCue();
    await t.playing(cueId);
    assert.equal(last(fake.requestsTo('PUT /me/player/play')).query.device_id, 'speaker-1');
    await t.stop(cueId);

    await t.put('/api/spotify/settings', { deviceId: null });
    fake.state.devices.forEach((d) => { d.is_active = d.id === 'computer-1'; });
    await t.request('DELETE', `/api/cues/${cueId}`);
});

test('a track cue plays on Spotify, shows its time, and stops', async () => {
    const socket = await ws();
    const cueId = await createSpotifyCue();
    await t.playing(cueId);

    const play = last(fake.requestsTo('PUT /me/player/play'));
    assert.deepEqual(play.body, { uris: [LONG_SONG] });
    assert.equal(play.query.device_id, 'computer-1');
    assert.equal(lastVolume(), 80, 'the cue volume sets the player volume');
    assert.equal(last(fake.requestsTo('PUT /me/player/repeat')).query.state, 'off');

    const update = await t.waitForTimeUpdate(socket, cueId, (p) => p.nowPlaying && p.currentTimeSec > 0);
    assert.equal(update.payload.nowPlaying, 'Long Song - Other Artist');
    assert.equal(update.payload.totalDurationSec, 600);
    assert.equal(update.payload.status, 'playing');

    const stopped = t.waitForCueStatus(socket, cueId, 'stopped');
    await t.stop(cueId);
    await stopped;
    assert.equal(fake.state.player.isPlaying, false);
});

test('pausing a Spotify cue pauses the player, and pressing again resumes it', async () => {
    const cueId = await createSpotifyCue({ retriggerBehavior: 'toggle_pause_play' });
    await t.playing(cueId);

    assert.equal((await t.trigger(cueId)).status, 'paused');
    assert.equal(await t.status(cueId), 'paused');
    assert.equal(fake.state.player.isPlaying, false);

    assert.equal((await t.trigger(cueId)).status, 'playing');
    assert.equal(fake.state.player.isPlaying, true);
    await t.stop(cueId);
});

test('a pause in the Spotify app shows on the cue', async () => {
    const socket = await ws();
    const cueId = await createSpotifyCue();
    await t.playing(cueId);
    await sleep(2800); // past the settle time after starting

    const paused = t.waitForCueStatus(socket, cueId, 'paused');
    fake.externalPause();
    await paused;
    assert.equal(await t.status(cueId), 'paused');
    await t.stop(cueId);
});

test('a track that plays to its end completes the cue', async () => {
    const socket = await ws();
    const cueId = await createSpotifyCue({ spotifyUri: SHORT_SONG, knownDuration: 2.5 });
    const completed = t.waitForCueStatus(socket, cueId, 'completed', 10000);
    await t.playing(cueId);
    await completed;
});

test('fade out and stop lowers the player volume, then pauses it and puts the level back', async () => {
    const socket = await ws();
    const cueId = await createSpotifyCue({ fadeOutTime: 1000, volume: 1 });
    await t.playing(cueId);
    const volumesBefore = fake.requestsTo('PUT /me/player/volume').length;

    const stopped = t.waitForCueStatus(socket, cueId, 'stopped', 5000);
    await t.post(`/api/cues/${cueId}/stop`, { fadeOut: true });
    assert.equal(await t.status(cueId), 'playing', 'still playing while it fades');
    await stopped;

    const fadeVolumes = fake.requestsTo('PUT /me/player/volume').slice(volumesBefore).map((r) => Number(r.query.volume_percent));
    assert.ok(fadeVolumes.length >= 3, `stepped down, got ${fadeVolumes}`);
    // It pauses once the fade is done, from its last (near-silent) step.
    assert.ok(Math.min(...fadeVolumes) <= 5, `faded to silence, got ${fadeVolumes}`);
    assert.equal(last(fadeVolumes), 100, 'level restored for next time');
    assert.equal(fake.state.player.isPlaying, false);
});

test('fade in starts the player silent and raises it to the cue volume', async () => {
    const cueId = await createSpotifyCue({ fadeInTime: 800, volume: 0.6 });
    const volumesBefore = fake.requestsTo('PUT /me/player/volume').length;
    await t.playing(cueId);
    await sleep(1300);
    const volumes = fake.requestsTo('PUT /me/player/volume').slice(volumesBefore).map((r) => Number(r.query.volume_percent));
    assert.equal(volumes[0], 0, 'set to silence before playing');
    assert.equal(last(volumes), 60);
    assert.ok(volumes.length >= 3, `ramped up, got ${volumes}`);
    await t.stop(cueId);
});

test('a playlist cue plays the playlist, and the grid arrows step through it', async () => {
    const cueId = await createSpotifyCue({ spotifyUri: PLAYLIST_LINK, loop: true });
    await t.playing(cueId);
    const play = last(fake.requestsTo('PUT /me/player/play'));
    assert.deepEqual(play.body, { context_uri: PLAYLIST });
    assert.equal(last(fake.requestsTo('PUT /me/player/repeat')).query.state, 'context');

    const nav = await t.post(`/api/cues/${cueId}/playlist/navigate`, { direction: 'next' });
    assert.equal(nav.success, true, nav.error);
    assert.equal(fake.requestsTo('POST /me/player/next').length, 1);
    await t.waitFor(async () => (await t.playback()).spotify?.nowPlaying?.startsWith('Second Long Song'));
    await t.stop(cueId);
});

test('starting another Spotify cue replaces the one playing', async () => {
    const socket = await ws();
    const first = await createSpotifyCue();
    const second = await createSpotifyCue({ spotifyUri: SECOND_SONG });
    await t.playing(first);
    const firstStopped = t.waitForCueStatus(socket, first, 'stopped');
    await t.playing(second);
    await firstStopped;
    assert.equal(fake.state.player.uris[0], SECOND_SONG);
    await t.stop(second);
});

test('a ducking trigger lowers a Spotify cue, and it comes back after', async () => {
    await t.setConfig({ duckingFadeTime: 200 });
    const spotifyCue = await createSpotifyCue({ enableDucking: true, volume: 1 });
    const trigger = await t.createCue({ isDuckingTrigger: true, duckingLevel: 50 }, 2);
    await t.playing(spotifyCue);
    await t.playing(trigger);
    await t.waitFor(() => lastVolume() === 50);
    assert.equal((await t.playback()).spotify.isDucked, true);

    await t.stop(trigger);
    await t.waitFor(() => lastVolume() === 100);
    await t.stop(spotifyCue);
});

test('Stop All stops the Spotify cue too', async () => {
    const socket = await ws();
    const cueId = await createSpotifyCue();
    await t.playing(cueId);
    const stopped = t.waitForCueStatus(socket, cueId, 'stopped');
    await t.stopAll('stop');
    await stopped;
    assert.equal(fake.state.player.isPlaying, false);
});

test('an expired access token is refreshed without the operator noticing', async () => {
    const cueId = await createSpotifyCue();
    const tokensBefore = fake.state.tokenCount;
    fake.expireAccessToken();
    await t.playing(cueId);
    assert.equal(fake.state.tokenCount, tokensBefore + 1);
    await t.stop(cueId);
});

test('without Premium, starting a cue reports why', async () => {
    const socket = await ws();
    const cueId = await createSpotifyCue();
    fake.state.product = 'free';
    try {
        const errorMessage = t.waitFor(() => socket.received.find((m) => m.type === 'spotify-error'));
        const result = await t.trigger(cueId);
        assert.equal(result.success, false);
        assert.match(result.error, /Premium/);
        assert.match((await errorMessage).payload.message, /Premium/);
        assert.equal(await t.status(cueId), 'stopped');
    } finally {
        fake.state.product = 'premium';
        }
});

test('disconnecting forgets the login', async () => {
    const status = (await t.post('/api/spotify/logout')).status;
    assert.equal(status.connected, false);
    const cueId = await createSpotifyCue();
    assert.match((await t.trigger(cueId)).error, /not connected/i);
    await connect(); // leave it connected, as other tests may run after
});
