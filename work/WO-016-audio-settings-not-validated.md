# WO-016: Invalid audio settings are saved, and then no cue plays

| | |
|---|---|
| Status | Awaiting decision |
| Severity | Medium |
| Feature | App config: audio settings (`PUT /api/config`) |
| Opened | 2026-11-21, by Claude (found by the Rust port's HTTP recording, `rust/app-fixtures/http-inputs.jsonl` case `2002-config-update-invalid`) |
| Reproduction test | `test/config.test.js` - "rejects invalid audio settings instead of saving them" |
| Related | WO-002 |

## Feature
`PUT /api/config` updates settings, validates them and saves them to `appConfig.json`; invalid
values get `400 {success:false, error, details}`. The audio settings (sample rate, buffer size,
output channel count) are applied to the audio engine (WO-002).

## Problem
`validateConfig` (`src/backend/appConfigManager.js:281-316`) checks ports, fade times, ducking and
crossfade times, but not `audioSampleRate`, `audioBufferSize` or `audioOutputChannelCount`.
`PUT /api/config {"audioSampleRate": "fast"}` answers 200 and saves it. From then on every
trigger answers `{"success":false,"error":"sampleRate should be a valid number"}` - no cue plays -
and since the value is saved, it survives a restart until someone sets a valid rate again.

The UI only offers valid values, so this takes a REST client, a script or Companion sending a bad
value. The other checks have gaps of the same kind (e.g. `defaultFadeInTime: "x"` is not `< 0`,
so it passes), which this work order does not cover.

## Proposed solution
Add to `validateConfig`, for keys present in the update:
- `audioSampleRate`: a positive integer (optionally one of the rates the UI offers);
- `audioBufferSize`: a positive integer (optionally a power of two, 16-8192);
- `audioOutputChannelCount`: an integer 1-64.

Options:
1. **Type and range checks only** (recommended): rejects nonsense, accepts any rate the device may
   support; the engine still reports a device that refuses a valid-looking rate.
2. Restrict to the values the UI offers: stricter, but scripts that set other rates the device
   supports would break.

Acceptance: the reproduction test passes; valid updates still pass (`test/config.test.js`); the
Rust port validates the same way.

## What has been done
- 2026-11-21: reproduced with the test above (marked `todo`); cause traced. The Rust port's
  recording keeps the case, in its last phase after playback (a valid rate put back does not
  recover the engine: WO-017).
- 2026-11-21: another consequence, found by the Rust port of `outputPatch.js`: with a fractional
  `audioOutputChannelCount` (e.g. 2.5, accepted today), `normalizeOutputPatch` clamps patches to
  fractional channels (`[5,7]` -> `[1.5,1.5]`, `src/backend/utils/outputPatch.js:15-17`). Option 1's
  integer check covers it.

## Decision
Pending. The owner said on 2026-11-21 that open decisions are taken later.
