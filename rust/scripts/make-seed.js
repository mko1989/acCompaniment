#!/usr/bin/env node
/**
 * Builds rust/app-fixtures/data: the data dir every recorded HTTP case starts
 * from (copied fresh for each server start). It runs the Node app on an empty
 * data dir, adds one audio file per format and a spread of cues through the
 * API, stops it, and keeps the result. Run again to rebuild; then re-record.
 *
 * The output device is set to BlackHole when present, so recording is silent
 * (rust/DECISIONS.md ADR-012).
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const {
    getFreePort, spawnServer, waitForHealth, waitForExit,
} = require('../../test/helpers/harness');
const { ffmpegBinary } = require('../../test/audio/lib/signals');

const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, 'rust', 'app-fixtures', 'data');

// name, file, extra ffmpeg args (input is a 10 s sine: long enough that nothing ends on its own while the recorded playback phase runs), unusual on purpose where it helps
const FORMATS = [
    ['Tone WAV mono 44k', 'tone-mono-44k.wav', ['-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le']],
    ['Tone WAV stereo 48k', 'tone-stereo-48k.wav', ['-ac', '2', '-ar', '48000', '-c:a', 'pcm_s24le']],
    ['Tone MP3', 'tone.mp3', ['-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k']],
    ['Tone FLAC', 'tone.flac', ['-ac', '2', '-ar', '96000', '-c:a', 'flac']],
    ['Tone OGG Vorbis', 'tone.ogg', ['-ac', '2', '-ar', '44100', '-c:a', 'libvorbis']],
    ['Tone M4A AAC', 'tone.m4a', ['-ac', '2', '-ar', '44100', '-c:a', 'aac']],
    ['Tone AAC ADTS', 'tone.aac', ['-ac', '2', '-ar', '44100', '-c:a', 'aac', '-f', 'adts']],
    ['Zażółć gęślą 🎵', 'zażółć-🎵.wav', ['-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le']],
];

async function main() {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'accompaniment-seed-'));
    const dataDir = path.join(work, 'data');
    const srcDir = path.join(work, 'src');
    await fs.mkdir(srcDir);

    const ffmpeg = ffmpegBinary();
    for (const [, file, args] of FORMATS) {
        execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
            ...args, path.join(srcDir, file)]);
    }

    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawnServer({ PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir });
    const exited = waitForExit(child);
    try {
        await waitForHealth(base, 20000);
        const call = async (method, url, body) => {
            const res = await fetch(base + url, {
                method,
                headers: body ? { 'Content-Type': 'application/json' } : {},
                body: body ? JSON.stringify(body) : undefined,
            });
            const json = await res.json();
            if (!res.ok || json.success === false) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
            return json;
        };

        const devices = await call('GET', '/api/audio/output-devices');
        const list = devices.devices || devices.outputDevices || [];
        const blackhole = list.find((d) => /blackhole/i.test(d.name || ''));
        await call('PUT', '/api/config', blackhole ? { audioOutputDeviceId: blackhole.name } : {});
        if (!blackhole) console.warn('BlackHole not found: recording will play to the default output.');

        const files = {};
        for (const [name, file] of FORMATS) {
            const form = new FormData();
            form.append('audioFile', new Blob([await fs.readFile(path.join(srcDir, file))]), file);
            form.append('name', name);
            const res = await fetch(`${base}/api/audio/upload`, { method: 'POST', body: form });
            const body = await res.json();
            if (!body.success) throw new Error(`upload ${file}: ${body.error}`);
            files[file] = body.audioFile;
        }

        const ref = (f) => ({ audioFileId: files[f].id, relativePath: files[f].relativePath });
        const cue = (data) => call('POST', '/api/cues', { volume: 0.05, ...data });
        await cue({ name: 'Plain', type: 'single_file', ...ref('tone-mono-44k.wav') });
        await cue({ name: 'Fades and loop', type: 'single_file', ...ref('tone-stereo-48k.wav'),
            fadeInTime: 300, fadeOutTime: 500, loop: true });
        await cue({ name: 'Trimmed MP3', type: 'single_file', ...ref('tone.mp3'), trimStartTime: 0.25, trimEndTime: 1.5 });
        await cue({ name: 'Toggle retrigger', type: 'single_file', ...ref('tone.flac'), retriggerBehavior: 'pause' });
        await cue({ name: 'Ducking trigger', type: 'single_file', ...ref('tone.ogg'), isDuckingTrigger: true, duckingLevel: 0.3 });
        await cue({ name: 'Ducked', type: 'single_file', ...ref('tone.m4a'), enableDucking: true });
        await cue({ name: 'ADTS', type: 'single_file', ...ref('tone.aac') });
        await cue({ name: 'Zażółć 🎵 cue', type: 'single_file', ...ref('zażółć-🎵.wav') });
        await cue({
            name: 'Playlist', type: 'playlist',
            playlistItems: ['tone-mono-44k.wav', 'tone.mp3', 'tone.flac'].map((f, i) => ({
                id: `item-${i}`, name: files[f].name, ...ref(f),
            })),
        });
        await cue({
            name: 'Shuffled playlist', type: 'playlist', shuffle: true,
            playlistItems: ['tone.ogg', 'tone.m4a'].map((f, i) => ({ id: `shuffle-${i}`, name: files[f].name, ...ref(f) })),
        });
    } finally {
        child.kill('SIGTERM');
        const result = await exited;
        if (result.code !== 0) console.warn('Seed server exit:', result, child.getOutput().stderr.slice(-2000));
    }

    // The PCM cache is internal (ADR-006) and logs are per run: leave them out.
    for (const skip of ['pcm-cache', 'cache', 'logs']) {
        await fs.rm(path.join(dataDir, skip), { recursive: true, force: true });
    }
    // audioDirectory/cuesDirectory are written but never read: pin them so
    // GET /api/config does not carry this run's temp path.
    const cfgPath = path.join(dataDir, 'config', 'appConfig.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    cfg.audioDirectory = '/seed/data/audio';
    cfg.cuesDirectory = '/seed/data/cues';
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    // Metadata stores each file's absolute path, here this run's temp dir. A
    // moved data dir can't play those (WO-015), so store the path relative to
    // audio/, which the app resolves inside the audio dir it runs with.
    const metaDir = path.join(dataDir, 'audio', 'metadata');
    for (const f of await fs.readdir(metaDir)) {
        const p = path.join(metaDir, f);
        const m = JSON.parse(await fs.readFile(p, 'utf8'));
        if (m.relativePath) m.path = m.relativePath;
        await fs.writeFile(p, JSON.stringify(m, null, 2));
    }
    await fs.rm(OUT, { recursive: true, force: true });
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.cp(dataDir, OUT, { recursive: true });
    // Files outside the library, for POST /api/audio/import and /validate.
    const incoming = path.join(REPO, 'rust', 'app-fixtures', 'incoming');
    await fs.rm(incoming, { recursive: true, force: true });
    await fs.mkdir(incoming, { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
        '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', path.join(incoming, 'import.wav')]);
    await fs.writeFile(path.join(incoming, 'notes.txt'), 'not audio\n');
    await fs.rm(work, { recursive: true, force: true });
    console.log(`Seed written to ${path.relative(REPO, OUT)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
