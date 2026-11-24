# WO-044: `npm ci` fails on Linux without the PulseAudio headers

| | |
|---|---|
| Status | Open |
| Severity | Low (tooling) |
| Feature | Test tooling install (`package.json` devDependencies, `@hamitzor/rtaudio.js`) |
| Opened | 2026-11-24, by Claude (the owner ran `npm ci` on an Ubuntu box with Node 24) |
| Reproduction test | - (`npm ci` on Linux without `libpulse-dev`) |
| Related | - |

## Feature
`npm ci` installs the test tooling. `@hamitzor/rtaudio.js` is only the loopback recorder of the
audio suites (`test/audio/`, `test/audio-ui/`).

## Problem
With no prebuilt binary for the Node version, the package compiles RtAudio, which needs
`libpulse-dev` (and cmake). Without it the whole `npm ci` fails, so even the plain smoke tests
can't run.

## Proposed solution
Options:
- A: move it to `optionalDependencies`, so a failed build doesn't stop the install; the audio
  suites say what to install when it's missing. Recommended.
- B: only document `libpulse-dev cmake` in the README's Linux prerequisites.

## What has been done
- 2026-11-24: opened.

## Decision
Pending.
