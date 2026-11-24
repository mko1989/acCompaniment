# WO-046: On Windows no cue plays: "Audio file not found"

| | |
|---|---|
| Status | Done |
| Severity | Critical (Windows: no cue plays) |
| Feature | Finding a cue's audio file (`rust/app/src/core/paths.rs`, `is_path_within`) |
| Opened | 2026-11-24, by Claude (the owner clicked cues on a Windows laptop; nothing played) |
| Reproduction test | `rust/app/src/core/paths.rs` - "a_windows_path_inside_the_folder_is_within_it" |
| Related | WO-038 (the same kind of `/` assumption) |

## Feature
A cue names its file relative to the audio folder; the server resolves it, checks it stays
inside the folder, and plays it.

## Problem
In show mode a click reached the server (`cue_toggled` came back) but nothing played and the
server logged nothing; triggering over REST answered `{"success":false,"error":"Audio file not
found"}`. The waveform editor still played, because the browser plays that itself.

Root cause: `PathManager::is_path_within` (`core/paths.rs`) checked
`p.starts_with(base + "/")`. Node's check used `path.sep`, which is `\` on Windows, so every
resolved file counted as outside the audio folder and `resolve_path` returned nothing. Every
caller of the check was affected (playing, durations, Replace, uploads' containment).

Also `server/ws.rs` `media_duration` tested `path.starts_with('/')` for "absolute" (now
`nodefs::is_absolute`).

## Proposed solution
Compare against the platform separator (`nodefs::SEP_STR`). Acceptance: the reproduction test
passes; on Windows cues play from show mode and over REST; macOS and Linux unchanged.

## What has been done
- 2026-11-24: the fix above; the reproduction test passes; on macOS all Rust tests and the smoke
  suite (286/286) pass. Not yet run on Windows.

- 2026-11-24: verified by the owner: cues play on the Windows laptop ("windows now works"). The smoke suite has not run on Windows yet (WO-044). Done.

## Decision
- 2026-11-24, Claude on the owner's delegation (ADR-016): fix as proposed.
