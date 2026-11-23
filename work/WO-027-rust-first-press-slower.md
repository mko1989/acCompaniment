# WO-027: Rust core: a press just after the stream opens sounds ~15-20 ms later than on Node

| | |
|---|---|
| Status | Won't fix |
| Severity | Low |
| Feature | Rust port (B4) audio engine: opening the output stream |
| Opened | 2026-11-22, by Claude (B4 loopback measurements) |
| Reproduction test | None in the suites (a measurement, not a pass/fail behavior); the scratch measurement is described under *What has been done* |
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
- 2026-11-23: investigated.
  - Timed `open_stream` with temporary logging (since removed): device lookup 0.06 ms, configs
    0.7 ms, `build_output_stream` 65 ms, `play` 5 ms; 71 ms in all, once. Node's first trigger
    request (which opens its stream) took 137 ms, the core's 75 ms; later presses 2-6 ms on both.
  - The loopback tests' "first press" is not the one that opens the stream: `warm()` opens it
    about half a second earlier. Measured press-to-sound with the loopback recorder (a cue warmed,
    then 6 takes of press / 1 s / press, BlackHole, 512 frames @ 48 kHz):
    - core, first take straight after warm: 52.2, 55.7, 58.6 ms; later takes 34-42 ms;
    - core, first take 2 s after warm: 33.2, 34.9 ms; later takes 32-40 ms;
    - Node: 33.2-40.3 ms throughout.
  - So the extra 15-20 ms belongs to the first second or so after the stream opens (consistent
    with cpal's output unit settling; not traced further): afterwards the core matches Node. The
    stream opens once per session (and after a device or audio-settings change), on the first
    press. That press's trigger request returns sooner on the core (75 ms against 137 ms); its
    press-to-sound wasn't measured on either.

## Decision
- 2026-11-23, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Won't fix: the difference is limited to presses in the
  first second after the stream opens, and the open itself is quicker on the core; opening
  the stream at start-up instead (option 2) would change when the app takes the device, for
  ~15 ms on one press. Revisit if a user hears it.
