# WO-047: Autosave backups made in the same millisecond overwrite each other

| | |
|---|---|
| Status | Open |
| Severity | Low |
| Feature | Project backups (`rust/app/src/core/cues.rs`, `create_backup`) |
| Opened | 2026-11-24, by Claude (the smoke suite on the owner's Ubuntu box) |
| Reproduction test | `test/projects.test.js` - "autosave keeps only the newest 20 backups per project" (fails on a fast machine) |
| Related | - |

## Feature
Every save copies the project to `cues/backups/<ISO time>_<file>`, keeping the newest 20.

## Problem
The name has millisecond resolution. On the Ubuntu box 26 quick saves left 16 backups, not 20:
saves in the same millisecond overwrote each other. The Node app named them the same way. In use
this only drops near-identical copies, but the count and the test are off.

## Proposed solution
To be written: e.g. add a counter when the name is taken.

## What has been done
- 2026-11-24: opened.

## Decision
Pending.
