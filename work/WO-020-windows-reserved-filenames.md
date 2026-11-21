# WO-020: Windows reserved names (CON, NUL, COM1, ...) are used as library file names

| | |
|---|---|
| Status | Open |
| Severity | Low |
| Feature | Media library: file names (`sanitizeFilename`), on Windows |
| Opened | 2026-11-21, by Claude (found by the Rust port's recording of `mediaLibrary.js`, `rust/media-library-names`) |
| Reproduction test | `test/unit/media-library.test.js` - "Windows reserved device names are made safe" |
| Related | WO-019, WO-012 (also needs Windows) |

## Feature
`sanitizeFilename` (`src/backend/mediaLibrary.js:36-50`) turns a dropped or uploaded file's name
into one that is safe to create in the library folder on every platform.

## Problem
It replaces `/ : * ? " < > |` and control characters, but leaves Windows' reserved device names
as they are: `CON.wav`, `nul.mp3`, `LPT1.flac` come out unchanged (the reproduction test shows
`CON.wav -> CON.wav`). On Windows, creating a file with such a name - with or without an
extension - fails or opens the device instead, so adding such a file would fail or lose the
audio. Names ending in a dot or space are a related Windows trap (Windows strips them) worth
checking at the same time.

Not yet verified on Windows (this Mac can only show the name passes through); recent Windows 11
builds relaxed some of these rules.

## Proposed solution
When the base name (before the first dot) is one of `CON PRN AUX NUL COM1-9 LPT1-9` (any case),
prefix it, e.g. `_CON.wav`; also strip trailing dots and spaces from the base. Apply on every
platform, so a library copied from a Mac to Windows works too.

Acceptance: the reproduction test passes; on Windows, uploading `CON.wav` works and plays.

## What has been done
- 2026-11-21: reproduction test written (marked `todo`); the pass-through confirmed on macOS.
  Needs a Windows machine to confirm the effect.

## Decision
Pending: pursue? (needs Windows). The owner said on 2026-11-21 that open decisions are taken later.
