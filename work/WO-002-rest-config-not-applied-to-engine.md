# WO-002: Audio settings changed over REST are saved but not applied

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | App config API - audio engine settings |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction test | `test/audio/formats.test.js` - "changing an audio setting over REST (PUT /api/config) applies it too (WO-002)"; `test/config.test.js` - "an audio engine setting changed over REST is applied to the engine, not just saved (WO-002)" |
| Related | WO-001 |

## Feature
`audioOutputDeviceId`, `audioOutputChannelCount`, `audioSampleRate` and
`audioBufferSize` configure the audio engine. Changing one should re-open the
engine with the new setting, whichever way it was changed.

## Problem
There are two ways to save config, and only one applies audio settings:
- WebSocket `save-app-config` (the browser UI) compares the audio keys
  before and after and calls `cueManager.applyAudioEngineConfig()`
  (`src/backend/websocketManager.js:266-286`).
- REST `PUT /api/config` (`src/backend/routes/config.js:33`) saves the config
  and calls `propagateConfig` (`:8-11`), which only does
  `cueManager.setConfig()` and a broadcast - the engine is never re-opened.

So over REST (scripts, Companion-style integrations, the test suites) the
new device / channel count / sample rate is saved, reported back by `GET
/api/config`, shown in the UI - and ignored by playback until the server
restarts. Reproduced: `PUT {audioOutputChannelCount: 1}` → the cue still
plays on both outputs.

`POST /api/config/reset` (`routes/config.js:73`) goes through the same
`propagateConfig` and has the same gap.

## Proposed solution
Apply engine changes in one place that every save path goes through, rather
than duplicating the WebSocket logic in the route:
- Add `cueManager.applyConfig(prevConfig, nextConfig)` that calls
  `setConfig(next)` and, if any of the four audio keys differ, awaits
  `applyAudioEngineConfig()`.
- Call it from `save-app-config`, `PUT /api/config` and
  `POST /api/config/reset`; remove the inline comparison from
  `websocketManager.js`.

(`appConfigManager` has change listeners, but they're fire-and-forget; the
save should resolve only once the engine has re-opened, so the caller can
rely on the new setting being live.)

Acceptance: the reproduction test passes; the existing UI device/channel
tests still pass; `PUT /api/config` returns after the engine has re-opened.

## What has been done
- 2026-10-24: Found while writing the engine-settings loopback tests (they
  failed through REST, passed through the UI's WebSocket path). Root cause
  traced. Reproduction test added (`todo`); the other engine tests save via
  WebSocket. No product code changed.
- 2026-10-24: Implemented as proposed.
  - `src/backend/cueManager.js`: new `applyConfig(prevConfig, nextConfig)`
    (sets the config; if any of `AUDIO_ENGINE_CONFIG_KEYS` changed, awaits
    `applyAudioEngineConfig()`).
  - `src/backend/routes/config.js`: `propagateConfig` is async and goes
    through `applyConfig`; `PUT /` and `POST /reset` await it before
    responding, so the setting is live when the request returns.
  - `src/backend/websocketManager.js`: `save-app-config` uses
    `applyConfig` instead of its own comparison; it now broadcasts the
    config after the engine has re-opened rather than before.
  - `getPlaybackStatus()` gained `engine: { deviceId, sampleRate,
    channelCount }` - what the engine is running with - so tests (and
    anyone else) can see a setting took effect.
  - Tests: the loopback reproduction test is no longer `todo` and passes; a
    new server test (no audio device needed) checks a REST sample-rate
    change reaches the engine; the calibration test now asserts the engine's
    device and rate.
  - Results: engine-settings loopback tests 3/3; `config`, `api-extras`,
    `websocket-protocol` server tests 39/39 + the new test (9/9 in
    `config.test.js`).

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  proposed fix.
