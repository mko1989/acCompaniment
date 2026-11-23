# WO-024: Rust core: the playback status can miss the last command when the stream has stalled

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Rust port (B4) audio engine: the playback status (`GET /api/cues/status/playback`, `voices`) |
| Opened | 2026-11-22, by Claude (one failure in a full smoke run against the Rust core: `test/api-extras.test.js` - "Stop All without a behavior uses the configured Stop All behavior", "fading, not cut") |
| Reproduction test | `rust/app/src/audio/engine.rs` (unit tests) - "settled_report_applies_commands_a_stalled_stream_never_took" |
| Related | WO-014, WO-025 |

## Feature
The playback status lists the voices the engine is playing (fading, ducked, position...). The
original's audio worker applies each command and reports its status straight away, so a status
read right after a command (stop with a fade, say) shows it (WO-014 made the tests wait for that
report). The Rust engine applies commands on the audio callback instead, so `voices()` waits for
the callback to have applied everything already sent.

## Problem
`CpalEngine::settled_report` (`rust/app/src/audio/engine.rs:720`) waits at most
`min(3 periods + 20 ms, 200 ms)` and then returns the report as it is. When the callback doesn't
run within that time the status is stale: it misses the commands still queued. That happens:
- when the stream has stalled or been killed but cpal hasn't reported the error yet (the stream
  still counts as running, so `apply_if_no_stream` doesn't step in). Parallel test servers change
  the shared default device's sample rate, which kills streams (WO-025): the smoke run that
  failed had several servers on the default device;
- with a buffer longer than ~60 ms (e.g. 8192 frames at 44.1 kHz = 186 ms): the cap is shorter
  than one period.

The user-facing effect is small (a status read shows the state before the last command for one
read); the app's behavior is otherwise unchanged. The smoke test fails intermittently.

## Proposed solution
When the wait runs out with commands still queued, the control side applies them itself, as it
already does with no stream: `try_lock` the audio state (never block - if the callback holds it,
it is applying them right now, so keep waiting a little longer), drain the commands and publish
the status. Also re-check `stream_running()` in the wait loop, so a stream that dies while
waiting is noticed at once.

Acceptance: the reproduction unit test passes; the smoke suite against the core passes in full
runs (3 in a row); test:audio and test:audio:ui unchanged.

## What has been done
- 2026-11-22: found in a full smoke run against the core (285/286); the test passed 4/4 on its
  own and in 2 further full runs. Traced to `settled_report`. Reproduction unit test written
  (`#[ignore]` naming this WO: a stream that counts as running but whose callback never runs).
- 2026-11-23: fixed in `rust/app/src/audio/engine.rs` `settled_report`: past the wait, the control
  side `try_lock`s the audio state and applies the queued commands itself (if the callback holds
  it, it is applying them: wait up to 200 ms more); a stream that dies while waiting is noticed at
  once. The reproduction test runs (no `#[ignore]`) and passes.
  - The smoke failure that opened this WO came back once after the fix (1 in 3 full runs): a fade
    that never finished. That was WO-025's stream fight between parallel test servers, not this;
    fixed there. Afterwards: smoke against the core 286/286 in 7 full runs (4 + 3).
  - cargo test 40/40, clippy and fmt clean; test:audio 89/89 and test:audio:ui 15/15 against the
    core.

## Decision
- 2026-11-22, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Fix as proposed; no behavior to choose.
