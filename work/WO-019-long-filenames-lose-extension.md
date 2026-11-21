# WO-019: Files with names over 200 characters can't be added (the extension is cut off)

| | |
|---|---|
| Status | Awaiting decision |
| Severity | Low |
| Feature | Media library: file names (`sanitizeFilename`) |
| Opened | 2026-11-21, by Claude (found by the Rust port's recording of `mediaLibrary.js`, `rust/media-library-names`) |
| Reproduction test | `test/unit/media-library.test.js` - "a long filename keeps its extension and whole characters when shortened" |
| Related | WO-020 |

## Feature
Every file added to the library gets a safe file name from `sanitizeFilename`
(`src/backend/mediaLibrary.js:36-50`): no path, no control or reserved characters, at most 200
characters.

## Problem
The limit is applied to the whole name, extension included: `clean.slice(0, 200)` (`:49`). A
name longer than 200 UTF-16 units loses its extension, and the cut can also fall inside an emoji,
leaving half a character. Effects, by caller:

- upload and import (`audioFileManager.js:268`): refused as `Unsupported file format: (none)` -
  reproduced on 2026-11-21 by uploading `"a" x 199 + "😀.wav"` to a running server;
- replacing a file's audio (`audioFileManager.js:337`): same name handling;
- the legacy library migration (`mediaLibrary.js:220-222`) and project bundle import
  (`projectBundle.js:144`): a long name would come out without its extension.

Long names are uncommon (200 characters), but titles with artist, album and track details can get
there, and the error message does not say what is wrong.

## Proposed solution
Shorten the name part only: keep the extension, cut the base so base + extension fit in 200
UTF-16 units, and never cut between the two halves of a surrogate pair (step back one unit if the
cut would leave a high surrogate at the end).

Options:
1. **Keep the limit at 200 UTF-16 units** (recommended): same limit, now applied to the base.
2. Count the limit in UTF-8 bytes (filesystems limit names to 255 bytes, not characters): safer
   for names in non-Latin scripts, changes which names get shortened.

Acceptance: the reproduction test passes; uploading the name above works and plays; `npm test`
passes; the Rust port (`rust/media-library-names`) is changed the same way.

## What has been done
- 2026-11-21: reproduced by test (marked `todo`) and by hand (upload refused); cause traced.
  The port agent's first reading - a half emoji reaching the disk - does not happen through upload,
  because the name is refused first.

## Decision
Pending. The owner said on 2026-11-21 that open decisions are taken later.
