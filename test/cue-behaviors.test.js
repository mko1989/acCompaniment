/**
 * Cue playback behaviors beyond the basic trigger/stop cycle already
 * covered in smoke.test.js: pause/resume, every retrigger behavior
 * (restart, stop, fade_out_and_stop, do_nothing, pause_resume, and the
 * play_new_instance graceful-fallback-to-restart), stop-all, and the
 * newly-wired master volume control.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { uploadTestAudio, pollUntil, useServer } = require('./helpers/harness');

const server = useServer();

async function createCue(overrides = {}) {
    const audioFile = await uploadTestAudio(server.baseUrl(), {
        name: `Behavior Test Audio ${Math.random().toString(36).slice(2)}`,
        filename: `behavior-${Math.random().toString(36).slice(2)}.wav`,
    });
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Behavior Test Cue',
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
            volume: 0.05,
            ...overrides,
        }),
    });
    const body = await res.json();
    assert.equal(body.success, true, `createCue failed: ${body.error}`);
    return body.cue.id;
}

async function getStatus(cueId) {
    const res = await fetch(`${server.baseUrl()}/api/cues/${cueId}`);
    const body = await res.json();
    return body.cue?.status;
}

async function trigger(cueId) {
    const res = await fetch(`${server.baseUrl()}/api/cues/${cueId}/trigger`, { method: 'POST' });
    return res.json();
}

async function waitForStatus(cueId, status, timeoutMs = 5000) {
    return pollUntil(async () => (await getStatus(cueId)) === status ? true : null, { timeoutMs });
}

test('pause and resume a playing cue via toggle-pause', async () => {
    const cueId = await createCue();
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const pauseRes = await fetch(`${server.baseUrl()}/api/cues/${cueId}/toggle-pause`, { method: 'POST' });
    const pauseBody = await pauseRes.json();
    assert.equal(pauseBody.success, true);
    assert.equal(pauseBody.status, 'paused');
    await waitForStatus(cueId, 'paused');

    const resumeRes = await fetch(`${server.baseUrl()}/api/cues/${cueId}/toggle-pause`, { method: 'POST' });
    const resumeBody = await resumeRes.json();
    assert.equal(resumeBody.success, true);
    assert.equal(resumeBody.status, 'playing');
    await waitForStatus(cueId, 'playing');

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('toggle-pause on a cue that is not playing fails cleanly', async () => {
    const cueId = await createCue();
    const res = await fetch(`${server.baseUrl()}/api/cues/${cueId}/toggle-pause`, { method: 'POST' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
});

test('retrigger behavior "restart": triggering an already-playing cue restarts it', async () => {
    const cueId = await createCue({ retriggerBehavior: 'restart' });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true);
    await waitForStatus(cueId, 'playing');

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('retrigger behavior "do_nothing": triggering again leaves it playing, unchanged', async () => {
    const cueId = await createCue({ retriggerBehavior: 'do_nothing' });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true);
    assert.equal(await getStatus(cueId), 'playing', 'cue should still be playing, not stopped or restarted');

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('retrigger behavior "stop": triggering again stops it', async () => {
    const cueId = await createCue({ retriggerBehavior: 'stop' });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true);
    await waitForStatus(cueId, 'stopped');
});

test('retrigger behavior "fade_out_and_stop": triggering again fades out and stops', async () => {
    const cueId = await createCue({ retriggerBehavior: 'fade_out_and_stop', fadeOutTime: 100 });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true);
    await waitForStatus(cueId, 'stopped', 5000);
});

test('retrigger behavior "fade_out_and_stop": stays "playing" for the full fade duration, not stopped instantly', async () => {
    // Regression test: the cue's reported status used to jump straight to
    // 'stopped' (and broadcast as such) the instant the fade *started*,
    // while the mixer kept the audio itself audibly playing (getting
    // quieter) for the whole configured fadeOutTime - so a client watching
    // status would see "stopped" while the speakers were still making
    // sound. The status should only become 'stopped' once the fade has
    // actually finished.
    const fadeOutTime = 2000;
    const cueId = await createCue({ retriggerBehavior: 'fade_out_and_stop', fadeOutTime });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true);

    await new Promise((resolve) => setTimeout(resolve, fadeOutTime * 0.5));
    assert.equal(await getStatus(cueId), 'playing', 'cue should still report playing while mid-fade');

    await waitForStatus(cueId, 'stopped', fadeOutTime);
});

test('retrigger behavior "pause_resume": triggering again pauses it', async () => {
    const cueId = await createCue({ retriggerBehavior: 'pause_resume' });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true);
    await waitForStatus(cueId, 'paused');

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('retrigger behavior "play_new_instance" degrades gracefully to a restart instead of erroring', async () => {
    const cueId = await createCue({ retriggerBehavior: 'play_new_instance' });
    await trigger(cueId);
    await waitForStatus(cueId, 'playing');

    const second = await trigger(cueId);
    assert.equal(second.success, true, 'play_new_instance should not surface an error to the operator');
    await waitForStatus(cueId, 'playing');

    await fetch(`${server.baseUrl()}/api/cues/${cueId}/stop`, { method: 'POST' });
});

test('stop-all stops every playing cue', async () => {
    const cueA = await createCue();
    const cueB = await createCue();
    await trigger(cueA);
    await trigger(cueB);
    await waitForStatus(cueA, 'playing');
    await waitForStatus(cueB, 'playing');

    const res = await fetch(`${server.baseUrl()}/api/cues/stop-all`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.stoppedCount >= 2);

    await waitForStatus(cueA, 'stopped');
    await waitForStatus(cueB, 'stopped');
});

test('stop-all with fade_out_and_stop keeps cues "playing" for the fade duration, not stopped instantly', async () => {
    // Same regression as the single-cue fade_out_and_stop retrigger test,
    // but for the "Stop All" button's fade behavior: stopAllCues() used to
    // clear state and broadcast 'stopped' for every playing cue the instant
    // the fade *started*, while the mixer kept them all audibly playing
    // (getting quieter) for the whole fade. Stop All fades over its own
    // configured defaultStopAllFadeOutTime (1500ms by default), not each
    // cue's fadeOutTime - see test/stop-and-fade.test.js for that and the
    // zero-fade cases.
    const fadeOutTime = 2000;
    const cueA = await createCue({ fadeOutTime });
    const cueB = await createCue({ fadeOutTime });
    await trigger(cueA);
    await trigger(cueB);
    await waitForStatus(cueA, 'playing');
    await waitForStatus(cueB, 'playing');

    const res = await fetch(`${server.baseUrl()}/api/cues/stop-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ behavior: 'fade_out_and_stop' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    await new Promise((resolve) => setTimeout(resolve, fadeOutTime * 0.5));
    assert.equal(await getStatus(cueA), 'playing', 'cue A should still report playing while mid-fade');
    assert.equal(await getStatus(cueB), 'playing', 'cue B should still report playing while mid-fade');

    await waitForStatus(cueA, 'stopped', fadeOutTime);
    await waitForStatus(cueB, 'stopped', fadeOutTime);
});

// --- Master volume ---------------------------------------------------------

test('master volume defaults to 1.0 and can be read', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/master-volume`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.volume, 1);
});

test('sets the master volume and it is reflected on the next read', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/master-volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: 0.5 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.volume, 0.5);

    const getRes = await fetch(`${server.baseUrl()}/api/remote/master-volume`);
    const getBody = await getRes.json();
    assert.equal(getBody.volume, 0.5);
});

test('master volume is clamped to the 0-2 range rather than rejected', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/master-volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: 99 }),
    });
    const body = await res.json();
    assert.equal(body.volume, 2, 'volume should be clamped to the max of 2, not accepted as-is or rejected');
});

test('rejects a non-numeric master volume', async () => {
    const res = await fetch(`${server.baseUrl()}/api/remote/master-volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: 'loud' }),
    });
    assert.equal(res.status, 400);
});

test('reflects the current master volume in the playback status endpoint', async () => {
    await fetch(`${server.baseUrl()}/api/remote/master-volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: 0.75 }),
    });
    const res = await fetch(`${server.baseUrl()}/api/remote/status`);
    const body = await res.json();
    assert.equal(body.status.masterVolume, 0.75);
});
