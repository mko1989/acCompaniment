# WO-011: Windows and Linux installers built on a Mac contain the macOS audio engine binary

| | |
|---|---|
| Status | Done |
| Severity | Critical (for Windows/Linux users) |
| Feature | Packaging - `npm run dist` |
| Opened | 2026-10-24, by Claude (checking the 2.0.5-beta installers before release) |
| Reproduction test | `scripts/check-native-binaries.js` (electron-builder `afterPack` hook - refuses a package with another platform's binaries; `--load` loads the packaged audio engine) |
| Related | WO-012 |

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
- 2026-10-24: Implemented option A.
  - `.github/workflows/release.yml`: builds macOS (universal, macos-latest),
    Windows (x64, windows-latest) and Linux (x64 on ubuntu-22.04, arm64 on
    ubuntu-22.04-arm) each on its own runner; checks each packaged app
    loads its own audio engine; on a pushed `v*` tag attaches the installers
    to that tag's release (a tag with a `-` makes a pre-release). Pushes to
    `node` build without releasing.
  - `scripts/check-native-binaries.js`: electron-builder `afterPack` hook
    (package.json `build.afterPack`) reading the RtAudio addon's and
    ffmpeg's headers (Mach-O / PE / ELF + CPU) and failing the package on a
    mismatch, or if the platform's addon file is missing; CLI `--load`
    loads the addon with the packaged runtime with node_modules' build
    moved aside. Verified: refuses Windows/Linux packages built on the Mac
    (listing each wrong binary), passes the Mac package.
  - `scripts/build-rtaudio.js` (was `build-rtaudio-universal.js`): Linux
    now built with an `$ORIGIN` rpath so the packaged addon finds
    `librtaudio.so` next to itself (the Mac build already used
    `@loader_path`).
  - `package.json`: `dist*` scripts build for the current platform with
    `--publish never`; the .deb depends on `libpulse0` (the Linux engine
    links PulseAudio); the `prebuild` stub override now refers to a root
    devDependency (`$prebuild`) - the old relative `file:` path resolved
    inside @hamitzor/rtaudio.js, so `node_modules/prebuild` had always been
    a dangling link, which broke packaging on Windows.
  - CI runs: 1) config error (`deb` under `linux`) - fixed; 2) Windows
    failed on the dangling `prebuild` link - fixed; 3) Windows load check
    aborted inside RtAudio's device probe on a runner with no audio devices
    - the check now only loads the addon (opened WO-012 for the app side);
    4) all four platforms green, each loading its own packaged audio engine.
  - Published: the 2.0.5-beta pre-release now carries the macOS, Windows
    and both Linux installers from run 4 (commit `dc5a126`); the .debs were
    unpacked and their engine binaries checked (ELF x64 / ELF arm64,
    `libpulse0` in Depends).
  - README "Building for Distribution" describes the workflow and the check.

## Decision
- 2026-10-24, owner: "A" - GitHub Actions, building each platform on its
  own runner, plus the packaging check.
