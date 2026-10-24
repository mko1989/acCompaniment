# WO-011: Windows and Linux installers built on a Mac contain the macOS audio engine binary

| | |
|---|---|
| Status | In progress |
| Severity | Critical (for Windows/Linux users) |
| Feature | Packaging - `npm run dist` |
| Opened | 2026-10-24, by Claude (checking the 2.0.5-beta installers before release) |
| Reproduction test | - (`file dist/win-unpacked/resources/app.asar.unpacked/node_modules/@hamitzor/rtaudio.js/build/Release/*.node` after `npm run dist` on macOS) |
| Related | - |

## Feature
`npm run dist` builds installers for macOS (.dmg), Windows (.exe) and Linux
(.deb, amd64 and arm64). Each must contain native binaries for its own
platform: ffmpeg (fetched per platform by `scripts/fetch-ffmpeg.js`) and the
RtAudio addon (`@hamitzor/rtaudio.js`), which is the whole audio engine.

## Problem
Built on macOS, every installer gets the **macOS** RtAudio addon: the
`.node` file in the Windows and both Linux packages is a universal Mach-O
library, not a Windows DLL or Linux ELF. ffmpeg is right for each platform;
only RtAudio is wrong. On Windows or Linux the app would install and start,
and the audio engine would fail to load - no playback at all.

Cause: RtAudio is built from source with cmake-js (`postinstall` and
`scripts/build-rtaudio-universal.js` build it for this Mac), and
electron-builder can't rebuild a native addon for another OS - it packages
whatever binary is in `node_modules`. There are no prebuilt RtAudio binaries
for the other platforms to fall back on.

The 0.3.0 installers in `dist/` were built the same way; unverified, but
they very likely have the same problem.

## Proposed solution
Build each platform's installer on that platform:
- A. **GitHub Actions** (recommended): a release workflow with a matrix of
  `macos-latest`, `windows-latest`, `ubuntu-latest` (+ an arm64 Linux
  runner or QEMU for the arm64 .deb), each running `npm ci` and its own
  `npm run dist:<platform>`, uploading to the release for the tag. Repeatable
  and doesn't need other machines.
- B. Build by hand on a Windows PC and a Linux machine for each release.
- C. Ship macOS only until A or B exists.

Either way, add a packaging check that fails the build if a package's
RtAudio `.node` isn't for that package's platform (inspect the file header:
`MZ` for Windows, ELF for Linux, Mach-O for macOS), so a mismatched
installer can't be published again.

## What has been done
- 2026-10-24: Found while checking the 2.0.5-beta installers before
  attaching them to the release (`file` on each package's addon). The
  2.0.5-beta pre-release was published with the macOS .dmg only, and its
  notes say why Windows/Linux installers are missing. No packaging change
  yet.

## Decision
- 2026-10-24, owner: "A" - GitHub Actions, building each platform on its
  own runner, plus the packaging check.
