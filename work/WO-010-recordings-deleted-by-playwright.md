# WO-010: Loopback suite recordings are deleted by the next Playwright run

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Loopback audio suites - saved recordings (test tooling, not the app) |
| Opened | 2026-10-24, by Claude (full regression run) |
| Reproduction test | - (found by running `npm run test:audio` then `npm run test:audio:ui`: the first's recordings were gone) |
| Related | WO-009 |

## Feature
Every loopback take is saved as a WAV plus an Audacity label track, so a
failing transition can be listened to and inspected after the run.

## Problem
The takes were saved under `test-results/audio/` and
`test-results/audio-ui/`. `test-results/` is Playwright's output directory,
which Playwright empties at the start of every run - so running the e2e or
browser audio suite (`npm test` runs e2e last) deleted the backend audio
suite's recordings, and the browser suite's own takes only survived until
the next Playwright run. Found when going back to the recording of a failed
test after a full regression run.

## Proposed solution
Save takes to a directory of their own that no tool clears:
`test-recordings/audio/` and `test-recordings/audio-ui/` (gitignored).
Playwright attachments of browser takes still go to its report as well.

## What has been done
- 2026-10-24: Implemented as proposed: `test/audio/lib/loopback.js` and
  `test/audio-ui/fixtures.js` write to `test-recordings/`; `.gitignore`,
  README and CLAUDE.md updated.

## Decision
- 2026-10-24: Fixed directly as part of the work the owner asked for ("start
  knocking them out"); a defect in test tooling written in the same session,
  with no behavior choice involved. Owner may review.
