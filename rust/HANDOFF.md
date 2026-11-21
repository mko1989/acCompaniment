# Handoff

Where the port stands (2026-11-21). Load the `rust-anything` skill, then read [MAP.md](MAP.md).

## State

- Before checkpoint 1 (ADR-010): the app is not recorded yet and there is no front door. Fallback
  rate: not measured (no `rust/app` yet). No unit claimed.
- Spotify is removed from the Node app (commit `99dc820`, ADR-003; ADR-013 proposed).
- Research done: [research/](research/) (audio engine, HTTP/WebSocket, files and metadata).

## Paused: waiting for the owner

The owner deleted `node_modules/` and `dist/` on purpose and asked to wait before anything that
runs the Node app (recording, `npm test`, the front door, which starts the original behind it).
Do not run `npm ci` / `npm install` until the owner says so.

## Next, when the owner says go

1. `npm ci` (if the owner asks for it).
2. Record: the seed and inputs are ready (`rust/scripts/make-seed.js`, `make-inputs.js`, outputs in
   `rust/app-fixtures/`). Rebuild them only if the app changed, then:
   ```sh
   rust-anything app record . --http --no-traps --normalize key-order --pace 100 --timeout 180 \
     --inputs rust/app-fixtures/http-inputs.jsonl \
     --fresh rust/app-fixtures/data --fresh rust/app-fixtures/incoming \
     -- env ACCOMPANIMENT_DATA_DIR=rust/app-fixtures/data HOST=127.0.0.1 node server.js
   ```
   Check that the phase 3 (playback) cases answer `success: true` (the seed plays into BlackHole),
   then `rust-anything app replay .` must be 100%.
3. Run `node --test test/engine-recovery.test.js`: WO-017's reproduction has not run yet; it must
   report `todo` (failing), not `ok`.
4. `rust-anything app front-door .`, replay 100%: checkpoint 1. Stop and report: the plan in
   MAP.md, the open questions there (all decisions were deferred by the owner), WO-013..017.

## Recording notes

- rust-anything drops a request identical to an earlier one: `make-inputs.js` tags every path with
  `?case=NNNN`.
- The seed stores metadata `path` as the relative path because of WO-015.
- `/api/config/network` and `/api/audio/output-devices` are machine-specific: replay them on this
  Mac only (or drop those cases before CI replay).
