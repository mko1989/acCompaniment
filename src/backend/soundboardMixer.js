/**
 * PCM mixing engine for server-primary audio output (RtAudio callback).
 * All mixing runs synchronously inside render() — no async, no allocations in hot path.
 *
 * Playback is organised in *voices*: normally a cue has exactly one, but the
 * "play new instance" retrigger behavior layers another voice of the same
 * cue on top of the ones already playing. Everything addressed by cue id
 * (stop, pause, resume, volume, ducking) applies to all of that cue's voices,
 * and onCueComplete fires once, when a cue's last voice ends.
 *
 * Each voice has two independent gain stages, multiplied together:
 *   - fade gain: fade-in on start, fade-out on stop, live volume changes
 *   - duck gain: lowered while a ducking trigger cue is playing
 * Keeping them separate means a duck never disturbs a fade in progress (or
 * the other way round), and un-ducking always returns to the right level.
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

/** Advances a ramp (fade or duck) by one frame; returns the new current value. */
function stepRamp(current, target, step) {
    if (current === target) {
        return current;
    }
    const next = current + step;
    return Math.abs(target - next) < Math.abs(step) ? target : next;
}

function rampRemainingSec(current, target, step, sampleRate) {
    if (step === 0 || current === target) {
        return 0;
    }
    return Math.max(0, (target - current) / step) / sampleRate;
}

class SoundboardMixer {
    constructor({ sampleRate = 48000, channelCount = 2 } = {}) {
        this.sampleRate = sampleRate;
        this.channelCount = channelCount;
        // voiceId -> voice. Insertion order is start order, so the last
        // voice of a cue seen while iterating is its newest.
        this.activeCues = new Map();
        this.onCueComplete = null;
        this.masterGain = 1.0;
        this._voiceCounter = 0;
    }

    setMasterGain(value) {
        this.masterGain = clamp(Number(value) || 0, 0, 2);
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

    /** All voices currently playing for a cue, oldest first. */
    _voicesOf(cueId) {
        const voices = [];
        for (const voice of this.activeCues.values()) {
            if (voice.cueId === cueId) voices.push(voice);
        }
        return voices;
    }

    hasCue(cueId) {
        return this._voicesOf(cueId).length > 0;
    }

    voiceCount(cueId) {
        return this._voicesOf(cueId).length;
    }

    /**
     * Starts a cue. By default this replaces any voices the cue already has
     * (silently - no completion callback). With options.newInstance it adds
     * a voice alongside them instead.
     */
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
        const duckGain = clamp(options.duckGain ?? 1, 0, 1);

        if (!options.newInstance) {
            for (const voice of this._voicesOf(cueId)) {
                this.activeCues.delete(voice.voiceId);
            }
        }

        const voiceId = `${cueId}#${++this._voiceCounter}`;
        const voice = {
            id: cueId,
            cueId,
            voiceId,
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
            duckGain,
            duckTarget: duckGain,
            duckStep: 0,
            stopping: false,
            isPaused: false,
            startedAt: Date.now(),
            peakAccum: 0,
        };

        this.activeCues.set(voiceId, voice);
        return voice;
    }

    stopCue(cueId, fadeOutSeconds = 0) {
        const voices = this._voicesOf(cueId);
        if (voices.length === 0) {
            return false;
        }

        for (const voice of voices) {
            if (fadeOutSeconds <= 0) {
                this.activeCues.delete(voice.voiceId);
                continue;
            }
            voice.stopping = true;
            voice.gainTarget = 0;
            voice.gainStep = computeGainStep(voice.currentGain, 0, fadeOutSeconds, voice.sampleRate);
        }
        return true;
    }

    stopAll(fadeOutSeconds = 0) {
        const cueIds = new Set(Array.from(this.activeCues.values(), (v) => v.cueId));
        for (const cueId of cueIds) {
            this.stopCue(cueId, fadeOutSeconds);
        }
    }

    /** Changes a cue's volume live. A voice that is fading out keeps fading. */
    setGain(cueId, volume, rampSeconds = 0.05) {
        const voices = this._voicesOf(cueId);
        if (voices.length === 0) {
            return false;
        }
        for (const voice of voices) {
            voice.volume = volume;
            if (voice.stopping) continue;
            voice.gainTarget = volume;
            voice.gainStep = computeGainStep(voice.currentGain, volume, rampSeconds, voice.sampleRate);
        }
        return true;
    }

    /** Ramps a cue's duck gain (1 = not ducked) to `multiplier`. */
    setDuck(cueId, multiplier, fadeSeconds = 0) {
        const voices = this._voicesOf(cueId);
        if (voices.length === 0) {
            return false;
        }
        const target = clamp(Number(multiplier), 0, 1);
        for (const voice of voices) {
            voice.duckTarget = target;
            voice.duckStep = computeGainStep(voice.duckGain, target, fadeSeconds, voice.sampleRate);
        }
        return true;
    }

    pauseCue(cueId) {
        const voices = this._voicesOf(cueId).filter((v) => !v.isPaused);
        if (voices.length === 0) {
            return false;
        }
        for (const voice of voices) voice.isPaused = true;
        return true;
    }

    resumeCue(cueId) {
        const voices = this._voicesOf(cueId).filter((v) => v.isPaused);
        if (voices.length === 0) {
            return false;
        }
        for (const voice of voices) voice.isPaused = false;
        return true;
    }

    getStatus() {
        const playing = [];
        for (const voice of this.activeCues.values()) {
            const positionSec = voice.position / voice.sampleRate;
            // A gain ramp in progress is either a fade-out (stopCue with a
            // fade) or a fade-in (playCue with fadeInTime). Report which, and
            // how long the ramp has left, so clients can show a fading state -
            // the ramp lives only here, nothing else knows it's happening.
            const ramping = voice.gainStep !== 0 && voice.gainTarget !== voice.currentGain;
            const fadeRemainingSec = ramping
                ? rampRemainingSec(voice.currentGain, voice.gainTarget, voice.gainStep, voice.sampleRate)
                : 0;
            playing.push({
                cueId: voice.cueId,
                voiceId: voice.voiceId,
                isPaused: voice.isPaused,
                stopping: voice.stopping,
                isFadingOut: ramping && voice.stopping,
                isFadingIn: ramping && !voice.stopping && voice.gainStep > 0,
                fadeRemainingSec,
                isDucked: voice.duckTarget < 1,
                duckGain: voice.duckGain,
                positionSec,
                trimStartSec: voice.trimStartFrame / voice.sampleRate,
                trimEndSec: voice.trimEndFrame / voice.sampleRate,
                volume: voice.volume,
                currentGain: voice.currentGain,
                outputPatch: [...voice.outputPatch],
            });
        }
        return {
            sampleRate: this.sampleRate,
            channelCount: this.channelCount,
            activeCount: this.activeCues.size,
            masterGain: this.masterGain,
            playing,
        };
    }

    /**
     * Returns and resets the peak output level accumulated since the last
     * drain, per cue (the loudest of its voices). Deliberately separate from
     * getStatus(), which is read by several unrelated REST endpoints and
     * must stay a side-effect-free snapshot — only the playback-time
     * broadcast loop should be draining peaks.
     */
    drainPeakLevels() {
        const levels = {};
        for (const voice of this.activeCues.values()) {
            const level = voice.isPaused ? 0 : voice.peakAccum;
            levels[voice.cueId] = Math.max(levels[voice.cueId] || 0, level);
            voice.peakAccum = 0;
        }
        return levels;
    }

    render(outputBuffer, nFrames, nChannels) {
        outputBuffer.fill(0);

        // Each entry records *why* a voice is being removed this frame, not
        // just its id - reaching the natural end of the file and fading out
        // to silence because of a deliberate stop both end up here, and
        // callers (cueManager, ultimately deciding whether to broadcast
        // 'completed' vs 'stopped', and whether a playlist should
        // auto-advance) need to tell those apart.
        const toRemove = [];

        for (const voice of this.activeCues.values()) {
            if (voice.isPaused) {
                continue;
            }

            const patchL = voice.outputPatch[0];
            const patchR = voice.outputPatch[1];
            const buf = voice.buffer;
            const ch = voice.channels;

            for (let f = 0; f < nFrames; f++) {
                if (voice.position >= voice.trimEndFrame) {
                    if (voice.loop) {
                        voice.position = voice.trimStartFrame;
                    } else {
                        toRemove.push({ voice, reason: 'completed' });
                        break;
                    }
                }

                const idx = voice.position * ch;
                const left = buf[idx] || 0;
                const right = buf[idx + 1] ?? left;

                const vol = voice.currentGain * voice.duckGain * this.masterGain;
                const outL = left * vol;
                const outR = right * vol;
                const outBase = f * nChannels;
                outputBuffer[outBase + patchL] += outL;
                if (patchR !== patchL) {
                    outputBuffer[outBase + patchR] += outR;
                }

                const absL = outL < 0 ? -outL : outL;
                const absR = outR < 0 ? -outR : outR;
                if (absL > voice.peakAccum) voice.peakAccum = absL;
                if (absR > voice.peakAccum) voice.peakAccum = absR;

                voice.position++;

                if (voice.duckGain !== voice.duckTarget) {
                    voice.duckGain = stepRamp(voice.duckGain, voice.duckTarget, voice.duckStep);
                }

                if (voice.gainTarget !== voice.currentGain) {
                    voice.currentGain = stepRamp(voice.currentGain, voice.gainTarget, voice.gainStep);
                }
                // Checked whether or not the gain moved this frame: a voice
                // already silent when its fade-out began (a volume-0 cue, or
                // one stopped before its fade-in rendered anything) has
                // nothing to ramp, and used to stay forever, silent but
                // still "playing".
                if (voice.stopping && voice.currentGain === 0) {
                    toRemove.push({ voice, reason: 'stopped' });
                    break;
                }
            }
        }

        for (const { voice, reason } of toRemove) {
            this.activeCues.delete(voice.voiceId);
            // Only the end of a cue's last voice ends the cue - a layered
            // "new instance" finishing leaves the others playing.
            if (this.onCueComplete && !this.hasCue(voice.cueId)) {
                this.onCueComplete(voice.cueId, reason);
            }
        }
    }
}

module.exports = SoundboardMixer;
