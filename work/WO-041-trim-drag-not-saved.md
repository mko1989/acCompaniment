# WO-041: Dragging the trim region on the waveform is sometimes not saved

| | |
|---|---|
| Status | Done |
| Severity | Low (test only: the app saves the drag) |
| Feature | Browser UI - waveform trim region (`src/frontend/ui/waveform*.js`) |
| Opened | 2026-11-23, by Claude (CI on macOS, run 45270613387; passes on the owner's Mac and in the earlier CI runs: intermittent) |
| Reproduction test | `test/e2e/waveform.spec.js` - "dragging the trim region works when the waveform is ready before the sidebar has slid open (WO-041)" (deterministic: a 3 s slide) |
| Related | WO-040 |

## Feature
Dragging the trim region moves both trim points and saves them to the cue.

## Problem
On the CI Mac the cue's `trimStartTime` stayed 1 (not > 1.05) for 10 s after the drag: the drag
was not saved, or not registered as a drag. Cause unknown: the drag's pointer events may land
before the waveform is ready on a slower machine, or the save is skipped.

Root cause (2026-11-26, from the Playwright trace of macOS CI run 45801699870): the test, not
the app. The properties sidebar opens with a 0.3 s width transition (`src/frontend/styles/layout.css:254`),
and on the CI Mac the waveform and its region were ready before it had finished. The test
measured the waveform and the region at once, mid-slide: the waveform box was ~63 px wide (it
ends up 289 px), so the drag was 6.3 px long, and it started at x=1225 where the region was no
longer - the screencast frame at the mouse-down (139.956 s) shows the sidebar not open yet; the
frame 0.5 s later shows it open with the region elsewhere. The press landed on the background, so
there was nothing to save. Locally the waveform loads after the slide is over, which is why it
passed there (even with the CPU throttled 6x). A user can't hit this: they drag the region where
they see it.

## Proposed solution
Test only: measure the boxes once they have stopped moving (`settledBox`, the wait `clickAt`
already did, now shared), and keep a deterministic regression test with the slide stretched to
3 s. Acceptance: the stretched-slide test fails with the old measuring and passes with the new.

## What has been done
- 2026-11-23: seen once in CI; opened.

2026-11-26 - Failed again on macOS CI (run 45801699870, commit 281df0a): trimStartTime stayed 1
(expected > 1.05 within 10 s), i.e. the drag was not saved at all; Linux and Windows passed.

2026-11-26 - Investigated from the CI trace (above). Proved it: with the slide stretched to 3 s,
measuring at once failed 3/3 (waveform box 13-28 px wide), waiting for the layout passed 3/3.
Changed `test/e2e/waveform.spec.js`: `settledBox` helper used by `clickAt` and by a shared
`dragRegion`; added the stretched-slide test. Waveform spec 25/25; the trim-drag tests 15/15 with
`--repeat-each=5`.

## Decision
- 2026-11-26, the owner: "do the investigation on wo-041".
- 2026-11-26, Claude on the owner's delegation (ADR-016): fix the test; no app change, since a
  user drags what they see.
