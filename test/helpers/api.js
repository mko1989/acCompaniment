/**
 * Small REST/WebSocket helpers bound to one test server, shared by the
 * feature test files. `api(server)` takes the object useServer() returns.
 */

const assert = require('node:assert/strict');
const {
    uploadTestAudio, pollUntil, connectWs, waitForMessage, waitForReceived,
} = require('./harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 10);

function api(server) {
    const url = (path) => `${server.baseUrl()}${path}`;

    async function request(method, path, body) {
        const res = await fetch(url(path), {
            method,
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, body: json };
    }

    const post = async (path, body) => (await request('POST', path, body ?? {})).body;
    const put = async (path, body) => (await request('PUT', path, body)).body;
    const get = async (path) => (await request('GET', path)).body;

    async function upload(durationSec = 10) {
        return uploadTestAudio(server.baseUrl(), {
            name: `Audio ${rand()}`,
            filename: `audio-${rand()}.wav`,
            durationSec,
        });
    }

    async function createCue(overrides = {}, durationSec = 10) {
        const audioFile = await upload(durationSec);
        const body = await post('/api/cues', {
            name: `Cue ${rand()}`,
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
            volume: 0.05,
            ...overrides,
        });
        assert.equal(body.success, true, `createCue failed: ${body.error}`);
        return body.cue.id;
    }

    async function createPlaylist(itemCount, overrides = {}, itemDurationSec = 1) {
        const items = [];
        for (let i = 0; i < itemCount; i++) {
            const f = await upload(itemDurationSec);
            items.push({ id: `item-${i}`, name: `Item ${i}`, audioFileId: f.id, relativePath: f.relativePath });
        }
        const body = await post('/api/cues', {
            name: `Playlist ${rand()}`,
            type: 'playlist',
            volume: 0.05,
            playlistItems: items,
            ...overrides,
        });
        assert.equal(body.success, true, `createPlaylist failed: ${body.error}`);
        return body.cue.id;
    }

    const getCue = async (cueId) => (await get(`/api/cues/${cueId}`)).cue;
    const status = async (cueId) => (await getCue(cueId))?.status;
    const trigger = (cueId, body) => post(`/api/cues/${cueId}/trigger`, body);
    const stop = (cueId) => post(`/api/cues/${cueId}/stop`);
    const updateCue = (cueId, updates) => put(`/api/cues/${cueId}`, updates);

    async function setConfig(updates) {
        const body = await put('/api/config', updates);
        assert.equal(body.success, true, `setConfig failed: ${body.error}`);
        return body.config;
    }

    const playback = async () => (await get('/api/cues/status/playback')).status;
    const voices = async (cueId) => (await playback()).voices.filter((v) => v.cueId === cueId);

    async function waitForStatus(cueId, wanted, timeoutMs = 5000) {
        return pollUntil(async () => ((await status(cueId)) === wanted ? true : null), { timeoutMs, intervalMs: 50 });
    }

    async function waitFor(fn, timeoutMs = 5000) {
        return pollUntil(async () => (await fn()) || null, { timeoutMs, intervalMs: 50 });
    }

    async function playing(...cueIds) {
        for (const id of cueIds) await trigger(id);
        for (const id of cueIds) await waitForStatus(id, 'playing');
    }

    async function stopAll(behavior = 'stop') {
        return post('/api/cues/stop-all', { behavior });
    }

    const ws = () => connectWs(server.baseUrl());

    function waitForCueStatus(socket, cueId, wanted, timeoutMs = 5000) {
        return waitForMessage(
            socket,
            (m) => m.type === 'cue_status' && m.payload?.cueId === cueId && m.payload?.status === wanted,
            timeoutMs
        );
    }

    /** A cue status the server sent on connect (or sends later). */
    function waitForInitialCueStatus(socket, cueId, wanted, timeoutMs = 5000) {
        return waitForReceived(
            socket,
            (m) => m.type === 'cue_status' && m.payload?.cueId === cueId && m.payload?.status === wanted,
            timeoutMs
        );
    }

    function waitForTimeUpdate(socket, cueId, predicate = () => true, timeoutMs = 5000) {
        return waitForMessage(
            socket,
            (m) => m.type === 'playback-time-update' && m.payload?.cueId === cueId && predicate(m.payload),
            timeoutMs
        );
    }

    return {
        request, post, put, get, upload, createCue, createPlaylist, getCue, status, trigger, stop,
        updateCue, setConfig, playback, voices, waitForStatus, waitFor, playing, stopAll, ws,
        waitForCueStatus, waitForInitialCueStatus, waitForTimeUpdate,
    };
}

module.exports = { api, sleep };
