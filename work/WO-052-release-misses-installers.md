# WO-052: The draft release gets only the headless packages, not the installers

| | |
|---|---|
| Status | Done |
| Severity | High (a release without its installers) |
| Feature | Release workflow (`.github/workflows/release.yml`, the release job) |
| Opened | 2026-11-24, by Claude (the v2.0.0-beta release run 45386324623) |
| Reproduction test | - (the release workflow) |
| Related | WO-048 |

## Problem
The bundle artifacts keep Tauri's folders (`dmg/`, `nsis/`, `msi/`, `deb/`, `rpm/`,
`appimage/`); after `download-artifact` they are under `dist/<folder>/`. The release step
attached `dist/*`, which matches only the headless tarballs at the top level.

## Proposed solution
Attach `dist/**/*`.

## What has been done
- 2026-11-24: the glob fixed. For v2.0.0-beta the six installers were downloaded from the run's
  artifacts and attached to the draft by hand (`gh release upload`).

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
