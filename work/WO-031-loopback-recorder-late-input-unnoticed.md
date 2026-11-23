# WO-031: Loopback suites: when the recorder itself loses input, the test fails instead of retrying

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Loopback test suites (`test/audio/`, `test/audio-ui/`): the recorder (`test/audio/lib/capture.js`, `recorderWorker.js`) and the dropout retry (`test/audio/lib/loopback.js`) |
| Opened | 2026-11-23, by Claude (test:audio against the Rust core failed 2-3 pitch/position tests per run, e.g. formats "a mono MP3 plays on both outputs..." - "pitch: expected 1593.750 ± 3, got 1597.386"; calibration "a cue at volume 1..." - "segment at 2.3s: 24 !== 23") |
| Reproduction test | `test/unit/audio-capture.test.js` - "a late input callback is reported: the recorder lost input there (WO-031)", "ordinary scheduling jitter is not reported (WO-031)" |
| Related | WO-009, WO-024..030 |

## Feature
The loopback suites play through the app to a loopback device (BlackHole) and record its input
with RtAudio on a worker thread. Virtual devices drop the odd buffer, so a test that fails *and*
whose recording has a hole in it (digital silence between sound, `Take.holes()`) is retried, up
to 3 times (`audioTest`, `test/audio/lib/loopback.js:93`); a failure without one is reported.

## Problem
A hole is what an *output* dropout looks like. The recorder can lose *input* too: when its
callback runs late (two buffer periods or more - a 1024-frame buffer is 21.3 ms), the device
moves on and the input of the missed cycles is never delivered. The recording then has no hole
but a *skip*: 40-50 ms of the app's sound simply missing, with sound on both sides, and RtAudio
doesn't flag it as an overflow. Tests that read a position or pitch at a fixed time after the
onset then read the wrong segment: the reading is pulled towards the next segment's frequency
(1597 Hz instead of 1593.75 ± 3) or the segment comes one early. The suite doesn't recognise the
take as unreliable, so it reports a failure.

Measured on this Mac (2026-11-23), 12 takes of a 2.5 s tone per run, each segment's boundaries
found to the millisecond and compared with the recorder's buffer arrival times:
- against the Rust core: 3 and 4 takes with skips (20-50 ms each), **every one at a late recorder
  callback** (gaps of 43-67 ms); the app's own rendered output (tapped in the callback,
  temporary instrumentation since removed) was complete in every take, and cpal's callback and
  playback times were regular throughout;
- against Node: late recorder callbacks in 4 takes of 12 as well - the machine (WO-009), not
  the app; next to Node they mostly show up mixed with holes, so the suite retried them.
- bare players, 3 x 10 s each, same recorder: cpal sine 0 holes and 0 skips; RtAudio sine holes
  in 2 rounds of 3.

So the core is not dropping audio; the suite misses the recorder's own losses, which with the
core aren't accompanied by holes.

## Proposed solution
Keep the recorder's buffer arrival times in the Take and add `Take.lateInput()`: arrivals more
than two buffer periods after the previous one (with where and how long). Count those with
holes when deciding to retry, and print them as a diagnostic, as holes are. No choice to make.

Acceptance: the reproduction tests pass; test:audio and test:audio:ui pass against Node and the
Rust core; the calibration test's numbers unchanged (it counts holes in the app's output, which
stays its subject).

## What has been done
- 2026-11-23: investigated as above; reproduction unit tests written (`todo` naming this WO).
- 2026-11-23: fixed. `test/audio/lib/capture.js`: the Take keeps the arrivals and has
  `lateInput()`; `test/audio/lib/loopback.js`: a failed test is retried when a take has holes *or*
  late input, and the diagnostic says which; `test/audio-ui/fixtures.js` annotates late input next
  to holes (that suite retries every failure anyway). `todo` removed: unit 141/141.
  test:audio against the core 89/89 twice (no retries needed in those runs), against Node 89/89;
  test:audio:ui against the core 15/15, against Node 15/15 twice (one earlier run failed the XFADE
  test 3 times in a row and didn't repeat: noted in rust/HANDOFF.md).

## Decision
- 2026-11-23, decided by Claude on the owner's delegation (ADR-016; owner, 2026-11-21: "do the
  best you can with those dillemas"). Fix as proposed.
