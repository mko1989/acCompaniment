/**
 * The audio engine must recover once its settings are valid again: a failed
 * reconfiguration (a rate the device refuses, a device that went away) must
 * not leave it dead until the app restarts.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer } = require('./helpers/harness');
const { api } = require('./helpers/api');

const server = useServer();
const t = api(server);

const putConfig = (body) => fetch(`${server.baseUrl()}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

test('cues play again after a failed engine reopen, once the settings are valid again',
    { todo: 'WO-017: after a failed reconfiguration the engine stays "not initialized" until restart' },
    async () => {
        const before = (await (await fetch(`${server.baseUrl()}/api/config`)).json()).config;
        const cueId = await t.createCue({ volume: 0.05 });
        try {
            // Any failed reopen will do; today a non-numeric rate is the reliable
            // one (RtAudio clamps odd numbers). Once WO-016 rejects it at the
            // API, this needs another way to make the reopen fail.
            await putConfig({ audioSampleRate: 'fast' });
            await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
            await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });

            await putConfig({ audioSampleRate: before.audioSampleRate });
            const res = await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
            const body = await res.json();
            assert.equal(body.success, true, `trigger after recovery failed: ${body.error}`);
        } finally {
            await putConfig({ audioSampleRate: before.audioSampleRate });
            await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
        }
    });
