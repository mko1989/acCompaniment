# Port map: acCompaniment-NODEtoRUST

8 of 35 units have a Rust port; no original changed since it was recorded.

## Ports

| Unit | Crate | In Rust | Kept in the original | Cases | Last diff | Original |
| --- | --- | --- | --- | ---: | ---: | --- |
| `rust/shims/cue-aliases/` | `rust/cue-aliases` | `normalizeCueFieldAliases` | - | 85 | 85/85 | unchanged |
| `rust/shims/id-validation/` | `rust/id-validation` | `isValidUuid`, `validateUuidOrError` | - | 696 | 696/696 | unchanged |
| `rust/shims/lru-cache/` | `rust/lru-cache` | `runCache`, `estimateAudioBufferBytes` | - | 463 | 463/463 | unchanged |
| `rust/shims/media-library-names/` | `rust/media-library-names` | `sanitizeFilename`, `withCopyNumber`, `cleanLegacyName`, `isSupportedAudio` | - | 1306 | 1306/1306 | unchanged |
| `rust/shims/output-patch/` | `rust/output-patch` | `normalizeOutputPatch` | - | 955 | 955/955 | unchanged |
| `rust/shims/playlist-logic/` | `rust/playlist-logic` | `shuffledOrder`, `isValidOrder`, `effectiveOrder`, `decideItemEnd`, `stepIndex`, `peekNextIndex` | - | 7971 | 7971/7971 | unchanged |
| `rust/shims/retrigger-logic/` | `rust/retrigger-logic` | `normalizeRetriggerBehavior`, `resolveRetrigger` | - | 993 | 993/993 | unchanged |
| `rust/shims/soundboard-mixer/` | `rust/soundboard-mixer` | `runMixer` | - | 447 | 447/447 | unchanged |

## Not ported yet

In the order `analyze` suggests.

| Unit | Lines | Exports | Readiness |
| --- | ---: | ---: | ---: |
| `companion-module-highpass-accompaniment/variables.js` | 106 | 5 | 100 |
| `companion-module-highpass-accompaniment/upgrades.js` | 28 | 1 | 100 |
| `companion-module-highpass-accompaniment/instance.js` | 112 | 5 | 99 |
| `companion-module-highpass-accompaniment/client.js` | 348 | 3 | 87 |
| `companion-module-highpass-accompaniment/config.js` | 35 | 1 | 100 |
| `companion-module-highpass-accompaniment/feedbacks.js` | 124 | 1 | 95 |
| `companion-module-highpass-accompaniment/presets.js` | 151 | 1 | 95 |
| `companion-module-highpass-accompaniment/actions.js` | 168 | 1 | 94 |
| `src/backend/utils/` | 136 | 0 | 85 |
| `archive/legacy-electron-app/src/main/utils/` | 55 | 0 | 94 |
| `companion-module-highpass-accompaniment/main.js` | 29 | 0 | 99 |
| `start-nodejs.js` | 60 | 0 | 98 |
| `archive/legacy-electron-app/src/renderer/easter_egg_game/` | 505 | 0 | 87 |
| `src/frontend/audio/` | 257 | 0 | 87 |
| `src/backend/middleware/` | 2 | 0 | 100 |
| `scripts/` | 502 | 0 | 67 |
| `server.js` | 330 | 0 | 73 |
| `rust/scripts/` | 361 | 0 | 63 |
| `archive/legacy-electron-app/` | 504 | 0 | 68 |
| `electron-launcher/` | 799 | 0 | 59 |
| `src/frontend/` | 1416 | 26 | 41 |
| `src/backend/routes/` | 1495 | 0 | 27 |
| `src/backend/` | 6017 | 0 | 0 |
| `archive/legacy-electron-app/src/main/` | 2337 | 0 | 0 |
| `archive/legacy-electron-app/src/renderer/` | 5866 | 103 | 0 |
| `archive/legacy-electron-app/src/renderer/ui/` | 7031 | 156 | 0 |
| `src/frontend/ui/` | 4593 | 78 | 0 |

Regenerate with `rust-anything map --write`. Commit this file: when the original changes upstream, the next map marks every port whose recording it outdated.
