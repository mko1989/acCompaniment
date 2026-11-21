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
| `src/backend/utils/outputPatch.js` | 23 | open |
| `src/backend/utils/lruCache.js` | 73 | open |
| `src/backend/retriggerLogic.js` | 90 | open |
| `src/backend/playlistLogic.js` | 121 | open |
| `src/backend/mediaLibrary.js` (pure helpers: `sanitizeFilename`, `withCopyNumber`, ...) | ~100 | open |
| `cueDataManager.normalizeCueFieldAliases` | ~60 | open |
| `src/backend/soundboardMixer.js` (DSP, float tolerance) | 451 | open |

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
- WO-013 (shutdown stalls with a WebSocket client connected): decide the fix; the Rust server
  must shut down cleanly either way.
- Recording must include .flac, .ogg, .m4a and .aac files, which no test covers today
  (research/audio-engine.md).
