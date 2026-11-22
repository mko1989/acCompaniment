# Rust port map

Goal: acCompaniment's server and audio engine as one Rust binary that serves the unchanged browser
UI, keeps the HTTP/WebSocket protocol and on-disk formats, and passes the recorded cases plus the
existing test suites (smoke, e2e, loopback audio). Then a Tauri tray app replaces Electron.

Read first: [DECISIONS.md](DECISIONS.md) (ADR index below), [GLOSSARY.md](GLOSSARY.md),
`HANDOFF.md` when present, research in [research/](research/). Measured state:
`rust-anything map --write` → `PORT_MAP.md`.

## ADRs

001 scope: backend + audio to Rust, UI stays JS · 002 Companion, Spotify, archive out ·
003 remove Spotify, keep old Spotify cues hidden · 004 Companion protocol compatible ·
005 equivalence bar (key order and error text free) · 006 same on-disk formats ·
007 cpal + symphonia · 008 Tauri launcher · 009 targets · 010 checkpoints · 011 branch and cutover ·
012 record quietly · 013 Spotify cue creation answers 400 (proposed) ·
014 CommonJS units bridged through typed shims · 015 how Wave B is built and measured ·
016 decisions delegated · 017 HTTP details that need not match · 018 audio engine details ·
019 playlist/cache behaviors kept

## Proof

1. `rust-anything app record` of the HTTP API: 167 cases in `rust/app-cases/http/`, from a fixed
   seed data dir (`rust/app-fixtures/`, built by `rust/scripts/`). Original and front door 167/167.
2. The existing node:test smoke suite (and later Playwright e2e) run against the Rust binary:
   `ACCOMPANIMENT_SERVER_BIN=rust/app/target/release/accompaniment node --test test/*.test.js`.
   These cover the WebSocket protocol and shutdown, which `app record` does not.
3. `npm run test:audio` and `npm run test:audio:ui` for everything audible (ADR-007).

## Plan (approved by the owner 2026-11-21: "start")

Wave A: pure logic, ported and proved function by function (`bridge` / `record` / `diff` / `gate`),
each through a typed ES-module shim in `rust/shims/` (ADR-014). Crates are libraries for the core.

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
(`app wire --route '*'`), with the whole-app kill switch back to Node until the lift:

| Stage | Covers | State |
| --- | --- | --- |
| B1 data layer | pathManager, appConfigManager, atomicWrite, mediaLibrary IO, cueDataManager, projectBundle, audioFileManager (metadata) | done 2026-11-22: `rust/app/src/core/` (paths, config, nodefs, library, cues, bundle, audio_files, probe, jsv); differential check vs. Node 303/303 (`node rust/scripts/diff-data.js`), seed round-trips byte for byte |
| B2 server | server.js, routes/*, middleware, websocketManager, static UI | claimed by session ce56df02 2026-11-22 (subagent) |
| B3 cue engine | cueManager (triggers, retrigger, fades, ducking, playlists, crossfade) | done 2026-11-22: `core/cue_engine.rs` + `clock.rs` (injectable clock/timers) + `AudioEngine` trait with a recording fake (`cue_fakes.rs`); differential 245/245 new ops (548/548 with B1) |
| B4 audio engine | audioPlaybackManager, workerMixer, audioEngineWorker, audioDecoder, pcmCache on cpal + symphonia | open |

Wave C: Tauri tray app replacing `electron-launcher/` (ADR-008), and CI installers (WO-011).

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

- From B1 (open gaps, for B2/B4 and the lift):
  - B2: one lock around the core (it is synchronous; it replaces Node's save queue); a streaming
    zip writer for `GET /api/projects/:id/bundle` (B1's writes to a file); wire the config-change
    listeners; port the network-interface listing.
  - B4/ADR-018: the metadata probe can't read Ogg Opus/FLAC/Speex, fragmented MP4, APEv2/Lyrics3,
    ID3v2 TXXX: use the ffmpeg fallback there too, or extend the probe.
  - Lift (ADR-009): `core/nodefs.rs` ports Node's POSIX `path` only; Windows path rules are
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

## Out of scope

`companion-module-highpass-accompaniment/`, `archive/`, Spotify (ADR-002, ADR-003);
`src/frontend/` stays JS (ADR-001); `scripts/build-rtaudio.js`, `fetch-ffmpeg.js`,
`probe-rtaudio.js` become obsolete with ADR-007; `electron-launcher/` is replaced, not ported.

## Open questions

- None open. The owner delegated the open decisions on 2026-11-21 (ADR-016): see ADR-013 and
  ADR-017 to ADR-019, and work orders WO-013 to WO-022.
- Recording must include .flac, .ogg, .m4a and .aac files (done: the seed has one of each).

