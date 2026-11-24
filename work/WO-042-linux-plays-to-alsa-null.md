# WO-042: On Linux the app can pick ALSA's "null" device, so nothing is heard and cues end at once

| | |
|---|---|
| Status | In progress |
| Severity | Critical (Linux: no sound at all) |
| Feature | Output device selection (`rust/app/src/audio/devices.rs`, `rust/app/src/audio/engine.rs`) |
| Opened | 2026-11-24, by Claude (the owner ran the smoke suite and the server on an Ubuntu box) |
| Reproduction test | `rust/app/src/audio/devices.rs` - "the_default_output_is_never_alsas_null_device" |
| Related | WO-037 (probably the same cause) |

## Feature
With no output device chosen (or "default"), the app plays to the system's default output,
like RtAudio's `getDefaultOutputDevice()`.

## Problem
On the owner's Ubuntu box the server opened "Discard all samples (playback) or generate zero
samples (capture)" - ALSA's `null` PCM - and 61 smoke tests failed: cues never reported
"playing", or reached their end at once; pause didn't hold; no `playback-time-update` arrived.
The `null` device throws the sound away and doesn't keep time, so the mixer runs as fast as it
can.

Root cause:
- `devices.rs` `probe` (non-macOS) listed only what cpal's `host.devices()` returns. On ALSA
  that is the hint list, which doesn't always include `default`, so no device was marked as the
  default output.
- `Registry::default_output` then fell back to the first device with outputs. ALSA lists `null`
  first.
- `engine.rs` `cpal_device` also looked only in `host.devices()`, so it couldn't open
  `default` either.

## Proposed solution
- `probe` adds cpal's `default_output_device()` to the front of the list when it isn't listed.
- The default-output rule (`pick_default_output`) never picks `alsa:null`.
- `cpal_device` falls back to `default_output_device()` when that is the device asked for.

Acceptance: the reproduction test passes; on the Ubuntu box the server opens a real device and
the smoke suite's playback tests pass.

## What has been done
- 2026-11-24: reproduction test and the fix above (`devices.rs`, `engine.rs`); unit tests pass
  on macOS. The Linux/Windows code path still needs building on Linux (the owner's box or CI).
- 2026-11-24: on the owner's Ubuntu box it builds and now opens device 129 (not "null"); playing
  then failed on the buffer size, WO-045.

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
