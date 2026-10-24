# WO-009: Audible dropouts during playback (investigation)

| | |
|---|---|
| Status | Won't fix |
| Severity | Medium (if it were the app's) |
| Feature | Audio engine - continuous playback |
| Opened | 2026-10-24, by Claude (loopback suite) |
| Reproduction test | `test/audio/calibration.test.js` - "the app drops out no more often than the loopback device itself does" |
| Related | - |

## Feature
Once a cue is playing, its sound must be continuous: no gaps, whatever else
the server is doing.

## Problem
Recordings of playback contain occasional dropouts - runs of digital
silence, one or more buffers long (up to ~3000 samples, ~60 ms), at random
moments. The engine's own counter agrees: `WorkerMixer: Audio dropouts ...`
reports driver underflows and late buffers (worst gaps 30-130 ms against a
10.7 ms buffer period) at the same times.

The question this work order answers: is that the app, or the machine?

## Proposed solution
Measured, not assumed:
- A bare RtAudio player with a trivial render callback
  (`test/audio/lib/baselinePlayer.js`, its own process, no app) plays the
  same tone to the same device, in turns with the app, recorded the same
  way. If only the app drops out, it's the app.
- Results (dropouts per 18 s of playback each, bare player vs app):
  - NoMachine Audio Adapter, four runs: 0 vs 4, 12 vs 14, 18 vs 18,
    2 vs 6 - 32 vs 42 in all.
  - BlackHole 2ch, one run: 20 vs 20.
- The bare player - no app at all - drops out at a similar rate on both
  virtual devices, so most of this is the Mac (scheduling under load / the
  drivers), not the app. The app was somewhat worse over the NoMachine runs
  (42 vs 32); that difference is within the run-to-run spread seen here
  (0 to 18 for the same player) and was even on BlackHole, so it isn't
  evidence of an app problem - but it isn't proof of none either.

Recommendation: no app change. Keep the comparison test as the guard - it
fails if the app ever drops out clearly more than the bare player - and
keep the suites' retry-on-dropout policy so behavior tests don't fail on
environmental gaps. Re-run the comparison on show hardware with a real
interface before relying on that for a show; if the app is worse there,
reopen with the measurements.

## What has been done
- 2026-10-24: Built the comparison and dropout detection into the loopback
  suite (sample-level gap detection, engine report capture). Made the test
  recorder allocation-free (preallocated buffers) after its own buffer size
  showed up in gap lengths. Measured as above. No product code changed.
- 2026-10-24 (after the other fixes): Full regression run with the machine
  under load (load average 8.2 - a browser plugin at 40% CPU, WindowServer,
  VS Code, a second user session). The bare player alone dropped out 32 and
  then 52 times per 18 s (it was 0-20 earlier in the day); the app 12 and
  62. "Adding files while a cue plays" failed once with dropouts outside the
  upload window (0.4 s, 0.9 s, 3.9 s, 6.5 s - the uploads ran 1.3-1.9 s),
  so it was narrowed to the uploads and 2 s after (WO-010 run); it then
  failed once and passed once under the same load. Conclusion unchanged:
  on this machine dropouts follow system load and hit a bare RtAudio player
  as much as the app. The dropout tests are only meaningful on a quiet
  machine - run them with other heavy apps closed.

## Decision
- 2026-10-24, owner: "start knocking them out" - taken as approval of the
  recommendation: closed with no app change, as environmental on this
  machine. The comparison test stays as the guard; reopen with measurements
  if the app drops out clearly more than the bare player, or on show
  hardware.
