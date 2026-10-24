/**
 * Spotify Web API access: the account login (OAuth authorization code with
 * PKCE - no client secret, so the user's own Spotify app's client ID is
 * all that's needed), token refresh, and authenticated requests.
 *
 * Settings and tokens live in their own file (config/spotify.json), not in
 * the app config: the app config is sent to every connected page, and the
 * tokens must never leave the server.
 */

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');
const { writeJsonAtomic } = require('../utils/atomicWrite');
const { parseSpotifyLink } = require('./spotifyUri');

const SCOPES = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-read-private',
    'playlist-read-private',
    'playlist-read-collaborative',
];

// A login has this long to come back from Spotify's consent page.
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
// Refresh this long before the access token actually expires.
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

class SpotifyError extends Error {
    constructor(message, { status = 0, reason = null } = {}) {
        super(message);
        this.name = 'SpotifyError';
        this.status = status;
        this.reason = reason;
    }
}

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// What the operator should be told, for the errors a show can actually hit.
function friendlyMessage(status, reason, apiMessage) {
    if (reason === 'PREMIUM_REQUIRED') return 'Spotify Premium is required to control playback';
    if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(apiMessage || ''))) {
        return 'No Spotify player found - open Spotify on this computer, or pick a device in Settings';
    }
    if (status === 401) return 'The Spotify login has expired - reconnect Spotify in Settings';
    if (status === 429) return 'Spotify is rate limiting requests - try again in a moment';
    return apiMessage ? `Spotify: ${apiMessage}` : `Spotify request failed (HTTP ${status})`;
}

class SpotifyClient extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.configDir     where spotify.json lives
     * @param {() => string} options.getRedirectUri
     */
    constructor({ configDir, getRedirectUri }) {
        super();
        this.settingsPath = path.join(configDir, 'spotify.json');
        this.getRedirectUri = getRedirectUri;
        this.accountsUrl = (process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com').replace(/\/$/, '');
        this.apiUrl = (process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1').replace(/\/$/, '');
        this.settings = {};
        this._pendingLogins = new Map(); // state -> { verifier, redirectUri, createdAt }
        this._refreshing = null;
    }

    async load() {
        try {
            if (await fs.pathExists(this.settingsPath)) {
                this.settings = JSON.parse(await fs.readFile(this.settingsPath, 'utf-8')) || {};
            }
        } catch (error) {
            console.error(`SpotifyClient: Could not read ${this.settingsPath}: ${error.message}`);
            this.settings = {};
        }
    }

    async _save() {
        await writeJsonAtomic(this.settingsPath, this.settings);
        await fs.chmod(this.settingsPath, 0o600).catch(() => {});
    }

    isConnected() {
        return Boolean(this.settings.refreshToken && this.settings.clientId);
    }

    /** Everything a page may see - never the tokens. */
    getStatus() {
        const { clientId = '', user = null, deviceId = null, deviceName = null } = this.settings;
        return {
            clientId,
            connected: this.isConnected(),
            user,
            deviceId,
            deviceName,
            redirectUri: this.getRedirectUri(),
        };
    }

    _emitStatus() {
        this.emit('status', this.getStatus());
    }

    /** clientId, deviceId, deviceName. A new client ID means a new login. */
    async updateSettings(updates = {}) {
        const next = { ...this.settings };
        if (typeof updates.clientId === 'string') {
            const clientId = updates.clientId.trim();
            if (clientId && !/^[A-Za-z0-9]{16,64}$/.test(clientId)) {
                throw new SpotifyError('That doesn\'t look like a Spotify client ID');
            }
            if (clientId !== (next.clientId || '')) {
                next.clientId = clientId;
                delete next.accessToken;
                delete next.accessTokenExpiresAt;
                delete next.refreshToken;
                delete next.user;
            }
        }
        if ('deviceId' in updates) {
            next.deviceId = updates.deviceId || null;
            next.deviceName = updates.deviceId ? (updates.deviceName || null) : null;
        }
        this.settings = next;
        await this._save();
        this._emitStatus();
        return this.getStatus();
    }

    // --- Login ------------------------------------------------------------

    /** The Spotify consent page URL to send the browser to. */
    beginLogin() {
        if (!this.settings.clientId) {
            throw new SpotifyError('Enter your Spotify app\'s client ID first');
        }
        const now = Date.now();
        for (const [key, pending] of this._pendingLogins) {
            if (now - pending.createdAt > PENDING_LOGIN_TTL_MS) this._pendingLogins.delete(key);
        }
        const state = base64url(crypto.randomBytes(16));
        const verifier = base64url(crypto.randomBytes(48));
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
        const redirectUri = this.getRedirectUri();
        this._pendingLogins.set(state, { verifier, redirectUri, createdAt: now });

        const params = new URLSearchParams({
            client_id: this.settings.clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            code_challenge_method: 'S256',
            code_challenge: challenge,
            scope: SCOPES.join(' '),
            state,
        });
        return `${this.accountsUrl}/authorize?${params}`;
    }

    /** Spotify sent the browser back with ?code&state (or ?error). */
    async completeLogin({ code, state, error }) {
        const pending = state ? this._pendingLogins.get(state) : null;
        if (state) this._pendingLogins.delete(state);
        if (error) {
            throw new SpotifyError(error === 'access_denied' ? 'Spotify access was not granted' : `Spotify login failed: ${error}`);
        }
        if (!pending || Date.now() - pending.createdAt > PENDING_LOGIN_TTL_MS) {
            throw new SpotifyError('This login link has expired - start again from Settings');
        }
        if (!code) {
            throw new SpotifyError('Spotify did not return an authorization code');
        }
        const tokens = await this._tokenRequest({
            grant_type: 'authorization_code',
            code,
            redirect_uri: pending.redirectUri,
            client_id: this.settings.clientId,
            code_verifier: pending.verifier,
        });
        this._storeTokens(tokens);
        await this._save();

        try {
            const me = await this.request('GET', '/me');
            this.settings.user = {
                id: me?.id || null,
                displayName: me?.display_name || me?.id || null,
                product: me?.product || null,
            };
            await this._save();
        } catch (meError) {
            console.warn(`SpotifyClient: Logged in, but could not read the account: ${meError.message}`);
        }
        this._emitStatus();
        return this.getStatus();
    }

    async logout() {
        delete this.settings.accessToken;
        delete this.settings.accessTokenExpiresAt;
        delete this.settings.refreshToken;
        delete this.settings.user;
        await this._save();
        this._emitStatus();
        return this.getStatus();
    }

    _storeTokens(tokens) {
        this.settings.accessToken = tokens.access_token;
        this.settings.accessTokenExpiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
        // A refresh may or may not hand out a new refresh token.
        if (tokens.refresh_token) this.settings.refreshToken = tokens.refresh_token;
    }

    async _tokenRequest(form) {
        let response;
        try {
            response = await fetch(`${this.accountsUrl}/api/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(form),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            throw new SpotifyError(`Could not reach Spotify: ${error.message}`);
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new SpotifyError(body.error_description || body.error || `Spotify login failed (HTTP ${response.status})`, {
                status: response.status,
                reason: body.error || null,
            });
        }
        return body;
    }

    async _refreshAccessToken() {
        if (!this._refreshing) {
            this._refreshing = (async () => {
                if (!this.isConnected()) {
                    throw new SpotifyError('Spotify is not connected - connect it in Settings', { status: 401 });
                }
                try {
                    const tokens = await this._tokenRequest({
                        grant_type: 'refresh_token',
                        refresh_token: this.settings.refreshToken,
                        client_id: this.settings.clientId,
                    });
                    this._storeTokens(tokens);
                    await this._save();
                } catch (error) {
                    // The login was revoked or the client ID changed on
                    // Spotify's side: only a new login can fix that.
                    if (error.reason === 'invalid_grant' || error.reason === 'invalid_client') {
                        await this.logout();
                        throw new SpotifyError('The Spotify login has expired - reconnect Spotify in Settings', { status: 401 });
                    }
                    throw error;
                }
            })().finally(() => {
                this._refreshing = null;
            });
        }
        return this._refreshing;
    }

    async _accessToken() {
        if (!this.isConnected()) {
            throw new SpotifyError('Spotify is not connected - connect it in Settings', { status: 401 });
        }
        const expiresAt = this.settings.accessTokenExpiresAt || 0;
        if (!this.settings.accessToken || Date.now() > expiresAt - TOKEN_REFRESH_MARGIN_MS) {
            await this._refreshAccessToken();
        }
        return this.settings.accessToken;
    }

    // --- API requests -----------------------------------------------------

    /**
     * An authenticated Web API call. Resolves with the parsed JSON body, or
     * null for an empty response (204, as e.g. "nothing is playing" is).
     */
    async request(method, apiPath, { query, body } = {}) {
        const url = new URL(`${this.apiUrl}${apiPath}`);
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }

        const send = async () => {
            const token = await this._accessToken();
            try {
                return await fetch(url, {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                    },
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
            } catch (error) {
                throw new SpotifyError(`Could not reach Spotify: ${error.message}`);
            }
        };

        let response = await send();
        if (response.status === 401) {
            await this._refreshAccessToken();
            response = await send();
        }

        const text = await response.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = null;
            }
        }
        if (!response.ok) {
            const apiMessage = json?.error?.message || null;
            const reason = json?.error?.reason || null;
            const error = new SpotifyError(friendlyMessage(response.status, reason, apiMessage), { status: response.status, reason });
            const retryAfter = Number(response.headers.get('retry-after'));
            if (Number.isFinite(retryAfter)) error.retryAfterMs = retryAfter * 1000;
            throw error;
        }
        return json;
    }

    /**
     * What a Spotify link points at, for naming a cue after it:
     * { uri, type, name, subtitle, durationSec, trackCount }.
     */
    async describe(link) {
        const target = parseSpotifyLink(link);
        if (!target) {
            throw new SpotifyError('Not a Spotify link - copy one with Share > Copy link in Spotify');
        }
        const base = { uri: target.uri, type: target.type, name: null, subtitle: null, durationSec: 0, trackCount: null };
        const data = await this.request('GET', `/${target.type}s/${target.id}`);
        const artists = (list) => (list || []).map((artist) => artist.name).filter(Boolean).join(', ') || null;
        switch (target.type) {
            case 'track':
                return { ...base, name: data?.name, subtitle: artists(data?.artists), durationSec: (data?.duration_ms || 0) / 1000 };
            case 'episode':
                return { ...base, name: data?.name, subtitle: data?.show?.name || null, durationSec: (data?.duration_ms || 0) / 1000 };
            case 'album':
                return { ...base, name: data?.name, subtitle: artists(data?.artists), trackCount: data?.total_tracks ?? null };
            case 'playlist':
                return {
                    ...base,
                    name: data?.name,
                    subtitle: data?.owner?.display_name || null,
                    trackCount: data?.tracks?.total ?? data?.items?.total ?? null,
                };
            case 'show':
                return { ...base, name: data?.name, subtitle: data?.publisher || null, trackCount: data?.total_episodes ?? null };
            default:
                return { ...base, name: data?.name || null };
        }
    }

    async getDevices() {
        const body = await this.request('GET', '/me/player/devices');
        return (body?.devices || []).map((device) => ({
            id: device.id,
            name: device.name,
            type: device.type,
            isActive: Boolean(device.is_active),
            isRestricted: Boolean(device.is_restricted),
            supportsVolume: device.supports_volume !== false,
            volumePercent: typeof device.volume_percent === 'number' ? device.volume_percent : null,
        }));
    }
}

module.exports = { SpotifyClient, SpotifyError };
