/**
 * The WebSocket message protocol itself: both the event-style
 * {type, payload} messages (trigger_cue, toggle_cue, stop_cue,
 * stop_all_cues, create_cue, update_cue, delete_cue, playlist_navigate,
 * ping) and the invoke-style {type, requestId, payload} -> `${type}_response`
 * request/response messages (get-app-config, save-app-config, get-cues,
 * add-or-update-cue, generate-uuid, get-media-duration, get-http-remote-info,
 * delete-cue). REST already covers this same backend logic elsewhere; this
 * file is about the WebSocket wire protocol the browser UI and Companion
 * actually speak.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    uploadTestAudio,
    useServer,
    connectWs,
    waitForType,
    wsInvoke,
    wsSend,
} = require('./helpers/harness');

const server = useServer();

let ws;
let audioFile;

test('connects over WebSocket', async () => {
    ws = await connectWs(server.baseUrl());
    assert.equal(ws.readyState, ws.OPEN);
});

test('responds to ping with pong', async () => {
    const pongPromise = waitForType(ws, 'pong');
    wsSend(ws, 'ping');
    await pongPromise;
});

test('invoke: generate-uuid returns a real UUID', async () => {
    const res = await wsInvoke(ws, 'generate-uuid');
    assert.match(res.payload, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('invoke: get-app-config returns the current config', async () => {
    const res = await wsInvoke(ws, 'get-app-config');
    assert.equal(res.payload.httpRemotePort, 3333);
});

test('invoke: save-app-config updates and broadcasts the config', async () => {
    const configUpdatePromise = waitForType(ws, 'config-updated');
    const res = await wsInvoke(ws, 'save-app-config', { defaultFadeOutTime: 500 });
    assert.equal(res.payload.success, true);

    const broadcast = await configUpdatePromise;
    assert.equal(broadcast.payload.config.defaultFadeOutTime, 500);
});

test('invoke: get-http-remote-info points at the /remote page', async () => {
    const res = await wsInvoke(ws, 'get-http-remote-info');
    assert.equal(res.payload.enabled, true);
    for (const iface of res.payload.interfaces) {
        assert.match(iface.url, /\/remote$/);
    }
});

test('uploads an audio file to build a cue from', async () => {
    audioFile = await uploadTestAudio(server.baseUrl(), { name: 'WS Protocol Audio', filename: 'ws-protocol.wav' });
    assert.ok(audioFile.id);
});

let wsCreatedCueId;

test('event: create_cue creates a cue and responds with cue_created', async () => {
    const responsePromise = waitForType(ws, 'cue_created');
    wsSend(ws, 'create_cue', {
        name: 'WS Created Cue',
        type: 'single_file',
        audioFileId: audioFile.id,
        relativePath: audioFile.relativePath,
        volume: 0.05,
    });
    const response = await responsePromise;
    assert.equal(response.payload.success, true);
    assert.ok(response.payload.cue.id);
    wsCreatedCueId = response.payload.cue.id;
});

test('event: update_cue updates the cue and responds with cue_updated', async () => {
    const responsePromise = waitForType(ws, 'cue_updated');
    wsSend(ws, 'update_cue', { cueId: wsCreatedCueId, updates: { name: 'Renamed via WS' } });
    const response = await responsePromise;
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.cueId, wsCreatedCueId);

    const getRes = await fetch(`${server.baseUrl()}/api/cues/${wsCreatedCueId}`);
    const getBody = await getRes.json();
    assert.equal(getBody.cue.name, 'Renamed via WS');
});

test('event: trigger_cue starts playback and responds with cue_triggered', async () => {
    const responsePromise = waitForType(ws, 'cue_triggered');
    wsSend(ws, 'trigger_cue', { cueId: wsCreatedCueId });
    const response = await responsePromise;
    assert.equal(response.payload.success, true);

    const statusUpdate = await waitForType(ws, 'cue_status', 5000).catch(() => null);
    if (statusUpdate) {
        assert.equal(statusUpdate.payload.cueId, wsCreatedCueId);
    }
});

test('event: toggle_cue on a playing cue applies its retrigger behavior', async () => {
    const responsePromise = waitForType(ws, 'cue_toggled');
    wsSend(ws, 'toggle_cue', { cueId: wsCreatedCueId });
    const response = await responsePromise;
    assert.equal(response.payload.success, true);
});

test('event: stop_cue stops playback and responds with cue_stopped', async () => {
    const responsePromise = waitForType(ws, 'cue_stopped');
    wsSend(ws, 'stop_cue', { cueId: wsCreatedCueId });
    const response = await responsePromise;
    assert.equal(response.payload.success, true);
});

test('event: stop_all_cues responds with all_cues_stopped', async () => {
    const responsePromise = waitForType(ws, 'all_cues_stopped');
    wsSend(ws, 'stop_all_cues');
    const response = await responsePromise;
    assert.equal(response.payload.success, true);
});

test('event: delete_cue deletes the cue and responds with cue_deleted', async () => {
    const responsePromise = waitForType(ws, 'cue_deleted');
    wsSend(ws, 'delete_cue', { cueId: wsCreatedCueId });
    const response = await responsePromise;
    assert.equal(response.payload.success, true);

    const getRes = await fetch(`${server.baseUrl()}/api/cues/${wsCreatedCueId}`);
    assert.equal(getRes.status, 404);
});

test('invoke: add-or-update-cue creates a new cue when id is "new"', async () => {
    const res = await wsInvoke(ws, 'add-or-update-cue', {
        id: 'new',
        name: 'Invoke Created Cue',
        type: 'single_file',
        audioFileId: audioFile.id,
        relativePath: audioFile.relativePath,
    });
    assert.equal(res.payload.success, true);
    assert.ok(res.payload.cue.id);

    // clean up via the invoke-style delete-cue path too, so this file
    // covers both delete flavors (event-style delete_cue above, invoke-
    // style delete-cue here)
    const deleteRes = await wsInvoke(ws, 'delete-cue', res.payload.cue.id);
    assert.equal(deleteRes.payload.success, true);
});

test('invoke: get-media-duration resolves a real duration for an uploaded file', async () => {
    const res = await wsInvoke(ws, 'get-media-duration', { filePath: audioFile.relativePath });
    assert.ok(typeof res.payload === 'number' && res.payload > 0);
});

test('invoke: unknown message type returns an error, not a crash', async () => {
    const res = await wsInvoke(ws, 'not-a-real-message-type');
    assert.ok(res.error);
    // and the connection must still be usable afterwards
    const pingRes = waitForType(ws, 'pong');
    wsSend(ws, 'ping');
    await pingRes;
});

test('closes the WebSocket connection', () => {
    ws.close();
});
