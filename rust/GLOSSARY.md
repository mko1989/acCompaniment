# Glossary

The original's domain terms, their meaning, and their name in Rust. Add terms as units bring them.

| Term (original) | Meaning | Rust name |
| --- | --- | --- |
| cue | A button in the grid that plays audio: a single file or a playlist, with volume, fades, trim, retrigger behavior and output patch | `Cue` (`cue` module) |
| cue type `single_file` / `playlist` | What a cue plays | `CueKind` |
| retrigger behavior | What triggering an already playing cue does (restart, stop, pause, new instance, ...) - `retriggerLogic.js` | `RetriggerBehavior` |
| playlist item / order / shuffle | Files a playlist cue plays in turn; shuffled order kept per cue - `playlistLogic.js` | `PlaylistItem`, `playlist` module |
| trim (start / end) | Part of a file a cue plays | `Trim` |
| output patch | Which output channels a cue plays to - `utils/outputPatch.js` | `OutputPatch` |
| ducking | Lowering other cues while a ducking-trigger cue plays | `duck` module |
| crossfade | Fading the playing cue out while the next fades in | `Crossfade` |
| master volume | Global output gain | `master_volume` |
| workspace | A saved set of cues (legacy grouping, `routes/workspaces.js`) | `Workspace` |
| project | A named folder of cues and settings in the data dir; can be exported as a bundle | `Project` |
| project bundle | Zip export of a project with its audio - `projectBundle.js` | `bundle` module |
| media library / audio file | Imported audio files with ids and metadata - `mediaLibrary.js`, `audioFileManager.js` | `Library`, `AudioFile` |
| PCM cache | Decoded audio cached on disk (internal, may change format, ADR-006) | `pcm_cache` |
| app config | Global settings file (port, output device, sample rate, ...) - `appConfigManager.js` | `AppConfig` |
| data dir | `ACCOMPANIMENT_DATA_DIR`, default `~/.accompaniment` | `DataDir` |
| audio engine / mixer | Real-time playback and mixing - `audioEngineWorker.js`, `soundboardMixer.js` | `engine`, `Mixer` |
