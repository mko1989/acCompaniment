# Rust port: decisions

Every decision the port depends on, as ADRs. Numbered in order, never renumbered. A changed
decision gets a new ADR that supersedes the old one. All decisions below were made by the owner
(mko1989) on 2026-11-21, answering questions with a recommended answer.

## ADR-001: Port the backend and the audio engine to one Rust binary
Status: accepted (2026-11-21)
Context: acCompaniment is an Express + WebSocket server (`server.js`, `src/backend/`) with an
RtAudio engine on a worker thread, a browser UI, an Electron tray launcher and a Companion module.
Decision: the server, routes, managers and audio engine become one Rust binary. The browser UI
(`src/frontend/`) stays JS and is served by the Rust binary as static files.
Consequences: the UI and its e2e tests keep working against the Rust server unchanged.

## ADR-002: Companion module, Spotify and archive/ are not part of the app
Status: accepted (2026-11-21)
Context: owner: "companion module, spotify and archive should not be part of the app."
Decision: none of the three is ported. `companion-module-highpass-accompaniment/` and `archive/`
stay in the repo untouched, outside the port. Spotify is removed (ADR-003).
Consequences: `analyze` units under those paths are out of scope in `MAP.md`.

## ADR-003: Remove Spotify from the server and the UI; keep old Spotify cues in project files
Status: accepted (2026-11-21)
Context: Spotify has server routes (`/api/spotify`), `src/backend/spotify/`, a cue type and UI.
Decision: remove Spotify from the Node original first (server, UI, tests), then record the
original. Spotify cues in existing projects are kept in the project file unchanged, are not shown
in the grid and do not play.
Consequences: the recording never contains Spotify routes; no Rust code for Spotify.

## ADR-004: The Companion wire protocol stays compatible
Status: accepted (2026-11-21)
Context: existing Companion setups talk to the server over HTTP and WebSocket.
Decision: the Rust server keeps the same routes and WebSocket messages, so the current Companion
module works unchanged.
Consequences: WebSocket message shapes are part of the recorded contract.

## ADR-005: Equivalence bar
Status: accepted (2026-11-21)
Decision: same routes, same status codes, same JSON values. JSON key order and the exact wording
of error messages may differ (the `error` field must still be present where the original sends
it). The UI must work unchanged. Recordings use the `key-order` normalizer.
Consequences: a case that differs only in key order or error text passes.

## ADR-006: Same on-disk formats
Status: accepted (2026-11-21)
Decision: the Rust app reads and writes the same config file, workspaces, projects in
`~/.accompaniment` (`ACCOMPANIMENT_DATA_DIR`) and exported project bundles. The PCM cache is
internal and may change format (rebuilt on demand).

## ADR-007: Audio engine on cpal + symphonia
Status: accepted (2026-11-21)
Context: today RtAudio (`@hamitzor/rtaudio.js`) for output and ffmpeg for decoding.
Decision: cpal for device output, symphonia for decoding; no ffmpeg binary shipped.
rust-anything cannot record audio output, so the audio engine is proved by the loopback suites
(`npm run test:audio`, `npm run test:audio:ui`).
Consequences: formats only ffmpeg decoded must be checked (`test/audio/formats.test.js`).

## ADR-008: Tauri replaces the Electron launcher
Status: accepted (2026-11-21)
Decision: a Tauri tray app starts the server in-process. Ported after the server is lifted.
Consequences: the per-platform CI installer builds (WO-011) are reworked for Tauri.

## ADR-009: Targets
Status: accepted (2026-11-21)
Decision: macOS (Apple Silicon and Intel), Windows, Linux, each built on its own platform in CI.

## ADR-010: Checkpoints
Status: accepted (2026-11-21)
Decision: stop for the owner's go-ahead (1) after the whole app is recorded and the front door
replays 100%, (2) after each wave of units, (3) after the audio engine passes the loopback suites.

## ADR-011: Branch and cutover
Status: accepted (2026-11-21)
Decision: work on the `rust-port` branch, committed at each checkpoint; `main` keeps the Node app.
The Rust app ships as a separate beta only once it passes replay, `test:audio` and
`test:audio:ui`. The Node app stays until the owner retires it.

## ADR-012: Recording plays audio quietly
Status: accepted (2026-11-21)
Decision: record at low volume, as the server tests do, and never at the same time as the audio
suites.

## ADR-013: Creating a Spotify cue is rejected with 400
Status: accepted (2026-11-21; proposed earlier the same day, confirmed by Claude on the owner's
delegation, ADR-016)
Context: while implementing ADR-003, the app turned out not to validate cue types at all: any
`type` is accepted. A cue created or changed to `spotify` would then be hidden on the next load.
Decision: `POST /api/cues` and `PUT /api/cues/:id` with `type: 'spotify'` answer 400
`Spotify cues are no longer supported`. Other unknown types are accepted as before.
Consequences: recorded as part of the contract; the Rust server does the same.

## ADR-014: CommonJS units are bridged through typed ES-module shims
Status: accepted (2026-11-21), a technical choice made by Claude while porting; the owner may revisit
Context: rust-anything's `bridge`/`record` only see ES-module `export` declarations; every backend
file is CommonJS (`module.exports = {...}`), so `analyze` counts 0 exports for all of them.
Decision: each Wave A unit gets `rust/shims/<unit>/index.ts`: `export function`s with parameter
types that call the original CommonJS module unchanged. The shim is the unit `bridge` takes;
`record` therefore records the original itself. Shims add no behavior and are deleted at the lift.
Unit crates are not loaded into the Node app as shadows: they become libraries of `rust/app`, used
by the core when Wave B ports it (MAP.md).
Consequences: generated inputs follow the shim's types; add real inputs with `record --inputs`.
Shim types must be as wide as the original's callers use (a value the shim's type excludes is
never recorded).

## ADR-015: How Wave B is built and measured
Status: accepted (2026-11-21), a technical choice made by Claude when the owner said "start b";
the owner may revisit
Context: every route shares the same cue, playback and file state, so the core can't be wired
route by route through the front door (MAP.md, Wave B). It has to grow in Rust beside the proxy and
switch over at once.
Decision:
- The core lives in `rust/app/src/core/` (one module per original manager), and uses the Wave A
  ports' `port.rs` code directly (no napi in the app binary).
- A development switch: `ACCOMPANIMENT_CORE=rust` makes the binary serve everything from the Rust
  core and not start Node; without it, the front door proxies to Node as before. Progress is the
  replay pass rate with the switch on:
  `rust-anything app replay . --build "env ACCOMPANIMENT_CORE=rust rust/app/target/release/accompaniment"`.
- Stages, in order, each its own checkpoint report: B1 data layer (files, config, library, cue
  data, bundles), B3 cue engine (against an `AudioEngine` trait with a silent engine), B2 routes and
  WebSocket, B4 audio engine (cpal + symphonia; needs the owner's audio decisions first).
- The core reproduces the original as recorded, including the open work orders' bugs (WO-013 to
  WO-020), until the owner decides each; a fix then goes into both the Node app and the core.
- When replay with the switch on is 100% and the node:test and Playwright suites pass against it,
  `app wire --route '*'` makes the core the default, with the kill switch back to Node until the
  lift.
Consequences: the fallback rate stays 100% until the switch-over, then drops to 0 in one step.

## ADR-016: The owner delegated the open decisions
Status: accepted (2026-11-21)
Context: owner, 2026-11-21, after the open questions were listed in MAP.md: "do the best you can
with those dillemas".
Decision: Claude takes the open decisions, each recorded as delegated: the work orders' decisions
in work/ (WO-013 to WO-022), and the port's decisions here (ADR-013 confirmed, ADR-017 to ADR-019).
The owner can overturn any of them; a change gets a new dated entry, as always.

## ADR-017: HTTP details that need not match
Status: accepted (2026-11-21), decided by Claude on the owner's delegation (ADR-016)
Context: rust/research/http-websocket.md: Express's 400/413/415 error pages are HTML with a stack
trace, Express adds `X-Powered-By: Express` and a weak ETag (and 304s) on JSON responses.
Decision: for those error pages, the status and content type must match, the body need not; the
Rust server sends no `X-Powered-By` and no ETag on JSON (static files and `/api/audio/serve` keep
theirs). Everything else in ADR-005 stands.
Consequences: the recorded body of `rust/app-cases/http/2004-config-bad-json` (Express's 400 page
for bad JSON, with a Node stack trace) was replaced by `...` on 2026-11-22; its status and
content-type are still compared. Re-recording brings the stack trace back: replace it again.

## ADR-018: Audio engine details (supersedes part of ADR-007)
Status: accepted (2026-11-21), decided by Claude on the owner's delegation (ADR-016); answers the
questions in rust/research/audio-engine.md section 7
Decision:
- Decoding: symphonia first; files it can't decode (Ogg Opus, HE-AAC, multichannel AAC) fall back
  to the ffmpeg the app already ships, so no file that plays today stops playing. This replaces
  ADR-007's "no ffmpeg binary shipped"; dropping ffmpeg later is a separate decision once the
  fallback is shown to be rare.
- m4a/AAC: trim encoder delay and padding (edit list / iTunSMPB) as ffmpeg does, so gapless
  playlists stay gapless (WO-006).
- Resampling: a good-quality sinc resampler (rubato); the bar is the loopback suites (in tune,
  right level, no audible artifacts), not sample-identity with swresample.
- Output devices on macOS are reported in RtAudio's "Manufacturer: Name" form, and a saved device
  matches in either form (old configs and the test harness keep working). Device ids in the API
  stay RtAudio-style numbers (129, 130, ... in probe order), as the recorded responses show.
- "System Default" is resolved when the stream opens, as today (not followed live).
- The device is opened at its full channel count; channels no cue is patched to carry silence.
- Linux: cpal's PulseAudio host, as today's RtAudio build.
- macOS: the Rust app must run on every macOS the current app runs on. If cpal 0.18's CoreAudio
  code needs macOS 14.2 at load time, weak-link it or use a cpal version that doesn't (to be
  checked on the first build, MAP.md).

## ADR-019: Playlist and cache behaviors kept as they are
Status: accepted (2026-11-21), decided by Claude on the owner's delegation (ADR-016)
Decision: with shuffle on, when items are added or removed mid-pass, a fresh order is drawn and
play continues from the current item's place in it (kept: it never repeats the current item and
needs no extra state). The two LruCache quirks (an `undefined` key stops eviction; a NaN size
disables byte eviction) can't happen from the app's callers: no change, no work order. The
out-of-range playlist index became WO-022 and is fixed.
