# WO-027: Rust core: the first press after start-up sounds ~15 ms later than on Node

| | |
|---|---|
| Status | Open |
| Severity | Low |
| Feature | Rust port (B4) audio engine: opening the output stream |
| Opened | 2026-11-22, by Claude (B4 loopback measurements) |
| Reproduction test | To be written: a loopback test measuring press-to-sound of the first press after the server starts |
| Related | WO-026 |

## Feature
Both the original and the port open the output stream lazily, on the first play
(`ensureStreamOpen`, `src/backend/audioPlaybackManager.js:155`). Once open the stream stays open,
and press-to-sound is the same on both (33-41 ms core, 34-42 ms Node).

## Problem
The first press - the one that opens the stream - measured 40-61 ms on the Rust core against
33-44 ms on Node (8 runs each, `rust/app/B4-NOTES.md`). Where the extra time goes is not yet known
(candidates: cpal's device lookup by id enumerating every device, `supported_output_configs`, the
host thread round trip, cpal's start-up of the AudioUnit). A show's first cue would sound up to
~20 ms late compared with now.

## Proposed solution
Investigate first: time each step of `open_stream` (`rust/app/src/audio/engine.rs:313`) and the
round trip. Then, depending on what's found:
1. remove the slow step (e.g. look the device up once, not per open);
2. open the stream when the engine initialises rather than on the first play (a behavior change:
   the app would hold the device from start-up);
3. accept the difference.

Recommendation: decide after measuring; prefer 1.

## What has been done
- 2026-11-22: opened from the B4 measurements.

## Decision
Pending (investigation first).
