# WO-041: Dragging the trim region on the waveform is sometimes not saved

| | |
|---|---|
| Status | Open |
| Severity | Medium |
| Feature | Browser UI - waveform trim region (`src/frontend/ui/waveform*.js`) |
| Opened | 2026-11-23, by Claude (CI on macOS, run 45270613387; passes on the owner's Mac and in the earlier CI runs: intermittent) |
| Reproduction test | `test/e2e/waveform.spec.js` - "dragging the trim region saves the moved trim points" (intermittent; not marked) |
| Related | WO-040 |

## Feature
Dragging the trim region moves both trim points and saves them to the cue.

## Problem
On the CI Mac the cue's `trimStartTime` stayed 1 (not > 1.05) for 10 s after the drag: the drag
was not saved, or not registered as a drag. Cause unknown: the drag's pointer events may land
before the waveform is ready on a slower machine, or the save is skipped.

## Proposed solution
To investigate: rerun with tracing uploaded from CI, and locally with CPU throttling.

## What has been done
- 2026-11-23: seen once in CI; opened.

## Decision
Pending.
