/**
 * A stand-in for Spotify's accounts service and Web API, enough of both
 * for the server's Spotify cues: login (PKCE token exchange + refresh), the
 * player endpoints, and a small catalog. Playback is simulated in real
 * time - a playing track's progress advances, and it stops at its end.
 * The server under test is pointed at it with SPOTIFY_ACCOUNTS_URL and
 * SPOTIFY_API_URL.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const CATALOG = {
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC': { name: 'Short Song', artists: ['Test Artist'], durationMs: 2500 },
    'spotify:track:7ouMYWpwJ422jRcDASZB7P': { name: 'Long Song', artists: ['Other Artist'], durationMs: 600000 },
    'spotify:track:0eGsygTp906u18L0Oimnem': { name: 'Second Long Song', artists: ['Other Artist'], durationMs: 600000 },
};
const PLAYLISTS = {
    'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M': {
        name: 'Show Music',
        owner: 'Test User',
        tracks: ['spotify:track:7ouMYWpwJ422jRcDASZB7P', 'spotify:track:0eGsygTp906u18L0Oimnem'],
    },
};

function trackJson(uri) {
    const t = CATALOG[uri];
    return {
        uri,
        id: uri.split(':')[2],
        name: t.name,
        duration_ms: t.durationMs,
        artists: t.artists.map((name) => ({ name })),
    };
}

function startFakeSpotify() {
    const state = {
        requests: [],
        clientId: null,
        accessToken: null,
        refreshToken: null,
        tokenCount: 0,
        product: 'premium',
        devices: [
            { id: 'computer-1', name: 'This Computer', type: 'Computer', is_active: true, is_restricted: false, supports_volume: true, volume_percent: 70 },
            { id: 'speaker-1', name: 'Kitchen Speaker', type: 'Speaker', is_active: false, is_restricted: false, supports_volume: true, volume_percent: 30 },
        ],
        player: null, // { deviceId, uris, contextUri, index, isPlaying, progressMs, since, repeat, shuffle }
        volume: null,
        pkce: new Map(), // code -> challenge
    };

    function progressOf(player) {
        const track = CATALOG[player.uris[player.index]];
        let progress = player.progressMs + (player.isPlaying ? Date.now() - player.since : 0);
        if (progress >= track.durationMs) {
            if (player.repeat === 'track') {
                progress %= track.durationMs;
            } else if (player.index + 1 < player.uris.length) {
                player.index += 1;
                player.progressMs = 0;
                player.since = Date.now();
                return progressOf(player);
            } else {
                // Ran out: stops on the last track, back at its start.
                player.isPlaying = false;
                player.progressMs = 0;
                progress = 0;
            }
        }
        return progress;
    }

    function send(res, status, body) {
        if (body === undefined) {
            res.writeHead(status);
            res.end();
            return;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }

    function apiError(res, status, message, reason) {
        send(res, status, { error: { status, message, ...(reason ? { reason } : {}) } });
    }

    async function readBody(req) {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        return raw;
    }

    function issueTokens() {
        state.tokenCount += 1;
        state.accessToken = `access-${state.tokenCount}`;
        state.refreshToken = `refresh-${state.tokenCount}`;
        return { access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 3600, token_type: 'Bearer' };
    }

    async function handleToken(req, res) {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('grant_type') === 'authorization_code') {
            const challenge = state.pkce.get(form.get('code'));
            const verifier = form.get('code_verifier') || '';
            const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
            if (!challenge || challenge !== expected) {
                return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
            }
            state.clientId = form.get('client_id');
            return send(res, 200, issueTokens());
        }
        if (form.get('grant_type') === 'refresh_token') {
            if (form.get('refresh_token') !== state.refreshToken) {
                return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
            }
            return send(res, 200, issueTokens());
        }
        return send(res, 400, { error: 'unsupported_grant_type' });
    }

    function deviceFor(url) {
        const id = url.searchParams.get('device_id');
        return id ? state.devices.find((d) => d.id === id) : state.devices.find((d) => d.is_active);
    }

    async function handleApi(req, res, url) {
        const auth = req.headers.authorization || '';
        if (!state.accessToken || auth !== `Bearer ${state.accessToken}`) {
            return apiError(res, 401, 'The access token expired');
        }
        const route = `${req.method} ${url.pathname.replace(/^\/v1/, '')}`;
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : undefined;
        state.requests.push({ route, query: Object.fromEntries(url.searchParams), body, at: Date.now() });

        const player = state.player;
        const playerRoute = route.startsWith('PUT /me/player') || route.startsWith('POST /me/player');
        if (playerRoute && state.product !== 'premium') {
            return apiError(res, 403, 'Player command failed: Premium required', 'PREMIUM_REQUIRED');
        }

        switch (route) {
            case 'GET /me':
                return send(res, 200, { id: 'tester', display_name: 'Test User', product: state.product });
            case 'GET /me/player/devices':
                return send(res, 200, { devices: state.devices.map((d) => ({ ...d, volume_percent: d.id === player?.deviceId && state.volume !== null ? state.volume : d.volume_percent })) });
            case 'GET /me/player': {
                if (!player) return send(res, 204);
                const progress = progressOf(player);
                const uri = player.uris[player.index];
                return send(res, 200, {
                    is_playing: player.isPlaying,
                    progress_ms: progress,
                    item: trackJson(uri),
                    context: player.contextUri ? { uri: player.contextUri } : null,
                    device: { id: player.deviceId },
                    repeat_state: player.repeat,
                    shuffle_state: player.shuffle,
                });
            }
            case 'PUT /me/player/play': {
                const device = deviceFor(url);
                if (!device) return apiError(res, 404, 'Device not found', 'NO_ACTIVE_DEVICE');
                if (body?.uris || body?.context_uri) {
                    const contextUri = body.context_uri || null;
                    const uris = contextUri ? PLAYLISTS[contextUri]?.tracks : body.uris;
                    if (!uris || uris.some((u) => !CATALOG[u])) return apiError(res, 400, 'Invalid uri');
                    state.player = {
                        deviceId: device.id,
                        uris,
                        contextUri,
                        index: Math.min(body.offset?.position || 0, uris.length - 1),
                        isPlaying: true,
                        progressMs: 0,
                        since: Date.now(),
                        repeat: player?.repeat || 'off',
                        shuffle: player?.shuffle || false,
                    };
                } else if (player) {
                    player.progressMs = progressOf(player);
                    player.isPlaying = true;
                    player.since = Date.now();
                } else {
                    return apiError(res, 404, 'Nothing to resume', 'NO_ACTIVE_DEVICE');
                }
                state.devices.forEach((d) => { d.is_active = d.id === device.id; });
                return send(res, 204);
            }
            case 'PUT /me/player/pause':
                if (!player || !player.isPlaying) return apiError(res, 403, 'Restriction violated', 'UNKNOWN');
                player.progressMs = progressOf(player);
                player.isPlaying = false;
                return send(res, 204);
            case 'PUT /me/player/volume':
                state.volume = Number(url.searchParams.get('volume_percent'));
                return send(res, 204);
            case 'PUT /me/player/repeat':
                if (player) player.repeat = url.searchParams.get('state');
                return send(res, 204);
            case 'PUT /me/player/shuffle':
                if (player) player.shuffle = url.searchParams.get('state') === 'true';
                return send(res, 204);
            case 'POST /me/player/next':
            case 'POST /me/player/previous': {
                if (!player) return apiError(res, 404, 'No active device', 'NO_ACTIVE_DEVICE');
                progressOf(player);
                const step = route.endsWith('next') ? 1 : -1;
                player.index = Math.max(0, Math.min(player.uris.length - 1, player.index + step));
                player.progressMs = 0;
                player.since = Date.now();
                return send(res, 204);
            }
            default: {
                const match = url.pathname.match(/^\/v1\/(tracks|playlists)\/([A-Za-z0-9]+)$/);
                if (req.method === 'GET' && match) {
                    const uri = `spotify:${match[1].slice(0, -1)}:${match[2]}`;
                    if (match[1] === 'tracks' && CATALOG[uri]) return send(res, 200, trackJson(uri));
                    const playlist = PLAYLISTS[uri];
                    if (playlist) {
                        return send(res, 200, {
                            uri,
                            name: playlist.name,
                            owner: { display_name: playlist.owner },
                            tracks: { total: playlist.tracks.length },
                        });
                    }
                    return apiError(res, 404, 'Resource not found');
                }
                return apiError(res, 404, `No fake for ${route}`);
            }
        }
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fake');
        const handle = url.pathname === '/api/token'
            ? handleToken(req, res)
            : url.pathname.startsWith('/v1/')
                ? handleApi(req, res, url)
                : Promise.resolve(send(res, 404, { error: 'not found' }));
        handle.catch((error) => send(res, 500, { error: error.message }));
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({
                state,
                accountsUrl: base,
                apiUrl: `${base}/v1`,
                /** What Spotify's consent page would do: approve, and remember the PKCE challenge. */
                approve(authorizeUrl) {
                    const url = new URL(authorizeUrl);
                    const code = `code-${crypto.randomBytes(4).toString('hex')}`;
                    state.pkce.set(code, url.searchParams.get('code_challenge'));
                    return { code, state: url.searchParams.get('state'), redirectUri: url.searchParams.get('redirect_uri') };
                },
                /** Spotify invalidating the access token (it expired early). */
                expireAccessToken() {
                    state.accessToken = `revoked-${state.accessToken}`;
                },
                requestsTo(route) {
                    return state.requests.filter((r) => r.route === route);
                },
                /** Someone pressing pause in the Spotify app. */
                externalPause() {
                    if (state.player?.isPlaying) {
                        state.player.progressMs = progressOf(state.player);
                        state.player.isPlaying = false;
                    }
                },
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

module.exports = { startFakeSpotify };
