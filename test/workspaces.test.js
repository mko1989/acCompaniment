/**
 * Workspace management: listing, current-workspace tracking, creating a
 * new workspace, isolation of cues between workspaces, updating/saving/
 * deleting, and the read-only get-by-id / export-import round trip.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { uploadTestAudio, useServer } = require('./helpers/harness');

const server = useServer();

let defaultWorkspaceId;
let secondWorkspaceId;
let cueInDefaultWorkspace;

test('lists workspaces and includes the auto-created default one', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0].name, 'Default Workspace');
    defaultWorkspaceId = body.workspaces[0].id;
});

test('gets the current workspace', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/current`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workspace.id, defaultWorkspaceId);
});

test('creates a cue in the default workspace', async () => {
    const audioFile = await uploadTestAudio(server.baseUrl(), { name: 'WS Test Audio', filename: 'ws-test.wav' });
    const res = await fetch(`${server.baseUrl()}/api/cues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Default Workspace Cue',
            type: 'single_file',
            audioFileId: audioFile.id,
            relativePath: audioFile.relativePath,
        }),
    });
    const body = await res.json();
    assert.equal(body.success, true);
    cueInDefaultWorkspace = body.cue.id;
});

test('creates and activates a second workspace', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Second Workspace', description: 'Created by smoke tests' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.workspace.name, 'Second Workspace');
    secondWorkspaceId = body.workspace.id;
});

test('the second workspace is now current and has no cues', async () => {
    const currentRes = await fetch(`${server.baseUrl()}/api/workspaces/current`);
    const currentBody = await currentRes.json();
    assert.equal(currentBody.workspace.id, secondWorkspaceId);

    const cuesRes = await fetch(`${server.baseUrl()}/api/cues`);
    const cuesBody = await cuesRes.json();
    assert.deepEqual(cuesBody.cues, [], 'a freshly created workspace should start with no cues');
});

test('the default workspace still has its cue when read directly (read-only, does not switch)', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/${defaultWorkspaceId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(
        body.workspace.cues.some((c) => c.id === cueInDefaultWorkspace),
        'reading the default workspace directly should still show its cue'
    );

    // and reading it must not have switched the active workspace
    const currentRes = await fetch(`${server.baseUrl()}/api/workspaces/current`);
    const currentBody = await currentRes.json();
    assert.equal(currentBody.workspace.id, secondWorkspaceId, 'GET /:id must not change which workspace is active');
});

test('switches back to the default workspace via load', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/${defaultWorkspaceId}/load`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const cuesRes = await fetch(`${server.baseUrl()}/api/cues`);
    const cuesBody = await cuesRes.json();
    assert.ok(cuesBody.cues.some((c) => c.id === cueInDefaultWorkspace), 'cue should reappear after switching back');
});

test('renames a workspace via PUT without switching the active workspace', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/${secondWorkspaceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Second Workspace' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workspace.name, 'Renamed Second Workspace');

    const currentRes = await fetch(`${server.baseUrl()}/api/workspaces/current`);
    const currentBody = await currentRes.json();
    assert.equal(currentBody.workspace.id, defaultWorkspaceId, 'PUT /:id must not change the active workspace');
});

test('saves the current (default) workspace explicitly', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/save`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.workspace.id, defaultWorkspaceId);
});

test('deletes the (non-current) second workspace', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/${secondWorkspaceId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    const listRes = await fetch(`${server.baseUrl()}/api/workspaces`);
    const listBody = await listRes.json();
    assert.ok(!listBody.workspaces.some((w) => w.id === secondWorkspaceId), 'deleted workspace should no longer be listed');
});

test('404s for a well-formed but nonexistent workspace id', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/00000000-0000-4000-8000-000000000000`);
    assert.equal(res.status, 404);
});

test('rejects a workspace id that is not a valid UUID', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/not-a-uuid`);
    assert.equal(res.status, 400);
});

test('export then import round-trips a workspace as a new one', async () => {
    const exportRes = await fetch(`${server.baseUrl()}/api/workspaces/${defaultWorkspaceId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeAudioFiles: false }),
    });
    const exportBody = await exportRes.json();
    assert.equal(exportBody.success, true);

    const importRes = await fetch(`${server.baseUrl()}/api/workspaces/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importPath: exportBody.exportPath }),
    });
    assert.equal(importRes.status, 200);
    const importBody = await importRes.json();
    assert.equal(importBody.success, true);
    assert.ok(importBody.workspace.id, 'imported workspace should have an id');
    assert.ok(
        importBody.workspace.cues.some((c) => c.id === cueInDefaultWorkspace),
        'imported workspace should carry over the cue from the exported one'
    );
});

test('rejects importing from a path outside the data directory', async () => {
    const res = await fetch(`${server.baseUrl()}/api/workspaces/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importPath: '/etc/passwd' }),
    });
    assert.equal(res.status, 400);
});
