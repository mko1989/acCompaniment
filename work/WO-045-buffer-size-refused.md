# WO-045: A device that refuses the configured buffer size plays nothing

| | |
|---|---|
| Status | In progress |
| Severity | Critical (no sound on such devices) |
| Feature | Opening the output stream (`rust/app/src/audio/engine.rs`, `open_stream`) |
| Opened | 2026-11-24, by Claude (the owner ran the server on an Ubuntu box after WO-042) |
| Reproduction test | `rust/app/src/audio/engine.rs` - "the_buffer_size_is_clamped_into_a_range_the_device_reports" |
| Related | WO-042; possibly the Windows "cues don't play" report of the same day |

## Feature
The stream opens with the configured buffer size (`audioBufferSize`, default 512), clamped into
the device's range as RtAudio does.

## Problem
With WO-042 fixed, the Ubuntu box opened ALSA's "default" device, and every cue failed:
"Error playing cue ...: Buffer size 512 is not in the supported range 1024..=1024". The clamp
only looked at configs with exactly the stream's channel count; this device reports its range on
another. Any refusal of the fixed size then failed the whole stream, and the cue.

## Proposed solution
- `clamp_buffer`: the range from a config with the stream's channel count, else from any config.
- If the device still refuses the fixed size, open it at its own default size
  (`BufferSize::Default`) rather than not at all.

Acceptance: the reproduction test passes; on the Ubuntu box cues play and the smoke suite's
playback tests pass; macOS unchanged.

## What has been done
- 2026-11-24: the fix above; the reproduction test passes; on macOS the smoke, stop-and-fade and
  retrigger tests pass (53/53). Not yet run on Linux or Windows.
- 2026-11-24: on the owner's Ubuntu box cues play, and the smoke suite passes 282/286 (1 fail,
  WO-047; 3 todo, WO-037).

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
