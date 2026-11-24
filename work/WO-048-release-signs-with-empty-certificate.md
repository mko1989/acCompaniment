# WO-048: The macOS release build fails when no signing certificate is set

| | |
|---|---|
| Status | Done |
| Severity | High (no macOS installer, so no release) |
| Feature | Release workflow (`.github/workflows/release.yml`, the Bundle step) |
| Opened | 2026-11-24, by Claude (the v2.0.0-beta release run) |
| Reproduction test | - (the release workflow on a repo without the Apple secrets) |
| Related | - |

## Feature
The release workflow builds the installers; macOS is signed and notarized only when the
`APPLE_*` secrets are set, and unsigned otherwise.

## Problem
The repo has no Apple secrets, but the step passes `${{ secrets.APPLE_CERTIFICATE }}` etc. as
environment variables, which arrive as empty strings. Tauri treats a set `APPLE_CERTIFICATE` as
"sign", and failed: "failed to import the signing certificate as a PKCS#12 (.p12) file". The
other platforms built, but the release job needs every bundle, so no draft release was made.

## Proposed solution
The Bundle step unsets the empty `APPLE_*` variables before building. Acceptance: the release
workflow builds an unsigned macOS bundle without the secrets, and the draft release is made.

## What has been done
- 2026-11-24: the fix above. The release has to be built again from a tag on the fixed commit.

- 2026-11-24: the release run 45386324623 built an unsigned macOS bundle; every job passed. Done.

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
