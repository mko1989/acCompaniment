# Handoff

Where the port stands (2026-11-21). Load the `rust-anything` skill, then read [MAP.md](MAP.md).

## State

- Wave A done (2026-11-21): eight pure-logic units, every gate passing.
- Wave B (ADR-015): B1 data layer and B3 cue engine done (2026-11-22) in `rust/app/src/core/`,
  proved by the differential check `node rust/scripts/diff-data.js` (Node vs. Rust on the same op
  scripts in `rust/scripts/data-ops/`; results, engine calls, broadcasts, state and the data dir
  compared after every op: 548/548). B2 done: the Rust core serves everything with
  `ACCOMPANIMENT_CORE=rust` (replay 146/167, fallback 0%; every failure needs B4); without the
  switch the front door proxies to Node (167/167). Next: B4 audio (MAP.md).
- Smoke suite against the core:
  `ACCOMPANIMENT_SERVER_BIN=rust/app/target/release/accompaniment ACCOMPANIMENT_SERVER_ENV=ACCOMPANIMENT_CORE=rust node --test test/*.test.js`
- `app replay --case` replays one request on a fresh seed, without the requests before it: on this
  stateful recording it fails on the data dump. Use full replays.
- The differential once gave 546/548 straight after a release build (op names not captured); six
  later runs were 548/548. If it recurs, capture the failing ops.
- The owner delegated open decisions (ADR-016); WO-013 to WO-023 are fixed in Node and the port.
- Re-check any Wave A crate: `rust-anything gate $PWD/rust/<crate>` (absolute path: relative
  ones break `build`).
- Front door: `rust/app` (binary `accompaniment`), an axum server that starts `node server.js` on
  a free internal port and proxies everything to it (hyper: paths unchanged, bodies streamed,
  WebSocket upgrades piped). Same `PORT`/`HOST` defaults as server.js. Shutdown sends the original
  SIGTERM. A port conflict exits 1 with server.js's message.
- The test harness runs the existing node:test suites against any server binary:
  `ACCOMPANIMENT_SERVER_BIN=rust/app/target/release/accompaniment node --test test/*.test.js`.

## Recording

Rebuild the seed and inputs only if the app changed (`node rust/scripts/make-seed.js`,
`node rust/scripts/make-inputs.js`), then record and check the original passes:

```sh
rm -rf rust/app-cases
rust-anything app record . --http --no-traps --normalize key-order --normalize timestamps --normalize uuids \
  --normalize 'filestamp=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z' \
  --normalize 'workdir=rust-anything-app-server[-0-9]*' \
  --normalize 'ports="(httpPort|websocketPort)":[0-9]+|(127\.0\.0\.1|localhost|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):[0-9]+' \
  --normalize 'timing="(startTime|currentTime|positionSec)":(0\.[0-9eE+-]+|[1-9][0-9.eE+-]*)' \
  --pace 500 --timeout 900 --inputs rust/app-fixtures/http-inputs.jsonl \
  --fresh rust/app-fixtures/data --fresh rust/app-fixtures/incoming \
  --db-dump "node $PWD/rust/scripts/dump-data.js rust/app-fixtures/data" \
  -- env ACCOMPANIMENT_DATA_DIR=rust/app-fixtures/data HOST=127.0.0.1 node server.js
rust-anything app replay .                                                   # 167/167
rust-anything app replay . --build rust/app/target/release/accompaniment     # 167/167
```

Note `rust/app-cases/rust-anything.json` is rewritten by `app record`: set its `"name"` back to
`accompaniment` afterwards.

`--db-dump` makes the data dir part of every case: after each request `rust/scripts/dump-data.js`
prints every file (JSON in full, audio as size + SHA-256; not the PCM cache or `temp/`), so the
Rust core must write the same files (ADR-006). Its order ignores random UUIDs.

What the recording taught (keep when re-recording):
- `--pace 500`: the app saves 300 ms after a change (debounced); with a shorter pace the data dump
  after a request may or may not include that save, depending on load (a replay under load failed
  on 101 dumps). 500 ms is past it; checked by replaying while a cargo build ran.
- `--normalize uuids`: ids the server generates are random; when the two recording runs' UUIDs
  happen to share characters, the wildcard keeps them literally and later replays fail. All UUIDs
  are wildcards now; the B1/B3 differential check (`diff-data.js`) still compares ids, mapped by
  first appearance.
- rust-anything drops a request identical to an earlier one: `make-inputs.js` tags every path
  with `?case=NNNN`.
- With `key-order`, a body is compared re-formatted only when it is valid JSON. A `[..]` wildcard
  where a number was (a port, a count, a time) makes it invalid, and it is then compared as raw
  text, so the key order must match for that case. That is why ports and timing are normalized
  by name, the seed's audio is 10 s long (nothing ends on its own during the playback phase, so
  counts are stable), and the port is not fixed (the front door needs its own port).
- Cases still compared as raw text (key order matters for the port): those whose bodies carry
  `httpPort`/`websocketPort`, `startTime`, or a non-zero `currentTime`/`positionSec`: remote info,
  health and the playback status reads in phase 3.
- The seed stores metadata `path` relative (WO-015). The bad-sample-rate request is in phase 4,
  after playback (WO-016, WO-017).
- `/api/config/network`-style output and `/api/audio/output-devices` are machine-specific: replay
  on this Mac only, or drop those cases before CI replay.

## Next

1. B4: the cpal + symphonia `AudioEngine` (ADR-007, ADR-018, research/audio-engine.md), replacing
   `server/engine.rs`'s `NoOutputEngine`, using `rust/soundboard-mixer`'s port. Done when the core
   replays 167/167 and smoke, e2e, test:audio and test:audio:ui pass against it.

## Known limits of the front door

- If the front door itself is killed with SIGKILL, the Node child keeps running (no parent-death
  signal on macOS).
