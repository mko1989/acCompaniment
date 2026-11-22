# WO-017: After a failed engine reopen, no cue plays until the app restarts

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Audio engine: applying audio settings (`AudioPlaybackManager.applyAudioConfig`) |
| Opened | 2026-11-21, by Claude (found by the Rust port's HTTP recording, while checking WO-016) |
| Reproduction test | `test/unit/audio-playback-manager.test.js` - "the engine is usable again after a failed reopen, once a reopen succeeds" (replaced `test/engine-recovery.test.js`, see below) |
| Related | WO-016, WO-002 |

## Feature
Changing the output device, sample rate, buffer size or channel count reopens the engine's
output stream with the new settings (WO-002). If reopening fails, the engine reports the error;
once the settings are valid again it should play again.

## Problem
After one failed reopen, every trigger answers `{"success":false,"error":"Audio engine not
initialized"}` - even after the settings are put back to working values and the reopen succeeds.
Only restarting the app recovers. Reproduced by hand on 2026-11-21 against a fresh copy of the
recording seed:

1. trigger a cue: `success: true`
2. `PUT /api/config {"audioSampleRate":"fast"}` (accepted, WO-016)
3. trigger: `"sampleRate should be a valid number"`
4. `PUT /api/config {"audioSampleRate":48000}`
5. trigger: `"Audio engine not initialized"` - and so on until restart.

Cause: `isInitialized` is set to `true` only in `init()` (`src/backend/audioPlaybackManager.js:113`).
A failed reopen in `applyAudioConfig` sets it to `false` (`:251`). The next `applyAudioConfig`
reopens the stream successfully (`_openStream()` clears `initError`, `:212`) but never sets
`isInitialized` back to `true` (`:220-255`), and `playCue` refuses while it is `false` (`:294-298`).

Today a bad value sent over REST (WO-016) is the easy way in; in a show the same happens whenever a
reopen fails for a real reason - a device unplugged or busy at the moment the settings change.

## Proposed solution
In `applyAudioConfig`, after a successful `_openStream()`, set `this.isInitialized = true` (the
mixer exists: `init()` created it). Also make the "unchanged" shortcut not apply while the engine
is not initialized (it already checks `isInitialized`).

There is no real choice to make here beyond whether to also retry the reopen automatically on the
next trigger; recommended: no, keep it to settings changes (the UI shows the error).

Acceptance: the reproduction test passes; `npm test` passes. Once WO-016 rejects non-numeric rates
at the API, the reproduction test needs another way to make the reopen fail (see its comment).

## What has been done
- 2026-11-21: reproduced by hand (above); cause traced; reproduction test written (marked `todo`).
  Its first version used a rate of 1 Hz, which RtAudio accepts (the test passed, so it did not
  reproduce); a 1 GHz version hung decoding a 10 s file to 10^10 samples and was stopped. The
  current version uses `"fast"`.
- 2026-11-21: after `node_modules` was reinstalled (`brew install cmake`, `npm ci`, with the owner's
  go-ahead), the reproduction test fails as expected: "trigger after recovery failed: Audio engine
  not initialized" (reported as `todo`).
- 2026-11-22: fixed. `audioPlaybackManager.applyAudioConfig`: sets `isInitialized` after a successful reopen. The server-level test that made the reopen fail with `"fast"` (now refused by WO-016) was replaced by a unit test, `test/unit/audio-playback-manager.test.js` - "the engine is usable again after a failed reopen, once a reopen succeeds", which stubs a failing reopen; it reproduced the bug before the fix and passes after.
  Verified: npm test: unit 139/139, smoke 285/285 (no todo left), e2e 175/175; test:audio 88/88 on an idle machine (a first run with Rust builds running beside it had 6 dropout failures, as CLAUDE.md warns); test:audio:ui 12 passed, 3 flaky (passed on retry).

## Decision
- 2026-11-21, decided by Claude on the owner's delegation. Owner, 2026-11-21: "do the best you can with those dillemas" - the open decisions were delegated to Claude.
  Fix as proposed: set `isInitialized` after a successful reopen. No automatic retry on trigger; the UI shows the error.
