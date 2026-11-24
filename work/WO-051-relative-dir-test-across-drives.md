# WO-051: The relative-data-dir test can't set up on Windows CI (temp folder on another drive)

| | |
|---|---|
| Status | Done |
| Severity | Low (tests only) |
| Feature | `test/relative-data-dir.test.js` |
| Opened | 2026-11-24, by Claude (Windows CI run 45383129540) |
| Reproduction test | `test/relative-data-dir.test.js` - "replacing a file's audio keeps the file when the data dir is relative" |
| Related | WO-023 |

## Problem
The test makes its data dir in the system temp folder and passes it to the server as a path
relative to the repo. On GitHub's Windows runners the repo is on D: and the temp folder on C:;
no relative path crosses drives, so `path.relative` returned an absolute path and the test's
own check (`!path.isAbsolute(relativeDir)`) failed. Not an app bug.

## Proposed solution
Make the temp folder inside the repo's git-ignored `tmp/`.

## What has been done
- 2026-11-24: done; the test passes on macOS. Windows CI to confirm.

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
