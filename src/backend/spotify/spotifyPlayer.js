/**
 * Plays Spotify cues through Spotify Connect: the audio comes out of a
 * Spotify player (the Spotify app on this computer, a speaker, ...) that
 * this tells what to play over the Web API. Spotify never hands the audio
 * itself to other apps, so it can't go through the audio engine's mixer -
 * fades and ducking are done with the player's own volume instead.
 *
 * There is one Spotify player, so one Spotify cue plays at a time; starting
 * another replaces it.
 *
 * Events: 'status' (cueId, 'playing' | 'paused') when the player's state
 * changes other than by a command from here (someone pressed pause in the
 * Spotify app); 'ended' (cueId, 'completed' | 'stopped'); 'warning'
 * (message) for problems the operator should see.
 */

const EventEmitter = require('events');
const { parseSpotifyLink } = require('./spotifyUri');
const { SpotifyError } = require('./spotifyClient');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_VOLUME_STEP_MS = 250;
// Spotify takes a moment to report a newly started item; a cue that still
// isn't playing after this long didn't start.
const START_TIMEOUT_MS = 8000;
// After a command, the player's reported state lags behind for a bit.
const SETTLE_MS = 2500;
// How close to its end an item counts as having played out.
const NEAR_END_MS = 1500;
const DEVICE_CACHE_MS = 60 * 1000;

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 1));

// A gain moving from one level to another over time; ms 0 = already there.
function ramp(from, to, ms, now = Date.now()) {
    return { from, to, ms: Math.max(0, ms), startedAt: now };
}

function rampValue(r, now = Date.now()) {
    if (!r.ms) return r.to;
    const t = Math.min(1, (now - r.startedAt) / r.ms);
    return r.from + (r.to - r.from) * t;
}

function rampDone(r, now = Date.now()) {
    return !r.ms || now - r.startedAt >= r.ms;
}

function describeItem(item) {
    if (!item) return null;
    const by = (item.artists || []).map((artist) => artist.name).filter(Boolean).join(', ') || item.show?.name;
    return by ? `${item.name} - ${by}` : item.name || null;
}

class SpotifyPlayer extends EventEmitter {
    constructor(client, options = {}) {
        super();
        this.client = client;
        this.pollMs = Number(process.env.SPOTIFY_POLL_MS) || options.pollMs || DEFAULT_POLL_MS;
        this.volumeStepMs = options.volumeStepMs || DEFAULT_VOLUME_STEP_MS;
        this.active = null;
        this._pollTimer = null;
        this._volumeTimer = null;
        this._pollInFlight = false;
        this._volumeInFlight = false;
        this._backoffUntil = 0;
        this._device = null; // { device, resolvedAt }
    }

    isActive(cueId) {
        return Boolean(this.active && this.active.cueId === cueId);
    }

    activeCueId() {
        return this.active?.cueId ?? null;
    }

    /** True while the cue is audibly playing (for ducking). */
    isSounding(cueId) {
        return this.isActive(cueId) && this.active.status === 'playing';
    }

    // --- Starting -----------------------------------------------------------

    /**
     * @param {object} cue                 a 'spotify' cue
     * @param {object} options
     * @param {number} options.fadeInMs
     * @param {number} options.duckGain    start already ducked (0-1)
     */
    async play(cue, { fadeInMs = 0, duckGain = 1 } = {}) {
        const target = parseSpotifyLink(cue.spotifyUri);
        if (!target) {
            return { success: false, error: 'This cue has no Spotify track or playlist - paste a Spotify link into its properties' };
        }

        // The player can only play one thing: once this starts, whatever it
        // was playing for another cue is over (no pause - this replaces it).
        // Until then that cue keeps its state, but stops reacting to the
        // player, which is about to switch to something else.
        const previous = this.active;
        if (previous) previous.suspended = true;

        try {
            const device = await this._resolveDevice();
            const cueVolume = clamp01(cue.volume ?? 1);
            const fadeMs = device.supportsVolume ? Math.max(0, Number(fadeInMs) || 0) : 0;
            const now = Date.now();
            const active = {
                cueId: cue.id,
                uri: target.uri,
                kind: target.isContext ? 'context' : 'item',
                deviceId: device.id,
                supportsVolume: device.supportsVolume,
                cueVolume,
                fade: ramp(fadeMs > 0 ? 0 : 1, 1, fadeMs, now),
                fadingIn: fadeMs > 0,
                duck: ramp(duckGain, duckGain, 0, now),
                stopping: false,
                status: 'playing',
                confirmed: false,
                startedAt: now,
                settleUntil: now + SETTLE_MS,
                progressMs: 0,
                durationMs: (Number(cue.knownDuration) || 0) * 1000,
                polledAt: now,
                nowPlaying: null,
                sentPercent: null,
            };

            // Set the level first, so nothing blasts in before a fade.
            if (active.supportsVolume) {
                await this._sendVolume(active, this._percent(active, now));
            }

            const body = target.isContext ? { context_uri: target.uri } : { uris: [target.uri] };
            const trackCount = Number(cue.spotifyTrackCount) || 0;
            if (target.isContext && cue.shufflePlaylist && trackCount > 1 && target.type !== 'artist') {
                body.offset = { position: Math.floor(Math.random() * trackCount) };
            }
            await this._command('PUT', '/me/player/play', active, body);

            if (previous) this._finish(previous, 'stopped');
            this.active = active;
            this._startTimers();

            // Best effort: some players don't allow these.
            const repeat = cue.loop ? (target.isContext ? 'context' : 'track') : 'off';
            await this._command('PUT', '/me/player/repeat', active, undefined, { state: repeat }).catch(() => {});
            if (target.isContext) {
                await this._command('PUT', '/me/player/shuffle', active, undefined, { state: Boolean(cue.shufflePlaylist) }).catch(() => {});
            }
            return { success: true };
        } catch (error) {
            if (previous) previous.suspended = false;
            if (error.status === 404) this._device = null;
            return { success: false, error: error.message };
        }
    }

    // The configured device, else the one Spotify is already using, else
    // the first one there is. A configured one is remembered for a while
    // (saving a request per start); "the active one" is looked up every
    // time, as the operator may have switched players in the Spotify app.
    async _resolveDevice() {
        const cached = this._device;
        const { deviceId = null, deviceName = null } = this.client.settings || {};
        if (deviceId && cached && Date.now() - cached.resolvedAt < DEVICE_CACHE_MS && cached.forDeviceId === deviceId) {
            return cached.device;
        }
        const devices = await this.client.getDevices();
        let device;
        if (deviceId) {
            device = devices.find((d) => d.id === deviceId) || (deviceName && devices.find((d) => d.name === deviceName));
            if (!device) {
                throw new SpotifyError(`The Spotify player "${deviceName || deviceId}" isn't available - open Spotify on it, or pick another player in Settings`);
            }
        } else {
            device = devices.find((d) => d.isActive && !d.isRestricted) || devices.find((d) => !d.isRestricted);
        }
        if (!device) {
            throw new SpotifyError('No Spotify player found - open Spotify on this computer, or pick a player in Settings');
        }
        if (device.isRestricted) {
            throw new SpotifyError(`The Spotify player "${device.name}" can't be controlled remotely`);
        }
        this._device = { device, forDeviceId: deviceId, resolvedAt: Date.now() };
        return device;
    }

    // --- Stopping / pausing ------------------------------------------------

    /**
     * fadeOutMs > 0 fades the player's volume down first (when it has
     * one, and is playing); 'ended' (cueId, 'stopped') follows the fade.
     * Otherwise it stops now, with no 'ended'.
     */
    async stop(fadeOutMs = 0) {
        const active = this.active;
        if (!active) {
            return { success: true, fading: false };
        }
        const fadeMs = Math.max(0, Number(fadeOutMs) || 0);
        if (fadeMs > 0 && active.supportsVolume && active.status === 'playing') {
            const now = Date.now();
            active.stopping = true;
            active.fadingIn = false;
            active.fade = ramp(rampValue(active.fade, now), 0, fadeMs, now);
            return { success: true, fading: true };
        }
        this._clear(active);
        await this._silence(active);
        return { success: true, fading: false };
    }

    async pause() {
        const active = this.active;
        if (!active || active.status !== 'playing') {
            return { success: false, error: 'Cue not playing' };
        }
        try {
            await this._command('PUT', '/me/player/pause', active);
            active.status = 'paused';
            active.settleUntil = Date.now() + SETTLE_MS;
            active.progressMs = this._progress(active);
            active.polledAt = Date.now();
            return { success: true, status: 'paused' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async resume() {
        const active = this.active;
        if (!active || active.status !== 'paused') {
            return { success: false, error: 'Cue not paused' };
        }
        try {
            await this._command('PUT', '/me/player/play', active);
            active.status = 'playing';
            active.settleUntil = Date.now() + SETTLE_MS;
            active.polledAt = Date.now();
            return { success: true, status: 'playing' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /** Next / previous track of a playing playlist, album, ... */
    async skip(direction) {
        const active = this.active;
        if (!active || active.kind !== 'context') {
            return { success: false, error: 'Cue not playing a Spotify playlist' };
        }
        try {
            await this._command('POST', direction === 'previous' ? '/me/player/previous' : '/me/player/next', active);
            active.settleUntil = Date.now() + SETTLE_MS;
            active.progressMs = 0;
            active.polledAt = Date.now();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // --- Level ----------------------------------------------------------------

    setDuck(gain, fadeMs = 0) {
        const active = this.active;
        if (!active) return;
        const now = Date.now();
        active.duck = ramp(rampValue(active.duck, now), clamp01(gain), fadeMs, now);
    }

    setCueVolume(volume) {
        if (this.active) this.active.cueVolume = clamp01(volume);
    }

    _percent(active, now = Date.now()) {
        return Math.round(100 * active.cueVolume * rampValue(active.duck, now) * rampValue(active.fade, now));
    }

    async _sendVolume(active, percent) {
        try {
            await this._command('PUT', '/me/player/volume', active, undefined, { volume_percent: percent });
            active.sentPercent = percent;
        } catch (error) {
            // e.g. VOLUME_CONTROL_DISALLOW: this player has a fixed level.
            if (error.status === 403 || error.status === 404) {
                active.supportsVolume = false;
            } else {
                throw error;
            }
        }
    }

    async _volumeTick() {
        const active = this.active;
        if (!active || active.suspended || this._volumeInFlight) return;
        const now = Date.now();
        if (active.fadingIn && rampDone(active.fade, now)) {
            active.fadingIn = false;
        }
        if (active.stopping && (rampDone(active.fade, now) || !active.supportsVolume)) {
            await this._finishFadeOut(active);
            return;
        }
        if (!active.supportsVolume) return;
        const percent = this._percent(active, now);
        if (percent === active.sentPercent) return;
        this._volumeInFlight = true;
        try {
            await this._sendVolume(active, percent);
        } catch (error) {
            this._handleRequestError(error);
        } finally {
            this._volumeInFlight = false;
        }
    }

    // --- Following the player ------------------------------------------------

    async _poll() {
        const active = this.active;
        if (!active || active.suspended || this._pollInFlight || Date.now() < this._backoffUntil) return;
        this._pollInFlight = true;
        try {
            const state = await this.client.request('GET', '/me/player', { query: { additional_types: 'episode' } });
            if (this.active === active && !active.suspended) this._evaluate(active, state);
        } catch (error) {
            if (this.active === active && error.status === 401) {
                this._finish(active, 'stopped');
                this.emit('warning', error.message);
            } else {
                this._handleRequestError(error);
            }
        } finally {
            this._pollInFlight = false;
        }
    }

    _evaluate(active, state) {
        const now = Date.now();
        const item = state?.item || null;
        const matches = Boolean(state) && (active.kind === 'context'
            ? state.context?.uri === active.uri
            : item?.uri === active.uri);

        if (!active.confirmed) {
            if (matches) {
                active.confirmed = true;
            } else {
                if (now - active.startedAt > START_TIMEOUT_MS) {
                    this._finish(active, 'stopped');
                    this.emit('warning', 'Spotify did not start playing the cue - check the Spotify player');
                }
                return;
            }
        }

        const projected = this._progress(active, now);
        const nearEnd = active.durationMs > 0 && projected >= active.durationMs - NEAR_END_MS;

        if (active.stopping && (!matches || !state.is_playing)) {
            void this._finishFadeOut(active);
            return;
        }

        if (!matches) {
            if (now < active.settleUntil) return;
            // Played to the end and Spotify's autoplay carried on with
            // something else: that's not part of the show.
            if (state?.is_playing && nearEnd) {
                void this._command('PUT', '/me/player/pause', active).catch(() => {});
            }
            this._finish(active, 'completed');
            return;
        }

        // The last item ran out and the player stopped on it.
        if (!state.is_playing && active.status === 'playing' && nearEnd && now >= active.settleUntil) {
            this._finish(active, 'completed');
            return;
        }

        active.progressMs = Number(state.progress_ms) || 0;
        active.durationMs = Number(item?.duration_ms) || active.durationMs;
        active.polledAt = now;
        active.nowPlaying = describeItem(item);

        const status = state.is_playing ? 'playing' : 'paused';
        if (status !== active.status && now >= active.settleUntil && !active.stopping) {
            active.status = status;
            this.emit('status', active.cueId, status);
        }
    }

    _progress(active, now = Date.now()) {
        const progress = active.progressMs + (active.status === 'playing' && active.confirmed ? now - active.polledAt : 0);
        return active.durationMs > 0 ? Math.min(progress, active.durationMs) : progress;
    }

    _handleRequestError(error) {
        if (error.status === 429) {
            this._backoffUntil = Date.now() + (error.retryAfterMs || 5000);
        }
    }

    // --- Lifecycle -----------------------------------------------------------

    async _command(method, apiPath, active, body, query = {}) {
        return this.client.request(method, apiPath, { query: { ...query, device_id: active.deviceId }, body });
    }

    // Pauses the player and puts its volume back to the cue's level (a fade
    // left it at 0) - unless another cue has started on it meanwhile.
    async _silence(active) {
        if (this.active) return;
        await this._command('PUT', '/me/player/pause', active).catch(() => {});
        if (active.supportsVolume && !this.active) {
            await this._command('PUT', '/me/player/volume', active, undefined, {
                volume_percent: Math.round(100 * active.cueVolume),
            }).catch(() => {});
        }
    }

    _clear(active) {
        if (this.active === active) {
            this.active = null;
            this._stopTimers();
        }
    }

    // A fade-out reached silence: the cue has stopped once the player has.
    async _finishFadeOut(active) {
        if (this.active !== active) return;
        this._clear(active);
        await this._silence(active);
        this.emit('ended', active.cueId, 'stopped');
    }

    _finish(active, reason) {
        if (this.active !== active) return;
        this._clear(active);
        this.emit('ended', active.cueId, reason);
    }

    _startTimers() {
        this._stopTimers();
        this._pollTimer = setInterval(() => { void this._poll(); }, this.pollMs);
        this._volumeTimer = setInterval(() => { void this._volumeTick(); }, this.volumeStepMs);
        this._pollTimer.unref?.();
        this._volumeTimer.unref?.();
    }

    _stopTimers() {
        clearInterval(this._pollTimer);
        clearInterval(this._volumeTimer);
        this._pollTimer = null;
        this._volumeTimer = null;
    }

    /** What the cue button shows: time, fades, ducking, the current track. */
    snapshot() {
        const active = this.active;
        if (!active) return null;
        const now = Date.now();
        const fadeRemainingMs = active.fade.ms ? Math.max(0, active.fade.ms - (now - active.fade.startedAt)) : 0;
        const duckGain = rampValue(active.duck, now);
        return {
            cueId: active.cueId,
            status: active.status,
            currentTimeSec: this._progress(active, now) / 1000,
            totalDurationSec: active.durationMs / 1000,
            isFadingIn: active.fadingIn && fadeRemainingMs > 0,
            isFadingOut: active.stopping && fadeRemainingMs > 0,
            fadeTimeRemainingMs: (active.fadingIn || active.stopping) ? fadeRemainingMs : 0,
            isDucked: duckGain < 1 - 1e-6,
            duckGain,
            nowPlaying: active.nowPlaying,
            volumePercent: active.supportsVolume ? this._percent(active, now) : null,
        };
    }

    async cleanup() {
        if (this.active) {
            await this.stop(0);
        }
        this._stopTimers();
    }
}

module.exports = { SpotifyPlayer };
