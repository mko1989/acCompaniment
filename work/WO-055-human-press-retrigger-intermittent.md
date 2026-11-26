# WO-055: A human-length press on a playing cue's name is sometimes not taken as a retrigger

| | |
|---|---|
| Status | Open |
| Severity | Medium (a click in show mode that does nothing; intermittent) |
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
Root cause not investigated yet.

## Proposed solution
Pending investigation: reproduce under load (`--repeat-each` with the whole cue-grid spec, or
CPU stress), then check whether the redraw can still replace the press target.

## What has been done
2026-11-26 - Opened. Failure seen once in the full run; 5/5 passes alone.

## Decision
Pending.
