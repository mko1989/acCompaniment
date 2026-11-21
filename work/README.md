# Work orders

Every bug is resolved through a work order - see "Bugs are resolved through
work orders" in [CLAUDE.md](../CLAUDE.md) for the workflow and template.

| WO | Title | Severity | Status | Decision needed |
|---|---|---|---|---|
| [WO-001](WO-001-config-save-resets-output-device.md) | Saving any setting in the config sidebar can move the show output to the system default device | Critical | Done | - |
| [WO-002](WO-002-rest-config-not-applied-to-engine.md) | Audio settings changed over REST are saved but not applied | Medium | Done | - |
| [WO-003](WO-003-playlist-items-use-cue-trim.md) | Playlist items all play with the cue's trim instead of their own | High | Done | - |
| [WO-004](WO-004-mono-files-3db-quiet.md) | Mono files play 3 dB quieter than the file | Medium | Done | - |
| [WO-005](WO-005-output-patch-drops-right-channel.md) | Patching both sides of a cue to one output drops the file's right channel | Medium | Done | - |
| [WO-006](WO-006-playlist-join-gap.md) | Up to 10.7 ms of silence between playlist items | Low | Done | - |
| [WO-007](WO-007-playlist-status-flicker.md) | A playing playlist briefly reads as "stopped" between items | Low | Done | - |
| [WO-008](WO-008-companion-play-cue-toggles.md) | Companion's "Play Cue" can pause, stop or restart a playing cue | Medium | Done | - |
| [WO-009](WO-009-audio-dropouts.md) | Audible dropouts during playback (investigation) | Medium | Won't fix | - (environmental; guard test kept) |
| [WO-010](WO-010-recordings-deleted-by-playwright.md) | Loopback suite recordings are deleted by the next Playwright run | Low | Done | - |
| [WO-011](WO-011-cross-built-installers-ship-mac-rtaudio.md) | Windows and Linux installers built on a Mac contain the macOS audio engine binary | Critical | Done | - |
| [WO-012](WO-012-windows-no-audio-devices-abort.md) | On Windows with no audio devices, probing devices aborts the process | High | Open | Pursue? (needs Windows) |
| [WO-013](WO-013-shutdown-waits-for-websocket-clients.md) | Shutdown stalls and ends in SIGKILL while a WebSocket client is connected | Low | Awaiting decision | Option 1 or 2 |
| [WO-014](WO-014-tests-read-voices-before-mixer-reports.md) | Smoke tests read the mixer's voices before the worker has reported them (intermittent failure) | Low | Awaiting decision | Option 1 or 2 |
| [WO-015](WO-015-moved-data-dir-cues-silent.md) | After the data dir moves, no cue plays (files looked up at their old absolute path) | High | Awaiting decision | Option 1 or 2 |
| [WO-016](WO-016-audio-settings-not-validated.md) | Invalid audio settings are saved, and then no cue plays | Medium | Awaiting decision | Option 1 or 2 |
| [WO-017](WO-017-engine-stays-dead-after-failed-reopen.md) | After a failed engine reopen, no cue plays until the app restarts | Medium | Awaiting decision | Also retry on trigger? (recommended: no) |
