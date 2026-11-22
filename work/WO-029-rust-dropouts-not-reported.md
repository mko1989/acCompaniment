# WO-029: Rust core: audio dropouts are not logged

| | |
|---|---|
| Status | Open |
| Severity | Low |
| Feature | Rust port (B4) audio engine: dropout report |
| Opened | 2026-11-22, by Claude (comparing the port's engine with `audioEngineWorker.js` for WO-028) |
| Reproduction test | None before the fix (there was no counter to test, and a real dropout can't be caused on demand); the fix adds `rust/app/src/audio/engine.rs` (unit tests) - "a_late_callback_is_reported_as_a_dropout" |
| Related | WO-028, WO-009 |

## Feature
The original's audio worker counts dropouts - underflows the driver reports and callbacks that
come more than two buffer periods after the previous one - and every 5 s with any, logs
`WorkerMixer: Audio dropouts in the last 5s: N underflow(s) reported by the driver, M late
buffer(s) (worst gap X ms, buffer period Y ms)` (`src/backend/audioEngineWorker.js:146-155`,
`src/backend/workerMixer.js:137-146`). It's the first thing to look at when someone hears a
dropout, and the loopback suites print these lines next to a take (`test/audio/lib/loopback.js:256`,
`test/audio/calibration.test.js:109`).

## Problem
The Rust engine counts nothing and logs nothing: a dropout leaves no trace in the server's log,
and the calibration test's "engine" diagnostics are always empty against the core.

## Proposed solution
Count late callbacks in the audio callback (time since the previous one > 2 periods, worst gap)
and underflows from cpal's `Xrun` (WO-028) in atomics; the control side logs the same line every
5 s when any were counted. No choice to make.

Acceptance: the reproduction unit test passes; the line appears in the server log for a stalled
callback.

## What has been done
- 2026-11-22: opened.

## Decision
- 2026-11-22, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Fix as proposed.
