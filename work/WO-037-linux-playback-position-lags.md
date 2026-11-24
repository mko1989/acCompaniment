# WO-037: On Linux (CI, PulseAudio null sink) the playback position lags the clock

| | |
|---|---|
| Status | Open |
| Severity | Medium (if it is the app: times, fades and auto-stops run late on Linux) |
| Feature | Audio engine on Linux (cpal ALSA) - playback position, fades, stop after a fade |
| Opened | 2026-11-23, by Claude (CI on ubuntu-22.04: runs 45265130852 and 45267892964) |
| Reproduction test | `test/api-extras.test.js` - "Stop All without a behavior uses the configured Stop All behavior"; `test/retrigger.test.js` - "playing + restart: starts over from the beginning", "playing + toggle_pause_play: pauses, and pressing again resumes where it left off" (marked `todo` on Linux only) |
| Related | WO-024, WO-025 (the Stop All test was intermittent on macOS before those), WO-012 |

## Feature
A playing cue's position follows the wall clock; a fade-out of N ms ends, and the cue reports
"stopped", N ms after it starts.

## Problem
On the GitHub ubuntu-22.04 runner, with a PulseAudio null sink as ALSA's default device (the
runner has no sound card; see `.github/workflows/ci.yml`):
- after 1.2 s of playing, the position is not past 1 s (`retrigger.test.js:42`);
- after 0.8 s + 0.3 s of playing, it is not past 0.7 s (`retrigger.test.js:61`);
- a Stop All with an 800 ms fade starts the fade (`isFadingOut` true) but the cue is not
  "stopped" 2 s later (`api-extras.test.js:104`) - in both runs.
Everything else passes there (283-284 of 286). macOS (real and CI) and the local loopback
suites don't show it.

So the engine's clock runs late by a few hundred ms or more: either the stream starts late
(PulseAudio's ALSA plugin buffers deeply) or the device consumes slower than real time. Not
known yet whether a real Linux machine with a sound card does the same - that is what matters.

## Proposed solution
Not yet: investigate first (on hold with the rest of Linux, owner 2026-11-23: "let's leave the
Linux version for now").
1. On a Linux machine with real audio (ALSA hw device, and PipeWire/Pulse): run the three tests
   and `npm run test:audio` (loopback via `snd-aloop`).
2. In CI: log the server's stderr (the engine prints its device, rate and buffer) and the
   callback timing (the WO-029 dropout report) for one run.
3. Then decide: an app fix (e.g. how the position is derived from the stream on ALSA), or a CI
   artifact (the null sink's pacing), in which case the markers stay CI-only.

## What has been done
- 2026-11-23: seen in two CI runs; the three tests are marked
  `todo: process.platform === 'linux' && 'WO-037: ...'`, so they still run (and must pass) on
  macOS and Windows.
- 2026-11-24: on the owner's Ubuntu box (a real sound card), after WO-042 and WO-045, the three
  tests marked for this pass, and the smoke suite passes 282/286 (the other fail is WO-047). The
  lag is likely CI's PulseAudio null sink; still to be confirmed on CI.

## Decision
Pending.
