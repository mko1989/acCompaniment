#!/usr/bin/env node
/**
 * Writes rust/app-fixtures/http-inputs.jsonl: the requests `rust-anything app
 * record --http` sends, in name order, to one server started on a fresh copy
 * of rust/app-fixtures/data (see make-seed.js). Ids are read from the seed,
 * so rebuild the seed, then this, then record.
 *
 * Phases: 1 reads and error paths, 2 changes, 3 playback, 4 deletes/reset.
 */

const path = require('node:path');
const fs = require('node:fs');

const FIX = path.join(__dirname, '..', 'app-fixtures');
const DATA = path.join(FIX, 'data');
const wsDir = path.join(DATA, 'cues', 'workspaces');
const wsFile = fs.readdirSync(wsDir).find((f) => f.endsWith('.json'));
const workspace = JSON.parse(fs.readFileSync(path.join(wsDir, wsFile), 'utf8'));
const cue = Object.fromEntries(workspace.cues.map((c) => [c.name, c.id]));
const metaDir = path.join(DATA, 'audio', 'metadata');
const audio = Object.fromEntries(fs.readdirSync(metaDir).map((f) => {
    const m = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8'));
    return [m.relativePath || m.filename || m.name, m.id];
}));
const PROJECT = workspace.id;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const MP3 = audio['tone.mp3'];
const WAV = audio['tone-mono-44k.wav'];
if (!MP3 || !WAV || !cue.Plain) throw new Error('seed ids not found: rebuild with make-seed.js');

const cases = [];
let phase = 0;
let n = 0;
function section(p) { phase = p; n = 0; }
function req(label, method, p, body, headers) {
    n += 1;
    const name = `${phase}${String(n).padStart(3, '0')}-${label}`;
    // rust-anything drops a request identical to an earlier one; the same read
    // before and after a change is the point here, so tag each with its case.
    // The app ignores query parameters it does not know.
    const tagged = `${p}${p.includes('?') ? '&' : '?'}case=${name.slice(0, 4)}`;
    const c = { name, method, path: tagged };
    if (body !== undefined) {
        c.headers = { 'content-type': 'application/json', ...(headers || {}) };
        c.body = typeof body === 'string' ? body : JSON.stringify(body);
    } else if (headers) {
        c.headers = headers;
    }
    cases.push(c);
}
const get = (label, p, headers) => req(label, 'GET', p, undefined, headers);
const post = (label, p, body = {}) => req(label, 'POST', p, body);
const put = (label, p, body) => req(label, 'PUT', p, body);
const del = (label, p) => req(label, 'DELETE', p);
function multipart(label, p, field, filename, text) {
    const b = 'rustanythingboundary';
    const body = `--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
        + `Content-Type: application/octet-stream\r\n\r\n${text}\r\n--${b}--\r\n`;
    req(label, 'POST', p, body, { 'content-type': `multipart/form-data; boundary=${b}` });
}

// --- 1: reads, static files, error paths ------------------------------------
section(1);
get('health', '/api/remote/health');
get('remote-info', '/api/remote/info');
get('remote-status', '/api/remote/status');
get('remote-cues', '/api/remote/cues');
get('remote-master-volume', '/api/remote/master-volume');
get('remote-crossfade', '/api/remote/crossfade');
get('cues', '/api/cues');
for (const [name, id] of Object.entries(cue)) get(`cue-${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '').toLowerCase()}`, `/api/cues/${id}`);
get('cue-unknown', `/api/cues/${UNKNOWN}`);
get('cue-not-uuid', '/api/cues/not-a-uuid');
get('cue-uppercase-uuid', `/api/cues/${cue.Plain.toUpperCase()}`);
get('playback-status', '/api/cues/status/playback');
get('config', '/api/config');
get('config-path', '/api/config/path');
get('audio-list', '/api/audio');
get('audio-list-page', '/api/audio?limit=2&offset=1');
get('audio-list-limit-huge', '/api/audio?limit=9999');
get('audio-list-limit-bad', '/api/audio?limit=abc&offset=-3');
get('audio-stats', '/api/audio/stats/overview');
get('audio-search', '/api/audio/search/tone');
get('audio-search-unicode', `/api/audio/search/${encodeURIComponent('zażółć')}`);
get('audio-search-none', '/api/audio/search/nothing-matches');
get('audio-file', `/api/audio/${MP3}`);
get('audio-file-unknown', `/api/audio/${UNKNOWN}`);
get('audio-serve', `/api/audio/serve/${WAV}`, { range: 'bytes=0-15' });
get('audio-serve-suffix', `/api/audio/serve/${WAV}`, { range: 'bytes=-8' });
get('audio-serve-open-range', `/api/audio/serve/${WAV}`, { range: 'bytes=100000-' });
get('audio-serve-bad-range', `/api/audio/serve/${WAV}`, { range: 'bytes=999999999-' });
get('audio-serve-multi-range', `/api/audio/serve/${WAV}`, { range: 'bytes=0-1,4-5' });
get('audio-serve-unknown', `/api/audio/serve/${UNKNOWN}`);
get('workspaces', '/api/workspaces');
get('workspaces-with-cues', '/api/workspaces?includeCues=true&limit=1');
get('workspace-current', '/api/workspaces/current');
get('workspace', `/api/workspaces/${PROJECT}`);
get('workspace-unknown', `/api/workspaces/${UNKNOWN}`);
get('projects', '/api/projects');
get('project-current', '/api/projects/current');
get('static-root', '/');
get('static-remote', '/remote');
get('static-index', '/index.html');
get('static-css', '/styles/base.css');
get('static-missing', '/styles/missing.css');
get('static-traversal', '/../server.js');
get('unknown-api-route', '/api/nope');
get('method-mismatch-stop-all', '/api/cues/stop-all');
get('method-mismatch-upload', '/api/audio/upload');
get('method-mismatch-remote', '/api/remote/cues/stop-all');
req('method-mismatch-projects', 'DELETE', '/api/projects/current');
req('method-mismatch-config', 'PUT', '/api/config/network', {});
req('options-preflight', 'OPTIONS', '/api/cues', undefined,
    { origin: 'http://example.test', 'access-control-request-method': 'POST' });
get('cors-origin', '/api/remote/health', { origin: 'http://example.test' });

// --- 2: changes ------------------------------------------------------------
section(2);
put('config-update', '/api/config', { defaultFadeInTime: 250, crossfadeTime: 1500, theme: 'dark' });
put('config-update-invalid-port', '/api/config', { httpRemotePort: 70000 });
put('config-update-unknown-key', '/api/config', { notARealSetting: 1 });
req('config-bad-json', 'PUT', '/api/config', '{"theme": ', {});
post('cue-create', '/api/cues', { name: 'Created 🎵', type: 'single_file', audioFileId: WAV, relativePath: 'tone-mono-44k.wav', volume: 0.05 });
post('cue-create-minimal', '/api/cues', { name: 'Minimal' });
post('cue-create-empty', '/api/cues', {});
post('cue-create-spotify', '/api/cues', { name: 'S', type: 'spotify', spotifyUri: 'spotify:track:x' });
post('cue-create-weird-values', '/api/cues', { name: 'Weird', type: 'single_file', volume: 1.5, fadeInTime: -1, trimStartTime: 1e21 });
req('cue-create-no-body', 'POST', '/api/cues');
put('cue-update', `/api/cues/${cue.Plain}`, { name: 'Plain renamed', volume: 0.04, loop: true });
put('cue-update-output-patch', `/api/cues/${cue.Plain}`, { outputPatch: [1, 1] });
put('cue-update-to-spotify', `/api/cues/${cue.Plain}`, { type: 'spotify' });
put('cue-update-unknown', `/api/cues/${UNKNOWN}`, { name: 'x' });
get('cue-after-update', `/api/cues/${cue.Plain}`);
post('cue-reorder', '/api/cues/reorder', { cueIds: Object.values(cue).reverse() });
post('cue-reorder-bad', '/api/cues/reorder', { cueIds: 'nope' });
get('cues-after-reorder', '/api/cues');
post('master-volume', '/api/remote/master-volume', { volume: 0.5 });
post('master-volume-bad', '/api/remote/master-volume', { volume: 'loud' });
post('crossfade-on', '/api/remote/crossfade', { enabled: true });
post('crossfade-bad', '/api/remote/crossfade', { enabled: 'yes' });
post('crossfade-off', '/api/remote/crossfade', { enabled: false });
put('audio-update', `/api/audio/${MP3}`, { name: 'Renamed MP3', tags: ['a', 'ż'] });
put('audio-update-unknown', `/api/audio/${UNKNOWN}`, { name: 'x' });
post('audio-validate', '/api/audio/validate', { filePath: 'rust/app-fixtures/incoming/import.wav' });
post('audio-validate-missing', '/api/audio/validate', { filePath: 'rust/app-fixtures/incoming/missing.wav' });
post('audio-validate-not-audio', '/api/audio/validate', { filePath: 'rust/app-fixtures/incoming/notes.txt' });
post('audio-import', '/api/audio/import', { filePath: 'rust/app-fixtures/incoming/import.wav', name: 'Imported' });
post('audio-import-again', '/api/audio/import', { filePath: 'rust/app-fixtures/incoming/import.wav' });
post('audio-import-missing', '/api/audio/import', {});
multipart('audio-upload-not-audio', '/api/audio/upload', 'audioFile', 'notes.txt', 'hello');
multipart('audio-upload-fake-wav', '/api/audio/upload', 'audioFile', 'fake.wav', 'not really a wav');
multipart('audio-upload-wrong-field', '/api/audio/upload', 'file', 'x.wav', 'x');
post('audio-upload-not-multipart', '/api/audio/upload', {});
multipart('audio-replace-unknown', `/api/audio/${UNKNOWN}/replace`, 'audioFile', 'x.wav', 'x');
get('audio-list-after-import', '/api/audio');
post('workspace-create', '/api/workspaces', { name: 'Second workspace' });
post('workspace-create-empty', '/api/workspaces', {});
get('workspace-current-after-create', '/api/workspaces/current');
post('workspace-save', '/api/workspaces/save', { name: 'Saved', description: 'desc' });
put('workspace-update', `/api/workspaces/${PROJECT}`, { name: 'Seed renamed' });
put('workspace-update-unknown', `/api/workspaces/${UNKNOWN}`, { name: 'x' });
post('workspace-load', `/api/workspaces/${PROJECT}/load`);
post('workspace-export', `/api/workspaces/${PROJECT}/export`, { includeAudioFiles: false });
post('workspace-import-missing', '/api/workspaces/import', { importPath: 'rust/app-fixtures/incoming/missing.json' });
post('project-create', '/api/projects', { name: 'New project' });
get('project-current-after-create', '/api/projects/current');
put('project-rename', '/api/projects/current', { name: 'Renamed project ✓' });
put('project-rename-empty', '/api/projects/current', { name: '' });
get('projects-after-create', '/api/projects');
post('project-open-seed', `/api/projects/${PROJECT}/open`);
post('project-open-unknown', `/api/projects/${UNKNOWN}/open`);
get('project-bundle-unknown', `/api/projects/${UNKNOWN}/bundle`);
multipart('project-import-not-zip', '/api/projects/import', 'bundle', 'x.zip', 'not a zip');
post('project-import-not-multipart', '/api/projects/import', {});
post('project-open-seed-again', `/api/projects/${PROJECT}/open`);

// --- 3: playback (plays into BlackHole when present) ------------------------
section(3);
post('trigger-plain', `/api/cues/${cue.Plain}/trigger`);
get('status-while-playing', '/api/cues/status/playback');
get('remote-status-while-playing', '/api/remote/status');
post('stop-plain', `/api/cues/${cue.Plain}/stop`);
post('stop-plain-again', `/api/cues/${cue.Plain}/stop`);
post('trigger-fades', `/api/cues/${cue['Fades and loop']}/trigger`);
post('stop-fades-with-fade', `/api/cues/${cue['Fades and loop']}/stop`, { fadeOut: true });
post('trigger-toggle', `/api/cues/${cue['Toggle retrigger']}/trigger`);
post('retrigger-toggle', `/api/cues/${cue['Toggle retrigger']}/trigger`);
get('toggle-cue-after-retrigger', `/api/cues/${cue['Toggle retrigger']}`);
post('toggle-pause', `/api/cues/${cue['Toggle retrigger']}/toggle-pause`);
post('toggle-pause-unknown', `/api/cues/${UNKNOWN}/toggle-pause`);
post('trigger-ducked', `/api/cues/${cue.Ducked}/trigger`);
post('trigger-ducking', `/api/cues/${cue['Ducking trigger']}/trigger`);
get('status-ducking', '/api/cues/status/playback');
post('trigger-playlist', `/api/cues/${cue.Playlist}/trigger`);
post('playlist-next', `/api/cues/${cue.Playlist}/playlist/navigate`, { direction: 'next' });
post('playlist-previous', `/api/cues/${cue.Playlist}/playlist/navigate`, { direction: 'previous' });
post('playlist-bad-direction', `/api/cues/${cue.Playlist}/playlist/navigate`, { direction: 'up' });
post('playlist-jump', `/api/cues/${cue.Playlist}/playlist/jump`, { index: 2 });
post('playlist-jump-out-of-range', `/api/cues/${cue.Playlist}/playlist/jump`, { index: 99 });
post('playlist-navigate-single', `/api/cues/${cue.Plain}/playlist/navigate`, { direction: 'next' });
post('remote-trigger', `/api/remote/cues/${cue.ADTS}/trigger`);
post('remote-trigger-unknown', `/api/remote/cues/${UNKNOWN}/trigger`);
post('remote-navigate', `/api/remote/cues/${cue['Shuffled playlist']}/playlist/navigate`, { direction: 'next' });
post('remote-stop', `/api/remote/cues/${cue.ADTS}/stop`);
post('trigger-unicode', `/api/cues/${cue['Zażółć 🎵 cue']}/trigger`);
post('trigger-trimmed', `/api/cues/${cue['Trimmed MP3']}/trigger`);
post('trigger-unknown', `/api/cues/${UNKNOWN}/trigger`);
post('trigger-not-uuid', '/api/cues/nope/trigger');
post('stop-all-fade', '/api/cues/stop-all', { behavior: 'fade_out_and_stop' });
post('stop-all', '/api/cues/stop-all', { behavior: 'stop' });
post('remote-stop-all', '/api/remote/cues/stop-all');
post('stop-all-no-body', '/api/cues/stop-all');
get('status-after-stop-all', '/api/cues/status/playback');

// --- 4: deletes and reset ---------------------------------------------------
section(4);
del('cue-delete', `/api/cues/${cue.ADTS}`);
del('cue-delete-again', `/api/cues/${cue.ADTS}`);
del('cue-delete-not-uuid', '/api/cues/nope');
del('audio-delete-in-use', `/api/audio/${MP3}`);
del('audio-delete-unknown', `/api/audio/${UNKNOWN}`);
get('cues-after-deletes', '/api/cues');
del('project-delete-open', `/api/projects/${PROJECT}`);
del('project-delete-unknown', `/api/projects/${UNKNOWN}`);
del('workspace-delete-unknown', `/api/workspaces/${UNKNOWN}`);
// Last, because the original saves this (WO-016) and its engine then stays dead even after a
// valid rate is put back (WO-017): nothing after it would play.
put('config-update-invalid', '/api/config', { audioSampleRate: 'fast' });
put('config-restore-sample-rate', '/api/config', { audioSampleRate: 48000 });
post('trigger-after-restore', `/api/cues/${cue.Plain}/trigger`);
post('config-reset', '/api/config/reset');
get('config-after-reset', '/api/config');
get('health-at-end', '/api/remote/health');

fs.writeFileSync(path.join(FIX, 'http-inputs.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`${cases.length} requests written to rust/app-fixtures/http-inputs.jsonl`);
