# acCompaniment — Backend Fix & Multichannel Plan

Status: **implemented** · Owner: unassigned · Last updated: 2026-06-14

This document breaks the backend review into self-contained tasks that independent
agents can pick up. Each task lists the problem, affected files (with line refs at
time of writing — re-verify before editing), the fix, and acceptance criteria.

## Conventions

- **Auth is explicitly out of scope.** The app runs on closed/trusted LANs. Do **not**
  add tokens, API keys, or login. CORS may stay permissive.
- Severity reflects impact on a closed-LAN deployment (not internet exposure).
- Each task is designed to be independent. Where ordering matters, it's noted under
  **Depends on**.
- After any change, run the app (`npm run start:node`), exercise the affected flow,
  and check `~/.accompaniment` on disk.
- Don't break the WebSocket message contract used by the frontend (`renderer.js`,
  `cueStore.js`). If you change a response shape, update both sides.

## Status legend

`[ ]` todo · `[~]` in progress · `[x]` done · `[-]` won't do

---

# Track A — Persistence & data integrity (highest priority)

These cause real data loss and the empty/orphaned workspace files in
`~/.accompaniment/cues/workspaces`.

## A1 — Atomic workspace & config writes `[x]`
**Severity:** High · **Files:** `src/backend/cueDataManager.js` (~127, ~157),
`src/backend/appConfigManager.js` (~84-108)

**Problem:** Saves use direct `fs.writeFile`. A crash or concurrent write mid-flush
leaves 0-byte JSON files. `getAllWorkspaces` then skips them but they linger forever
(the "Skipping empty workspace file" log spam).

**Fix:**
1. Add a shared helper `writeJsonAtomic(filePath, obj)` that writes to
   `${filePath}.tmp.${pid}` then `fs.rename` over the target (rename is atomic on
   same filesystem). Optionally `fsync` before rename.
2. Route all workspace/config/metadata writes through it.

**Acceptance:**
- Killing the server mid-save never produces a 0-byte file.
- No new "Skipping empty workspace file" entries appear after normal use.

---

## A2 — Serialize workspace saves (no interleaving) `[x]`
**Severity:** High · **Files:** `src/backend/cueDataManager.js`
**Depends on:** A1

**Problem:** Concurrent `saveWorkspace()` calls (rapid cue edits) interleave
read-modify-write with no lock.

**Fix:** Add a simple per-manager promise chain / mutex so saves run sequentially:
```js
this._saveQueue = this._saveQueue.then(() => this._doSave(...)).catch(...)
```
or a tiny `async-mutex`-style guard (no new dep needed; a chained promise is fine).

**Acceptance:** Firing 20 rapid cue updates results in a single consistent final
file with all updates present; no lost writes.

---

## A3 — Stop minting orphan workspace files `[x]`
**Severity:** High · **Files:** `src/backend/cueDataManager.js` (~111-138, ~157),
`src/backend/routes/workspaces.js` (~43-52), `src/backend/cueManager.js` (~21-28)

**Problem (multiple root causes):**
- `saveWorkspace()` uses `id: this.currentWorkspace?.id || uuidv4()` → mints a brand
  new file every save when `currentWorkspace` is null (e.g. after delete).
- `POST /api/workspaces` creates a persisted workspace but never activates it.
- Startup creates another "Default Workspace" whenever the on-disk listing is empty
  (because corrupt files were skipped), while the broken files remain.

**Fix:**
1. `saveWorkspace()` must **require** an active workspace or an explicit
   `workspaceId` arg; if none, return an error instead of generating a new UUID.
2. `createWorkspace()` should either set the new workspace as current, or be split
   into `createWorkspaceInMemory()` vs `persistWorkspace()` so empty drafts aren't
   written until they have content.
3. On startup, before creating a fresh "Default Workspace", clean up / ignore
   already-empty files and prefer an existing non-empty workspace.

**Acceptance:**
- Creating/saving/deleting workspaces and restarting several times does **not**
  accumulate empty `.json` files.
- Exactly one Default Workspace exists after a clean first run.

---

## A4 — Add a one-time cleanup for existing orphan files `[x]`
**Severity:** Medium · **Files:** `src/backend/cueDataManager.js`
**Depends on:** A3

**Problem:** Users already have many empty workspace files on disk.

**Fix:** On startup, after loading, delete `.json` files in `cues/workspaces` that
parse to empty/invalid (0 bytes or `{}` with no `id`). Log how many were removed.
Be conservative — only remove provably-empty files.

**Acceptance:** Existing empty files are removed on next launch; valid workspaces
untouched.

---

## A5 — Persist REST cue mutations `[x]`
**Severity:** High · **Files:** `src/backend/routes/cues.js` (~50-127),
`src/backend/cueManager.js` (`createCue` ~62, `updateCue` ~110, `deleteCue` ~131)

**Problem:** `POST/PUT/DELETE /api/cues` change memory + broadcast but never call
`saveWorkspace()`. Changes are lost on restart. (We already patched the WebSocket
invoke paths.)

**Fix (preferred):** Make `cueManager.createCue/updateCue/deleteCue` themselves call
`saveWorkspace()` (debounced) on success, so **every** entry point persists. Then
remove the now-redundant explicit saves in `websocketManager.js` to keep one source
of truth. If debouncing, flush on shutdown (`cueManager.cleanup`).

**Acceptance:** Create/update/delete a cue via REST, restart, change persists.

---

## A6 — Consolidate cue persistence to a single path `[x]`
**Severity:** Medium · **Files:** `src/backend/websocketManager.js`
(~236-254, ~522-595), `src/backend/cueManager.js`
**Depends on:** A5

**Problem:** Cue CRUD is duplicated across invoke handlers (`add-or-update-cue`,
`delete-cue`) and event-style handlers (`create_cue`, `update_cue`, `delete_cue`),
with inconsistent saving. Event-style `create_cue`/`delete_cue` don't save at all.

**Fix:** Have all WebSocket cue mutations call the same `cueManager` methods (which,
per A5, persist). Remove dead/duplicate event handlers or make them delegate.

**Acceptance:** Only one code path mutates cues; all entry points persist; no dead
handlers.

---

## A7 — Non-mutating workspace read `[x]`
**Severity:** High · **Files:** `src/backend/routes/workspaces.js` (~259-262),
`src/backend/cueDataManager.js` (`loadWorkspace` ~171-186, `exportWorkspace` ~353-355)

**Problem:** `GET /api/workspaces/:id` calls `loadWorkspace`, which swaps the active
workspace and replaces in-memory cues — a read with destructive side effects.
`exportWorkspace` has the same side effect.

**Fix:** Add `readWorkspace(id)` that reads + parses the file and returns it **without**
touching `this.cues`/`this.currentWorkspace`. Use it for GET and export.

**Acceptance:** `GET /api/workspaces/:id` (and export) leaves the active workspace and
playing cues unchanged.

---

# Track B — Audio engine & multichannel output

## B0 — Decide & document the single playback engine `[x]`
**Severity:** High (architectural) · **Files:** `src/backend/audioPlaybackManager.js`,
`src/backend/cueManager.js` (startCuePlayback ~395-459), `src/frontend/audio/*`

**Problem:** Two engines run in parallel: server `node-web-audio-api`
(`audioPlaybackManager.js`, hardcoded stereo) and the browser **Howler.js** path
(what you actually hear). State diverges and files get decoded twice.

**Decision (see `AUDIO_ENGINE_PLAN.md`):** Server-primary playout via RtAudio +
`SoundboardMixer`; browser Howler gated to preview/solo only (ENG8). Interim:
`node-web-audio-api` remains until ENG3 lands.

**Acceptance:** Documented decision; ENG1–ENG3 track implements migration.

**Depends on:** nothing, but **B1 depends on this.**

---

## B1 — Multichannel (>2) output support `[x]`
**Severity:** Feature · **Files:** `src/backend/audioPlaybackManager.js`,
`src/backend/soundboardMixer.js`, `src/backend/cueDataManager.js`,
`src/backend/cueManager.js`, `src/frontend/ui/appConfigUI.js`,
`src/frontend/ui/propertiesSidebar*.js`
**Depends on:** B0

**Problem:** Output was stereo-only. Browser Howler cannot route to hardware
channels; server playout ignored per-cue channel assignment.

**Decision (see `AUDIO_ENGINE_PLAN.md`):** Server-primary multichannel via RtAudio
+ `SoundboardMixer.outputPatch`. Config opens N channels on the selected device;
each cue stores `outputPatch: [leftIndex, rightIndex]` (0-based).

**Implemented:**
1. `outputPatch` on cue model (default `[0, 1]`), persisted in workspace JSON
2. Config sidebar: server device list (`GET /api/audio/output-devices`) + channel count
3. Properties sidebar: Left/Right output selectors when `audioOutputChannelCount > 2`
4. `applyAudioConfig()` reopens RtAudio stream on config save (device/channel change)

**Acceptance:** Cue with `outputPatch: [2, 3]` routes via server mixer; config can
open >2 channels on a multichannel interface.

---

# Track C — Robustness & correctness

## C1 — `await` async WebSocket handlers `[x]`
**Severity:** Medium · **Files:** `src/backend/websocketManager.js` (~119-151)

**Problem:** Async handlers (`handleTriggerCue`, etc.) are called without `await` in
the `handleMessage` switch, so rejections can escape the surrounding try/catch.

**Fix:** `await` each async handler; ensure a single top-level try/catch returns a
proper error response.

**Acceptance:** A throwing handler returns a structured error to the client and logs
once; no unhandledRejection warnings.

---

## C2 — Validate config on every write path `[x]`
**Severity:** Medium · **Files:** `src/backend/appConfigManager.js`
(`updateConfig` ~119-147), `src/backend/websocketManager.js`
(`save-app-config` ~214-224), `src/backend/routes/config.js` (~24-38)

**Problem:** REST validates with `validateConfig` but `updateConfig` and the
WebSocket `save-app-config` path bypass it, allowing invalid ports/fade times.

**Fix:** Run `validateConfig({ ...current, ...updates })` (validate the **merged**
result, not just provided fields) inside `updateConfig` so all callers are covered.

**Acceptance:** Invalid values are rejected regardless of entry point; partial PUTs
can't produce an invalid stored config.

---

## C3 — Fix playlist auto-advance wiring `[x]`
**Severity:** Medium · **Files:** `src/backend/cueManager.js`
(`handleCuePlaybackComplete` ~487-514, `handlePlaybackEnd` ~543)

**Problem:** `handleCuePlaybackComplete` (which advances playlists) is never called;
the playback-end callback uses `handlePlaybackEnd`, which skips playlist logic.

**Fix:** Wire the playback-end callback to invoke the completion handler that runs
playlist-advance for `playlistPlayMode === 'continue'`. (If B0 removes the server
engine, implement advance in the surviving engine instead.)

**Acceptance:** A playlist cue in "continue" mode advances to the next item on end.

---

## C4 — Track & clear fade-out timeouts `[x]`
**Severity:** Medium · **Files:** `src/backend/audioPlaybackManager.js` (~181-187),
`src/frontend/audio/audioManager.js` (~250-262)

**Problem:** Fade-out uses `setTimeout(...source.stop())` whose id isn't stored. If a
cue is restarted/stopped before it fires, the stale timer can stop the new instance.

**Fix:** Store the timeout id on the playback info; clear it on stop/restart/cleanup.
(If B0 removes the server engine, this only applies to the surviving path.)

**Acceptance:** Rapidly retriggering a fading cue never cuts off the new playback.

---

## C5 — Implement or remove pause/resume `[x]`
**Severity:** Low · **Files:** `src/backend/audioPlaybackManager.js`
(`togglePauseCue` ~238-257), `src/backend/cueManager.js` (~360-386)

**Problem:** `togglePauseCue` only flips a flag (server) / stops the cue; UI can show
"paused" while audio keeps playing.

**Fix:** Either implement real pause/resume in the surviving engine (Web Audio:
track offset, stop, restart from offset) or remove the affordance and document it.

**Acceptance:** Pause actually pauses, resume continues from position — or the option
is gone from the UI.

---

# Track D — Performance & resource use

## D1 — Bound audio buffer caches `[x]`
**Severity:** Medium · **Files:** `src/backend/audioPlaybackManager.js` (~16, 43-67),
`src/frontend/audio/audioManager.js` (~11, 83-108)

**Problem:** Decoded PCM buffers are cached in a Map and never evicted until cleanup —
unbounded memory growth with large libraries.

**Fix:** Add an LRU cap (by count and/or total bytes). Evict least-recently-used on
insert. (Apply to the surviving engine after B0.)

**Acceptance:** Loading many large files keeps memory bounded; recently used cues stay
fast.

---

## D2 — Index audio metadata (kill O(n²) scans) `[x]`
**Severity:** Medium · **Files:** `src/backend/audioFileManager.js`
(`getAudioFileByPath` ~212-237, `getAllAudioFiles` ~174-201)

**Problem:** Each lookup linearly scans all metadata JSON; listing is O(n²). Also,
files lacking metadata get a **new random UUID on every call** (unstable IDs).

**Fix:**
1. Build an in-memory index `relativePath -> metadata` (and `id -> metadata`),
   refreshed on import / on a directory-mtime check.
2. On first discovery of a file without metadata, **persist** metadata with a stable
   UUID so the ID never changes.

**Acceptance:** Repeated listings are fast; a given file keeps the same id across
calls and restarts.

---

## D3 — Read max audio file size from config `[x]`
**Severity:** Low · **Files:** `src/backend/audioFileManager.js` (~10),
`src/backend/routes/audio.js` (multer config)

**Problem:** `maxFileSize` hardcoded (100MB) and ignores
`appConfigManager.maxAudioFileSize`.

**Fix:** Source the limit from config; apply to both multer and manager checks.

**Acceptance:** Changing the config value changes the enforced upload limit.

---

# Track E — API/REST correctness

## E1 — Fix route ordering in audio router `[x]`
**Severity:** High (functional bug) · **Files:** `src/backend/routes/audio.js`
(~58-81 vs `/search/:query`, `/serve/:id`, `/stats/overview`)

**Problem:** `GET /:id` is declared before the literal multi-segment routes, so
`GET /api/audio/search/foo` matches `/:id` with `id="search"`.

**Fix:** Move all literal/static routes (`/search/:query`, `/serve/:id`,
`/stats/overview`, etc.) **above** the `/:id` param route.

**Acceptance:** `search`, `serve`, `stats` endpoints work; `/:id` still works for real
ids.

---

## E2 — Correct MIME + stream error handling on serve `[x]`
**Severity:** Medium · **Files:** `src/backend/routes/audio.js` (~283-311)

**Problem:** `serve` hardcodes `Content-Type: audio/mpeg` for all formats and has no
`stream.on('error')` handler (so a read error hangs the response).

**Fix:** Map MIME from extension (wav/ogg/flac/aac/m4a/mp3); attach
`stream.on('error', ...)` → 500 and destroy. Consider `Accept-Ranges` for seeking.

**Acceptance:** Non-mp3 files report correct content type; a missing/unreadable file
returns an error instead of hanging.

---

## E3 — Multer error handling + tag parsing `[x]`
**Severity:** Medium · **Files:** `src/backend/routes/audio.js` (~84-117, ~97)

**Problem:** No multer error middleware (size-limit returns HTML, not JSON);
`JSON.parse(req.body.tags)` throws → 500 instead of 400.

**Fix:** Add an `(err, req, res, next)` handler translating multer errors to JSON;
wrap tag parsing in try/catch → 400 on malformed input.

**Acceptance:** Oversized upload and bad `tags` return clean 4xx JSON.

---

## E4 — Avoid double-copy / temp cleanup on upload `[x]`
**Severity:** Medium · **Files:** `src/backend/routes/audio.js` (~84-117),
`src/backend/audioFileManager.js` (`importAudioFile` ~70-85)

**Problem:** Multer writes to `audioDir` root, then `importAudioFile` copies again to
`imported/`, leaving the temp upload behind.

**Fix:** Upload straight into the target subdir (or delete the temp after import).
Clean up temp on failure too.

**Acceptance:** One file per import; no leftover temp files on success or failure.

---

## E5 — Consistent status codes & response shapes `[x]`
**Severity:** Low · **Files:** `src/backend/routes/cues.js` (~116-119),
`src/backend/routes/*`

**Problem:** Inconsistencies, e.g. delete-not-found returns 400 instead of 404.

**Fix:** Use 404 for missing resources, 400 for bad input, 200/201 for success;
standardize `{ success, data?|error }` shape across routes.

**Acceptance:** Status codes match semantics; response shape consistent.

---

## E6 — Bound/paginate large listings `[x]`
**Severity:** Low · **Files:** `src/backend/routes/audio.js` (~39-55),
`src/backend/routes/workspaces.js` (~5-20)

**Problem:** `GET /api/audio` and `GET /api/workspaces` return full payloads
(workspaces include all cues) unbounded.

**Fix:** Return metadata summaries for list endpoints; add `limit`/`offset` query
params; fetch full detail via `/:id`.

**Acceptance:** List endpoints return summaries and support pagination; UI updated if
it relied on full payloads.

---

# Track F — Path safety & cleanup (LAN-appropriate hardening)

Auth is out of scope, but these prevent **accidental** corruption/escape and stray
files — still worth doing on a LAN.

## F1 — Validate workspace/cue/audio IDs as UUIDs `[x]`
**Severity:** Medium · **Files:** `src/backend/cueDataManager.js` (~173, ~253),
`src/backend/routes/workspaces.js` (param routes), `src/backend/pathManager.js`

**Problem:** IDs are interpolated into `path.join(...)` without validation; a value
containing `..`/`/` escapes the intended directory.

**Fix:** Add an `isValidId` (UUID regex) guard; reject non-matching ids at route entry
and before any `path.join`. Add a `pathManager` helper that asserts a resolved path
stays within its base dir.

**Acceptance:** Requests with `../` or absolute ids are rejected with 400; valid UUIDs
work.

---

## F2 — Confine file paths to data dir `[x]`
**Severity:** Medium · **Files:** `src/backend/pathManager.js` (`resolvePath` ~59-72,
`toRelativePath` ~39-55), `src/backend/audioFileManager.js`
(`updateAudioFileMetadata` ~275-284, `importAudioFile` ~70-85),
`src/backend/routes/audio.js` (~121-157, ~188-204),
`src/backend/routes/workspaces.js` (import ~223-235, export ~190-199)

**Problem:** `resolvePath` returns absolute paths unchanged; `importAudioFile`/import
endpoints accept arbitrary absolute paths; `PUT /api/audio/:id` lets a client set the
stored `path`; export writes to process CWD.

**Fix:**
1. `resolvePath`/`toRelativePath` must resolve under the base dir and verify
   `resolved.startsWith(base)`; reject otherwise.
2. Whitelist updatable audio metadata fields (never allow `path`/`id` via API).
3. Restrict import sources to the data dir (or accept uploads only).
4. Export to `pathManager.cuesDir`/temp, not CWD.

**Acceptance:** Imports/updates/exports can't read or write outside the app data dir;
`/serve/:id` can't be repointed to arbitrary files.

---

# Track G — Finish the migration & production hardening (2026-09-17)

The legacy pre-migration Electron app (`main.js`, `src/main/`, `src/renderer/`) has
been moved to `archive/legacy-electron-app/` (kept for reference, not built or
packaged). `package.json` now points at the new architecture
(`electron-launcher/main.js`), and the following were addressed:

## G1 — Package the new architecture, not the old one `[x]`
`package.json` `main`/`build` config pointed at the legacy app, so `npm run dist`
would have shipped unhardened old code. Now points at `electron-launcher/main.js`,
with an explicit `build.files` allowlist, `asarUnpack` for the native rtaudio addon,
and `build/entitlements.mac.plist` (was missing entirely).

## G2 — Launcher spawns a system `node`, breaking packaged builds `[x]`
`electron-launcher/main.js` shelled out to `spawn('node', [...])` — depends on the
end user having Node.js installed, can't read files inside an asar archive, and
mismatches the ABI `electron-rebuild` targets. Now spawns `process.execPath` with
`ELECTRON_RUN_AS_NODE=1` (Electron's own bundled Node), fixing all three.

## G3 — Port default inconsistency (3000 vs 3333) `[x]`
`appConfigManager.js`'s `DEFAULT_CONFIG.httpRemotePort` and the launcher's
`nodePort` default were 3000, while `server.js`'s own fallback and the docs said
3333. Standardized on 3333 everywhere.

## G4 — Crash/robustness hardening `[x]`
Added `uncaughtException`/`unhandledRejection` handlers, `EADDRINUSE` handling on
`server.listen()`, a try/catch around the RtAudio render callback, `setErrorCallback`
wiring (broadcasts `audio-engine-error` on device loss), a friendlier error for a
missing/wrong-ABI native module, and bounded auto-restart + a heartbeat in the
Electron launcher. Noisy per-message/100ms-interval `console.log`s are now gated
behind the (previously dead) `enableDebugLogging` config flag.

## G5 — HTTP remote control page was missing entirely `[x]`
A README-advertised, screenshotted feature (`/remote`) had no frontend counterpart
in the new architecture (only the REST API existed). Ported and rewired to the
`{type, payload}` WebSocket envelope and the existing `/api/remote/*` REST routes.

## G6 — Easter egg game, workspace-change config reload, playlist multi-file drop `[x]`
Restored the Ctrl+Alt+P easter egg (static assets, no backend needed), wired the
app-config reload that was commented out on workspace change, and implemented
`addFilesToStagedPlaylist` (dropping files onto an open playlist's properties
sidebar never worked, even in the legacy app).

## G7 — Per-cue OSC trigger `[-]`
**Won't do (for now).** The legacy app had per-cue OSC triggering with a Learn
mode; it has zero backend support in the new architecture, and the new app's
global OSC config was already explicitly stripped out. Intentionally deferred —
this is a real, scoped feature (UDP listener, learn-mode protocol, persistence,
sidebar UI), not a bug. Companion and the HTTP remote page cover remote-triggering
needs in the meantime. Revisit if OSC hardware integration becomes a real
requirement.

## G8 — Smoke test suite, REST status staleness, req.body crashes `[x]`
**Severity:** High (the req.body one) · **Files:** `test/smoke.test.js` (new),
`src/backend/cueManager.js` (`getCue`/`getCues`, `_mergeLiveState`), `server.js`
(req.body-normalizing middleware, PORT-vs-config-port precedence)

Added `test/smoke.test.js` (`npm run test:smoke`, included in `npm test`): spawns
the real `start-nodejs.js` entry point against an isolated temp data dir
(`ACCOMPANIMENT_DATA_DIR`, new env override) and exercises HTTP, WebSocket,
upload, and the full cue lifecycle like a real client. It found three real bugs,
all fixed:
- `cueManager.getCue()`/`getCues()` returned the raw persisted cue record, never
  merging in live playback status from the in-memory `cueStates` map - every REST
  read (`GET /api/cues`, `/api/cues/:id`, `/api/remote/cues`) was permanently
  stale; only WebSocket broadcasts ever reflected real status.
- Systemic: ~17 route handlers destructure fields straight off `req.body`
  (`const { fadeOut } = req.body`) with no fallback. A POST with no body at all
  (normal for an action endpoint like "stop") leaves `req.body` `undefined` and
  500s. Fixed once, centrally, with middleware guaranteeing `req.body` is always
  at least `{}`.
- A fresh data dir + explicit `PORT` env var got silently overridden back to the
  config's default port, since the newly-auto-created config's `httpRemotePort`
  always won over an explicit `PORT=`. Only surfaces when both conditions hold at
  once - exactly what running isolated tests does every time.

**Known limitation found via testing, not fully fixed (root cause is third-party):**
during shutdown, `AudioPlaybackManager._closeStream()`'s call to `rt.stopStream()`
(native, synchronous) can deadlock against RtAudio's own CoreAudio I/O thread if a
render callback is in flight at just the wrong moment - observed directly via a
`sample` stack trace during test development. Because this blocks the whole JS
event loop synchronously, no JS-level timeout (including `server.js`'s own
10s shutdown force-exit) can fire to recover. Mitigated at the process level
instead: `electron-launcher/main.js`'s `stopNodeServer()` now actually escalates
to `SIGKILL` after a 5s grace period (previously it just gave up *waiting* and
called it "force stopped" without sending any kill signal - the child leaked as
an orphan holding the port and audio device). The smoke test's own teardown does
the same. A standalone headless deployment (`node start-nodejs.js` with no
supervisor) has no such external escalation available - run it under a process
supervisor (systemd, pm2, launchd with `KeepAlive`) in that configuration.

**Also confirmed via a from-scratch reinstall on this machine:** the published
`@hamitzor/rtaudio.js` prebuilt binary's `librtaudio.dylib` failed to load
(`Library not loaded: @rpath/librtaudio.dylib`, referencing the package author's
own build machine path). CMake was required locally for the `cmake-js rebuild`
fallback (`prebuild-install || cmake-js rebuild` in that package's own install
script) to succeed. CMake is not currently documented as a prerequisite anywhere
- worth adding to README/QUICKSTART, since relying on the prebuilt binary alone
is not reliable in practice.

## G9 — Vulnerability fixes, dependency major bumps, expanded smoke coverage `[x]`
**Severity:** High (the security fixes) · **Files:** `package.json`/`package-lock.json`,
`electron-launcher/main.js`, `src/backend/routes/audio.js`, `src/backend/cueManager.js`,
`src/backend/routes/remote.js`, `server.js`, `test/*.test.js` (5 new files + shared
`test/helpers/harness.js`)

`npm audit`: 42 → 15 findings. Safe transitive-dependency fixes via `npm audit fix`;
removed `electron-rebuild` (redundant with `electron-builder`'s own rebuild step, and
its dependency chain was a real chunk of the findings); bumped `electron-builder` 24→26
and `electron` 38→44 (both major), each re-verified with the full test suite plus an
actual packaged `electron-builder --dir --mac` build launched for real. The remaining
15 all trace back to `@hamitzor/rtaudio.js`'s own build-time toolchain (`cmake-js`,
`prebuild`) with no upstream fix available - build-time only, not shipped runtime code.

That packaged-build verification caught a second real orphan-process bug beyond the one
already fixed above: the async `SIGKILL`-after-5s escalation assumed the launcher
process would stay alive long enough for its own timer to fire, but Electron's internal
shutdown can tear the whole process down faster than that, abandoning the pending timer.
Fixed with `process.on('exit', ...)` - synchronous-only, but guaranteed to run right
before the process terminates regardless of *why*. Verified with three consecutive
launch/`SIGTERM` cycles against the packaged build, zero orphans.

Expanded the smoke suite from 1 file (16 tests) to 8 files (106 tests, running in
parallel in ~20-27s): playlists, app config, workspace isolation/export/import, audio
file management (including a **Range-request bug found and fixed** -
`GET /api/audio/serve/:id` advertised `Accept-Ranges: bytes` but never actually honored
Range requests, always streaming the full file with a 200), the WebSocket wire protocol
specifically (both event-style and invoke-style messages - Companion and the browser UI
speak this, not just REST), every retrigger behavior, pause/resume, and the
`/api/remote/*` endpoints specifically (separate route handlers from `/api/cues/*`,
actually used by Companion/the HTTP remote page).

Two more real bugs found this way: `setMasterVolume()` (added in an earlier session)
was completely unreachable - no route or WS message called it; wired up
`cueManager.setMasterVolume()`/`getMasterVolume()` and `GET`/`POST
/api/remote/master-volume`. And `GET /api/remote/health` was 100% dead code -
`server.js` registered its own simpler inline handler for the same path *before*
mounting `routes/remote.js`, and Express matches routes in registration order, so the
router's richer handler (playback status, connected WebSocket client count) never ran.
Consolidated into one handler that's a superset of both response shapes.

## G10 — Playwright browser end-to-end tests `[x]`
**Files:** `playwright.config.js` (new), `test/e2e/*` (new)

Everything through G9 tested the backend directly (HTTP/WebSocket) - none of it ever
loaded `src/frontend/` in an actual browser. Added Playwright (`npm run test:e2e`,
included in `npm test`): 10 tests across 3 spec files covering the main UI (page load,
live WebSocket-driven DOM rendering when a cue is created via the API while the page is
already open, edit-mode vs show-mode click behavior verified via the real `.playing` CSS
class, config sidebar, and the file-picker cue-creation flow), the `/remote` page
(listing, triggering playback cross-checked against the REST API, the audio-engine-error
banner), and the Ctrl+Alt+P easter egg (real keyboard event → `window.open()`).

Found one real, reproducible issue during development - in the test setup, not the app:
with Playwright's default 4 parallel workers, one test (`window.open()` under load)
consistently timed out, but passed reliably every time run in isolation. Unlike the
Node-level smoke tests (each file gets its own isolated server), every e2e spec shares
one live server with a real, CPU-hungry RtAudio engine; running several Chromium
instances at once against that was a genuine resource-contention ceiling on typical dev
hardware, not a flake to paper over with a longer timeout. Capped `workers: 2`, which
fixed it consistently across 5 repeated runs and, as a bonus, made the whole suite
noticeably faster too (~6s vs ~32s).

---

## G11 — Remove easter egg, gut the dead client audio engine, add per-cue VU meter + retrigger icon `[x]`
**Files:** `src/frontend/audio/audioController.js` (rewritten), 19 sibling files under
`src/frontend/audio/` (deleted), `src/frontend/easter_egg_game/` (deleted),
`test/e2e/easter-egg.spec.js` (deleted), `src/frontend/styles/crossfade.css` (deleted),
`src/frontend/renderer.js`, `src/frontend/ui.js`, `src/frontend/ui/appConfigUI.js`,
`src/frontend/ui/cueGrid.js`, `src/frontend/index.html`,
`src/frontend/styles/cue-grid.css`, `src/backend/soundboardMixer.js`,
`src/backend/audioPlaybackManager.js`, `src/backend/cueManager.js`,
`test/smoke.test.js`, `test/websocket-protocol.test.js`, `test/e2e/main-ui.spec.js`

Three related changes, since the app is now genuinely server-primary (real cue
playback always goes over WebSocket to the Node.js RtAudio mixer) but the frontend
still carried ~5,677 lines of a dead pre-migration client-side Howler.js playback
engine (`SERVER_PRIMARY_PLAYBACK = true` was hardcoded, routing everything past it)
and was missing UI that made that server-side state visible:

- **Removed the Ctrl+Alt+P easter egg** (`src/frontend/easter_egg_game/`) entirely.
- **Gutted the dead client audio engine**: deleted 19 of the 20 files under
  `src/frontend/audio/`, replacing them with a single ~200-line
  `audioController.js` that only does what's actually reachable - send
  `toggle_cue`/`stop_all_cues`/`playlist_navigate` over WebSocket, track
  server-broadcast playback state for the UI to read back, and a tiny
  standalone single-shot `Howl` for the "Preview (local)" button. Also dropped
  the dead `#audioPlaybackMode` dropdown and the crossfade toggle button (which
  flipped a CSS class nothing downstream ever consumed - no server-side
  crossfade exists). Fixed two real bugs found along the way: "Preview (local)"
  used to broadcast a real `playback-time-update` for the cue's actual ID to
  every connected client (main grid, `/remote`, Companion), making a local
  preview flash as "playing" everywhere - the new preview never sends any
  WebSocket message. Playlist prev/next buttons called straight into the dead
  local engine and did nothing against real playback; they already called the
  right `audioController` methods, which now correctly send the real
  `playlist_navigate` message the backend expects.
- **Added a per-cue VU meter**: `soundboardMixer.js` tracks a running peak
  per active cue directly in the `render()` hot path (no allocation), drained
  by a new `drainPeakLevels()` - deliberately kept separate from `getStatus()`,
  which several unrelated REST endpoints read and must stay side-effect-free.
  The existing 100ms `playback-time-update` broadcast now carries a
  `peakLevel` field per playing cue; the frontend renders it as a thin
  threshold-colored bar along the bottom of each cue button.
- **Added a per-cue retrigger-behavior badge**: a small top-right badge on
  each cue button (glyph + tinted background + title tooltip) reflecting the
  cue's `retriggerBehavior` (restart/pause-resume/stop/fade-out-and-stop/
  do-nothing/play-new-instance). Set once per full grid rebuild
  (`cues-updated` already fires on every cue edit) - no live-patch wiring
  needed, unlike the VU meter.

While verifying with `npx playwright test`, adding the VU meter as its own
test (a second concurrently-playing-audio test alongside the existing "show
mode: Stop All" test) reproduced the same genuine CPU/RtAudio contention flake
documented in G10 (`workers: 2` was capped for exactly this reason) - fixed by
folding the VU meter assertions into the existing playback test instead of
adding a second one, confirmed stable across 5 repeated clean runs.

---

## G12 — Stuck "playing" cue buttons + slow first launch mistaken for a crash `[x]`
**Files:** `src/frontend/renderer.js`, `electron-launcher/main.js`,
`test/e2e/helpers.js`, `test/e2e/main-ui.spec.js`

Two bugs reported after G11 landed:

**1. Cue buttons stayed showing "playing" after the cue actually stopped.**
`renderer.js`'s WebSocket message handler updated the DOM (`handleCueStatusUpdate`
/ `updateCueButtonTimeDisplay`, both of which redraw via
`cueGrid.updateButtonPlayingState`) *before* updating the cached server
playback state (`audioController.updateServerPlaybackState`) that
`updateButtonPlayingState` actually reads its "is this cue playing" answer
from. On a `stopped`/`completed` transition, the redraw ran first and read
the stale (still-"playing") cache, re-adding the `.playing` class; the cache
fix that followed a moment later had nothing left to trigger a re-render, so
the button never corrected itself - since no further broadcast is ever sent
for a cue once it's stopped. Fixed by swapping the order in both the
`cue_status` and `playback-time-update` handlers: update the cache, then
redraw. Confirmed as the actual cause by reverting just this ordering and
watching the new regression test below fail exactly as described, then pass
again with the fix restored.

Added a new test to `test/e2e/main-ui.spec.js` ("a cue's playing state clears
on its own once it finishes naturally"): triggers a short (1.5s) cue and
never clicks Stop, asserting `.playing` clears on its own once the cue's
natural-completion broadcast arrives. (`createTestCue`'s test helper gained
an optional `durationSec` passthrough to make a short-lived cue easy to
construct.)

**2. The very first server start after opening the packaged app could look
like a crash.** The launcher's own readiness check gave a freshly spawned
server only two chances (at 4s and 7s) to answer its health endpoint before
logging "startup may have failed" and leaving the tray on a bare "Server
Stopped" label - no different from an actual crash, from the user's
perspective. `AudioPlaybackManager.init()` constructs `RtAudio()`
synchronously during server startup (before the HTTP server starts
listening), which enumerates audio devices via the OS's audio subsystem; on
top of that, the very first execution of a freshly-extracted native
`.node` binary on macOS can be held up for tens of seconds by Gatekeeper's
one-time verification scan (cached after that - which is exactly why a
second launch right afterward is instant). A user watching the tray say
"Server Stopped" for what looks like indefinitely reasonably concludes it
crashed. Replaced the fixed two-shot check with a bounded poll
(`_pollForStartup`, every 3s up to 60s) and added a distinct "Server
Starting…" tray label (`isStarting`) so a legitimately slow first boot reads
as "still working" instead of "stopped".

Found and fixed a second, related bug while in this code: `stopNodeServer()`
refused to kill the child process while `isNodeRunning` was still `false` -
exactly the state during that same startup window. Quitting the app while
the server was still starting up silently left it running as an orphan
(holding the port and the audio device) instead of terminating it. The guard
now keys on the child process existing at all, not on the health check
having already passed.

---

## G13 — False "not running" tray state from a single flaky heartbeat check + duplicate stop broadcasts `[x]`
**Files:** `electron-launcher/main.js`, `src/backend/cueManager.js`,
`test/websocket-protocol.test.js`

Reported after G12: the tray showed "Server Stopped" (graying out "Open
Browser UI") while the server was demonstrably fine - it kept handling real
WebSocket traffic (`get-app-config`, `get-cues`) in the same log excerpt,
seconds after `checkServerStatus()` logged a single health-check timeout.
`checkServerStatus()` mutated `isNodeRunning` and repainted the tray on *any*
single failed probe, including a bare timeout - and once opening the config
window (a real, if brief, main-process-busy moment) delayed that one HTTP
round-trip past 5s, the tray got stuck on "stopped" until the next heartbeat
happened to succeed 20s later. A real crash was already caught immediately
and reliably by the child process's own `'close'` handler, independent of
this timer - so the heartbeat's health check was never actually load-bearing
for detecting a dead process, only for a theoretical hang.

Made `checkServerStatus()` a pure probe with no side effects, and moved state
ownership to each caller: the startup poll and heartbeat now decide what a
result means for their own context. The heartbeat specifically requires
`HEARTBEAT_FAILURE_THRESHOLD` (3) *consecutive* failures - roughly a minute
of sustained unresponsiveness - before flipping `isNodeRunning` and
repainting the tray, and recovers it automatically the moment a later check
succeeds again.

Also fixed, found while in this code: `stopNodeServer()`'s guard
(`if (!this.isNodeRunning || !this.nodeProcess) return;`) silently no-opped
while the server was still in its startup window (`nodeProcess` alive,
`isNodeRunning` not yet `true`) - quitting the app during that window left
the child process running as an orphan instead of killing it. Now keyed on
`nodeProcess` alone.

**Separately**, while investigating a report that "the retrigger fails to
complete its actions on cues," reproduced every `retriggerBehavior` value
end-to-end against a live server and found `cueManager.stopCue()` sent every
stop *twice*: it called `stopCuePlayback()` (which already updates
`cueStates`/`playingCues` and broadcasts `cue_status: stopped` itself), then
redundantly repeated the same state update and broadcast again immediately
after - and disagreed with it in the process, since `stopCuePlayback()`
deletes the cue's live state entirely while `stopCue()`'s repeat put a
`stopped` entry back. Pre-existing since the baseline commit, not something
introduced this session. `stopCue()` now just returns `stopCuePlayback()`'s
result directly. Confirmed via a duplicated-message reproduction script
before and after; the final playback state was already correct either way
in every case tested, so this alone didn't explain the reported symptom -
the real cause turned out to be G14 below, found once the user narrowed the
report down to "fade out and stop" specifically. Added a regression test
asserting exactly one `stopped` broadcast per `stop_cue`.

---

## G14 — "Fade out and stop" reported cue/broadcast state as stopped instantly, while the audio kept playing for the whole fade `[x]`
**Files:** `src/backend/cueManager.js`, `src/backend/audioPlaybackManager.js`,
`src/backend/soundboardMixer.js`, `test/cue-behaviors.test.js`

The actual root cause behind "the retrigger fails to complete its actions on
cues," once narrowed down to the `fade_out_and_stop` behavior specifically:
starting a fade-out only *begins* a gain ramp in the mixer's `render()` loop -
the cue keeps producing audible, gradually-quieter audio for the entire
configured `fadeOutTime`. But `stopCuePlayback()` and `stopAllCues()` (its
"Stop All" equivalent, for the `fade_out_and_stop` stop-all behavior) both
treated *starting* the fade as equivalent to the cue having *already*
stopped: they immediately deleted the cue's `cueStates`/`playingCues` entries
and broadcast `cue_status: stopped` to every client the instant the fade
began, not once it actually finished. A user clicking "fade out and stop"
saw the cue button go to "not playing" right away while the speakers kept
playing it, audibly barely quieter, for the next several seconds - which
reads exactly like "I clicked it and nothing happened," since the one
thing that visibly changed (the button) said it already worked while the
one thing that mattered (the sound) hadn't.

Reproduced end-to-end against a live server before fixing: created a cue
with `fadeOutTime: 3000`, retriggered it with `fade_out_and_stop`, and
polled `/api/cues/status/playback` every 500ms - confirmed the cue vanished
from `playingCues` and its `cueStates` entry disappeared within 500ms of the
retrigger, 2.5 full seconds before the fade could possibly have finished.

Fixed by only doing that immediate cleanup-and-broadcast for a genuine
*immediate* stop (no fade). For a fade, the mixer's own `onCueComplete`
callback (already wired through `AudioPlaybackManager.handlePlaybackEnd` to
`CueManager.handleCuePlaybackComplete`) already fires the moment the fade's
gain ramp actually reaches silence and the cue is removed from the mixer -
that's the point that should trigger the state update and broadcast, not
the moment the fade starts.

This surfaced a second, related design gap while fixing it:
`onCueComplete`/`handlePlaybackEnd`/`handleCuePlaybackComplete` is *the same
callback* for two different things - a cue reaching the natural end of its
file, and a cue's deliberate fade-out reaching silence - and the existing
code always broadcast `'completed'` and, for a playlist in `continue` mode,
auto-advanced to the next item, regardless of which one had actually
happened. Naively routing a deliberate `fade_out_and_stop` through that same
path would have made stopping a playlist cue via fade silently skip to the
next track instead of just stopping. Threaded a `reason` (`'completed'` or
`'stopped'`) through the whole chain -
`soundboardMixer.render()`'s `toRemove` list, `onCueComplete(cueId, reason)`,
`AudioPlaybackManager.handlePlaybackEnd(cueId, reason)`,
`CueManager.handleCuePlaybackComplete(cueId, reason)` - so the eventual
broadcast status matches what actually happened, and the playlist
auto-advance is now gated on `reason === 'completed'` only.

Added regression tests polling status mid-fade (asserting it's still
`'playing'`, not `'stopped'`, half-way through a 2s fade) for both the
single-cue retrigger and the "Stop All" fade path.

---

## G15 — Launcher couldn't recover from a stale orphaned server holding the port `[x]`
**Files:** `electron-launcher/main.js`

Reported as "now it just doesn't start": the app crash-looped 3 times with
`EADDRINUSE: address already in use 0.0.0.0:3333`, then gave up. Root cause
was an orphaned `server.js` process left over from an earlier launcher
instance that had exited without killing its child (confirmed live: `ps -p
<pid> -o ppid=` showed the orphan reparented to `launchd`, PID 1 - its
original launcher was long gone). That orphan was fully healthy and
listening on 3333 the entire time.

The launcher already had exactly the logic needed to handle this -
`startNodeServer()` checks whether something's already answering on the
port before spawning, and adopts it instead of competing - but that check
was a single, un-retried HTTP request. Spawning a whole new Electron-hosted
Node process (loading the native RtAudio addon, enumerating audio devices)
three times in a rapid crash loop is real, substantial CPU work; the same
class of transient-load flakiness already found and fixed for the ongoing
heartbeat in G13 was enough to make that single pre-flight check miss a
perfectly healthy, idle orphan multiple times in a row, sending the launcher
off to repeatedly spawn a competing server that could only ever fail with
the same EADDRINUSE - burning all `MAX_RESTART_ATTEMPTS` against a problem
retrying could never fix, then giving up, while the real server sat there
the whole time, un-adopted and unreachable via the tray.

Two changes: the pre-flight check (`_probeServerRunning()`) now retries up
to 3 times, 750ms apart, before concluding nothing's listening. And the
child's stderr is now watched for `EADDRINUSE` specifically
(`_portConflictDetected`) - if the process then exits, that's unambiguous
proof something else already holds the port, so `_handlePortConflictExit()`
re-probes immediately and adopts the existing instance if it's healthy,
instead of wasting a bounded-retry cycle blindly repeating a doomed spawn.
Falls through to the normal `_handleUnexpectedExit()` alert-and-give-up path
only if the port's occupant genuinely isn't answering.

No test coverage - this project has no Electron test harness (launching a
full Electron app isn't something the existing Node-level or Playwright
suites can drive), consistent with the rest of `electron-launcher/` being
untested territory. Verified by reasoning through the exact reported
sequence and manually confirming the diagnosis (killing the actual orphaned
process on the reporting machine immediately unblocked it), not by an
automated regression test.

---

## G16 — Stop All stuck "playing", no fading state, broken playlist modes, and test expansion `[x]`

From `todos.md` (2026-09-29), plus bugs found while writing tests for it.

- **Stop All (fade) left buttons stuck "playing".** Fade-mode Stop All used
  each cue's own `fadeOutTime` (default 0) and ignored the configured
  `defaultStopAllFadeOutTime`. A 0-second "fade" is an immediate mixer
  removal, which never fires `onCueComplete`, but `cueManager.stopAllCues()`
  had skipped cleanup and the 'stopped' broadcast, waiting for that
  callback. The audio stopped and the button (and server `cueStates`)
  stayed "playing". `AudioPlaybackManager.stopCue()` now returns
  `{ fading }` and callers trust it rather than guessing from cue settings.
  That also fixes single-cue fade-stops after the fade time was edited
  mid-playback, and fading a paused cue, whose ramp never advanced. Stop All
  now fades over `defaultStopAllFadeOutTime`, as the legacy app did.
- **No visual fading state.** The grid already had `.fading-in/.fading-out`
  and a "Fading: x.xs" countdown, keyed off fields the legacy renderer
  computed. The server never sent them after the migration. The mixer now
  reports fade direction and remaining time, and `playback-time-update`
  carries `isFadingIn/isFadingOut/fadeTimeRemainingMs`.
- **Slow UI load.** Not reproducible in the page itself (cue grid renders in
  ~0.3s against a copy of real data). The launcher added fixed delays before
  "Open Browser UI" enabled: 3 retries 750ms apart on a *refused* connection
  before spawning (refused is definitive, so no retry now), and a 3s
  startup poll interval (now 500ms).
- **Playlist "Continue to next item" never played the next item.** It only
  moved the index. "Stop after item, cue next" and repeat-one did nothing,
  and a playlist's `loop` looped its current item forever. Implemented the
  legacy semantics in `cueManager._handlePlaylistItemEnd()`.
- **Output patch collapsed swapped stereo.** `Number(right) || left` treated
  channel 0 as missing, so `[1, 0]` became `[1, 1]` (backend util and the
  frontend form copy).
- **`writeJsonAtomic` temp-file collision.** Two writes of one file in the
  same millisecond shared a temp file (ENOENT on rename, possible
  interleaved content). Added a per-call counter.
- **REST `PUT /api/config` and `/reset` never reached cueManager** (stale
  config) or open UIs. They now propagate like the WebSocket save path.

Tests: new `test/unit/` (`node:test`, part of `npm run test:unit`) for the
mixer, AudioPlaybackManager stop contract and `utils/`;
`test/stop-and-fade.test.js`; playlist-mode tests in `playlist.test.js`;
`test/e2e/stop-all-fade.spec.js`. Each new regression test was confirmed to
fail on the pre-fix source.

Still not ported from the legacy app (data model and UI exist, the server
engine ignores them): **ducking**, **crossfade mode**, **playlist shuffle**,
and true **play_new_instance** polyphony (falls back to restart).

---

## G17 — Missing legacy features ported, UI wiring fixed, end-to-end coverage for every control `[x]`

**Features** (legacy Electron behaviour, now in the server engine):
- **Ducking.** Mixer voices have a duck-gain stage separate from the
  fade/volume gain. `cueManager._updateDucking()` recomputes every playing
  cue's level (strongest audible trigger wins; paused triggers don't duck)
  on every start/stop/pause/resume/edit, ramping over `duckingFadeTime`
  (new config, default 1000ms, editable in the sidebar). A duckable cue
  started under a trigger starts already ducked.
- **Crossfade mode.** Server-side session state (`crossfadeMode`), switched
  by the restored XFADE button, the remote page, `POST /api/remote/crossfade`
  or WS `set_crossfade_mode`; broadcast as `crossfade-mode-updated`. Fresh
  user starts fade other cues out and the new one in over `crossfadeTime`.
  Restarts, playlist advance and navigation don't crossfade.
- **Shuffle.** `playlistLogic.js` (pure) decides item end / navigation with
  a per-playlist shuffle order; loop reshuffles.
- **Play new instance.** The mixer holds several voices per cue; the cue
  completes when its last voice ends.
- **Retrigger behaviors.** `retriggerLogic.js` (pure) maps every UI option ×
  playing/paused to an action. `toggle_pause_play`, `replay_current_item`
  and `play_next_item` used to fall into a branch that re-triggered forever,
  and pressing a paused cue restarted it instead of resuming.
  Decisions: replay_current_item restarts the current item;
  play_new_instance on a paused cue plays it from the top (replacing the
  paused one); "fade out and stop" with a fade-out time of 0 stops
  instantly.

**Bugs fixed along the way**: shuffle/repeat saved as `shuffle`/`repeatOne`
(ignored; now normalized, including legacy workspaces); crossfade time never
saved; config inputs showing 0 as 1500 (then overwriting it); NaN saves;
volume 0 played at full volume; drag-to-reorder never saved (no server
handler); both multiple-files dialog buttons silently did nothing (live
FileList emptied) and then failed ("Cue not found" for a client-chosen id);
dropping a file on a single-file cue didn't change what it plays; the drop
overlay never appeared; the properties sidebar re-populated on every cue
broadcast (eating keystrokes, reloading the waveform); the playlist remove
button didn't re-render; waveform readout ignored seeks/Stop and region
drags/clicks never registered (WaveSurfer v7 event names); advertised
Shift/Ctrl arrow steps missing; remote page never showed initial state;
paused/cued state and crossfade mode lost for pages opened mid-show;
Stop All from the remote/Companion ignored the configured behavior; a
device change left buttons "playing"; rapid presses on one cue raced (now
serialized per cue).

**Tests**: e2e now runs one server per Playwright worker with a clean slate
per test (`test/e2e/fixtures.js`) and covers every control in the main UI,
sidebars, waveform editor, file handling and remote page (125 tests).
New server suites: retrigger, ducking, crossfade, shuffle, cue-properties,
api-extras. New unit suites: playlist-logic, retrigger-logic, cue-data,
mixer voices/ducking.

**G8 shutdown deadlock fixed.** Root cause, from the binding's source
(`node_rtaudio.cpp`): the audio thread makes a *blocking* call into JS for
every render callback, so `stopStream()` on the JS thread while one was
pending left both threads waiting on each other. `_closeStream()` now has
the next render callback return 1 (RtAudio's "drain and stop"), which stops
the stream on RtAudio's own thread while the JS thread keeps servicing
callbacks, then closes it (~70ms; direct `stopStream()` only as a timed-out
fallback). Before: 5 hangs in 5 full server-suite runs; after: 1 hang in
11 runs (~180 audio-server shutdowns), and the suite runs ~30% faster. Much
rarer, not gone: the remaining case isn't diagnosed yet - the test harness
now prints the server's last output when it has to force-kill, to catch it.

---

## G18 — Dependency vulnerabilities cleared, packages updated `[x]`

`npm audit` reported 15 (3 critical, 9 high, 3 moderate), every one reached
through `@hamitzor/rtaudio.js` (already at its latest, 2.2.0, unmaintained
since 2025-03): it lists its *build/publish* tools as runtime dependencies -
`cmake-js@7` (old `tar`) and `prebuild` (abandoned `request`, `nw-gyp`,
`node-ninja`, `tar@2`). Fixed with `overrides` in package.json:
`cmake-js` -> ^8 (patched `tar`), and `prebuild` -> an empty local stub
(`scripts/npm-stubs/prebuild`) - only the package's author ever runs it;
installing needs just `prebuild-install` and `cmake-js`. Result: 0
vulnerabilities, 243 fewer packages installed and shipped.

Also: every dependency updated to latest (express 5.2, ws 8.22,
music-metadata 11.16, fs-extra 11.4, cors 2.8.6, electron 44.4.5, ...);
`uuid` removed (its current major is ESM-only) for Node's built-in
`crypto.randomUUID()`; deprecated `fluent-ffmpeg` removed - it only ever
ran one ffmpeg command, now spawned directly in `audioDecoder.js` (same
flags, verified identical output on real files, clearer errors).
Node >= 20.17 now required (cmake-js 8).

Found on the way:
- **Compiling the audio engine from source was broken on CMake 4**
  (pre-existing - cmake-js 7 fails identically): rtaudio.js's CMakeLists asks
  for CMake 3.1 compatibility, which CMake 4 removed. The existing binary
  predated the CMake upgrade, so any fresh install or rebuild would have left
  the app without audio. Fixed via `.npmrc` (`cmake_CMAKE_POLICY_VERSION_MINIMUM=3.5`,
  which cmake-js passes to CMake). npm warns about the unknown key; harmless.
- **Mixer: fade-stopping a silent voice never finished** - a volume-0 cue,
  or a cue stopped before its fade-in rendered a frame, stayed "playing"
  forever (the ramp 0 -> 0 has no steps, and the "reached silence" check only
  ran while ramping). Surfaced as an intermittent crossfade test failure.
Verified by deleting node_modules and running a fresh `npm install`, then
the full suite twice (100 unit, 214 server, 127 e2e).

---

## G19 — Projects, unified media library, launcher branding, health check `[x]`

From `todos.md` (2026-09-29, second batch). Order: P1 -> P2 -> P3 -> P4
(P3's bundles depend on P2's library). Tests at every level for each.

### P1 — Launcher health check `[x]`
Every successful probe logged "Server is running and healthy", every 20s,
forever (the heartbeat). The heartbeat only relabelled the tray after ~1 min
of a *frozen* server and never restarted it; crashes are already caught
instantly by the child process exiting. **Remove the heartbeat.** Keep the
startup readiness poll (it's how "Open Browser UI" knows the server is up),
but log only the outcome, not every probe.

### P2 — Unified media library `[x]`
Today every upload is stored as `name_<timestamp>.ext` with a new id - the
real library has 67 files / 17 unique contents (440MB), many present twice
(`audio/` and `audio/imported/`).
- **Identity = filename.** Library is flat: `audio/<original filename>`.
  Content hash (sha256) stored in metadata.
- **Upload:** same name + same content -> reuse the existing file and id (no
  new copy). Same name + *different* content -> stored as `Name (2).ext`
  (an upload never silently changes other projects' audio). New name -> new.
- **Replace file** (button next to "Delete Cue", single-file cues): uploads
  a new version and overwrites the library file *in place* - same name, same
  id - so every cue in every project using it gets the new version. Clears
  decoded/PCM caches, refreshes durations, reloads the waveform.
- **Migration** (automatic, once, on first start): hash every file, keep one
  copy per unique content under its clean name (timestamp suffix removed),
  delete only byte-identical duplicates, rewrite every project's cue
  references (id + path) and the metadata. Backs up all project files and
  metadata first; writes a mapping log; idempotent (library version marker).

### P3 — Projects workflow `[x]`
"Project" = the existing workspace concept, surfaced in the UI.
- Settings sidebar **top: project name** input - edits save automatically.
- Settings sidebar **bottom: New Project, Load Project, Download Bundle,
  Import Bundle.** (Import is needed to use a bundle on another machine.)
- **Autosave** everything (cue edits already autosave; no Save button).
- **New:** creates an empty project and switches to it (current one is
  already saved). **Load:** dialog listing projects (name, cues, last
  changed) to open or delete. All open pages follow a switch.
- **Download Bundle:** a `.zip` with `project.json` + `audio/<files>`
  (streamed; zip64 for big projects). **Import Bundle:** upload the zip ->
  audio merged into the library by P2's rules -> new project -> opened.
- Server reopens the **last opened** project on restart (today: the most
  recently *modified* file, which forgets a project that was only opened).

### P4 — Launcher branding `[x]`
Config window in the main UI's style: app icon left of the name, Rewir font
throughout (same as the main UI, which uses the locally installed font), and
the app icon in the macOS dock (was Electron's default: nothing called
`app.dock.setIcon`; only packaged builds got `build.mac.icon`).

### Done - notes
- **Migration verified on a copy of the real library:** 66 files -> 16
  (440MB -> 110MB), 34 metadata records -> 16, all cues play. Matching uses
  relative paths (absolute ones in old records break when a data folder has
  been moved). Backup + mapping log in `cues/backups/library-migration-*`.
- **Found and fixed on the way:** an edit made < 300ms before switching
  project was lost (debounced save wrote into the new project); every
  autosave kept a backup forever (now newest 20 per project); non-audio files
  named `.wav` were accepted as uploads (now need a real duration); the
  launcher ignored `ACCOMPANIMENT_DATA_DIR` (config/log/"Open Data Directory"
  could point elsewhere than the server); `loadWorkspace` stopped playback
  only after swapping cues.
- **Tests:** new Electron suite (`test/electron/`, Playwright's Electron
  support, isolated data dir + port) for the launcher - it had none;
  server suites media-library, projects, projects-restart (incl. a bundle
  imported into a second, empty installation and played there); unit
  media-library; e2e media-library and projects.
- **Fonts:** Rewir/Apropal aren't bundled - main UI and launcher both use
  the copies installed on this Mac (licences unknown, so not redistributed).
- **Launcher without heartbeat:** a server the launcher *adopted* (already
  running on its port, not started by it) is no longer monitored.

---

## G20 — Settings polish, expanded waveform regions `[x]`

From `todos.md` (third batch).
- **Project name** field is now the size of the other fields (still bold).
- **"Enable HTTP Remote" removed** - nothing ever checked it; the remote
  page is always served. The port field below it is now labelled for what
  it is ("Server Port" - the one port the UI, remote and Companion share,
  applied at the next start). The remote links (and `/api/remote/info`,
  whose WebSocket URL used an unused `websocketPort` of 8877) now use the
  port the server is actually listening on, not the configured one.
  The links' Copy buttons were pushed off the sidebar's edge by a generic
  full-width button rule - fixed.
- **Expanded waveform editor didn't show in/out points** set during the
  session (in either editor) - it drew from the cue as it was when the
  sidebar opened, and setting a point only redrew the sidebar waveform. Both
  editors now draw from the same live trim values after every change
  (`_drawTrimRegions`); an unset end point (stored as 0) no longer risks a
  zero-width region.
- Also: the bundle import route now removes its temp files *before*
  replying (found as an intermittent test failure under load).

## G21 — Companion module rewritten for the Node server (2.0.0) `[x]`

The module (`companion-module-highpass-accompaniment/`) still spoke the
Electron app's protocol - a separate WebSocket on port 8877 with
`{action}` commands and `{event}` messages - so against the Node server it
couldn't connect, and wouldn't have understood anything if it had.

- **Transport stays WebSocket**, on the server's one port (3333): the
  server pushes cue state, times and fades, which feedbacks and timers
  need; HTTP would mean polling. The module now uses the same
  `{type, payload}` protocol as the web UI.
- **Server additions** for it: `playlist_jump` (+ `POST
  /api/cues/:id/playlist/jump`) - "jump to item" was in the module but no
  server ever implemented it; `toggle_pause_cue`; `set_master_volume`; the
  master volume is now sent on connect. The whole contract is pinned by
  `test/companion-protocol.test.js`.
- **Module**: protocol/state in a Companion-free `client.js`; new actions
  (pause/resume, crossfade on/off/toggle, master volume set/adjust, Stop
  Cue with or without fade, Stop All as-set-in-app / instant / fade), new
  feedbacks (active, playlist cued, ducked, crossfade on, connected), new
  variables (project name, crossfade mode, master volume, playing count,
  next playlist item, ducked). 1.x action/feedback/variable ids kept. An
  upgrade script moves saved connections from 8877 to 3333 and keeps old
  Stop All buttons fading. Manifest fixed (it was a copy of a Roland
  module's), HELP/README rewritten.
- **@companion-module/base 2 / tools 3** (ESM, default-export entry,
  object variable definitions, sectioned presets). Needs Companion 4.3+,
  and Node >= 22.20 to develop (tools 3 needs 22.x, so not 26; `.nvmrc`).
- Tests: 74 in the module (`yarn test`) - client against a fake server,
  every action/feedback/variable/preset, upgrades, the built entry's
  exports, and end to end against a real server via this repo's harness.

---

# Suggested execution order

1. **A1 → A2 → A3 → A4** (stop data loss & orphan files)
2. **A5 → A6 → A7** (cue persistence + safe reads)
3. **E1** (functional route bug), then **E2–E6**
4. **B0**, then **B1** (multichannel) — needs product answer on single vs multiple devices
5. **C1–C5**, **D1–D3**, **F1–F2** as capacity allows

## Quick reference — top fixes
- Atomic + serialized writes (A1, A2)
- Kill orphan workspace creation + cleanup (A3, A4)
- Persist REST cue mutations, single persistence path (A5, A6)
- Non-mutating workspace GET (A7)
- Audio route ordering (E1)
- Single playback engine + multichannel (B0, B1)
