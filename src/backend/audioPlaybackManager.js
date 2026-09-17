/**
 * Server-side Audio Playback Manager
 *
 * RtAudio output + SoundboardMixer PCM engine (server-primary playout).
 */

const fs = require('fs-extra');
const path = require('path');
const { RtAudio, RtAudioFormat } = require('@hamitzor/rtaudio.js');
const SoundboardMixer = require('./soundboardMixer');
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

            if (!this.mixer) {
                this.mixer = new SoundboardMixer({
                    sampleRate: this.sampleRate,
                    channelCount: this.channelCount,
                });
                this.mixer.setCueCompleteCallback((cueId) => {
                    this.handlePlaybackEnd(cueId);
                });
                this.mixer.setMasterGain(this.masterVolume);
            } else {
                this.mixer.setSampleRate(this.sampleRate);
                this.mixer.setChannelCount(this.channelCount);
            }

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

    async ensureStreamOpen() {
        if (!this.isInitialized) {
            throw new Error(this.initError || 'Audio engine not initialized');
        }
        if (this.streamOpen && this.rt?.isStreamOpen() && this.rt?.isStreamRunning()) {
            return;
        }
        await this._openStream();
        this.streamOpen = true;
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

    _closeStream() {
        if (!this.rt) {
            return;
        }

        try {
            if (this.rt.isStreamRunning()) {
                this.rt.stopStream();
            }
            if (this.rt.isStreamOpen()) {
                this.rt.closeStream();
            }
        } catch (error) {
            console.warn('AudioPlaybackManager: Error closing stream:', error.message);
        }
        this.streamOpen = false;
    }

    async _openStream() {
        if (!this.mixer) {
            this.mixer = new SoundboardMixer({
                sampleRate: this.sampleRate,
                channelCount: this.channelCount,
            });
            this.mixer.setCueCompleteCallback((cueId) => {
                this.handlePlaybackEnd(cueId);
            });
            this.mixer.setMasterGain(this.masterVolume);
        } else {
            this.mixer.setSampleRate(this.sampleRate);
            this.mixer.setChannelCount(this.channelCount);
        }

        this._closeStream();

        const device = this.rt.getDevices().find((d) => d.id === this.deviceId);
        const deviceName = device?.name || `device ${this.deviceId}`;

        // setErrorCallback surfaces native-layer conditions (device removed,
        // driver-level errors) that would otherwise only be printed to
        // stderr by the native addon with no way for the app to react. Wire
        // it to the same onEngineError hook the render-callback catch below
        // uses, so both paths reach the frontend the same way.
        if (typeof this.rt.setErrorCallback === 'function') {
            this.rt.setErrorCallback((errType, message) => {
                console.error(`AudioPlaybackManager: RtAudio error (${errType}): ${message}`);
                this.streamOpen = false;
                if (this.onEngineError) {
                    this.onEngineError({ type: String(errType), message: String(message) });
                }
            });
        }

        this.rt.openStream(
            { deviceId: this.deviceId, nChannels: this.channelCount },
            null,
            RtAudioFormat.RTAUDIO_FLOAT32,
            this.sampleRate,
            this.bufferSize,
            null,
            (output, _input, nFrames) => {
                try {
                    const sampleCount = nFrames * this.channelCount;
                    const out = new Float32Array(output.buffer, output.byteOffset, sampleCount);
                    this.mixer.render(out, nFrames, this.channelCount);
                } catch (error) {
                    // A throw from inside this native-driven callback would
                    // otherwise be an uncaught exception with no JS stack
                    // context tying it back here. Log it, mute this cycle's
                    // output (buffer is already silence-filled on failure
                    // paths inside render()), and keep the stream alive
                    // rather than taking down the whole process.
                    console.error('AudioPlaybackManager: Error in mixer render callback:', error);
                    if (this.onEngineError) {
                        this.onEngineError({ type: 'render-exception', message: error.message });
                    }
                }
                return 0;
            }
        );

        this.rt.startStream();
        this.streamOpen = true;
        this.initError = null;

        console.log(
            `AudioPlaybackManager: RtAudio stream open — ${deviceName}, `
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

        await this.stopAllCues(true);
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
                this.audioBuffers.set(filePath, cachedDisk, estimateFloat32Bytes(cachedDisk.floatBuffer));
                console.log(`AudioPlaybackManager: Loaded PCM cache for ${path.basename(filePath)}`);
                return cachedDisk;
            }
        }

        const decoded = await decodeToFloat32(filePath, this.sampleRate);
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

            if (this.playingCues.has(cueId)) {
                await this.stopCue(cueId);
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

    async stopCue(cueId, fadeOut = false) {
        try {
            const playbackInfo = this.playingCues.get(cueId);
            if (!playbackInfo || !this.mixer) {
                return { success: true };
            }

            const fadeSeconds = fadeOut ? playbackInfo.fadeOutTime : 0;
            this.mixer.stopCue(cueId, fadeSeconds);

            if (!fadeOut || fadeSeconds <= 0) {
                this.playingCues.delete(cueId);
            }

            console.log(`AudioPlaybackManager: Stopped cue ${cueId}`);
            return { success: true };
        } catch (error) {
            console.error(`AudioPlaybackManager: Error stopping cue ${cueId}:`, error);
            return {
                success: false,
                error: error.message,
            };
        }
    }

    async stopAllCues(fadeOut = false) {
        try {
            const cueIds = Array.from(this.playingCues.keys());
            const results = [];

            for (const cueId of cueIds) {
                const result = await this.stopCue(cueId, fadeOut);
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

    setMasterVolume(volume) {
        this.masterVolume = Math.max(0, Math.min(2, Number(volume)));
        if (this.mixer) {
            this.mixer.setMasterGain(this.masterVolume);
        }
        console.log(`AudioPlaybackManager: Master volume set to ${this.masterVolume}`);
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

    setPlaybackEndCallback(callback) {
        this.onPlaybackEnd = callback;
    }

    setEngineErrorCallback(callback) {
        this.onEngineError = callback;
    }

    handlePlaybackEnd(cueId) {
        this.playingCues.delete(cueId);
        console.log(`AudioPlaybackManager: Playback ended for cue ${cueId}`);

        if (this.onPlaybackEnd) {
            this.onPlaybackEnd(cueId);
        }
    }

    async cleanup() {
        try {
            await this.stopAllCues();
            this.audioBuffers.clear();

            if (this.rt) {
                this._closeStream();
            }

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
