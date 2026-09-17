/**
 * App configuration: get/update/validate/reset, network interface listing,
 * and the config file path endpoint.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fssync = require('node:fs');

const { useServer } = require('./helpers/harness');

const server = useServer();

test('gets the current configuration with sane defaults', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.config.httpRemotePort, 3333);
    assert.equal(typeof body.config.crossfadeTime, 'number');
    assert.equal(typeof body.config.supportedAudioFormats, 'object');
});

test('updates a simple config field and it is reflected on the next read', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultFadeInTime: 250 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.config.defaultFadeInTime, 250);

    const getRes = await fetch(`${server.baseUrl()}/api/config`);
    const getBody = await getRes.json();
    assert.equal(getBody.config.defaultFadeInTime, 250);
});

test('the config update was persisted to disk', async () => {
    const configPath = path.join(server.tempDataDir(), 'config', 'appConfig.json');
    const raw = fssync.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.defaultFadeInTime, 250);
});

test('rejects a config update with an out-of-range port', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ httpRemotePort: 99999 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(Array.isArray(body.details));

    // and it must not actually have been applied
    const getRes = await fetch(`${server.baseUrl()}/api/config`);
    const getBody = await getRes.json();
    assert.notEqual(getBody.config.httpRemotePort, 99999);
});

test('rejects a config update with an out-of-range crossfade time', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crossfadeTime: 50 }), // below the 100ms floor
    });
    assert.equal(res.status, 400);
});

test('resets configuration to defaults', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config/reset`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.config.defaultFadeInTime, 0, 'reset should discard the earlier defaultFadeInTime override');
    assert.equal(body.config.httpRemotePort, 3333);
});

test('lists network interfaces', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config/network`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.interfaces));
});

test('returns the config file path, inside the isolated data dir', async () => {
    const res = await fetch(`${server.baseUrl()}/api/config/path`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.path.startsWith(server.tempDataDir()), 'config path should live under this test\'s isolated data dir');
});
