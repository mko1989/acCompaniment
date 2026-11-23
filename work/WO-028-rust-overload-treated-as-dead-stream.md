# WO-028: Rust core: an audio overload (xrun) or a default-device change is treated as a dead stream

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Rust port (B4) audio engine: stream errors |
| Opened | 2026-11-22, by Claude (reading cpal 0.18's CoreAudio host while investigating WO-025) |
| Reproduction test | `rust/app/src/audio/engine.rs` (unit tests) - "an_overload_leaves_the_stream_running" |
| Related | WO-025, WO-029, WO-009 |

## Feature
The engine watches its output stream for errors. In the original, a stream error from RtAudio is
reported to the UI (`audio-engine-error`) and the next play reopens the stream; buffer underflows
are not errors there: they're counted and logged as dropouts (WO-029).

## Problem
cpal reports everything through one error callback, fatal or not. On macOS (cpal 0.18.2,
`src/host/coreaudio/macos/mod.rs`) only `DeviceNotAvailable` and `StreamInvalidated` pause the
stream; `Xrun` (the device's processor-overload notification - a dropout) and `DeviceChanged`
(the system default output moved; the stream follows it) leave it running. The engine's error
callback (`open_stream`, `rust/app/src/audio/engine.rs:350`) marks the stream dead on any error.
After one overload - which this Mac produces on its own now and then (WO-009):
- `sync()` broadcasts `audio-engine-error` to the UI, which the original never does for a dropout;
- the stream is still running but counted dead, so the control side applies commands itself
  while the callback also runs: when they collide the callback gets no lock and outputs a buffer
  of silence (another dropout);
- the next play reopens the stream, a gap in everything already playing.

## Proposed solution
Classify errors in the error callback: `Xrun` counts as an underflow for the dropout report
(WO-029) and nothing else; `DeviceChanged` is logged only; everything else is treated as now
(stream dead, then WO-025's reopen). No choice to make.

Acceptance: the reproduction unit test passes; smoke, test:audio and test:audio:ui against the
core unchanged.

## What has been done
- 2026-11-22: traced in cpal's source; the error handling moved into `stream_error()` (no change
  in behavior) so it can be tested; reproduction unit test written (`#[ignore]` naming this WO).
- 2026-11-23: fixed in `stream_error()`: `Xrun` counts an underflow for the dropout report
  (WO-029), `DeviceChanged` is logged, anything else marks the stream dead as before. The test runs
  and also checks a real failure still stops the stream. cargo test 40/40; smoke 286/286 (7 runs),
  e2e 176/176, test:audio 89/89, test:audio:ui 15/15 against the core.

## Decision
- 2026-11-22, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Fix as proposed.
