# Handoff

Where the port stands (2026-11-21). Load the `rust-anything` skill, then read [MAP.md](MAP.md).

## State

- Checkpoint 1 (ADR-010) reached: the HTTP API is recorded and the front door replays 167/167.
  Fallback rate 100% (no unit ported yet). No unit claimed. Waiting for the owner's go-ahead on
  the plan in MAP.md and the deferred decisions listed there.
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
rust-anything app record . --http --no-traps --normalize key-order --normalize timestamps \
  --normalize 'filestamp=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z' \
  --normalize 'workdir=rust-anything-app-server[-0-9]*' \
  --normalize 'ports="(httpPort|websocketPort)":[0-9]+|(127\.0\.0\.1|localhost|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):[0-9]+' \
  --normalize 'timing="(startTime":[0-9.eE+-]+|(currentTime|positionSec)":(0\.[0-9eE+-]+|[1-9][0-9.eE+-]*))' \
  --pace 100 --timeout 180 --inputs rust/app-fixtures/http-inputs.jsonl \
  --fresh rust/app-fixtures/data --fresh rust/app-fixtures/incoming \
  -- env ACCOMPANIMENT_DATA_DIR=rust/app-fixtures/data HOST=127.0.0.1 node server.js
rust-anything app replay .                                                   # 167/167
rust-anything app replay . --build rust/app/target/release/accompaniment     # 167/167
```

Note `rust/app-cases/rust-anything.json` is rewritten by `app record`: set its `"name"` back to
`accompaniment` afterwards.

What the recording taught (keep when re-recording):
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

1. Owner: approve the plan in MAP.md (Wave A pure units, then the core as one piece) and take the
   deferred decisions there when ready.
2. Then Wave A, one unit at a time (SKILL.md steps 1-5), claiming each in MAP.md.

## Known limits of the front door

- If the front door itself is killed with SIGKILL, the Node child keeps running (no parent-death
  signal on macOS).
