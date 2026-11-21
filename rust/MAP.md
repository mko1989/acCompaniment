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
014 CommonJS units bridged through typed shims

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
| B1 data layer | pathManager, appConfigManager, atomicWrite, mediaLibrary IO, cueDataManager, projectBundle, audioFileManager (metadata) | open |
| B2 server | server.js, routes/*, middleware, websocketManager, static UI | open |
| B3 cue engine | cueManager (triggers, retrigger, fades, ducking, playlists, crossfade) | open |
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

## Out of scope

`companion-module-highpass-accompaniment/`, `archive/`, Spotify (ADR-002, ADR-003);
`src/frontend/` stays JS (ADR-001); `scripts/build-rtaudio.js`, `fetch-ffmpeg.js`,
`probe-rtaudio.js` become obsolete with ADR-007; `electron-launcher/` is replaced, not ported.

## Open questions

- Audio engine (B4), for the owner at checkpoint 1: questions 1-7 and 9 in
  [research/audio-engine.md §7](research/audio-engine.md) (Linux host, macOS device-name form,
  formats symphonia can't decode, m4a priming, device ids, "System Default", resampler, channel
  width). Question 8 (cpal's macOS 14.2 floor) is a fact to verify, not a decision:
  the floor comes from loopback recording (`AudioHardwareCreateProcessTap`,
  cpal `src/host/coreaudio/macos/loopback.rs:18`). On the first cpal build, check with
  `nm -m` that the symbol is weak; if not, the binary won't launch below 14.2.
- HTTP (B2), for the owner: Express's 400/413/415 HTML error pages carry a stack trace; compare
  only status and content type for them? Accept `X-Powered-By` and the JSON weak ETag/304 as
  differences? (research/http-websocket.md)
- ADR-013 (proposed): creating a Spotify cue answers 400. Confirm.
- WO-014 (flaky smoke tests reading voices too early): decide the fix.
- WO-015 (High: a moved data dir plays nothing): decide the fix; the Rust port does the same.
- WO-016 (invalid audio settings are saved, then nothing plays): decide the fix.
- WO-017 (engine stays dead after one failed reopen): confirm the fix.
- WO-018 (NaN on a file's right channel reaches the output): decide the fix.
- WO-019 (long filenames lose their extension), WO-020 (Windows reserved names; needs Windows).
- WO-013 (shutdown stalls with a WebSocket client connected): decide the fix; the Rust server
  must shut down cleanly either way.
- Playlists, for the owner (behaviors found by `rust/playlist-logic`, maybe intended): when the
  current index is not in the play order (e.g. after items were deleted), the next item is
  `order[1]`, skipping `order[0]` (`playlistLogic.js:70`, `:96`); with shuffle on and a stale order
  (items added or removed), a fresh order is drawn and play continues from the current item's place
  in it, skipping the items before it for that pass.
- Recording must include .flac, .ogg, .m4a and .aac files, which no test covers today
  (research/audio-engine.md).
