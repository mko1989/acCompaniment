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
| [WO-013](WO-013-shutdown-waits-for-websocket-clients.md) | Shutdown stalls and ends in SIGKILL while a WebSocket client is connected | Low | Done | - |
| [WO-014](WO-014-tests-read-voices-before-mixer-reports.md) | Smoke tests read the mixer's voices before the worker has reported them (intermittent failure) | Low | Done | - |
| [WO-015](WO-015-moved-data-dir-cues-silent.md) | After the data dir moves, no cue plays (files looked up at their old absolute path) | High | Done | - |
| [WO-016](WO-016-audio-settings-not-validated.md) | Invalid audio settings are saved, and then no cue plays | Medium | Done | - |
| [WO-017](WO-017-engine-stays-dead-after-failed-reopen.md) | After a failed engine reopen, no cue plays until the app restarts | Medium | Done | - |
| [WO-018](WO-018-nan-sample-right-channel.md) | A NaN sample on a file's right channel reaches the output and spoils other cues | Low | Done | - |
| [WO-019](WO-019-long-filenames-lose-extension.md) | Files with names over 200 characters can't be added (the extension is cut off) | Low | Done | - |
| [WO-020](WO-020-windows-reserved-filenames.md) | Windows reserved names (CON, NUL, COM1, ...) are used as library file names | Low | Done | - |
| [WO-021](WO-021-companion-test-misses-early-reply.md) | The Companion "play_cue" test can miss its reply (intermittent failure) | Low | Done | - |
| [WO-022](WO-022-playlist-index-out-of-range.md) | A playlist whose current item was removed can't be triggered | Medium | Done | - |
| [WO-023](WO-023-relative-data-dir-replace-deletes-file.md) | With a relative data dir, "replace file" deletes the file it just replaced | Medium | Done | - |
| [WO-024](WO-024-rust-voices-stale-after-stream-stall.md) | Rust core: the playback status can miss the last command when the stream has stalled | Low | Done | - |
| [WO-025](WO-025-rust-stream-dies-on-device-rate-change.md) | Rust core: when another app changes the device's sample rate, playing cues go silent and never end | High | Done | - |
| [WO-026](WO-026-retrigger-test-counts-boundary-slot.md) | The "play_new_instance" loopback test counts a segment boundary as a third copy (intermittent failure) | Low | Done | - |
| [WO-027](WO-027-rust-first-press-slower.md) | Rust core: a press just after the stream opens sounds ~15-20 ms later than on Node | Low | Won't fix | - (only in the first second after the stream opens) |
| [WO-028](WO-028-rust-overload-treated-as-dead-stream.md) | Rust core: an audio overload (xrun) or a default-device change is treated as a dead stream | Medium | Done | - |
| [WO-029](WO-029-rust-dropouts-not-reported.md) | Rust core: audio dropouts are not logged | Low | Done | - |
| [WO-030](WO-030-playlist-highlight-returns-after-stop.md) | A playlist item can stay highlighted in the properties sidebar after the playlist stops | Low | Done | - |
| [WO-031](WO-031-loopback-recorder-late-input-unnoticed.md) | Loopback suites: when the recorder itself loses input, the test fails instead of retrying | Medium | Done | - |
