/**
 * PCM mixing engine for server-primary audio output (RtAudio callback).
 * All mixing runs synchronously inside render() — no async, no allocations in hot path.
 */

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function secondsToFrame(timeSec, sampleRate) {
    return Math.max(0, Math.floor(timeSec * sampleRate));
}

function computeGainStep(current, target, fadeSeconds, sampleRate) {
    if (fadeSeconds <= 0 || sampleRate <= 0) {
        return target - current;
    }
    const fadeFrames = fadeSeconds * sampleRate;
    if (fadeFrames <= 0) {
        return target - current;
    }
    return (target - current) / fadeFrames;
}

class SoundboardMixer {
    constructor({ sampleRate = 48000, channelCount = 2 } = {}) {
        this.sampleRate = sampleRate;
        this.channelCount = channelCount;
        this.activeCues = new Map();
        this.onCueComplete = null;
    }

    setChannelCount(channelCount) {
        this.channelCount = channelCount;
    }

    setSampleRate(sampleRate) {
        this.sampleRate = sampleRate;
    }

    setCueCompleteCallback(callback) {
        this.onCueComplete = callback;
    }

    playCue(cueId, floatBuffer, options = {}) {
        const channels = options.channels || 2;
        const sampleRate = options.sampleRate || this.sampleRate;
        const totalFrames = Math.floor(floatBuffer.length / channels);

        const trimStartTime = options.trimStartTime || 0;
        const trimEndTime = options.trimEndTime != null
            ? options.trimEndTime
            : totalFrames / sampleRate;

        const trimStartFrame = clamp(
            secondsToFrame(trimStartTime, sampleRate),
            0,
            Math.max(0, totalFrames - 1)
        );
        const trimEndFrame = clamp(
            secondsToFrame(trimEndTime, sampleRate),
            trimStartFrame + 1,
            totalFrames
        );

        const volume = options.volume ?? 1.0;
        const fadeInTime = options.fadeInTime || 0;
        const outputPatch = options.outputPatch || [0, 1];

        const cue = {
            id: cueId,
            buffer: floatBuffer,
            channels,
            sampleRate,
            trimStartFrame,
            trimEndFrame,
            position: trimStartFrame,
            loop: Boolean(options.loop),
            outputPatch: [
                clamp(outputPatch[0] ?? 0, 0, this.channelCount - 1),
                clamp(outputPatch[1] ?? outputPatch[0] ?? 1, 0, this.channelCount - 1),
            ],
            volume,
            currentGain: fadeInTime > 0 ? 0 : volume,
            gainTarget: volume,
            gainStep: computeGainStep(fadeInTime > 0 ? 0 : volume, volume, fadeInTime, sampleRate),
            stopping: false,
            isPaused: false,
            startedAt: Date.now(),
        };

        this.activeCues.set(cueId, cue);
        return cue;
    }

    stopCue(cueId, fadeOutSeconds = 0) {
        const cue = this.activeCues.get(cueId);
        if (!cue) {
            return false;
        }

        if (fadeOutSeconds <= 0) {
            this.activeCues.delete(cueId);
            return true;
        }

        cue.stopping = true;
        cue.gainTarget = 0;
        cue.gainStep = computeGainStep(cue.currentGain, 0, fadeOutSeconds, cue.sampleRate);
        return true;
    }

    stopAll(fadeOutSeconds = 0) {
        for (const cueId of Array.from(this.activeCues.keys())) {
            this.stopCue(cueId, fadeOutSeconds);
        }
    }

    setGain(cueId, volume) {
        const cue = this.activeCues.get(cueId);
        if (!cue) {
            return false;
        }
        cue.volume = volume;
        cue.gainTarget = volume;
        cue.gainStep = volume - cue.currentGain;
        return true;
    }

    pauseCue(cueId) {
        const cue = this.activeCues.get(cueId);
        if (!cue || cue.isPaused) {
            return false;
        }
        cue.isPaused = true;
        return true;
    }

    resumeCue(cueId) {
        const cue = this.activeCues.get(cueId);
        if (!cue || !cue.isPaused) {
            return false;
        }
        cue.isPaused = false;
        return true;
    }

    getStatus() {
        const playing = [];
        for (const [cueId, cue] of this.activeCues) {
            const positionSec = cue.position / cue.sampleRate;
            playing.push({
                cueId,
                isPaused: cue.isPaused,
                stopping: cue.stopping,
                positionSec,
                trimStartSec: cue.trimStartFrame / cue.sampleRate,
                trimEndSec: cue.trimEndFrame / cue.sampleRate,
                volume: cue.volume,
                currentGain: cue.currentGain,
                outputPatch: [...cue.outputPatch],
            });
        }
        return {
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
            activeCount: this.activeCues.size,
            playing,
        };
    }

    render(outputBuffer, nFrames, nChannels) {
        outputBuffer.fill(0);

        const toRemove = [];

        for (const [cueId, cue] of this.activeCues) {
            if (cue.isPaused) {
                continue;
            }

            const patchL = cue.outputPatch[0];
            const patchR = cue.outputPatch[1];
            const buf = cue.buffer;
            const ch = cue.channels;

            for (let f = 0; f < nFrames; f++) {
                if (cue.position >= cue.trimEndFrame) {
                    if (cue.loop) {
                        cue.position = cue.trimStartFrame;
                    } else {
                        toRemove.push(cueId);
                        break;
                    }
                }

                const idx = cue.position * ch;
                const left = buf[idx] || 0;
                const right = buf[idx + 1] ?? left;

                const vol = cue.currentGain;
                const outBase = f * nChannels;
                outputBuffer[outBase + patchL] += left * vol;
                if (patchR !== patchL) {
                    outputBuffer[outBase + patchR] += right * vol;
                }

                cue.position++;

                if (cue.gainTarget !== cue.currentGain) {
                    cue.currentGain += cue.gainStep;
                    if (Math.abs(cue.gainTarget - cue.currentGain) < Math.abs(cue.gainStep)) {
                        cue.currentGain = cue.gainTarget;
                    }
                    if (cue.stopping && cue.currentGain === 0) {
                        toRemove.push(cueId);
                        break;
                    }
                }
            }
        }

        for (const cueId of toRemove) {
            this.activeCues.delete(cueId);
            if (this.onCueComplete) {
                this.onCueComplete(cueId);
            }
        }
    }
}

module.exports = SoundboardMixer;
