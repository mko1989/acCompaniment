# Handoff

Where the port stands (2026-11-23). Load the `rust-anything` skill, then read [MAP.md](MAP.md).

## State

- Waves A and B done; lifted by hand (ADR-020): `rust/app` (binary `accompaniment`) is the whole
  server. No Node app, front door, switch or kill switch in this project any more; the owner keeps
  the Node original in another folder. Wave A's ports are modules of `rust/app/src/core/`.
- Proof, all against the Rust binary (2026-11-23, after the lift - see the commit message):
  replay of the 167 recorded HTTP cases, `cargo test` (incl. 12,916 recorded unit cases), smoke,
  e2e, test:audio, test:audio:ui. Bugs from now on: work orders (CLAUDE.md), fixed in Rust only.
- `cargo` lives in `~/.cargo/bin`: put it on PATH first, or a build silently doesn't happen.
- Every JS suite runs against `rust/app/target/release/accompaniment` (`npm run build` first);
  `ACCOMPANIMENT_SERVER_BIN` / `ACCOMPANIMENT_SERVER_ENV` point them at another binary
  (`test/helpers/serverCommand.js`). In zsh pass them literally, not through a variable.
- Watch: one test:audio:ui run (on the Node app, before the lift) failed "XFADE button: the next
  cue clicked crossfades..." three times in a row (outgoing fade 0.24-0.66 s against 0.8 s), then
  passed alone 3/3 and in two full runs; no hole or late input annotated. If it recurs on the
  Rust app, keep the takes and open a work order.
- `app replay --case` replays one request on a fresh seed, without the requests before it: on this
  stateful recording it fails on the data dump. Use full replays.

## The recorded HTTP cases

```sh
cargo build --release --manifest-path rust/app/Cargo.toml
rust-anything app replay . --build rust/app/target/release/accompaniment     # 167/167
```

They were recorded from the Node original (2026-11-21/22) and can't be re-recorded from this
project; they are the specification now (ADR-020), changed only as ADR-005 allows. The seed data
dir is `rust/app-fixtures/` (built by `rust/scripts/make-seed.js`, inputs by `make-inputs.js`);
`rust/app-cases/rust-anything.json` runs the Rust binary.

`--db-dump` made the data dir part of every case: after each request `rust/scripts/dump-data.js`
prints every file (JSON in full, audio as size + SHA-256; not the PCM cache or `temp/`), so the
app must write the same files (ADR-006). Its order ignores random UUIDs.

What the recording taught (keep in mind when reading a replay failure):
- `--pace 500`: the app saves 300 ms after a change (debounced); the dump after a request is
  taken past that.
- All UUIDs are wildcards (`--normalize uuids`); requests are tagged `?case=NNNN` because
  rust-anything drops a request identical to an earlier one.
- With `key-order`, a body is compared re-formatted only when it is valid JSON. A `[..]` wildcard
  where a number was makes it invalid, and it is then compared as raw text, so key order matters
  for those cases: bodies with `httpPort`/`websocketPort`, `startTime`, or a non-zero
  `currentTime`/`positionSec` (remote info, health, the playback status reads in phase 3).
- `/api/config/network`-style output and `/api/audio/output-devices` are machine-specific:
  replay on this Mac only, or drop those cases before a CI replay.

## Next

1. Wave C (ADR-008): the Tauri tray app and installers per platform; the checklist is in MAP.md
   ("Wave C"), including the first Windows and Linux runs and the open gaps "From B1/B2/B4".
2. Offer the owner a reshape pass (rust-anything whole-app.md §7): code that mirrors the Node
   structure (`core/nodefs.rs`, `jsv`, the manager-per-module layout) can become idiomatic Rust,
   one change at a time with every suite passing after each.
