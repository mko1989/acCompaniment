# Rust port map

Goal: acCompaniment's server and audio engine as one Rust binary that serves the unchanged browser
UI, keeps the HTTP/WebSocket protocol and on-disk formats, and passes the recorded cases plus the
existing test suites (smoke, e2e, loopback audio). Then a Tauri tray app replaces Electron.

Read first: [DECISIONS.md](DECISIONS.md) (ADR index below), [GLOSSARY.md](GLOSSARY.md),
[HANDOFF.md](HANDOFF.md), research in [research/](research/).

State (2026-11-23): Waves A and B done and lifted - the Rust binary is the app; the Node original
is no longer in this project (ADR-020; the owner keeps it elsewhere). Next: Wave C.

## ADRs

001 scope: backend + audio to Rust, UI stays JS · 002 Companion, Spotify, archive out ·
003 remove Spotify, keep old Spotify cues hidden · 004 Companion protocol compatible ·
005 equivalence bar (key order and error text free) · 006 same on-disk formats ·
007 cpal + symphonia · 008 Tauri launcher · 009 targets · 010 checkpoints · 011 branch and cutover ·
012 record quietly · 013 Spotify cue creation answers 400 (proposed) ·
014 CommonJS units bridged through typed shims · 015 how Wave B is built and measured ·
016 decisions delegated · 017 HTTP details that need not match · 018 audio engine details ·
019 playlist/cache behaviors kept · 020 Node removed, the Rust app is the app ·
021 the remote-info address is a wildcard in the recording · 022 the tray supervises a sidecar server

## Proof

1. `rust-anything app record` of the HTTP API (recorded from the Node original): 167 cases in
   `rust/app-cases/http/`, from a fixed seed data dir (`rust/app-fixtures/`, built by
   `rust/scripts/`). `rust-anything app replay . --build rust/app/target/release/accompaniment`.
2. The Wave A units' recorded cases (12,916), run by `cargo test` (`rust/app/tests/unit_cases.rs`).
3. The test suites, run against the Rust binary by default: smoke (node:test, covers the
   WebSocket protocol and shutdown), e2e (Playwright), and `npm run test:audio` /
   `npm run test:audio:ui` for everything audible (ADR-007).

## Plan (approved by the owner 2026-11-21: "start")

Wave A: pure logic, ported and proved function by function (`bridge` / `record` / `diff` / `gate`),
each through a typed ES-module shim (ADR-014). Lifted 2026-11-23 (ADR-020): the ports are modules
of `rust/app/src/core/`, their cases run in `cargo test`; the crates, bindings and shims are gone.

| Unit | Lines | State |
| --- | ---: | --- |
| `src/backend/utils/idValidation.js` | 29 | done 2026-11-21: `rust/id-validation`, gate passed, 696/696 |
| `src/backend/utils/outputPatch.js` | 23 | done 2026-11-21: `rust/output-patch`, gate passed, 955/955 |
| `src/backend/utils/lruCache.js` | 73 | done 2026-11-21: `rust/lru-cache`, gate passed, 463/463 |
| `src/backend/retriggerLogic.js` | 90 | done 2026-11-21: `rust/retrigger-logic`, gate passed, 993/993 |
| `src/backend/playlistLogic.js` | 121 | done 2026-11-21: `rust/playlist-logic`, gate passed, 7971/7971 (25 generated 1,000,000-item cases, 6.9 MB each, removed from `cases.jsonl` for size after they matched; `record` regenerates them) |
| `src/backend/mediaLibrary.js` (pure helpers: `sanitizeFilename`, `withCopyNumber`, `cleanLegacyName`, `isSupportedAudio`) | ~100 | done 2026-11-21: `rust/media-library-names`, gate passed, 1306/1306 |
| `cueDataManager.normalizeCueFieldAliases` | ~60 | done 2026-11-21: `rust/cue-aliases`, gate passed, 85/85 |
| `src/backend/soundboardMixer.js` (DSP) | 451 | done 2026-11-21: `rust/soundboard-mixer`, gate passed, 447/447 bit-exact |

Wave B: the stateful core, one piece. Every route shares the same cue and playback state, so it
cannot be proxied route by route. Built in stages inside `rust/app`, switched over at once
(done 2026-11-23, see below):

| Stage | Covers | State |
| --- | --- | --- |
| B1 data layer | pathManager, appConfigManager, atomicWrite, mediaLibrary IO, cueDataManager, projectBundle, audioFileManager (metadata) | done 2026-11-22: `rust/app/src/core/` (paths, config, nodefs, library, cues, bundle, audio_files, probe, jsv); differential check vs. Node 303/303 (`node rust/scripts/diff-data.js`), seed round-trips byte for byte |
| B2 server | server.js, routes/*, middleware, websocketManager, static UI | done 2026-11-22: `rust/app/src/server/`; with `ACCOMPANIMENT_CORE=rust` replay 146/167 (every failure needs B4), smoke 151/267 (every failure needs B4); interim `NoOutputEngine` answers like the original with no output device |
| B3 cue engine | cueManager (triggers, retrigger, fades, ducking, playlists, crossfade) | done 2026-11-22: `core/cue_engine.rs` + `clock.rs` (injectable clock/timers) + `AudioEngine` trait with a recording fake (`cue_fakes.rs`); differential 245/245 new ops (548/548 with B1) |
| B4 audio engine | audioPlaybackManager, workerMixer, audioEngineWorker, audioDecoder, pcmCache on cpal + symphonia | done 2026-11-23: `rust/app/src/audio/` (decode, pcm_cache, devices, engine); decoder 50/50 against Node's (`node rust/scripts/compare-decode.js`); with `ACCOMPANIMENT_CORE=rust` replay 167/167 (fallback 0%), smoke 286/286, e2e 176/176, test:audio and test:audio:ui pass; WO-024 to WO-031 |

Switch-over and lift: done 2026-11-23 by hand (ADR-020): the binary always serves from the
core; proxy, switch and Node removed. (`app wire`/`app lift` assume units wired route by route.)

Wave C (claimed by session ce56df02 2026-11-23; ADR-022: the server runs as a supervised sidecar):
Tauri tray app (ADR-008) and installers per platform (WO-011's lessons: build each platform on its
own runner).
- done 2026-11-23: `rust/tray/` (Tauri 2.x): tray menu, config window (`ui/config.html`, WO-032),
  the supervisor (`src/supervisor.rs`: adopt, spawn, readiness, crash restarts, hung-orphan kill,
  log with rotation, notifications), quit and SIGTERM stop the server. Tests: `cargo test` in
  `rust/tray` (9, against the real server binary), `test/tray/` (Playwright, the config window on
  a stubbed Tauri backend). macOS: `npm run bundle:tray` builds the `.app` and the DMG (x64 on
  this Mac; `CI=true` skips the Finder styling, which times out without automation access); the
  bundled app serves its own `frontend/` and ffmpeg - checked by running it.
- done 2026-11-23: macOS universal (`npm run bundle:tray:mac-universal`; app, server and ffmpeg
  all x86_64 + arm64; the x86_64 half run here). GitHub workflows written, not yet run:
  `.github/workflows/ci.yml` (tests on macOS, Windows, Linux), `release.yml` (installers per
  platform + the headless Linux package, on a `v*` tag, to a draft release).
- headless Linux (owner, 2026-11-23: "I need a headless Linux version too"): the server alone,
  with its UI and ffmpeg, as a systemd service (`packaging/linux-headless/`,
  `npm run package:headless`); the server now also finds `frontend/` beside its binary. On
  Ubuntu 22.04 in Docker (`ci/linux-check.sh`): the server builds, `cargo test` passes, the
  x64 tarball was made. Not yet done: the tarball run on a clean machine, the smoke suite on
  Linux, the tray app on Linux - put on hold by the owner 2026-11-23 (Docker needs more disk
  than this Mac has; "let's leave the Linux version for now"). CI's Linux jobs will cover them.
- left:
  - macOS: signing and notarization (needs the owner's Apple Developer ID; release.yml reads the
    `APPLE_*` secrets);
  - first runs on Windows and Linux: build, the smoke suite, the tray, device listing (ids only
    approximate RtAudio's there), a Windows machine without audio devices (WO-012's case);
    `core/nodefs.rs`'s Windows path rules (below); Linux arm64 needs its own ffmpeg in
    `tauri.linux.conf.json`;
  - macOS below 14: the binary starts (CoreAudio weak-linked) - try it (bundle minimum is 11.0);
  - a release workflow replacing the removed `.github/workflows/release.yml` (Electron).

## Rules for later stages (found while porting)

- B4: the decoder must hand the mixer 2-channel buffers, as `audioDecoder.js` does (`channels = 2`):
  the mixer reads a 1-channel buffer's next frame as its right side (latent in the original,
  reproduced by `rust/soundboard-mixer`).
- Wave B: JS value coercion (`Number()`, `String()`, truthiness) is now written in more than one
  unit crate (`output-patch`, `retrigger-logic`, `cue-aliases`); pull it into one shared module when
  the crates become libraries of `rust/app`.
- rust-anything 2.1.0 issues met (worked around): a zero-argument export generates code clippy
  rejects; `refresh` leaves a removed export in `rust-anything.json` (re-bridge instead).
- Known quirks of the original, not reachable from its callers, no work order (owner may decide
  otherwise): `LruCache` stops evicting after an `undefined` key; a NaN byte size disables byte
  eviction until `clear()` (`rust/lru-cache`).

- From B1 (open gaps):
  - B2: one lock around the core (it is synchronous; it replaces Node's save queue); a streaming
    zip writer for `GET /api/projects/:id/bundle` (B1's writes to a file); wire the config-change
    listeners; port the network-interface listing.
  - B4/ADR-018: the metadata probe can't read Ogg Opus/FLAC/Speex, fragmented MP4, APEv2/Lyrics3,
    ID3v2 TXXX: use the ffmpeg fallback there too, or extend the probe.
  - Open, Wave C (ADR-009): `core/nodefs.rs` ports Node's POSIX `path` only; Windows path rules are
    still to do.
  - Accepted differences (ADR-005): V8's `JSON.parse` error wording; a JSON file with lone-surrogate
    escapes reads as corrupt; zip names valid as UTF-8 are read as UTF-8 without the flag, and CRCs
    are checked (yauzl doesn't).

- From B3 (for B2/B4):
  - B2: hold `CueManager` behind one lock; drive `run_due_timers()` from a real timer (the 300 ms
    debounced save, the 100 ms playback-time broadcast); call `pump_engine_events()` after engine
    callbacks. Node interleaves operations on different cues at each `await`; the Rust core runs
    one at a time: watch for order differences in replay.
  - B4: `queue_next(still_wanted)` must become decode-first-then-ask (the fake calls it at once);
    engine end reasons other than completed/stopped are untested.
  - Known quirk, not reachable from the UI, no work order (ADR-019 style): `POST /api/cues` with a
    `null` playlist item fails with a raw TypeError message; the port reproduces it.

- From B2:
  - B4: replace `server/engine.rs`'s `NoOutputEngine` with the cpal engine (device list in RtAudio's
    names and ids, ADR-018); real engine callbacks must wake the core (e.g. post into the timer task);
    `queue_next` decode-first-then-ask. Then run e2e and both loopback suites against the core.
  - Open, Wave C and later: Windows network interfaces, path rules and bundle temp-file removal; Range on static files;
    non-identity `Content-Encoding` (415 today); nested urlencoded keys; busboy's latin1 filenames.

- From B4 (open, for Wave C and later):
  - Real-time hygiene: applying a play or queue command allocates on the audio thread (ids, the
    voice's entry, as the original's worker did), and a decoded buffer the LRU has evicted can be
    freed inside the callback. Neither measured as a problem (the rendered output had no gaps in the
    WO-031 probes), but both belong off the audio thread (open).
  - Devices: on macOS the list is CoreAudio's, identical to RtAudio's (names, ids from 129); on
    Windows and Linux it comes from cpal and the ids only approximate RtAudio's. Windows, Linux
    and macOS before 14 untested; `build.rs` weak-links CoreAudio so the binary starts below 14.2.
  - ffmpeg still ships (ADR-018): AAC/M4A, more than 2 channels, MP3 without a Xing/Info/VBRI
    header and WAV/AIFF with an odd-sized chunk go through it.
  - After a stream error the engine reopens at the device's current rate (WO-025); the mixer keeps
    the configured rate, so if another app changed the rate, playback runs at the wrong pitch until
    the next open - as the original's RtAudio stream does.
  - `server/engine.rs`' `NoOutputEngine` is no longer used; kept as a fallback.
  - Known quirk of the original, not reachable once the server listens, no work order:
    `routes/audio.js`' fallback to `AudioPlaybackManager.listOutputDevices()` aborts the process
    (the rtaudio.js binding unrefs a handle it never referenced).
  - `cargo` is in `~/.cargo/bin`, not on a fresh shell's PATH: a build that "succeeds" without it
    didn't run.

## Out of scope

`companion-module-highpass-accompaniment/`, `archive/` (left in place, untouched), Spotify
(ADR-002, ADR-003); `src/frontend/` stays JS (ADR-001); the Node app, Electron launcher and
RtAudio build scripts are removed (ADR-020); `scripts/fetch-ffmpeg.js` stays until Wave C
packages ffmpeg.

## Open questions

- None open. The owner delegated the open decisions on 2026-11-21 (ADR-016): see ADR-013 and
  ADR-017 to ADR-019, and work orders WO-013 to WO-031.
- Recording must include .flac, .ogg, .m4a and .aac files (done: the seed has one of each).

