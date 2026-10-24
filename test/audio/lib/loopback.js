/**
 * The loopback audio suite's harness (node:test): boots a server whose
 * output device is a loopback device (whatever the app plays comes
 * straight back as that device's input), records that input while a test
 * drives the app (capture.js), and hands back the recording analysed
 * (analyzer.js) and lined up with what the test did and when. With no
 * loopback device, every test in the file is skipped, saying why.
 *
 * Every take is saved to test-recordings/audio/<file>/<test>.wav with an
 * Audacity label track (.labels.txt) of the test's marks next to it, to
 * listen to or inspect a transition after the fact.
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { useServer, pollUntil } = require('../../helpers/harness');
const { makeToneFile, ANALYSIS_RATE } = require('./signals');
const {
    REPO_ROOT, RESPONSE_SEC, epochNow, findLoopback, Recorder, Take,
} = require('./capture');

// Not under test-results/: Playwright empties that at every run (WO-010).
const ARTIFACT_ROOT = path.join(REPO_ROOT, 'test-recordings', 'audio');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

/**
 * Call at the top level of a test file. Boots the server on the loopback
 * device and opens the recorder; returns { test, ...helpers }, where `test`
 * is node:test's, skipped when there's no loopback device.
 *
 * @param {object} [options]
 * @param {object} [options.config]  extra app config to boot with
 * @param {number} [options.sampleRate=48000]
 */
function loopbackSuite(options = {}) {
    const found = findLoopback();
    const skip = found.reason ? `loopback audio unavailable: ${found.reason}` : false;
    const sampleRate = options.sampleRate || ANALYSIS_RATE;
    const channels = 2;
    const suiteName = path.basename(require.main?.filename || process.argv[1] || 'audio', '.test.js');
    const artifactDir = path.join(ARTIFACT_ROOT, suiteName);

    const server = skip ? null : useServer({}, {
        config: {
            audioOutputDeviceId: found.output.name,
            audioOutputChannelCount: channels,
            audioSampleRate: sampleRate,
            ...options.config,
        },
    });
    let recorder = null;

    if (!skip) {
        before(async () => {
            recorder = new Recorder();
            await recorder.open({
                deviceId: found.input.id, channelCount: Math.min(channels, found.input.inputChannels),
                sampleRate, bufferSize: 1024,
            });
        });

        after(async () => {
            await recorder?.dispose();
        });

        // Every test starts from silence and server-wide defaults.
        afterEach(() => reset());
    }

    async function reset() {
        await request('POST', '/api/cues/stop-all', { behavior: 'stop' });
        await request('POST', '/api/remote/crossfade', { enabled: false });
        await request('POST', '/api/remote/master-volume', { volume: 1 });
        await sleep(150);
    }

    // Takes recorded by the running test, to tell a failure caused by a
    // dropout from a real one (see audioTest).
    let currentTakes = null;
    const MAX_ATTEMPTS = 3;

    /**
     * node:test's test(), skipped without a loopback device, and retried
     * when it fails *and* one of its recordings has a hole in it (holes()).
     * Virtual loopback devices occasionally drop a buffer even for a bare
     * player (calibration.test.js compares the two), and a behavior test
     * shouldn't fail on that; a failure without a hole, or the same failure
     * three times, is reported as usual.
     */
    function audioTest(name, opts, fn) {
        if (typeof opts === 'function') [opts, fn] = [{}, opts];
        return test(name, { ...opts, skip: skip || opts.skip }, async (t) => {
            for (let attempt = 1; ; attempt++) {
                currentTakes = [];
                try {
                    return await fn(t);
                } catch (error) {
                    const holes = currentTakes.flatMap((take) => take.holes());
                    if (holes.length === 0 || attempt >= MAX_ATTEMPTS || opts.noRetry) throw error;
                    t.diagnostic(
                        `attempt ${attempt} failed with ${holes.length} dropout(s) in the recording `
                        + `(${holes.map((h) => `${h.samples} samples at ${h.atSec.toFixed(3)}s`).join(', ')}) - retrying: `
                        + `${error.message.split('\n')[0]}`
                    );
                    await reset();
                } finally {
                    currentTakes = null;
                }
            }
        });
    }

    const dropoutReports = () => {
        const { stdout, stderr } = server.output();
        return `${stdout}\n${stderr}`.split('\n').filter((line) => /Audio dropouts/.test(line));
    };

    // --- REST ---------------------------------------------------------------

    async function request(method, urlPath, body) {
        const res = await fetch(`${server.baseUrl()}${urlPath}`, {
            method,
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return res.json().catch(() => ({}));
    }
    const post = (p, body) => request('POST', p, body ?? {});
    const put = (p, body) => request('PUT', p, body);
    const get = (p) => request('GET', p);

    /** Uploads a generated tone file (signals.makeToneFile) and returns its audioFile record. */
    async function uploadTone(spec = {}, format = 'wav') {
        const file = makeToneFile(spec, format);
        const form = new FormData();
        form.append('audioFile', new Blob([file.buffer], { type: file.mime }), `${rand()}-${file.filename}`);
        form.append('name', file.filename);
        const res = await fetch(`${server.baseUrl()}/api/audio/upload`, { method: 'POST', body: form });
        const body = await res.json();
        assert.equal(body.success, true, `upload of ${file.filename} failed: ${body.error}`);
        return body.audioFile;
    }

    /** A single-file cue playing a generated tone. `tone`: signals spec (+ format). */
    async function toneCue(tone = {}, cue = {}) {
        const { format = 'wav', ...spec } = tone;
        const audioFile = await uploadTone(spec, format);
        const body = await post('/api/cues', {
            name: `Tone ${audioFile.name || rand()}`,
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
            volume: 1,
            ...cue,
        });
        assert.equal(body.success, true, `create cue failed: ${body.error}`);
        await warm(body.cue.id);
        return body.cue.id;
    }

    /** A playlist cue whose items are tones in the given bands (one item each). */
    async function tonePlaylist(items, cue = {}) {
        const playlistItems = [];
        for (let i = 0; i < items.length; i++) {
            const { format = 'wav', ...spec } = items[i];
            const f = await uploadTone(spec, format);
            playlistItems.push({ id: `item-${i}`, name: `Item ${i}`, audioFileId: f.id, relativePath: f.relativePath });
        }
        const body = await post('/api/cues', {
            name: `Playlist ${rand()}`, type: 'playlist', volume: 1, playlistItems, ...cue,
        });
        assert.equal(body.success, true, `create playlist failed: ${body.error}`);
        return body.cue.id;
    }

    // First play of a file decodes it; do that before recording so a test's
    // timings measure the app's behavior, not ffmpeg's start-up.
    async function warm(cueId) {
        const cue = (await get(`/api/cues/${cueId}`)).cue;
        await put(`/api/cues/${cueId}`, { volume: 0 });
        await post(`/api/cues/${cueId}/trigger`);
        await waitForStatus(cueId, 'playing', 10000);
        await post(`/api/cues/${cueId}/stop`);
        await waitForIdle(cueId);
        await put(`/api/cues/${cueId}`, { volume: cue.volume });
    }

    const getCue = async (cueId) => (await get(`/api/cues/${cueId}`)).cue;
    const status = async (cueId) => (await getCue(cueId))?.status;
    const trigger = (cueId, body) => post(`/api/cues/${cueId}/trigger`, body);
    const stop = (cueId, body) => post(`/api/cues/${cueId}/stop`, body);
    const updateCue = (cueId, updates) => put(`/api/cues/${cueId}`, updates);

    async function setConfig(updates) {
        const body = await put('/api/config', updates);
        assert.equal(body.success, true, `setConfig failed: ${body.error}`);
        return body.config;
    }

    async function waitForStatus(cueId, wanted, timeoutMs = 5000) {
        const ok = Array.isArray(wanted) ? wanted : [wanted];
        return pollUntil(async () => (ok.includes(await status(cueId)) ? true : null), { timeoutMs, intervalMs: 25 });
    }

    /**
     * Not playing - stopped, or 'completed' after playing to its end - and
     * still not playing 250 ms later: a playlist reads as stopped for a
     * moment while it hands over from one item to the next (see
     * playlists.test.js), which isn't the end of it.
     */
    async function waitForIdle(cueId, timeoutMs = 5000) {
        const idle = ['stopped', 'completed'];
        let since = null;
        return pollUntil(async () => {
            if (!idle.includes(await status(cueId))) {
                since = null;
                return null;
            }
            since ??= Date.now();
            return Date.now() - since >= 250 ? true : null;
        }, { timeoutMs: timeoutMs + 250, intervalMs: 25 });
    }

    // --- Recording ------------------------------------------------------------

    /**
     * Records while `script(mark)` drives the app. `mark(label)` notes the
     * current time under a label (call it right before the action it
     * names). Records `leadSec` of silence before and `tailSec` after.
     * Returns the Take, saved under test-recordings/audio/.
     */
    async function record(t, script, { leadSec = 0.3, tailSec = 0.4 } = {}) {
        const marks = [];
        const mark = (label) => marks.push({ label, epochMs: epochNow() });
        const reportsBefore = dropoutReports().length;
        await recorder.start();
        await sleep(leadSec * 1000);
        let raw;
        try {
            await script(mark);
            await sleep(tailSec * 1000);
        } finally {
            raw = await recorder.stop();
        }
        const take = new Take(raw, {
            channels, sampleRate, marks, name: t?.name || `take-${rand()}`,
        });
        currentTakes?.push(take);
        take.file = take.save(artifactDir);
        t?.diagnostic?.(`recording: ${path.relative(REPO_ROOT, take.file)}`);
        // The engine's own dropout report (every 5 s, so it may land in a
        // later take) - to compare with what the recording heard.
        take.serverDropoutReports = dropoutReports().slice(reportsBefore);
        for (const line of take.serverDropoutReports) t?.diagnostic?.(`server: ${line.trim()}`);
        assert.equal(take.overflows, 0, `recorder lost input (${take.overflows} overflows) - timings unreliable`);
        return take;
    }

    /** Asserts a and b are within `tol` of each other, with a readable message. */
    function near(actual, expected, tol, what) {
        assert.ok(
            actual != null && Math.abs(actual - expected) <= tol,
            `${what}: expected ${expected?.toFixed?.(3) ?? expected} ± ${tol}, got ${actual?.toFixed?.(3) ?? actual}`
        );
    }

    /**
     * Asserts a press took audible effect "at once": within RESPONSE_SEC
     * (HTTP round trip + engine command + an output buffer or two), or a
     * hair early (onset/offset are accurate to a few ms).
     */
    function immediate(delaySec, what) {
        assert.ok(
            delaySec != null && delaySec >= -0.02 && delaySec <= RESPONSE_SEC,
            `${what}: expected within ${RESPONSE_SEC * 1000} ms, took ${delaySec == null ? 'forever' : `${(delaySec * 1000).toFixed(0)} ms`}`
        );
    }

    return {
        test: audioTest,
        skip,
        device: found,
        baseUrl: () => server.baseUrl(),
        request, post, put, get,
        uploadTone, toneCue, tonePlaylist, warm,
        getCue, status, trigger, stop, updateCue, setConfig, waitForStatus, waitForIdle,
        record, near, immediate, sleep,
    };
}

module.exports = { loopbackSuite, findLoopback, Recorder, Take, sleep };
