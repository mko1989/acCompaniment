// Typed ES-module face of src/backend/soundboardMixer.js (CommonJS, a stateful class), so
// rust-anything can bridge and record it (rust/DECISIONS.md ADR-014). `runMixer` is a
// deterministic driver: it builds one SoundboardMixer, applies a timeline of commands before the
// blocks they name, renders `blocks` blocks of `frames` frames into a Float32Array as the audio
// worker does, and returns everything observable. All mixing is the original's.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SoundboardMixer = require('../../../src/backend/soundboardMixer.js');

/** PCM samples, interleaved; `null` stands for NaN (JSON has no NaN). */
export interface Source {
    samples: (number | null)[];
}

/** Options as playCue/queueNext take them (channels, sampleRate, trims, volume, fadeInTime, outputPatch, duckGain, newInstance, loop, token). */
export interface Command {
    block: number;
    op: string;
    cue?: string;
    source?: number;
    options?: Record<string, unknown>;
    value?: number;
    seconds?: number;
}

export interface MixerRun {
    output: (number | null)[][];
    events: unknown[];
    returns: unknown[];
    status: unknown[];
    peaks: unknown[];
}

function call(mixer: any, buffers: Float32Array[], cmd: Command): unknown {
    const cue = cmd.cue;
    const secs = cmd.seconds ?? undefined;
    switch (cmd.op) {
        case 'play': return mixer.playCue(cue, buffers[cmd.source ?? 0], cmd.options ?? {}).voiceId;
        case 'queueNext': return mixer.queueNext(cue, buffers[cmd.source ?? 0], cmd.options ?? {});
        case 'clearNext': mixer.clearNext(cue); return null;
        case 'stop': return mixer.stopCue(cue, secs);
        case 'stopAll': mixer.stopAll(secs); return null;
        case 'setGain': return mixer.setGain(cue, cmd.value, secs);
        case 'setDuck': return mixer.setDuck(cue, cmd.value, secs);
        case 'pause': return mixer.pauseCue(cue);
        case 'resume': return mixer.resumeCue(cue);
        case 'setMasterGain': mixer.setMasterGain(cmd.value); return mixer.masterGain;
        case 'setChannelCount': mixer.setChannelCount(cmd.value); return null;
        case 'setSampleRate': mixer.setSampleRate(cmd.value); return null;
        case 'hasCue': return mixer.hasCue(cue);
        case 'voiceCount': return mixer.voiceCount(cue);
        default: return 'unknown op';
    }
}

export function runMixer(
    sampleRate: number,
    channelCount: number,
    sources: Source[],
    commands: Command[],
    blocks: number,
    frames: number,
): MixerRun {
    const mixer = new SoundboardMixer({ sampleRate, channelCount });
    const buffers = sources.map((s) => Float32Array.from(s.samples, (x) => (x === null ? NaN : x)));
    const run: MixerRun = { output: [], events: [], returns: [], status: [], peaks: [] };
    let block = 0;
    mixer.setCueCompleteCallback((cueId: string, reason: string) => {
        run.events.push({ block, type: 'complete', cueId, reason });
    });
    mixer.setCueAdvanceCallback((cueId: string, token: unknown) => {
        run.events.push({ block, type: 'advance', cueId, token: token ?? null });
    });
    for (block = 0; block < blocks; block++) {
        for (const cmd of commands) {
            if (cmd.block === block) run.returns.push({ block, op: cmd.op, result: call(mixer, buffers, cmd) ?? null });
        }
        const nChannels = mixer.channelCount;
        const out = new Float32Array(frames * nChannels);
        mixer.render(out, frames, nChannels);
        run.output.push(Array.from(out, (x) => (Number.isNaN(x) ? null : x)));
        run.status.push(mixer.getStatus());
        run.peaks.push(mixer.drainPeakLevels());
    }
    return run;
}
