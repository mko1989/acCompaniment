/**
 * Playwright fixtures for the loopback UI suite: the browser UI drives the
 * app while the loopback device's input is recorded (test/audio/lib/), so
 * every click is checked by what comes out of the output, not by state.
 *
 * One server for the worker (and the suite runs on one worker - there is
 * one loopback device), booted with the loopback as its output device. The
 * `audio` fixture creates tone cues, records takes and puts the app back to
 * a clean slate after each test. Without a loopback device every test is
 * skipped, saying why.
 *
 * Dropouts: virtual loopback devices drop the odd buffer even with no app
 * involved (test/audio/calibration.test.js compares the two), so the
 * project retries failures (playwright.config.js) and each take's dropouts
 * are attached as an annotation - a failure with none is a real one.
 */

const base = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const {
    REPO_ROOT, RESPONSE_SEC, epochNow, findLoopback, Recorder, Take,
} = require('../audio/lib/capture');
const { makeToneFile, ANALYSIS_RATE } = require('../audio/lib/signals');

// Not under test-results/: Playwright empties that at every run (WO-010).
const ARTIFACT_ROOT = path.join(REPO_ROOT, 'test-recordings', 'audio-ui');
// A click's budget to be heard: RESPONSE_SEC (API -> sound) plus what a
// real click adds - Playwright's actionability checks, the browser's event
// handling and the WebSocket hop.
const UI_RESPONSE_SEC = RESPONSE_SEC + 0.07;
const found = findLoopback();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function json(baseURL, method, urlPath, body) {
    const res = await fetch(`${baseURL}${urlPath}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
}

const test = base.test.extend({
    loopback: [async ({}, use) => {
        if (found.reason) {
            await use(null);
            return;
        }
        const port = await getFreePort();
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-audio-ui-'));
        fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'config', 'appConfig.json'), JSON.stringify({
            audioOutputDeviceId: found.output.name,
            audioOutputChannelCount: 2,
            audioSampleRate: ANALYSIS_RATE,
        }));
        const baseURL = `http://127.0.0.1:${port}`;
        const child = spawn(process.execPath, [path.join(REPO_ROOT, 'start-nodejs.js')], {
            cwd: REPO_ROOT,
            env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ACCOMPANIMENT_DATA_DIR: dataDir },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        const deadline = Date.now() + 30000;
        while (!(await fetch(`${baseURL}/api/remote/health`).then((r) => r.ok, () => false))) {
            if (Date.now() > deadline) throw new Error('audio-ui server did not become healthy');
            await sleep(200);
        }
        const recorder = new Recorder();
        await recorder.open({
            deviceId: found.input.id, channelCount: Math.min(2, found.input.inputChannels),
            sampleRate: ANALYSIS_RATE, bufferSize: 1024,
        });
        const initialConfig = (await json(baseURL, 'GET', '/api/config')).config;

        await use({ baseURL, device: found, recorder, initialConfig });

        await recorder.dispose();
        child.kill('SIGTERM');
        const timedOut = await Promise.race([exited.then(() => false), sleep(10000).then(() => true)]);
        if (timedOut) {
            child.kill('SIGKILL'); // known rtaudio.js shutdown deadlock (FIX_PLAN.md G8)
            await exited;
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
    }, { scope: 'worker', timeout: 60000 }],

    baseURL: async ({ loopback }, use) => {
        await use(loopback?.baseURL);
    },

    audio: async ({ loopback }, use, testInfo) => {
        testInfo.skip(Boolean(found.reason), `loopback audio unavailable: ${found.reason}`);
        const { baseURL, recorder, initialConfig } = loopback;
        const request = (method, p, body) => json(baseURL, method, p, body);
        const takes = [];

        async function uploadTone(spec = {}, format = 'wav') {
            const file = makeToneFile(spec, format);
            const form = new FormData();
            form.append('audioFile', new Blob([file.buffer], { type: file.mime }), `${rand()}-${file.filename}`);
            form.append('name', file.filename);
            const body = await (await fetch(`${baseURL}/api/audio/upload`, { method: 'POST', body: form })).json();
            if (!body.success) throw new Error(`upload failed: ${body.error}`);
            return body.audioFile;
        }

        const status = async (cueId) => (await request('GET', `/api/cues/${cueId}`)).cue?.status;
        async function waitForStatus(cueId, wanted, timeoutMs = 5000) {
            const ok = Array.isArray(wanted) ? wanted : [wanted];
            const deadline = Date.now() + timeoutMs;
            while (!ok.includes(await status(cueId))) {
                if (Date.now() > deadline) throw new Error(`cue ${cueId} never reached ${ok.join('/')}`);
                await sleep(25);
            }
        }

        // First play decodes the file - do it before recording (see
        // test/audio/lib/loopback.js warm()).
        async function warm(cueId, volume) {
            await request('PUT', `/api/cues/${cueId}`, { volume: 0 });
            await request('POST', `/api/cues/${cueId}/trigger`);
            await waitForStatus(cueId, 'playing', 10000);
            await request('POST', `/api/cues/${cueId}/stop`);
            await waitForStatus(cueId, ['stopped', 'completed']);
            await request('PUT', `/api/cues/${cueId}`, { volume });
        }

        async function toneCue(tone = {}, cue = {}) {
            const { format = 'wav', ...spec } = tone;
            const f = await uploadTone(spec, format);
            const body = await request('POST', '/api/cues', {
                name: cue.name || `Tone ${rand()}`, type: 'single_file', audioFileId: f.id, relativePath: f.relativePath,
                volume: 1, ...cue,
            });
            if (!body.success) throw new Error(`create cue failed: ${body.error}`);
            await warm(body.cue.id, body.cue.volume);
            return body.cue.id;
        }

        async function tonePlaylist(items, cue = {}) {
            const playlistItems = [];
            for (let i = 0; i < items.length; i++) {
                const f = await uploadTone(items[i]);
                playlistItems.push({ id: `item-${i}`, name: `Item ${i + 1}`, audioFileId: f.id, relativePath: f.relativePath });
            }
            const body = await request('POST', '/api/cues', {
                name: cue.name || `Playlist ${rand()}`, type: 'playlist', volume: 1, playlistItems, ...cue,
            });
            if (!body.success) throw new Error(`create playlist failed: ${body.error}`);
            return body.cue.id;
        }

        /** Records while `script(mark)` runs - see test/audio/lib/loopback.js record(). */
        async function record(script, { leadSec = 0.3, tailSec = 0.4, name } = {}) {
            const marks = [];
            const mark = (label) => marks.push({ label, epochMs: epochNow() });
            await recorder.start();
            await sleep(leadSec * 1000);
            let raw;
            try {
                await script(mark);
                await sleep(tailSec * 1000);
            } finally {
                raw = await recorder.stop();
            }
            const takeName = `${testInfo.title}${name ? ` - ${name}` : ''}${testInfo.retry ? ` (retry ${testInfo.retry})` : ''}`;
            const take = new Take(raw, { channels: 2, sampleRate: ANALYSIS_RATE, marks, name: takeName });
            take.file = take.save(path.join(ARTIFACT_ROOT, path.basename(testInfo.file, '.spec.js')));
            takes.push(take);
            await testInfo.attach(`${takeName}.wav`, { path: take.file, contentType: 'audio/wav' });
            return take;
        }

        function immediate(delaySec, what) {
            base.expect(
                delaySec != null && delaySec >= -0.02 && delaySec <= UI_RESPONSE_SEC,
                `${what}: expected within ${Math.round(UI_RESPONSE_SEC * 1000)} ms, took ${delaySec == null ? 'forever' : `${(delaySec * 1000).toFixed(0)} ms`}`
            ).toBe(true);
        }

        function near(actual, expected, tol, what) {
            base.expect(
                actual != null && Math.abs(actual - expected) <= tol,
                `${what}: expected ${expected} ± ${tol}, got ${actual?.toFixed?.(3) ?? actual}`
            ).toBe(true);
        }

        await use({
            baseURL, device: found, request, uploadTone, toneCue, tonePlaylist, status, waitForStatus,
            record, immediate, near, sleep,
            trigger: (cueId, body) => request('POST', `/api/cues/${cueId}/trigger`, body),
        });

        for (const take of takes) {
            const holes = take.holes();
            if (holes.length) {
                testInfo.annotations.push({
                    type: 'dropouts',
                    description: `${take.name}: ${holes.map((h) => `${h.samples} samples at ${h.atSec.toFixed(3)}s`).join(', ')}`,
                });
            }
        }
        await request('POST', '/api/cues/stop-all', { behavior: 'stop' });
        await request('POST', '/api/remote/crossfade', { enabled: false });
        await request('POST', '/api/remote/master-volume', { volume: 1 });
        await request('PUT', '/api/config', initialConfig);
        const { cues = [] } = await request('GET', '/api/cues');
        for (const cue of cues) await request('DELETE', `/api/cues/${cue.id}`);
        await sleep(150);
    },
});

module.exports = { test, expect: base.expect };
