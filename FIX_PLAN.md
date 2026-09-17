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
