// Writes inputs.jsonl for `rust-anything record --inputs`: targeted mixer timelines plus seeded
// random ones. Run: node rust/soundboard-mixer/make-inputs.cjs
const fs = require('fs');
const path = require('path');

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const ramp = (n, ch = 2, k = 1) => Array.from({ length: n * ch }, (_, i) => ((i * k) % 13 - 6) / 8);
const SRC = {
    stereo: { samples: ramp(40) },
    stereo2: { samples: ramp(24, 2, 5) },
    mono: { samples: ramp(30, 1, 3) },
    quad: { samples: ramp(20, 4, 7) },
    nan: { samples: [0.5, null, null, 0.25, 0.1, 0.2, null, null, 0.3, 0.3] },
    empty: { samples: [] },
    loud: { samples: Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.9 : -0.95)) },
};
const names = Object.keys(SRC);
const sources = names.map((n) => SRC[n]);
const S = Object.fromEntries(names.map((n, i) => [n, i]));

const cases = [];
const add = (commands, { sr = 1000, ch = 2, blocks = 4, frames = 16 } = {}) =>
    cases.push({ fn: 'runMixer', args: [sr, ch, sources, commands, blocks, frames] });
const play = (block, cue, source, options = {}) => ({ block, op: 'play', cue, source: S[source], options });

// --- targeted ---
add([play(0, 'a', 'stereo')]);
add([play(0, 'a', 'stereo', { volume: 0.5, duckGain: 0.7 }), { block: 1, op: 'setMasterGain', value: 1.5 }]);
add([play(0, 'a', 'loud', { volume: 3 }), { block: 0, op: 'setMasterGain', value: 5 }]);
add([play(0, 'a', 'stereo', { volume: 0 })]);
add([play(0, 'a', 'stereo', { fadeInTime: 0.025 })]);
add([play(0, 'a', 'stereo', { fadeInTime: 0.025 }), { block: 1, op: 'stop', cue: 'a', seconds: 0.02 }]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'stop', cue: 'a', seconds: 0.02 }]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'stop', cue: 'a' }]);
add([play(0, 'a', 'stereo', { trimStartTime: 0.003, trimEndTime: 0.021 })]);
add([play(0, 'a', 'stereo', { trimStartTime: 0.003, trimEndTime: 0.011, loop: true })], { blocks: 3 });
add([play(0, 'a', 'stereo', { trimEndTime: 0.01 }), { block: 0, op: 'queueNext', cue: 'a', source: S.stereo2, options: { token: 't1', trimStartTime: 0.002 } }], { blocks: 4 });
add([play(0, 'a', 'stereo', { trimEndTime: 0.01 }),
    { block: 0, op: 'queueNext', cue: 'a', source: S.stereo2, options: { token: 1 } },
    { block: 0, op: 'queueNext', cue: 'a', source: S.mono, options: { channels: 1, token: 'replaced' } }]);
add([play(0, 'a', 'stereo', { trimEndTime: 0.01 }), { block: 0, op: 'queueNext', cue: 'a', source: S.stereo2 }, { block: 0, op: 'clearNext', cue: 'a' }]);
add([play(0, 'a', 'stereo'), { block: 0, op: 'stop', cue: 'a', seconds: 0.05 }, { block: 1, op: 'queueNext', cue: 'a', source: S.stereo2 }]);
add([play(0, 'a', 'stereo', { trimEndTime: 0.02 }), { block: 0, op: 'queueNext', cue: 'a', source: S.stereo2 }, { block: 1, op: 'stop', cue: 'a', seconds: 0.03 }]);
for (const outputPatch of [[0, 1], [1, 0], [1, 1], [0, 0], [2, 3], [5, 9], [3], [], [null, 2], [-1, 1]]) {
    add([play(0, 'a', 'stereo', { outputPatch })], { ch: 4, blocks: 2 });
}
add([play(0, 'a', 'stereo')], { ch: 1, blocks: 2 });
add([play(0, 'a', 'mono', { channels: 1 })], { blocks: 3 });
add([play(0, 'a', 'quad', { channels: 4 })], { ch: 4, blocks: 2 });
add([play(0, 'a', 'nan'), play(0, 'b', 'stereo', { newInstance: true })], { blocks: 1 });
add([play(0, 'a', 'stereo'), play(1, 'a', 'stereo2', { newInstance: true }), { block: 2, op: 'voiceCount', cue: 'a' }, { block: 2, op: 'stop', cue: 'a', seconds: 0.005 }]);
add([play(0, 'a', 'stereo2'), play(0, 'a', 'stereo', { newInstance: true, trimEndTime: 0.01 })], { blocks: 4 });
add([play(0, 'a', 'stereo'), play(1, 'a', 'stereo2')]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'pause', cue: 'a' }, { block: 1, op: 'pause', cue: 'a' }, { block: 2, op: 'resume', cue: 'a' }, { block: 3, op: 'resume', cue: 'a' }]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'stop', cue: 'a', seconds: 0.03 }, { block: 1, op: 'setGain', cue: 'a', value: 1 }]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'setGain', cue: 'a', value: 0.2 }, { block: 2, op: 'setGain', cue: 'a', value: 0.9, seconds: 0 }]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'setDuck', cue: 'a', value: 0.3, seconds: 0.02 }, { block: 2, op: 'setDuck', cue: 'a', value: 7 }, { block: 3, op: 'setDuck', cue: 'a', value: -1, seconds: 0.004 }]);
add([play(0, 'a', 'stereo'), { block: 1, op: 'setMasterGain', value: -1 }, { block: 2, op: 'setMasterGain', value: 0.25 }]);
add([play(0, 'a', 'stereo', { outputPatch: [2, 3] }), { block: 0, op: 'setChannelCount', value: 4 }, play(1, 'b', 'stereo2', { outputPatch: [2, 3] }), { block: 2, op: 'setChannelCount', value: 2 }], { blocks: 4 });
add([{ block: 0, op: 'setSampleRate', value: 2000 }, play(0, 'a', 'stereo', { fadeInTime: 0.01 }), play(1, 'b', 'stereo2', { sampleRate: 500, fadeInTime: 0.01 })]);
add([play(0, 'a', 'empty'), play(0, 'b', 'empty', { channels: 1 })], { blocks: 2 });
add([play(0, 'a', 'stereo'), play(0, 'b', 'stereo2'), { block: 1, op: 'stopAll', seconds: 0.01 }, { block: 3, op: 'stopAll' }]);
add([{ block: 0, op: 'hasCue', cue: 'x' }, play(0, 'x', 'stereo'), { block: 0, op: 'hasCue', cue: 'x' }, { block: 0, op: 'nope' },
    { block: 1, op: 'stop', cue: 'y' }, { block: 1, op: 'setGain', cue: 'y', value: 1 }, { block: 1, op: 'setDuck', cue: 'y', value: 1 },
    { block: 1, op: 'pause', cue: 'y' }, { block: 1, op: 'resume', cue: 'y' }, { block: 1, op: 'queueNext', cue: 'y', source: 0 }, { block: 1, op: 'voiceCount', cue: 'y' }]);
add([play(0, 'a', 'stereo', { trimEndTime: 9 }), play(0, 'b', 'stereo2', { trimStartTime: 9 }), play(0, 'c', 'stereo', { trimStartTime: 0.02, trimEndTime: 0.01 })]);
add([play(0, 'a', 'stereo', { volume: 0 }), { block: 1, op: 'stop', cue: 'a', seconds: 0.5 }]);
add([play(0, 'a', 'stereo', { fadeInTime: 0.5 }), { block: 0, op: 'stop', cue: 'a', seconds: 0.5 }]);
add([play(0, 'a', 'stereo', { sampleRate: 44100, fadeInTime: 0.0003, trimStartTime: 0.0001 })], { sr: 48000, blocks: 2, frames: 24 });
add([play(0, 'a', 'stereo', { loop: 1, trimEndTime: 0.004 }), play(0, 'b', 'stereo2', { loop: 0, newInstance: 'yes' })], { blocks: 2 });

// --- seeded random timelines ---
const ops = ['play', 'play', 'play', 'queueNext', 'clearNext', 'stop', 'stopAll', 'setGain', 'setDuck', 'pause', 'resume', 'setMasterGain', 'hasCue', 'voiceCount'];
for (let n = 0; n < 400; n++) {
    const ch = pick([1, 2, 2, 2, 4]);
    const blocks = 2 + Math.floor(rnd() * 8);
    const frames = pick([8, 12, 16, 24]);
    const sr = pick([1000, 1000, 2000, 800]);
    const commands = [];
    const k = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < k; i++) {
        const op = pick(ops);
        const cmd = { block: Math.floor(rnd() * blocks), op, cue: pick(['a', 'b', 'c']) };
        if (op === 'play' || op === 'queueNext') {
            const src = pick(names);
            cmd.source = S[src];
            const o = {};
            if (src === 'mono') o.channels = 1;
            if (src === 'quad') o.channels = 4;
            if (rnd() < 0.4) o.volume = pick([0, 0.25, 0.5, 1, 1.7]);
            if (rnd() < 0.3) o.fadeInTime = pick([0.004, 0.01, 0.03]);
            if (rnd() < 0.3) o.trimStartTime = pick([0, 0.002, 0.007]);
            if (rnd() < 0.3) o.trimEndTime = pick([0.005, 0.012, 0.03]);
            if (rnd() < 0.2) o.loop = true;
            if (rnd() < 0.3) o.outputPatch = pick([[0, 1], [1, 0], [0, 0], [1, 1], [2, 3], [3, 0]]);
            if (rnd() < 0.2) o.newInstance = true;
            if (rnd() < 0.2) o.duckGain = pick([0, 0.5, 2]);
            if (op === 'queueNext') o.token = `t${i}`;
            cmd.options = o;
        }
        if (['stop', 'stopAll', 'setGain', 'setDuck'].includes(op) && rnd() < 0.7) cmd.seconds = pick([0, 0.003, 0.01, 0.04]);
        if (['setGain', 'setDuck', 'setMasterGain'].includes(op)) cmd.value = pick([0, 0.3, 0.8, 1, 1.5, 3]);
        commands.push(cmd);
    }
    add(commands, { sr, ch, blocks, frames });
}

const out = path.join(__dirname, 'inputs.jsonl');
fs.writeFileSync(out, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`${cases.length} cases, ${fs.statSync(out).size} bytes`);
