#!/usr/bin/env node
/**
 * Offline acceptance test for SoundboardMixer (ENG2).
 * Renders two cues with crossfade and channel routing, writes a WAV file.
 */

const fs = require('fs');
const path = require('path');
const SoundboardMixer = require('../src/backend/soundboardMixer');

const SAMPLE_RATE = 48000;
const CHANNELS = 4;
const DURATION_SEC = 2;
const N_FRAMES = SAMPLE_RATE * DURATION_SEC;

function makeToneBuffer({ frequency, durationSec, sampleRate, channels = 2, amplitude = 0.25 }) {
    const frameCount = Math.floor(durationSec * sampleRate);
    const buffer = new Float32Array(frameCount * channels);
    for (let i = 0; i < frameCount; i++) {
        const sample = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
        buffer[i * channels] = sample;
        buffer[i * channels + 1] = sample * 0.8;
    }
    return buffer;
}

function writeWav(filePath, interleaved, sampleRate, channels) {
    const numSamples = interleaved.length;
    const dataSize = numSamples * 4;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20); // IEEE float
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 4, 28);
    header.writeUInt16LE(channels * 4, 32);
    header.writeUInt16LE(32, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    const body = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
    fs.writeFileSync(filePath, Buffer.concat([header, body]));
}

function peakOnChannel(interleaved, nFrames, nChannels, channelIndex) {
    let peak = 0;
    for (let f = 0; f < nFrames; f++) {
        peak = Math.max(peak, Math.abs(interleaved[f * nChannels + channelIndex]));
    }
    return peak;
}

function main() {
    const mixer = new SoundboardMixer({ sampleRate: SAMPLE_RATE, channelCount: CHANNELS });
    const output = new Float32Array(N_FRAMES * CHANNELS);

    const toneA = makeToneBuffer({ frequency: 440, durationSec: 2, sampleRate: SAMPLE_RATE });
    const toneB = makeToneBuffer({ frequency: 880, durationSec: 2, sampleRate: SAMPLE_RATE });

    mixer.playCue('cue-a', toneA, {
        sampleRate: SAMPLE_RATE,
        outputPatch: [0, 1],
        volume: 1,
        fadeInTime: 0.1,
    });

    mixer.playCue('cue-b', toneB, {
        sampleRate: SAMPLE_RATE,
        outputPatch: [2, 3],
        volume: 0.8,
        fadeInTime: 0.2,
    });

    const blockSize = 512;
    let offset = 0;
    const stopAtFrame = Math.floor(SAMPLE_RATE * 0.5);
    let checkedMidStop = false;

    while (offset < N_FRAMES) {
        const frames = Math.min(blockSize, N_FRAMES - offset);
        const block = output.subarray(offset * CHANNELS, (offset + frames) * CHANNELS);
        mixer.render(block, frames, CHANNELS);

        if (offset < stopAtFrame && offset + frames >= stopAtFrame) {
            mixer.stopCue('cue-a', 0.3);
        }

        offset += frames;

        // After ~0.35s of fade, cue-a should be gone and cue-b still playing
        if (!checkedMidStop && offset >= stopAtFrame + Math.floor(SAMPLE_RATE * 0.35)) {
            const mid = mixer.getStatus();
            if (mid.activeCount !== 1 || mid.playing[0]?.cueId !== 'cue-b') {
                console.error('FAIL: mid-stop expected cue-b only, got', mid);
                process.exit(1);
            }
            checkedMidStop = true;
        }
    }

    if (!checkedMidStop) {
        console.error('FAIL: did not reach mid-stop checkpoint');
        process.exit(1);
    }

    const ch0Peak = peakOnChannel(output, N_FRAMES, CHANNELS, 0);
    const ch2Peak = peakOnChannel(output, N_FRAMES, CHANNELS, 2);
    const ch3Peak = peakOnChannel(output, N_FRAMES, CHANNELS, 3);

    console.log('Channel 0 peak (cue A):', ch0Peak.toFixed(4));
    console.log('Channel 2 peak (cue B):', ch2Peak.toFixed(4));
    console.log('Channel 3 peak (cue B):', ch3Peak.toFixed(4));
    console.log('Active cues at end of render:', mixer.getStatus().activeCount);

    const outPath = path.join(__dirname, '..', 'tmp', 'mixer-test.wav');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writeWav(outPath, output, SAMPLE_RATE, CHANNELS);
    console.log('Wrote', outPath);

    if (ch0Peak < 0.01 || ch2Peak < 0.01) {
        console.error('FAIL: expected signal on routed channels');
        process.exit(1);
    }

    console.log('Mid-stop crossfade check: PASS');

    console.log('PASS');
}

main();
