# WO-023: With a relative data dir, "replace file" deletes the file it just replaced

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | Media library: replacing a file's audio (`POST /api/audio/:id/replace`) |
| Opened | 2026-11-22, by Claude (found by the Rust port's B1 differential check, `rust/scripts/diff-data.js`) |
| Reproduction test | `test/relative-data-dir.test.js` - "replacing a file's audio keeps the file when the data dir is relative" |
| Related | WO-015 |

## Feature
"Replace" swaps the audio of a library file for a new upload, keeping its id, so every cue that
uses it plays the new audio.

## Problem
When `ACCOMPANIMENT_DATA_DIR` is a relative path, `PathManager` keeps every directory relative
(`src/backend/pathManager.js:5-12`), but records loaded from disk get absolute paths
(`resolvePath` uses `path.resolve`). In `replaceFile` (`src/backend/audioFileManager.js`, around
`:358-383`) the new location is `path.join(audioDir, name)` - relative - and is compared with the
record's absolute `path`: for the same file they differ, so `fs.remove(record.path)` deletes the
file that was just moved there. The API answers `success: true`; the file is gone, and every cue
using it fails to play.

It needs a relative data dir (the default `~/.accompaniment` is absolute) and a file added in an
earlier session (records created in the same session keep relative paths). The Rust port's
recording uses a relative data dir; a user setting `ACCOMPANIMENT_DATA_DIR=./show` would hit it.

## Proposed solution
Make the data dir absolute once, in the `PathManager` constructor (`path.resolve(dataDir)`), so
relative and absolute paths are never mixed anywhere (this also covers any other comparison of
the same kind). Alternative: resolve both sides in `replaceFile` only - narrower, leaves the same
trap elsewhere.

Acceptance: the reproduction test passes; `npm test` passes; the Rust core does the same.

## What has been done
- 2026-11-22: reproduced (the test needs a restart between adding and replacing the file, because
  only records loaded from disk are absolute); fixed in `src/backend/pathManager.js` and in the Rust
  core (`rust/app/src/core/paths.rs`); the affected test files pass (43/43) and the B1 differential
  check still matches (303/303).
- 2026-11-22: verified: `npm test` unit 139/139, smoke 286/286, e2e 175/175. Not audible, so the
  loopback suites were not needed.

## Decision
- 2026-11-22, decided by Claude on the owner's delegation (rust/DECISIONS.md ADR-016: "do the best
  you can with those dillemas"). Resolve the data dir in the `PathManager` constructor.
