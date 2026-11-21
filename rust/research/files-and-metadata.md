# Research: files, JSON, bundles and audio metadata

Scope: `fs-extra`, `yauzl`/`yazl`, `music-metadata`, `utils/atomicWrite.js`, `utils/idValidation.js`,
`utils/lruCache.js`, and the on-disk formats ADR-006 freezes. No Rust code here.

Line references are to commit `7f0e7a0` (HEAD of `rust-port`), read with `git show HEAD:<file>`.
The working tree is being changed for ADR-003 (Spotify removal); see "In-flight change" at the end.
Installed versions (from `node_modules/*/package.json`): fs-extra 11.4.1, yauzl 3.4.0, yazl 3.3.1,
music-metadata 11.16.1. Crate sources were read from the published `.crate` files listed in the
last section (fetched from static.crates.io, 2026-11-21).

## 1. On-disk formats (what Rust must read and write)

### 1.1 Data directory
- Root: `process.env.ACCOMPANIMENT_DATA_DIR || path.join(os.homedir(), '.accompaniment')`
  (`server.js:53`), created with `ensureDir` (`server.js:121`).
- `PathManager` (`src/backend/pathManager.js:5-12, 17-31`) creates, recursively, in order:
  `audio/`, `audio/imported/`, `audio/user/`, `cues/`, `cues/workspaces/`, `cues/backups/`,
  `cues/templates/`, `config/`, `temp/`, `temp/waveforms/`, `pcm-cache/`. Note the constructor
  calls the async `ensureDirectories()` without awaiting it (`pathManager.js:14`).
- Further paths: `audio/metadata/<uuid>.json` (`audioFileManager.js:37-39`),
  `audio/library.json` (`mediaLibrary.js:144`), `config/appConfig.json` (`appConfigManager.js:8`),
  `cues/workspaces/<uuid>.json` (`cueDataManager.js:310`), `cues/backups/` (`cueDataManager.js:539-563`),
  `cues/workspace_export_<id>_<ts>.json` (`routes/workspaces.js:198-202`), `temp/uploads/<uuid>.zip`
  and `temp/imports/<uuid>/` (`routes/projects.js:21,25,88`), `pcm-cache/` (internal, may change - ADR-006).
- Legacy Electron-era files can sit in the root (on this machine: `appConfig.json`, `cues.json`,
  `media/`, `logs/`). The backend never reads them; Rust must ignore them too.
- `audio/imported/` and `audio/user/` are recreated on every start even though the media library is
  flat (`mediaLibrary.js:1-10`); `migrateLibrary`'s `removeEmptyDirs` deletes them again when it runs.

### 1.2 How JSON is written: `writeJsonAtomic` (`src/backend/utils/atomicWrite.js:11-31`)
Every JSON file except the bundle's `project.json` goes through it.
- Body: `JSON.stringify(data, null, 2)` - 2-space indent, `": "` after keys, `[]`/`{}` for empty
  containers, **no trailing newline** (confirmed on real files: `appConfig.json` and workspace files
  end in `}` with no `0a`).
- Key order = JS object insertion order (integer-like keys first, ascending - ECMA-262
  OrdinaryOwnPropertyKeys). `undefined`-valued and function-valued properties are **omitted**;
  `undefined` inside arrays becomes `null`; `NaN`/`Infinity` become `null`; `Date` becomes its ISO string.
- Temp file: `${filePath}.tmp.${pid}.${Date.now()}.${counter}` in the same directory (line 20),
  opened with flags `'w'` (mode 0o666 & umask), `writeFile` UTF-8, `fd.sync()` (fsync), close,
  then `fsp.rename(tmp, filePath)` (line 30). The parent dir is `ensureDir`ed first (line 15).
  No directory fsync. The temp name doesn't end in `.json`, so directory scans (`endsWith('.json')`)
  never pick up a leftover temp file.
- `fsp.rename` is plain `fs/promises` - **not** graceful-fs, so there is no Windows retry loop.
  On Windows libuv implements rename as `MoveFileExW(from, to, MOVEFILE_REPLACE_EXISTING)`
  (libuv `src/win/fs.c`, `fs__rename`).
- Strings are written as UTF-8; a lone surrogate (possible after `slice(0,200)`, see 1.6) is written
  as U+FFFD (`EF BF BD`) by Node's encoder (verified: `Buffer.from('\ud83d')` -> `ef bf bd`).

Reading is always `fs.readFile(path,'utf-8')` + `JSON.parse` (no BOM strip; a BOM makes JSON.parse
throw), except `audio/library.json`, read with `fs.readJson`, which strips a leading BOM
(`node_modules/jsonfile/utils.js:8-11`).

### 1.3 `config/appConfig.json` (`src/backend/appConfigManager.js`)
- Defaults, in key order (lines 12-53): `audioOutputDeviceId:'default'`, `audioOutputChannelCount:2`,
  `audioSampleRate:48000`, `audioBufferSize:512`, `defaultFadeInTime:0`, `defaultFadeOutTime:0`,
  `defaultLoopSingleCue:false`, `defaultRetriggerBehavior:'restart'`, `defaultStopAllBehavior:'stop'`,
  `defaultStopAllFadeOutTime:1500`, `crossfadeTime:2000`, `duckingFadeTime:1000`, `theme:'system'`,
  `windowWidth:1200`, `windowHeight:800`, `windowX:null`, `windowY:null`, `websocketEnabled:true`,
  `websocketPort:8877`, `httpRemotePort:3333`, `audioDirectory:<abs audioDir>`,
  `cuesDirectory:<abs cuesDir>`, `autoLoadLastWorkspace:true`, `lastOpenedWorkspacePath:''`,
  `recentWorkspaces:[]`, `maxRecentWorkspaces:5`, `enableDebugLogging:false`,
  `maxAudioFileSize:104857600`, `supportedAudioFormats:['.mp3','.wav','.m4a','.aac','.ogg','.flac']`.
- Load (56-86): missing file -> defaults written immediately. Present -> `{...DEFAULT, ...parsed}`:
  **default keys keep the default order, unknown keys follow in file order and are preserved**;
  a non-array `recentWorkspaces` becomes `[]`. Parse error -> defaults in memory, file left untouched
  until the next save overwrites it.
- Update (123-165): body merged **unfiltered** (any key is persisted, e.g. `lastOpenedProjectId`,
  set from `server.js:179`, which is not a default and so lands at the end of the file).
  `audioOutputDeviceId` of `''`/`null` is dropped (WO-001). Validation (282-317) rejects but never
  coerces. Note JS comparisons (`config.crossfadeTime < 100`) on non-numbers: `undefined < 100` is
  false, `'50' < 100` is true - Rust must reproduce on `serde_json::Value`, not on typed fields.
- No migrations exist beyond the default merge.

### 1.4 Workspace / project files `cues/workspaces/<uuid>.json` (`src/backend/cueDataManager.js`)
- Shape at creation (296-308): `id, name, description, cues, layout{gridColumns:4, gridRows:4,
  cuePositions:{}}, createdAt, updatedAt`. Save (338-350) rebuilds the same key order; extra
  top-level keys are dropped on save but **kept** by `updateWorkspaceById` (409-414: spread of the
  read file, then `...updates`, `id`, `updatedAt`) and by `importWorkspace` (adds `importedAt`, 710-711).
- Timestamps: `new Date().toISOString()` -> `YYYY-MM-DDTHH:mm:ss.sssZ` (always ms, always `Z`).
- Every write of an existing file first copies it to `cues/backups/<ts>_<uuid>.json` where `<ts>` is
  the ISO string with `[:.]` -> `-` (539-551), then prunes to the newest 20 per file by **lexicographic**
  sort of names (555-563). Corrupt workspace files found while listing are copied to
  `backups/corrupted_<Date.now()>_<file>` (486-489). Empty/whitespace/no-`id` files are deleted by
  `cleanupOrphanWorkspaceFiles` (244-291).
- Listing (452-505): `readdir`, `.json` only, adds `cueCount` (drops `cues`), `filePath`, `fileSize`,
  `lastModified` (mtime), stable-sorted newest mtime first.
- Saves are serialized through a promise queue (97-101, 360-366).

### 1.5 Cue JSON
`validateCue` (566-604) runs on every read; `createCue` (104-143) on new cues. Both build an object
with defaults **then spread the input over it**, so:
- Key order: `id, name, type, status, currentTime, totalTime, volume, fadeInTime, fadeOutTime, loop,
  retriggerBehavior, trimStartTime, trimEndTime, isDuckingTrigger, enableDucking, duckingLevel,
  outputPatch, createdAt, updatedAt`, then any other input keys in input order.
- A default only applies when the key is **absent** (JSON has no `undefined`). A present key keeps
  its value verbatim, even `null` or a wrong type (`volume:"x"` survives; the `typeof` checks are dead
  for present keys). `outputPatch` is normalized (`utils/outputPatch.js:12-19`) only when absent -> `[0,1]`.
- After the spread, for `type==='single_file'`: `filePath = v||''`, `relativePath = v||''`,
  `knownDuration` number-or-0; for `playlist`: `playlistItems` array-or-`[]`, `currentPlaylistIndex`
  number-or-0, `shufflePlaylist`/`repeatOnePlaylistItem` `Boolean(v)`, `playlistPlayMode = v||'continue'`.
  These are assignments, so absent keys are appended at the end.
- Legacy aliases `shuffle`->`shufflePlaylist`, `repeatOne`->`repeatOnePlaylistItem` (14-17, 61-75):
  canonical set to `Boolean(alias)` only if absent, alias key deleted. The copy (`{...data}`) keeps
  key order; the canonical key, if added, goes last.
- JS truthiness is load-bearing: `trimEndTime: v || null` turns `0` into `null`; `||` treats `0`,
  `''`, `NaN`, `false`, `null` alike.
- Playlist item created when a cue becomes a playlist (27-39): `id, name, path, relativePath,
  audioFileId, volume:1, fadeInTime:0, fadeOutTime:0, trimStartTime, trimEndTime, knownDuration`.
- `rewriteCueReferences` (`mediaLibrary.js:86-105`) `Object.assign`s `{audioFileId, relativePath}`
  (existing keys keep position, new ones append) and **deletes `filePath`**.

### 1.6 Media library (`src/backend/mediaLibrary.js`, `audioFileManager.js`)
- Flat `audio/<filename>`; filename is identity. Supported extensions (lower-cased compare):
  `.mp3 .wav .m4a .aac .ogg .flac` (`mediaLibrary.js:19`).
- `sanitizeFilename` (36-50): `\` -> `/`, `path.basename`, strip U+0000-001F and U+007F, replace
  `/:*?"<>|` with `_`, JS `trim()`; a name that is only an extension (`.mp3`) -> `audio.mp3`; strip
  leading dots; empty or extension-only -> `audio<ext>`; then `slice(0,200)` in **UTF-16 code units**.
  Verified in Node: `'..mp3'` -> `'mp3'` (then rejected as unsupported), `'a'+'😀'*101+'.mp3'` ->
  200 units ending in a lone `\ud83d`.
- Collision naming: `withCopyNumber` `"Song.mp3"` -> `"Song (2).mp3"` (53-57); existence check is
  case-insensitive over `readdir` (`findExistingName`, 70-74); same name + same sha256 -> reuse
  (`audioFileManager.js:286-315`).
- `cleanLegacyName` strips `_\d{13}` before the extension (60-64).
- Metadata record `audio/metadata/<id>.json` on add (`audioFileManager.js:293-303`): `id, path`
  (absolute), `relativePath, filename, name, size, format, duration, bitrate, sampleRate, channels,
  codec, title, artist, album, hash` (sha256 hex), `importedAt, tags`. Fields whose probe value is
  `undefined` are **omitted** from the file. `codec` is **always omitted**: the code reads
  `metadata.format.codecName` (lines 154, 209), which music-metadata 11 never sets on `format`
  (`IFormat` has `codec`; `codecName` exists only on `ITrackInfo`, `music-metadata/lib/type.d.ts:400,443`).
  Discovered files get `discoveredAt` instead (468-478); replace adds `replacedAt`; metadata edits
  (only `name, tags, title, artist, album`) add `updatedAt`. Old records carry extra keys (e.g.
  `originalPath`) that must survive.
- `library.json` marker: `{version:2, migratedAt, files, unique, removed, referencesUpdated, backupDir}`
  (`mediaLibrary.js:286-296`), or `{version, migratedAt, files:0}` for an empty library (169).
- `migrateLibrary` (143-299): skip if `marker.version >= 2`. Walk `audio/` recursively, skipping the
  metadata dir; back up `metadata/` and `workspaces/` to `cues/backups/library-migration-<ts>/`;
  sha256 every file; group by hash, groups ordered by **oldest mtime first** (sort is stable, ties keep
  walk order); name = `cleanLegacyName(sanitizeFilename(name))`, `(n)` on case-insensitive clash;
  stage in `audio/.migrating/`, delete duplicates, move back; one record per group (base = first record
  with a `duration`), merged records deleted; rewrite every workspace's references; remove empty
  dirs (ignoring `.DS_Store`); empty `pcm-cache/`; write `migration-log.json` then the marker.
  Directory order matters here and in `getAudioFiles` (`pathManager.js:128-161`): Node's
  `fs.readdir` returns entries **sorted by `strcmp`** on Unix (libuv `src/unix/fs.c`,
  `uv__fs_scandir_sort`), NTFS order on Windows. `withFileTypes` Dirents don't follow symlinks, so
  symlinked files/dirs are skipped.

### 1.7 Project bundle (`src/backend/projectBundle.js`, `routes/projects.js`)
- Entries, in write order: `audio/<basename(record.relativePath)>` per distinct referenced file, in
  cue order (playlist items expanded; `spotify` cues skipped) (25-61), then `project.json` (76).
  No directory entries.
- `project.json` = `JSON.stringify(manifest, null, 2)`, no trailing newline:
  `{format:'accompaniment-project', version:1, exportedAt, missingAudio:[...], project:{name,
  description, layout, createdAt, cues}}` (63-75). `layout`/`createdAt` omitted if undefined.
- yazl defaults used: audio `compress:false` (method 0, stored); `project.json` deflate level 6
  (`yazl/index.js:196-203`). Every entry sets the UTF-8 flag (bit 11) and an Info-ZIP "UT"
  timestamp extra field; `addFile` entries take mtime and mode from `stat` and use a data descriptor
  (CRC unknown up front); `addBuffer` entries default to mode `0o100664`
  (`yazl/index.js:25-45, 432-437, 517-525, 595`). ZIP64 is used per entry when a size/offset exceeds
  `0xfffffffe`, and for the EOCD when entries >= 0xffff or the archive passes 4 GiB (`yazl/index.js:282-298, 491-498`).
- Reading (`readBundle`, 105-175): yauzl `lazyEntries`, `validateEntrySizes`. Limits: 5000 entries,
  20 GiB total uncompressed (counted **before** the directory-entry skip), `project.json` <= 50 MiB.
  Accepted: `project.json`; `audio/<name>` with no further `/`, `sanitizeFilename`d, must be a
  supported extension else the **whole import fails**; extracted to `<extractDir>/<index>-<safe>`;
  `name` reported is the unsanitized original. Everything else (e.g. `__MACOSX/`) ignored. Manifest
  must have `format`, `project`, `project.cues` array; `version > 1` rejected.
- yauzl itself (3.4.0, `index.js:358-363, 827-882`): file name from Info-ZIP Unicode Path field
  0x7075 if its CRC matches, else UTF-8 if bit 11, else **CP437**; `\` replaced by `/`
  (`strictFileNames:false`); then any name containing `..` as a component, starting with `/` or
  `X:` makes the **whole zip fail** (`"invalid relative path: ..."` / `"absolute path: ..."`). Only
  methods 0 and 8; encrypted entries fail; multi-disk fails; **CRC-32 is not verified**.
- Import (`cueManager.js:1478-1508`) adds each audio via `addFile`, maps cues by
  `basename(relativePath).toLowerCase()`.

### 1.8 `idValidation.js` and `lruCache.js`
- UUID: `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` (line 1):
  hyphenated only, versions 1-5, RFC variant, any case. 400 `{success:false, error:'Invalid <param>:
  must be a UUID'}` (14-23). New ids are `crypto.randomUUID()` (lower-case v4).
- `LruCache` (used by `audioPlaybackManager.js:65` for decoded buffers): `Map` insertion order,
  `get` re-inserts, `set` replaces and re-inserts, evicts oldest while `size > maxEntries` or
  `totalBytes > maxBytes` (0 disables a limit) - an entry larger than `maxBytes` evicts everything
  **including itself** (52-63). Size estimate `length*channels*4` (66-71). Defaults 50 / 512 MiB.

### 1.9 fs-extra calls and their semantics
Calls used (counted over `src/backend` + `server.js`): `remove`18, `ensureDir`18, `pathExists`14,
`readdir`12, `readFile`11, `stat`10, `copy`6, `move`4, `createReadStream`3, `readJson`2, `emptyDir`1.
- `ensureDir` = `mkdir -p`. `remove` = `rm -rf`, no error if missing. `pathExists` = access check.
- `move(src,dst)` (`fs-extra/lib/move/move.js:11-45`): errors `"dest already exists."` unless
  `overwrite:true`; tries `rename`, falls back to copy+remove on `EXDEV`. fs-extra patches `rename`
  through graceful-fs, which on Windows **retries EACCES/EPERM/EBUSY for up to 60 s**
  (`graceful-fs/polyfills.js:97-110`).
- `copy`: recursive, overwrite by default, timestamps **not** preserved, symlinks copied as links.
- `emptyDir`: delete contents, create if missing.

## 2. Rust replacements

### 2.1 Atomic JSON writes
- `std::fs::rename` replaces the target; on Windows it is `MoveFileExW` with a fallback to
  `SetFileInformationByHandle`, POSIX semantics on Win10 1607+ when the FS supports
  `FileRenameInfoEx`; fails across filesystems (doc.rust-lang.org/std/fs/fn.rename.html).
  That is at least as strong as libuv's `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`.
- `tempfile` 3.27: `NamedTempFile::new_in(dir)` then `persist(path)`. Unix: created with **mode
  0o600** unless permissions are given (`src/file/imp/unix.rs:23`) - Node creates 0o644 (0o666 &
  umask), so a temp-file approach changes file modes unless `Builder::permissions` is set. Windows
  persist = `MoveFileExW(.., MOVEFILE_REPLACE_EXISTING)` after clearing the temporary attribute
  (`src/file/imp/windows.rs:95-115`). `persist` does **not** fsync: call `as_file().sync_all()` first.
- `atomic-write-file` 0.3.1: creates with 0o666 (`src/imp/unix/mod.rs:74`), fsyncs and renames on
  commit (`src/lib.rs:616-617`); generic/Windows path is `fs::rename` (`src/imp/generic.rs:73-74`).
- Recommendation: hand-roll (10 lines, matches Node exactly): `create_dir_all(parent)`;
  `OpenOptions::new().write(true).create(true).truncate(true).open(tmp)` with the same
  `<file>.tmp.<pid>.<millis>.<counter>` name (std's default Unix mode is 0o666 & umask);
  `write_all`; `sync_all`; `rename`. Run on `spawn_blocking`. Serialize per-file writes as Node does
  (one queue per workspace manager).
- For `fs.move` use `rename` with an `EXDEV`/`ErrorKind::CrossesDevices` fallback to copy+remove;
  the `overwrite:false` check must be explicit. Optionally retry on Windows sharing violations to
  mirror graceful-fs (only `move`, not the atomic write).
- `remove` -> `remove_dir_all`/`remove_file` ignoring `NotFound`; `copy` (files only here) ->
  `std::fs::copy` (it copies permission bits; timestamps not preserved, like fs-extra).

### 2.2 JSON: serde_json matching `JSON.stringify(x, null, 2)`
- Keep documents as `serde_json::Value` with feature **`preserve_order`** (IndexMap) - every
  manager spreads/merges unknown keys, so typed structs would drop or reorder data. Typed views can
  sit on top for logic.
- `PrettyFormatter::with_indent(b"  ")` (the default, `serde_json-1.0.154/src/ser.rs:1954`) emits
  `[]`/`{}` for empty containers and `": "` like JS. Don't append `\n`.
- Strings: serde_json escapes `"` `\\` `\b \f \n \r \t` and other C0 as `\u00xx` lower-case hex
  (`ser.rs:1786-1793`), leaves `/`, DEL and non-ASCII raw - same as JSON.stringify.
- Numbers - the main byte trap. serde_json 1.0.154 formats f64 with `zmij`
  (`ser.rs:1716-1722`), which prints `1.0`, `0.0`, `-0.0`, `43210.0` (`zmij-1.0.23/tests/test.rs:54-60,106`).
  JS prints `1`, `0`, `0`, `43210`; large values as plain digits up to 1e21 (`9061488000000000`).
  Fix: a custom `Formatter` whose `write_f64` uses **`zmij_ecma`** 1.0.23 (fork of zmij that follows
  ECMA-262 Number::toString: `1.0`->`1`, `-0.0`->`0`, `9.061488e15`->`9061488000000000`;
  `zmij_ecma-1.0.23/tests/test_ecma.rs:52-58,103`) - or `ryu-js` 1.0.3 (same goal). Map non-finite
  to `null`. Integers parsed from files stay `u64/i64` and print without `.0` already.
- Parsing differences: serde_json rejects lone-surrogate escapes (`"\ud800"`) that JSON.parse
  accepts, and invalid UTF-8 (Node substitutes U+FFFD on `readFile(..,'utf-8')`). Read with
  `String::from_utf8_lossy` to match the latter; the former is rare enough to log as corrupt.
  Integers above 2^53 keep full precision in Rust (JS rounds) - harmless.
- Key order: JS hoists integer-like keys (`"0"`, `"12"`) to the front, ascending, on every object.
  Files written by Node already have that order and IndexMap keeps it, but keys **added** in Rust
  would be appended. Only `layout.cuePositions` is a plausible map with numeric keys; if Rust adds
  keys there, re-sort integer-like keys first. (ADR-005 tolerates key order in responses; on disk it
  is semantically the same, byte-different.)

### 2.3 Zip: the `zip` crate (9.x)
- Reading: `ZipArchive::new(File)` parses the central directory; ZIP64 read support is built in.
  Names: `name()` returns UTF-8 if the raw bytes are valid UTF-8 **regardless of bit 11**, else CP437
  (`zip-9.8.1/src/types.rs:143-151`) - yauzl uses CP437 whenever bit 11 is clear. A matching
  Unicode Path field (0x7075, CRC ok, valid UTF-8) replaces the name, as in yauzl
  (`src/extra_fields/extra_field.rs:313-324`). Backslashes are **not** converted.
  `enclosed_name()` (`src/path.rs:235-275`) allows `foo/../bar` and drops absolute prefixes rather
  than rejecting - **not** yauzl's rule. Port yauzl's `validateFileName` literally on `name()` after
  `\`->`/`: reject the whole bundle on `..` component, leading `/` or `X:`.
  `is_symlink()`/`unix_mode()` exist (`src/read/zipfile.rs:209-232`); the app's own rule (only
  `audio/<name>` regular files, sanitized) means symlink entries would be extracted as regular
  files containing the link target - same as yauzl; reject `is_symlink()` entries to be safe.
  The zip crate **verifies CRC-32** on read and has extra local-vs-central header consistency checks
  (`src/read/mod.rs:475-744`) - a bundle with a bad CRC or mismatched headers that Node accepts will
  be rejected. Acceptable (stricter); record it.
  Enable only `deflate` (yauzl supports only methods 0 and 8) - other methods then fail like yauzl.
- Writing: `ZipWriter::new_stream(W)` for a non-`Seek` sink (an HTTP body); run it on a blocking
  thread and forward chunks through a bounded channel (doc comment, `src/write.rs:2176-2183`).
  `SimpleFileOptions::default().compression_method(Stored)` for audio, `Deflated` level 6 for
  `project.json`. **`large_file(true)` must be set when an entry may be >= 4 GiB** - default is
  `false` and the write then errors (`src/write/options.rs:508-517`, threshold `u32::MAX`,
  `src/format/mod.rs:81`); yazl decides this automatically. Set it when `stat.len() >= 0xFFFF_FFFF`.
  The crate sets the UTF-8 flag only for non-ASCII names; yauzl and the zip crate read either way.
  Default mtime is "now" in UTC as DOS time (`src/datetime.rs:183-195`, `time` feature); yazl uses
  the file's mtime in local time plus a UT field. The app ignores entry times, so no impact.
  Default permission 0o644 (`src/write/options.rs:74`).

### 2.4 Audio metadata: music-metadata vs lofty vs symphonia
Fields read (`audioFileManager.js:196-213`): `format.duration`, `format.bitrate`, `format.sampleRate`,
`format.numberOfChannels`, `format.codecName` (always undefined, see 1.6), `common.title/artist/album`;
`parseFile(path, {duration:true})`; a file is rejected unless `duration > 0` (197-199). Durations are
stored as full-precision floats (e.g. `297.264`, `57.779661023617976` in real files).

How each library gets MP3 duration:
| case | music-metadata 11.16.1 (`lib/mpeg/MpegParser.js`) | symphonia 0.6.1 (`symphonia-bundle-mp3/src/demuxer.rs`) | lofty 0.25.5 (`src/mpeg/properties.rs`) |
|---|---|---|---|
| Xing/Info with frame count | `numFrames*spf/sr`, **delay/padding included** (565-571) | `numFrames*spf - LAME delay - padding` (438-448) | `round(spf*1000*frames/sr)` **ms** (151-166) |
| VBRI | - | `frames*spf` (450-457) | via VBR header |
| no header, first 3 frames same bitrate ("CBR") | `round(mpegSize/frame_size)*spf/sr`, mpegSize = file - first-frame offset - 128 if ID3v1 (306-327, 431-435) | average of first ~16 frames / 16 KiB extrapolated over the rest of the file (683-730) | last-frame search, `stream_len*8/bitrate` in ms (172-233) |
| no header, VBR | **counts every frame to EOF** (`duration:true`, 285-296, 445-449) | same estimate (wrong for VBR) | first-frame bitrate (comment: "TODO: Actually handle VBR") (221-228) |

Other formats in music-metadata: WAV `fact.dwSampleLength` or `dataChunkSize/blockAlign`, over
`sampleRate`, `undefined` for a `0xffffffff` size (`wav/WaveParser.js:112-129`, so such files are
rejected); FLAC `STREAMINFO totalSamples/sampleRate` (`flac/FlacParser.js:81`, 0 for unknown -> rejected);
MP4 track `mdhd duration / sampleRate` (assumes timescale == sample rate, `mp4/MP4Parser.js:283-337`);
Ogg Vorbis last-page granule / sample rate (`ogg/vorbis/VorbisStream.js:87-88`); ADTS AAC counts frames
with `duration:true` (`MpegParser.js:470-485`). Bitrate for VBR MP3 is `(mpegSize*8)/duration`,
a non-integer float (310-314).

Tags: music-metadata maps every native tag to `common` by priority `matroska, APEv2, vorbis,
ID3v2.4, ID3v2.3, ID3v2.2, exif(RIFF INFO), asf, iTunes, AIFF, ID3v1` (`common/MetadataCollector.js:10-30`);
singleton fields take the **last** value of the best priority (`prio1 <= prio0`, 286-296). Multiple
artists are joined `"A, B & C"` (`joinArtists`, 321-325). lofty exposes each tag separately
(`primary_tag`, `tags()`), returning the first artist only.

Recommendation: lofty is a tag reader with ms-rounded durations - don't use it for duration.
Use **symphonia** (already chosen in ADR-007) for codec params, and port music-metadata's duration
rules for MP3/ADTS (a frame-header scan: ~150 lines over the file bytes; symphonia's header parser
isn't public API) and the container-header rules for WAV/FLAC/MP4/Ogg (symphonia exposes
`n_frames`/`sample_rate` from the same headers; check `mdhd` timescale vs sample rate). Use **lofty**
(read-only, no `id3v2_compression_support` needed) for `title/artist/album`, choosing among
`tags()` in music-metadata's priority order and joining multiple artists the same way. Verify with
a corpus test: run music-metadata and the Rust probe over `test/` fixtures + the user library and
diff `duration` within 1e-9, `bitrate`, `sampleRate`, `channels`, tags.

### 2.5 Directory walking
Only two recursive walks (`pathManager.getAudioFiles`, `migrateLibrary.walk`). `walkdir` 2.5:
`follow_links(false)` by default matches Dirent semantics (symlinks skipped as neither file nor dir);
use `.sort_by_file_name()` to reproduce libuv's strcmp order on Unix (byte order of `OsStr` = strcmp).
Every flat `readdir` must also be sorted (`std::fs::read_dir` is unsorted). Plain `read_dir` + sort
is enough; walkdir is optional.

## 3. Semantic traps (Rust would write or report something different)

1. **Float formatting** `1.0`/`-0.0`/`1e16` -> use a zmij_ecma/ryu-js formatter (2.2). Any f64
   computed in Rust (volume `1.0`, durations, ms) is affected.
2. **Trailing newline / indent**: none / 2 spaces. `to_writer_pretty` matches; don't add `\n`.
3. **Omitted vs null**: JS drops `undefined` keys (record fields with no tag value, `codec` always,
   manifest `layout`/`createdAt`). Use `Option` + `skip_serializing_if = "Option::is_none"` or
   don't insert into the Value map. `null` must only appear where JS has `null`
   (`trimEndTime`, `windowX/Y`).
4. **`codec`**: Node never writes it. Rust must not either, or the record differs.
5. **Spread semantics** in `validateCue`/`createCue`/config load: defaults only for absent keys,
   present values kept verbatim, extra keys preserved in order, appended keys last (1.3, 1.5).
6. **JS truthiness** (`||`) and `Boolean()` on arbitrary JSON values - write helpers
   `js_truthy(&Value)` and use them everywhere the original uses `||`.
7. **`slice(0,200)` counts UTF-16 units** and can split a surrogate pair, producing U+FFFD on disk.
   Rust: truncate to 200 UTF-16 units via `encode_utf16`, and replace a trailing lone high surrogate
   with U+FFFD to be byte-identical. JS `trim()` strips Unicode `WhiteSpace` + `LineTerminator`
   incl. U+FEFF; Rust `str::trim` uses `White_Space` and **does not strip U+FEFF** - trim it explicitly.
8. **`path.extname`/`basename` semantics** differ from `Path::extension`: Node `'a.'` -> `'.'`,
   `'.mp3'` -> `''`, `'..mp3'` -> `'.mp3'` with base `'.'`, `'x..mp3'` -> `'.mp3'` (verified in
   Node). Port Node's algorithm on strings; don't use `Path::extension`/`file_stem`.
9. **Case-insensitive name lookup** uses JS `toLowerCase()` (full Unicode); use `str::to_lowercase`,
   not ASCII. macOS NFC/NFD normalization is not handled by Node either - don't add it.
10. **readdir order** (libuv strcmp sort) decides migration naming ties and listing order - sort.
11. **Zip names**: CP437 vs UTF-8 when bit 11 is clear and bytes are valid UTF-8; backslashes;
    whole-archive rejection rules; CRC verification (2.3). Port yauzl's decode+validate if exact
    parity matters; otherwise document "Rust decodes valid UTF-8 names without the flag" (an
    improvement for Linux Info-ZIP archives).
12. **ZIP64**: set `large_file` per entry by size, or >4 GiB bundles fail to export.
13. **Durations**: symphonia subtracts LAME delay+padding (~0.02-0.05 s shorter), estimates
    header-less files from 16 frames; lofty rounds to ms and mis-measures VBR - both differ from
    the stored `duration` values and from upload responses (ADR-005 "same JSON values"). Port the
    music-metadata rules (2.4).
14. **Temp file mode** 0o600 with `tempfile` vs 0o644 in Node (2.1).
15. **UUID validation**: `uuid::Uuid::parse_str` also accepts simple, braced and URN forms and any
    version - use the regex (or check length 36, hyphen positions, version 1-5, variant 8-b).
16. **Timestamps**: ISO with exactly 3 fractional digits and `Z`
    (e.g. `chrono` `to_rfc3339_opts(SecondsFormat::Millis, true)`); backup names replace `:` and `.`
    with `-`; prune by plain byte-wise sort.
17. **Windows rename retry**: `fs.move` retries locked files for 60 s via graceful-fs; the atomic
    JSON write does not. Mirror only for moves of audio files if needed.
18. **LRU**: byte-weighted with self-eviction - `lru`/`moka` don't match; hand-roll on `IndexMap`
    (`shift_remove` + `insert`, evict from index 0) in ~40 lines.

## In-flight change (working tree, not yet committed)
The uncommitted ADR-003 work in `cueDataManager.js` (`isHiddenCue`, `_takeHiddenCues`,
`withHiddenCues`) and `projectBundle.js`/`mediaLibrary.js`/`routes/projects.js` keeps `type:'spotify'`
cues out of memory and **writes them back after the other cues** in workspace files, exports and
bundles. Saving a project whose Spotify cues were interleaved therefore reorders its `cues` array.
Rust must copy that rule once it lands; line numbers above will drift with it.

## Recommended crates
| crate | version | features | use |
|---|---|---|---|
| serde_json | 1.0.154 | `preserve_order` | all JSON as `Value` |
| zmij_ecma | 1.0.23 | default | JS-exact f64 in a custom `Formatter` (alt: `ryu-js` 1.0.3) |
| indexmap | 2.14 | default | ordered maps, LRU |
| zip | 9.4.1 (or newer once >= 2 weeks old; 9.x ships near-daily) | `default-features = false`, `deflate` | bundle read/write |
| symphonia | 0.6.1 | per ADR-007 | codec params, container frame counts |
| lofty | 0.25.5 | default | title/artist/album only |
| sha2 + hex | 0.11 / 0.4 | default | sha256, lower-case hex via `hex::encode` |
| uuid | 1.x | `v4` | new ids only (not validation) |
| chrono or time | current | - | ISO-8601 ms timestamps |
| walkdir (optional) | 2.5.0 | - | the two recursive walks, `sort_by_file_name()` |
No `tempfile`/`atomic-write-file`: a hand-rolled write+fsync+rename matches Node byte for byte and mode for mode.
