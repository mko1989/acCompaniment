# WO-034: The smoke test "Replace with a different file type..." needs an ffmpeg on the PATH

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Smoke suite - media library Replace (`test/media-library.test.js`) |
| Opened | 2026-11-23, by Claude (first CI run: failed on macOS and Linux with `spawnSync ffmpeg ENOENT`, https://github.com/mko1989/acCompaniment/actions/runs/45260956244) |
| Reproduction test | `test/media-library.test.js` - "Replace with a different file type keeps the name with the new extension" (fails on any machine without `ffmpeg` on the PATH) |
| Related | WO-033 |

## Feature
Replacing a cue's audio file with a different format keeps the file's name with the new
extension. The test makes a FLAC to replace a WAV with, using ffmpeg.

## Problem
The test ran `ffmpeg` from the PATH (`test/media-library.test.js:181`). The owner's Mac has one
(Homebrew); the CI runners don't, though `npm run fetch:ffmpeg` put one in `vendor/ffmpeg/`,
where the app and the audio suite (`ffmpegBinary()`, `test/audio/lib/signals.js:116`) look.
The app was not at fault: the test failed before it called the server.

## Proposed solution
Use `ffmpegBinary()`: `FFMPEG_PATH`, then `vendor/ffmpeg/`, then the PATH - the same order as
the app. Acceptance: the test passes on the CI runners.

## What has been done
- 2026-11-23: `test/media-library.test.js` uses `ffmpegBinary()`. Locally `npm run test:smoke`
  passes (the vendored ffmpeg is found first); CI to confirm.

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016): fix the test as proposed (test
  tooling only).
