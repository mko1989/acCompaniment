# WO-043: `npm run test:unit` fails on a fresh clone: the tray build needs the staged server

| | |
|---|---|
| Status | Open |
| Severity | Low (tooling) |
| Feature | Test scripts (`package.json` `test:rust`) |
| Opened | 2026-11-24, by Claude (the owner ran `npm run test:unit` on an Ubuntu box) |
| Reproduction test | - (`npm run test:unit` on a fresh clone) |
| Related | - |

## Feature
`npm run test:unit` runs the server's and the tray's Rust tests.

## Problem
The tray's `build.rs` (tauri-build) requires `rust/tray/binaries/accompaniment-server-<triple>`,
which only `node scripts/stage-sidecar.js` creates. CI runs it; `test:rust` doesn't, so a fresh
clone fails with "resource path `binaries/accompaniment-server-x86_64-unknown-linux-gnu`
doesn't exist".

## Proposed solution
`test:rust` runs `node scripts/stage-sidecar.js` before the tray's `cargo test`.

## What has been done
- 2026-11-24: opened.

## Decision
Pending.
