# companion-module-highpass-accompaniment

A [Bitfocus Companion](https://bitfocus.io/companion) module for the [acCompaniment](https://github.com/mko1989/acCompaniment) soundboard. See [companion/HELP.md](companion/HELP.md) for what it does.

## How it talks to acCompaniment

A WebSocket to the acCompaniment server, on the same port as its web interface (3333 by default), using the server's own protocol - the same one the web UI uses. WebSocket rather than HTTP because the server pushes cue state, times and fades as they happen; polling HTTP couldn't drive feedbacks and timers.

Commands (`{ type, payload }`):

| type                 | payload                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `toggle_cue`         | `{ cueId, fromCompanion: true }`                                            |
| `play_cue`           | `{ cueId }`                                                                 |
| `stop_cue`           | `{ cueId, fadeOut }`                                                        |
| `stop_all_cues`      | `{ behavior? }` - `stop` / `fade_out_and_stop`; omitted = the app's setting |
| `toggle_pause_cue`   | `{ cueId }`                                                                 |
| `playlist_navigate`  | `{ cueId, direction: 'next' \| 'previous' }`                                |
| `playlist_jump`      | `{ cueId, index }` (0-based)                                                |
| `set_crossfade_mode` | `{ enabled }`                                                               |
| `set_master_volume`  | `{ volume }` (0-2)                                                          |

Events read: `cues-updated`, `cue_status`, `playback-time-update`, `workspace-updated`, `crossfade-mode-updated`, `master-volume-updated`. The server sends the cue list, project, crossfade mode, master volume and every active cue's state on connect.

This contract is tested on the server side too (`test/companion-protocol.test.js` in acCompaniment): change both together.

## Code

- `client.js` - the connection and the state it keeps (no Companion dependency)
- `instance.js` - wires the client to Companion: variables, feedback checks, definitions
- `actions.js`, `feedbacks.js`, `variables.js`, `presets.js`, `config.js`, `upgrades.js`
- `main.js` - the Companion entry point

## Development

```sh
yarn install
yarn test     # unit tests, plus tests against a real acCompaniment server when run inside the acCompaniment repo
yarn lint
yarn build    # makes the .tgz to import into Companion
```
