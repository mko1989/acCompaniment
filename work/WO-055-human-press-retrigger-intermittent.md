# WO-055: The human-length press test sometimes fails to find the cue name to press

| | |
|---|---|
| Status | Done |
| Severity | Low (test only) |
| Feature | Show-mode cue buttons: clicking a playing cue retriggers it (`src/frontend/ui/cueGrid*.js`) |
| Opened | 2026-11-26, by Claude (full e2e run on the Mac) |
| Reproduction test | `test/e2e/cue-grid.spec.js` - "a human-length press on a playing cue's name still retriggers it" (intermittent) |
| Related | WO-054 (found while adding its tests) |

## Feature
In show mode a click on a playing cue applies its retrigger behavior (here: stop). A real click
holds the button down ~150 ms while the button's name text is redrawn by time updates; a click
whose press target was replaced before release used to be dropped, and this test guards that fix.

## Problem
In a full `npm run test:e2e` on 2026-11-26 (183 tests, after the 16 new WO-054 tests were added)
this test failed once; run alone 5 times it passed 5 times. So under load the second press is
still sometimes lost - which a user would see as a click on a playing cue doing nothing.
Root cause (2026-11-26, from Linux CI run 45798716771, where it failed too): not the app. The
test's `boundingBox()` of `.cue-button-main-name` returned null - "Cannot read properties of null
(reading 'x')" - because the name element is replaced on every time update and the measurement
landed on one that had just been detached. No click was lost.

## Proposed solution
Test only: measure again until a measurement lands (up to 20 tries), then press as before.

## What has been done
2026-11-26 - Opened. Failure seen once in the full run; 5/5 passes alone.
2026-11-26 - Same failure on Linux CI; the error shows the null bounding box. Changed the test to
re-measure (`test/e2e/cue-grid.spec.js`); 10/10 with `--repeat-each=10`.

## Decision
- 2026-11-26, Claude on the owner's delegation (ADR-016): fix the test; the app is fine.
