/**
 * Server-side Audio Playback Manager
 *
 * RtAudio output + SoundboardMixer PCM engine (server-primary playout). The
 * stream and the mixer run on a worker thread (WorkerMixer) so the rest of
 * the server can't make an audio buffer late; the RtAudio instance here is
 * only used to list and pick devices.
 */

const fs = require('fs-extra');
const path = require('path');
const { RtAudio } = require('@hamitzor/rtaudio.js');
const WorkerMixer = require('./workerMixer');
const { toShared } = require('./workerMixer');
const { decodeToFloat32 } = require('./audioDecoder');
const { getCachedDecoded, warmPcmCache } = require('./pcmCache');
const { normalizeOutputPatch } = require('./utils/outputPatch');
const { LruCache } = require('./utils/lruCache');

function estimateFloat32Bytes(floatBuffer) {
    return floatBuffer ? floatBuffer.length * 4 : 0;
}

function resolveDeviceId(deviceIdSpec, rt) {
    if (deviceIdSpec === 'default' || deviceIdSpec == null || deviceIdSpec === '') {
        return rt.getDefaultOutputDevice();
    }

    const numericId = Number(deviceIdSpec);
    if (!Number.isNaN(numericId)) {
        return numericId;
    }

    const devices = rt.getDevices();
    const byName = devices.find((d) => d.name === deviceIdSpec);
    return byName ? byName.id : rt.getDefaultOutputDevice();
}

function resolveChannelCount(requested, deviceId, rt) {
    const devices = rt.getDevices();
    const device = devices.find((d) => d.id === deviceId);
    const maxChannels = device?.outputChannels || 2;
    const channels = requested || 2;
    return Math.max(1, Math.min(channels, maxChannels));
}

function formatOutputDevices(devices) {
    return devices
        .filter((d) => d.outputChannels > 0)
        .map((d) => ({
            id: d.id,
            name: d.name,
            outputChannels: d.outputChannels,
            isDefaultOutput: Boolean(d.isDefaultOutput),
            preferredSampleRate: d.preferredSampleRate,
            sampleRates: d.sampleRates,
        }));
}

class AudioPlaybackManager {
    constructor() {
        this.rt = null;
        this.mixer = null;
        this.playingCues = new Map();
        this.audioBuffers = new LruCache({
            maxEntries: 50,
            maxBytes: 512 * 1024 * 1024,
        });
        this.isInitialized = false;
        this.streamOpen = false;
        this.initError = null;
        this.onPlaybackEnd = null;
        this.onPlaybackAdvance = null;
        // cueId -> the next item queued to follow on gaplessly (queueNext).
        this.queuedNext = new Map();

        this.sampleRate = 48000;
        this.channelCount = 2;
        this.bufferSize = 512;
        this.deviceId = null;
        this.pcmCacheDir = null;
        this.masterVolume = 1.0;
        this.onEngineError = null;
    }

    static listOutputDevices() {
        const rt = new RtAudio();
        try {
            return formatOutputDevices(rt.getDevices());
        } finally {
            try {
                rt.closeStream();
            } catch {
                // No stream open — ignore
            }
        }
    }

    getOutputDevices() {
        if (!this.rt) {
            this.rt = new RtAudio();
        }
        return formatOutputDevices(this.rt.getDevices());
    }

    async init(config = {}) {
        try {
            console.log('AudioPlaybackManager: Initializing audio engine...');
            this._applyConfigValues(config);

            this._ensureMixer();

            this.isInitialized = true;
            this.streamOpen = false;
            this.initError = null;
            console.log(
                'AudioPlaybackManager: Engine ready '
                + `(device ${this.deviceId}, ${this.channelCount}ch @ ${this.sampleRate}Hz — stream opens on playback)`
            );
        } catch (error) {
            this.isInitialized = false;
            this.initError = error.message;
            console.error('AudioPlaybackManager: Failed to initialize:', error);
        }
    }

    _ensureMixer() {
        if (this.mixer) {
            this.mixer.setSampleRate(this.sampleRate);
            this.mixer.setChannelCount(this.channelCount);
            return;
        }
        this.mixer = new WorkerMixer({
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
        });
        this.mixer.setCueCompleteCallback((cueId, reason) => {
            this.handlePlaybackEnd(cueId, reason);
        });
        this.mixer.setCueAdvanceCallback((cueId, token) => {
            this.handlePlaybackAdvance(cueId, token);
        });
        // Native-layer conditions (device removed, driver errors), render
        // exceptions and the engine thread dying reach clients this way
        // instead of playback silently stopping with nothing in the UI.
        this.mixer.setEngineErrorCallback((error) => {
            this.streamOpen = false;
            if (this.onEngineError) {
                this.onEngineError(error);
            }
        });
        this.mixer.setMasterGain(this.masterVolume);
    }

    async ensureStreamOpen() {
        if (!this.isInitialized) {
            throw new Error(this.initError || 'Audio engine not initialized');
        }
        // Opening is async now (it happens on the audio thread): cues
        // started together share one open instead of reopening in turn.
        if (!this._opening) {
            this._opening = (async () => {
                if (this.streamOpen && await this.mixer.isStreamRunning()) {
                    return;
                }
                await this._openStream();
            })().finally(() => {
                this._opening = null;
            });
        }
        await this._opening;
    }

    _applyConfigValues(config = {}) {
        this.sampleRate = config.audioSampleRate || 48000;
        this.bufferSize = config.audioBufferSize || 512;
        this.pcmCacheDir = config.pcmCacheDir || null;

        if (!this.rt) {
            this.rt = new RtAudio();
        }

        this.deviceId = resolveDeviceId(config.audioOutputDeviceId, this.rt);
        this.channelCount = resolveChannelCount(
            config.audioOutputChannelCount,
            this.deviceId,
            this.rt
        );
    }

    // Stops and closes the output stream. The worker does it without
    // deadlocking against a pending render callback (FIX_PLAN.md G8).
    async _closeStream(timeoutMs = 2000) {
        try {
            await this.mixer?.closeStream?.(timeoutMs);
        } catch (error) {
            console.warn('AudioPlaybackManager: Error closing stream:', error.message);
        }
        this.streamOpen = false;
    }

    async _openStream() {
        this._ensureMixer();

        const { deviceName } = await this.mixer.openStream({
            deviceId: this.deviceId,
            channelCount: this.channelCount,
            sampleRate: this.sampleRate,
            bufferSize: this.bufferSize,
        });
        this.streamOpen = true;
        this.initError = null;

        console.log(
            `AudioPlaybackManager: RtAudio stream open (audio thread) — ${deviceName}, `
            + `${this.channelCount}ch @ ${this.sampleRate}Hz, buffer ${this.bufferSize}`
        );
    }

    async applyAudioConfig(config = {}) {
        const nextDeviceId = resolveDeviceId(config.audioOutputDeviceId, this.rt || new RtAudio());
        const rt = this.rt || new RtAudio();
        const nextChannelCount = resolveChannelCount(config.audioOutputChannelCount, nextDeviceId, rt);
        const nextSampleRate = config.audioSampleRate || this.sampleRate || 48000;
        const nextBufferSize = config.audioBufferSize || this.bufferSize || 512;

        const unchanged = this.isInitialized
            && this.deviceId === nextDeviceId
            && this.channelCount === nextChannelCount
            && this.sampleRate === nextSampleRate
            && this.bufferSize === nextBufferSize;

        if (unchanged) {
            return { success: true, unchanged: true };
        }

        await this.stopAllCues(false);
        this._applyConfigValues({
            ...config,
            audioOutputDeviceId: config.audioOutputDeviceId,
            audioOutputChannelCount: nextChannelCount,
            audioSampleRate: nextSampleRate,
            audioBufferSize: nextBufferSize,
            pcmCacheDir: config.pcmCacheDir ?? this.pcmCacheDir,
        });

        try {
            await this._openStream();
            return { success: true, unchanged: false };
        } catch (error) {
            this.isInitialized = false;
            this.initError = error.message;
            return { success: false, error: error.message };
        }
    }

    getMaxOutputChannels() {
        if (!this.rt) {
            return 2;
        }
        const device = this.rt.getDevices().find((d) => d.id === this.deviceId);
        return device?.outputChannels || this.channelCount || 2;
    }

    async loadAudioBuffer(filePath) {
        const cached = this.audioBuffers.get(filePath);
        if (cached) {
            return cached;
        }

        console.log(`AudioPlaybackManager: Decoding audio file: ${filePath}`);

        if (this.pcmCacheDir) {
            const cachedDisk = await getCachedDecoded(filePath, this.pcmCacheDir, this.sampleRate);
            if (cachedDisk) {
                cachedDisk.floatBuffer = toShared(cachedDisk.floatBuffer);
                this.audioBuffers.set(filePath, cachedDisk, estimateFloat32Bytes(cachedDisk.floatBuffer));
                console.log(`AudioPlaybackManager: Loaded PCM cache for ${path.basename(filePath)}`);
                return cachedDisk;
            }
        }

        const decoded = await decodeToFloat32(filePath, this.sampleRate);
        // Shared with the audio thread rather than copied to it on every play.
        decoded.floatBuffer = toShared(decoded.floatBuffer);
        this.audioBuffers.set(filePath, decoded, estimateFloat32Bytes(decoded.floatBuffer));

        console.log(`AudioPlaybackManager: Decoded ${path.basename(filePath)} (${decoded.durationSec.toFixed(2)}s)`);
        return decoded;
    }

    async playCue(cueId, filePath, options = {}) {
        try {
            if (!this.isInitialized || !this.mixer) {
                return {
                    success: false,
                    error: this.initError || 'Audio engine not initialized',
                };
            }

            await this.ensureStreamOpen();

            console.log(`AudioPlaybackManager: Playing cue ${cueId}: ${path.basename(filePath)}`);

            // A new instance plays on top of the cue's current voices;
            // anything else replaces them.
            if (this.playingCues.has(cueId) && !options.newInstance) {
                await this.stopCue(cueId);
            } else if (options.newInstance) {
                // What follows on is decided again for the new voice.
                this.clearNext(cueId);
            }

            const decoded = await this.loadAudioBuffer(filePath);
            const trimStartTime = options.trimStartTime || 0;
            const trimEndTime = options.trimEndTime ?? decoded.durationSec;

            const playbackInfo = {
                cueId,
                filePath,
                trimStartTime,
                trimEndTime,
                volume: options.volume ?? 1.0,
                fadeInTime: options.fadeInTime || 0,
                fadeOutTime: options.fadeOutTime || 0,
                loop: options.loop || false,
                isPaused: false,
                outputPatch: normalizeOutputPatch(
                    options.outputPatch,
                    this.channelCount
                ),
            };

            this.mixer.playCue(cueId, decoded.floatBuffer, {
                sampleRate: decoded.sampleRate,
                channels: decoded.channels,
                trimStartTime,
                trimEndTime,
                volume: playbackInfo.volume,
                fadeInTime: playbackInfo.fadeInTime,
                loop: playbackInfo.loop,
                outputPatch: playbackInfo.outputPatch,
                duckGain: options.duckGain ?? 1,
                newInstance: Boolean(options.newInstance),
            });

            this.playingCues.set(cueId, playbackInfo);

            console.log(`AudioPlaybackManager: Started playback for cue ${cueId}`);

            return {
                success: true,
                playbackInfo,
            };
        } catch (error) {
            console.error(`AudioPlaybackManager: Error playing cue ${cueId}:`, error);
            return {
                success: false,
                error: error.message,
            };
        }
    }

    /**
     * Queues a file to follow the cue's current one with no gap (WO-006:
     * a playlist's next item): the engine plays straight on into it when the
     * current one ends, and onPlaybackAdvance(cueId, token) fires instead of
     * onPlaybackEnd. `stillWanted()` is asked once the file is loaded - if
     * the cue has moved on meanwhile, nothing is queued. Returns whether it
     * was queued.
     */
    async queueNext(cueId, filePath, { trimStartTime = 0, trimEndTime = null, token } = {}, stillWanted = () => true) {
        if (!this.mixer || !this.playingCues.has(cueId)) return false;
        const decoded = await this.loadAudioBuffer(filePath);
        if (!this.playingCues.has(cueId) || !stillWanted()) return false;
        const next = { filePath, trimStartTime, trimEndTime: trimEndTime ?? decoded.durationSec, token };
        this.queuedNext.set(cueId, next);
        return this.mixer.queueNext(cueId, decoded.floatBuffer, {
            sampleRate: decoded.sampleRate,
            channels: decoded.channels,
            trimStartTime: next.trimStartTime,
            trimEndTime: next.trimEndTime,
            token,
        });
    }

    clearNext(cueId) {
        if (this.queuedNext.delete(cueId)) this.mixer?.clearNext(cueId);
    }

    handlePlaybackAdvance(cueId, token) {
        const next = this.queuedNext.get(cueId);
        const playbackInfo = this.playingCues.get(cueId);
        if (next && next.token === token && playbackInfo) {
            this.queuedNext.delete(cueId);
            playbackInfo.filePath = next.filePath;
            playbackInfo.trimStartTime = next.trimStartTime;
            playbackInfo.trimEndTime = next.trimEndTime;
        }
        this.onPlaybackAdvance?.(cueId, token);
    }

    setPlaybackAdvanceCallback(callback) {
        this.onPlaybackAdvance = callback;
    }

    // `fading` in the result tells the caller which of two very different
    // things happened: an immediate stop (cue is gone now, and the mixer
    // will never fire onCueComplete for it) or a fade that has only just
    // started (onCueComplete fires with reason 'stopped' once it reaches
    // silence). Callers must not guess this from their own fade settings -
    // a fade of 0 seconds is an immediate stop, and a caller that assumed
    // otherwise waited forever for a completion that never came.
    //
    // fadeOverrideSeconds replaces the cue's own fadeOutTime (Stop All uses
    // its own configured fade time rather than each cue's).
    async stopCue(cueId, fadeOut = false, fadeOverrideSeconds = null) {
        try {
            const playbackInfo = this.playingCues.get(cueId);
            if (!playbackInfo || !this.mixer) {
                return { success: true, fading: false };
            }

            let fadeSeconds = 0;
            if (fadeOut) {
                fadeSeconds = fadeOverrideSeconds ?? playbackInfo.fadeOutTime;
            }
            // A paused cue renders no frames, so its gain ramp would never
            // advance and the fade would never finish - stop it outright.
            if (playbackInfo.isPaused) {
                fadeSeconds = 0;
            }
            this.queuedNext.delete(cueId); // the mixer drops it with the stop
            this.mixer.stopCue(cueId, fadeSeconds);

            const fading = fadeSeconds > 0;
            if (!fading) {
                this.playingCues.delete(cueId);
            }

            console.log(`AudioPlaybackManager: Stopped cue ${cueId}${fading ? ` (fading over ${fadeSeconds}s)` : ''}`);
            return { success: true, fading };
        } catch (error) {
            console.error(`AudioPlaybackManager: Error stopping cue ${cueId}:`, error);
            return {
                success: false,
                error: error.message,
            };
        }
    }

    async stopAllCues(fadeOut = false, fadeOverrideSeconds = null) {
        try {
            const cueIds = Array.from(this.playingCues.keys());
            const results = [];

            for (const cueId of cueIds) {
                const result = await this.stopCue(cueId, fadeOut, fadeOverrideSeconds);
                results.push({ cueId, ...result });
            }

            console.log(`AudioPlaybackManager: Stopped ${cueIds.length} cues`);
            return {
                success: true,
                results,
            };
        } catch (error) {
            console.error('AudioPlaybackManager: Error stopping all cues:', error);
            return {
                success: false,
                error: error.message,
            };
        }
    }

    async pauseCue(cueId) {
        try {
            const playbackInfo = this.playingCues.get(cueId);
            if (!playbackInfo || playbackInfo.isPaused || !this.mixer) {
                return { success: false, error: 'Cue not playing' };
            }

            if (!this.mixer.pauseCue(cueId)) {
                return { success: false, error: 'Cue not playing' };
            }

            playbackInfo.isPaused = true;
            console.log(`AudioPlaybackManager: Paused cue ${cueId}`);
            return { success: true, status: 'paused' };
        } catch (error) {
            console.error(`AudioPlaybackManager: Error pausing cue ${cueId}:`, error);
            return { success: false, error: error.message };
        }
    }

    async resumeCue(cueId) {
        try {
            const playbackInfo = this.playingCues.get(cueId);
            if (!playbackInfo || !playbackInfo.isPaused || !this.mixer) {
                return { success: false, error: 'Cue not paused' };
            }

            if (!this.mixer.resumeCue(cueId)) {
                return { success: false, error: 'Cue not paused' };
            }

            playbackInfo.isPaused = false;
            console.log(`AudioPlaybackManager: Resumed cue ${cueId}`);
            return { success: true, status: 'playing' };
        } catch (error) {
            console.error(`AudioPlaybackManager: Error resuming cue ${cueId}:`, error);
            return { success: false, error: error.message };
        }
    }

    async togglePauseCue(cueId) {
        const playbackInfo = this.playingCues.get(cueId);
        if (!playbackInfo) {
            return { success: false, error: 'Cue not playing' };
        }

        if (playbackInfo.isPaused) {
            return this.resumeCue(cueId);
        }
        return this.pauseCue(cueId);
    }

    /** Ramps a playing cue's duck multiplier (1 = not ducked). */
    setCueDuck(cueId, multiplier, fadeSeconds = 0) {
        return this.mixer ? this.mixer.setDuck(cueId, multiplier, fadeSeconds) : false;
    }

    /** Applies a volume change to a cue that is already playing. */
    setCueVolume(cueId, volume) {
        const playbackInfo = this.playingCues.get(cueId);
        if (playbackInfo) {
            playbackInfo.volume = volume;
        }
        return this.mixer ? this.mixer.setGain(cueId, volume) : false;
    }

    voiceCount(cueId) {
        return this.mixer ? this.mixer.voiceCount(cueId) : 0;
    }

    setMasterVolume(volume) {
        this.masterVolume = Math.max(0, Math.min(2, Number(volume)));
        if (this.mixer) {
            this.mixer.setMasterGain(this.masterVolume);
        }
        console.log(`AudioPlaybackManager: Master volume set to ${this.masterVolume}`);
    }

    getMasterVolume() {
        return this.masterVolume;
    }

    getPlaybackStatus() {
        const mixerStatus = this.mixer ? this.mixer.getStatus() : null;
        return {
            isInitialized: this.isInitialized,
            initError: this.initError,
            deviceId: this.deviceId,
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
            playingCues: Array.from(this.playingCues.keys()),
            totalPlaying: this.playingCues.size,
            cachedBuffers: this.audioBuffers.size,
            mixer: mixerStatus,
        };
    }

    drainPeakLevels() {
        return this.mixer ? this.mixer.drainPeakLevels() : {};
    }

    setPlaybackEndCallback(callback) {
        this.onPlaybackEnd = callback;
    }

    setEngineErrorCallback(callback) {
        this.onEngineError = callback;
    }

    handlePlaybackEnd(cueId, reason = 'completed') {
        this.playingCues.delete(cueId);
        this.queuedNext.delete(cueId);
        console.log(`AudioPlaybackManager: Playback ended for cue ${cueId} (${reason})`);

        if (this.onPlaybackEnd) {
            this.onPlaybackEnd(cueId, reason);
        }
    }

    async cleanup() {
        try {
            await this.stopAllCues();
            this.audioBuffers.clear();

            await this._closeStream();
            await this.mixer?.terminate?.();

            this.rt = null;
            this.mixer = null;
            this.isInitialized = false;

            console.log('AudioPlaybackManager: Cleanup completed');
        } catch (error) {
            console.error('AudioPlaybackManager: Error during cleanup:', error);
        }
    }
}

module.exports = AudioPlaybackManager;
