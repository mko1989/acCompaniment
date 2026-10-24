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
