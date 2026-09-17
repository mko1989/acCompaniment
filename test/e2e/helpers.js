/**
 * Shared helpers for the Playwright browser tests. These talk to the one
 * server shared by the whole e2e run (see playwright.config.js), so every
 * cue/audio file created here uses a random-suffixed name - tests must
 * never assume they're the only thing in the workspace.
 */

/** Minimal but valid mono 16-bit PCM WAV buffer (a few seconds of a 440Hz tone). */
function makeTestWav(durationSec = 4) {
    const sampleRate = 44100;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
        buffer.writeInt16LE(sample, 44 + i * 2);
    }
    return buffer;
}

function uniqueName(prefix) {
    return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Uploads a generated test WAV via the given Playwright APIRequestContext. */
async function uploadTestAudio(request, { name = uniqueName('E2E Audio'), durationSec = 4 } = {}) {
    const res = await request.post('/api/audio/upload', {
        multipart: {
            audioFile: {
                name: `${name.replace(/[^a-z0-9]/gi, '-')}.wav`,
                mimeType: 'audio/wav',
                buffer: makeTestWav(durationSec),
            },
            name,
        },
    });
    const body = await res.json();
    if (!body.success) {
        throw new Error(`uploadTestAudio failed: ${body.error}`);
    }
    return body.audioFile;
}

/** Uploads a test audio file and creates a single_file cue from it. */
async function createTestCue(request, { name = uniqueName('E2E Cue'), volume = 0.05, ...overrides } = {}) {
    const audioFile = await uploadTestAudio(request, { name: `${name} Audio` });
    const res = await request.post('/api/cues', {
        data: {
            name,
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
            volume,
            ...overrides,
        },
    });
    const body = await res.json();
    if (!body.success) {
        throw new Error(`createTestCue failed: ${body.error}`);
    }
    return body.cue;
}

async function deleteCue(request, cueId) {
    await request.delete(`/api/cues/${cueId}`).catch(() => {});
}

module.exports = { makeTestWav, uniqueName, uploadTestAudio, createTestCue, deleteCue };
