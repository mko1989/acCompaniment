/**
 * The fakes the B3 differential check (rust/DECISIONS.md ADR-015) runs the ORIGINAL cueManager.js
 * against: an audio engine that logs every call and plays nothing, a WebSocket manager that
 * collects broadcasts, a controllable clock with timers, and a fixed random source. The Rust core
 * has the same fakes (rust/app/src/core/cue_engine/fakes.rs); both must behave identically, so
 * keep the two in step.
 */

const realSetTimeout = setTimeout;
const realSetImmediate = setImmediate;

/** Fake clock: replaces Date.now and the timer functions the cue manager uses. */
function installClock(start = 1700000000000) {
    const clock = { now: start, timers: [], seq: 0 };
    Date.now = () => clock.now;
    const add = (fn, ms, args, interval) => {
        const t = { id: ++clock.seq, due: clock.now + Math.max(0, Number(ms) || 0), fn, args, interval };
        clock.timers.push(t);
        return t;
    };
    const remove = (t) => {
        const i = clock.timers.indexOf(t);
        if (i >= 0) clock.timers.splice(i, 1);
    };
    global.setTimeout = (fn, ms, ...args) => add(fn, ms, args, null);
    global.clearTimeout = remove;
    global.setInterval = (fn, ms, ...args) => add(fn, ms, args, Math.max(1, Number(ms) || 0));
    global.clearInterval = remove;
    /** Runs every timer due within `ms`, in (due, creation) order, settling after each. */
    clock.advance = async (ms, settle) => {
        const target = clock.now + ms;
        for (;;) {
            let next = null;
            for (const t of clock.timers) {
                if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
            }
            if (!next) break;
            clock.now = next.due;
            if (next.interval) next.due += next.interval;
            else remove(next);
            next.fn(...next.args);
            await settle();
        }
        clock.now = target;
    };
    clock.pending = () => clock.timers
        .map((t) => ({ due: t.due - start, interval: t.interval }))
        .sort((a, b) => a.due - b.due);
    return clock;
}

/** Waits until no more work is happening: microtasks and the data layer's file I/O. */
function makeSettle(sizes) {
    return async () => {
        let last = '';
        let stable = 0;
        while (stable < 3) {
            await new Promise((r) => realSetImmediate(r));
            await new Promise((r) => realSetTimeout(r, 3));
            const now = sizes();
            if (now === last) stable += 1;
            else { stable = 0; last = now; }
        }
    };
}

/** A fixed random source: the given values in turn, cycling. */
function makeRng(values) {
    let i = 0;
    const rng = () => {
        if (!rng.values.length) return 0;
        const v = rng.values[i % rng.values.length];
        i += 1;
        return v;
    };
    rng.values = values;
    rng.reset = (vals) => { rng.values = vals; i = 0; };
    return rng;
}

function makeFakeWs() {
    const log = [];
    return {
        log,
        broadcast(message) { log.push({ m: 'broadcast', message }); },
        async broadcastCuesUpdate(cues) { log.push({ m: 'cuesUpdate', cues }); },
        broadcastCueUpdate(cueId, updates) { log.push({ m: 'cueUpdate', cueId, updates }); },
        broadcastCueStatus(cueId, status, extra) { log.push({ m: 'cueStatus', cueId, status, extra }); },
        broadcastWorkspaceUpdate(workspace) { log.push({ m: 'workspaceUpdate', workspace }); },
    };
}

/**
 * The audio engine, faked: the AudioPlaybackManager surface cueManager.js uses. It keeps voices
 * per cue (so playingCues, pause/resume, fades and status behave plausibly), logs every call that
 * changes something, and lets an op script the next result of a method.
 */
function makeFakeEngine() {
    const log = [];
    const script = [];
    const voices = new Map(); // cueId -> [voice]
    const lastToken = new Map();
    let voiceSeq = 0;
    const scripted = (m) => {
        const i = script.findIndex((s) => s.method === m);
        if (i < 0) return undefined;
        return JSON.parse(JSON.stringify(script.splice(i, 1)[0].result));
    };
    const allPaused = (list) => list.every((v) => v.paused);
    const entries = () => {
        const now = Date.now();
        const out = [];
        for (const [cueId, list] of voices) {
            for (const v of list) {
                out.push({
                    cueId,
                    voiceId: v.voiceId,
                    isPaused: v.paused,
                    isFadingIn: now < v.fadeInUntil,
                    isFadingOut: v.fadingOut,
                    isDucked: v.duckGain < 1,
                    duckGain: v.duckGain,
                    currentGain: v.volume * v.duckGain,
                    volume: v.volume,
                    positionSec: v.trimStartSec + (v.paused ? 0 : (now - v.startedAt) / 1000),
                    trimStartSec: v.trimStartSec,
                    trimEndSec: v.trimEndSec,
                    outputPatch: v.outputPatch,
                    fadeRemainingSec: Math.max(0, (v.fadeInUntil - now) / 1000),
                });
            }
        }
        return out;
    };
    const engine = {
        log,
        script,
        isInitialized: true,
        deviceId: 130,
        sampleRate: 48000,
        channelCount: 2,
        masterVolume: 1,
        callbacks: {},
        get playingCues() { return voices; },
        audioBuffers: { delete(p) { log.push({ m: 'audioBuffers.delete', args: [p] }); return false; } },
        mixer: { getStatus: () => ({ playing: entries() }) },
        async init(config) { log.push({ m: 'init', args: [config] }); },
        setPlaybackEndCallback(fn) { log.push({ m: 'setPlaybackEndCallback' }); engine.callbacks.end = fn; },
        setPlaybackAdvanceCallback(fn) { log.push({ m: 'setPlaybackAdvanceCallback' }); engine.callbacks.advance = fn; },
        setEngineErrorCallback(fn) { log.push({ m: 'setEngineErrorCallback' }); engine.callbacks.error = fn; },
        async applyAudioConfig(config) {
            log.push({ m: 'applyAudioConfig', args: [config] });
            return scripted('applyAudioConfig') ?? { success: true, unchanged: false };
        },
        async playCue(cueId, filePath, options) {
            log.push({ m: 'playCue', args: [cueId, filePath, options] });
            const s = scripted('playCue');
            if (s !== undefined) return s;
            if (!options.newInstance) voices.delete(cueId);
            const now = Date.now();
            const voice = {
                voiceId: ++voiceSeq,
                startedAt: now,
                volume: options.volume,
                duckGain: options.duckGain,
                paused: false,
                fadingOut: false,
                fadeInUntil: now + options.fadeInTime * 1000,
                trimStartSec: options.trimStartTime,
                trimEndSec: options.trimEndTime ?? 10,
                outputPatch: options.outputPatch ?? null,
            };
            const list = voices.get(cueId);
            if (list) list.push(voice);
            else voices.set(cueId, [voice]);
            return { success: true, voiceId: voice.voiceId };
        },
        async stopCue(cueId, fadeOut, seconds) {
            log.push({ m: 'stopCue', args: [cueId, fadeOut, seconds] });
            const s = scripted('stopCue');
            if (s !== undefined) return s;
            const list = voices.get(cueId);
            if (!list) return { success: true, fading: false };
            if (fadeOut && seconds > 0 && !allPaused(list)) {
                for (const v of list) v.fadingOut = true;
                return { success: true, fading: true };
            }
            voices.delete(cueId);
            return { success: true, fading: false };
        },
        async stopAllCues(fadeOut, seconds) {
            log.push({ m: 'stopAllCues', args: [fadeOut, seconds] });
            const s = scripted('stopAllCues');
            if (s !== undefined) return s;
            const results = [];
            for (const [cueId, list] of Array.from(voices)) {
                const fading = Boolean(fadeOut && seconds > 0 && !allPaused(list));
                if (fading) for (const v of list) v.fadingOut = true;
                else voices.delete(cueId);
                results.push({ cueId, fading });
            }
            return { success: true, results };
        },
        async pauseCue(cueId) {
            log.push({ m: 'pauseCue', args: [cueId] });
            const s = scripted('pauseCue');
            if (s !== undefined) return s;
            const list = voices.get(cueId);
            if (!list || allPaused(list)) return { success: false, error: 'Cue not playing' };
            for (const v of list) v.paused = true;
            return { success: true };
        },
        async resumeCue(cueId) {
            log.push({ m: 'resumeCue', args: [cueId] });
            const s = scripted('resumeCue');
            if (s !== undefined) return s;
            const list = voices.get(cueId);
            if (!list || !list.some((v) => v.paused)) return { success: false, error: 'Cue not paused' };
            for (const v of list) { v.paused = false; v.startedAt = Date.now(); }
            return { success: true };
        },
        setCueVolume(cueId, volume) {
            log.push({ m: 'setCueVolume', args: [cueId, volume] });
            for (const v of voices.get(cueId) || []) v.volume = volume;
        },
        setCueDuck(cueId, multiplier, seconds) {
            log.push({ m: 'setCueDuck', args: [cueId, multiplier, seconds] });
            for (const v of voices.get(cueId) || []) v.duckGain = multiplier;
        },
        setMasterVolume(volume) {
            log.push({ m: 'setMasterVolume', args: [volume] });
            engine.masterVolume = Math.min(2, Math.max(0, volume));
        },
        getMasterVolume() { return engine.masterVolume; },
        voiceCount(cueId) { return (voices.get(cueId) || []).length; },
        clearNext(cueId) { log.push({ m: 'clearNext', args: [cueId] }); },
        async queueNext(cueId, filePath, options, stillWanted) {
            const wanted = stillWanted();
            log.push({ m: 'queueNext', args: [cueId, filePath, options], stillWanted: wanted });
            const s = scripted('queueNext');
            const queued = s !== undefined ? s : wanted;
            if (queued) lastToken.set(cueId, options.token);
            return queued;
        },
        getPlaybackStatus() { return { mixer: { playing: entries() } }; },
        drainPeakLevels() {
            const peaks = {};
            for (const [cueId, list] of voices) if (!allPaused(list)) peaks[cueId] = 0.5;
            return peaks;
        },
        async cleanup() { log.push({ m: 'cleanup' }); },
        // Events from the "audio thread", driven by ops.
        end(cueId, reason) {
            voices.delete(cueId);
            engine.callbacks.end?.(cueId, reason);
        },
        advance(cueId, token) {
            engine.callbacks.advance?.(cueId, token ?? lastToken.get(cueId) ?? null);
        },
        error(payload) { engine.callbacks.error?.(payload); },
    };
    return engine;
}

module.exports = { installClock, makeSettle, makeRng, makeFakeWs, makeFakeEngine };
