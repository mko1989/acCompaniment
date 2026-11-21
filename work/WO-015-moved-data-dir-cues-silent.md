# WO-015: After the data dir moves, no cue plays (files looked up at their old absolute path)

| | |
|---|---|
| Status | Awaiting decision |
| Severity | High |
| Feature | Media library: finding a cue's audio file |
| Opened | 2026-11-21, by Claude (found while building the Rust port's recording seed, `rust/scripts/make-seed.js`) |
| Reproduction test | `test/moved-data-dir.test.js` - "cues still play after the data dir has moved" |
| Related | - |

## Feature
Imported audio files live in the data dir's `audio/` folder (`~/.accompaniment` or
`ACCOMPANIMENT_DATA_DIR`). Each has a metadata record in `audio/metadata/<id>.json` with its
`relativePath` (inside `audio/`) and an absolute `path`. Cues refer to files by `relativePath`.

## Problem
When the data dir is anywhere other than where the files were imported - restored from a backup
or copied to a new computer, a renamed home folder, a changed `ACCOMPANIMENT_DATA_DIR` - every
cue fails to play with `ENOENT: no such file or directory, stat '<old path>'`. The files are
there; the app looks in the old place. In a show, the whole grid is silent.

Cause: on load, `AudioFileManager` resolves each record's stored absolute `path` with
`resolveWithinAudioDir` (`src/backend/audioFileManager.js:74-80`; the same at `:435-441`). An
old absolute path is outside the new `audio/` folder, so `resolvePath` returns `null`
(`src/backend/pathManager.js:76-79`, logging "Path escapes base directory") and the record keeps
its stale `path`. Playback looks the file up by `relativePath` but then plays `audioFile.path`
(`src/backend/cueManager.js:985-1001`), the stale one. `relativePath`, which would have found the
file, is not used to rebuild the path.

Reproduce: import a file and make a cue, stop the app, move the data dir, start the app on the new
location, trigger the cue. The test above does this: `success: false`, `ENOENT` on the old path.

## Proposed solution
Options:
1. **Rebuild `path` from `relativePath` on load** (recommended): when the stored `path` does not
   resolve inside the current `audio/` folder (or `relativePath` is present at all), set
   `path = resolveWithinAudioDir(relativePath)`. No file format change; records are corrected in
   memory and on their next write.
2. Stop storing an absolute `path` and always derive it from `relativePath`: cleaner, but changes
   the metadata format (ADR-006 in `rust/DECISIONS.md` keeps formats the same; older versions
   reading the new files would need `path`).

Acceptance: the reproduction test passes; `npm test` passes; files whose `relativePath` escapes
`audio/` are still refused.

## What has been done
- 2026-11-21: reproduced with the test above (marked `todo`); cause traced.
- The Rust port's recording seed avoids the bug by storing `path` as the relative path (which
  `resolvePath` accepts); the recording therefore does not show this bug. The Rust port must fix
  it the same way the owner decides here.

## Decision
Pending. The owner said on 2026-11-21 that open decisions are taken later.
