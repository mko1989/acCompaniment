/**
 * A bare RtAudio tone player - no app - for telling the app's dropouts from
 * the device's. Plays a steady sine to a device for a while, then exits:
 *
 *   node baselinePlayer.js <deviceId> <seconds> [sampleRate] [bufferSize]
 *
 * The render callback is as cheap as a callback can be, so whatever gaps a
 * recording of this shows are the device's (or the OS's), not the app's.
 */

const { RtAudio, RtAudioFormat } = require('@hamitzor/rtaudio.js');

const [deviceId, seconds, sampleRate = 48000, bufferSize = 512] = process.argv.slice(2).map(Number);
const freq = 1031.25; // band 0, segment 5 (signals.js)
const step = (2 * Math.PI * freq) / sampleRate;
let phase = 0;
let stop = false;

const rt = new RtAudio();
rt.openStream(
    { deviceId, nChannels: 2 },
    null,
    RtAudioFormat.RTAUDIO_FLOAT32,
    sampleRate,
    bufferSize,
    null,
    (output, _input, nFrames) => {
        if (stop) return 1;
        const out = new Float32Array(output.buffer, output.byteOffset, nFrames * 2);
        for (let i = 0; i < nFrames; i++) {
            const s = 0.5 * Math.sin(phase);
            phase += step;
            out[i * 2] = s;
            out[i * 2 + 1] = s;
        }
        return 0;
    }
);
rt.startStream();
process.stdout.write('started\n');

setTimeout(async () => {
    stop = true;
    while (rt.isStreamRunning()) await new Promise((r) => setTimeout(r, 10));
    rt.closeStream();
    process.exit(0);
}, seconds * 1000);
