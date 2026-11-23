# WO-032: The launcher's "Interface" setting (localhost / 0.0.0.0) is saved but never applied

| | |
|---|---|
| Status | Done |
| Severity | Low |
| Feature | Tray app configuration window (`rust/tray/ui/config.html`, ported from the Electron launcher's `electron-launcher/config.html`) |
| Opened | 2026-11-23, by Claude (found while porting the launcher to Tauri, Wave C / ADR-022) |
| Reproduction test | `test/tray/config-window.spec.js` - "has no Interface setting: the server always listens on every interface" |
| Related | ADR-022 |

## Feature
The launcher's configuration window lets the user change the server's port. It also showed an
"Interface" select: "localhost (Local only)" or "0.0.0.0 (Network accessible)", which suggests
the user can keep the server off the network.

## Problem
The choice is written to `appConfig.json` as `httpRemoteHost` and then nothing reads it:
- The Electron launcher started the server with `PORT` only and deliberately no `HOST`
  (`electron-launcher/main.js:351` at 7b2756c: "the server should keep binding to 0.0.0.0 for
  LAN access (Companion, remote control from other devices)").
- The server binds `HOST` or every interface (`server.js:38` at 7b2756c;
  `rust/app/src/server/mod.rs:226` now) and never looks at `httpRemoteHost`.

So "localhost (Local only)" leaves the server reachable from the whole network, which is the
opposite of what the label says. The select also defaults to "localhost" when the setting is
absent, so most users have `httpRemoteHost: "localhost"` saved without having chosen it.
The only visible effect: the select changes the URL the window shows.

## Proposed solution
Options:
1. **Remove the Interface select (recommended).** The server keeps listening on every interface,
   which LAN remotes and Companion need, and the window stops promising a setting it doesn't
   have. `config.html`: drop `#serverHost` and its code; the tray never writes `httpRemoteHost`
   (an existing value stays in the file, unused, as before).
2. Make it work: the tray passes `HOST=127.0.0.1` when `httpRemoteHost` is "localhost". Every
   user who has the default "localhost" saved would lose LAN and Companion access on update -
   a regression for the main use (show control from another machine).
3. Make it work with a new key and default to the network, so nobody is cut off. More UI and
   code for a setting nobody has asked for.

Acceptance: the reproduction test passes (no `#serverHost` in the window); Change Port writes
only `httpRemotePort`; the server keeps answering on the LAN address.

## What has been done
- 2026-11-23: found while porting the window; reproduction test written (`test.fail`).
- 2026-11-23: fixed as decided (option 1). `rust/tray/ui/config.html`: the Interface select and
  its code are gone; the URL shown is always `http://localhost:<port>`; Change Port sends only
  `httpRemotePort`. The tray's `update_config` (`rust/tray/src/main.rs`) saves only that key and
  refuses a port outside 1-65535; the supervisor starts the server without `HOST`.
  `test.fail` removed from the reproduction test; "Change Port saves the new port" now checks
  that only `httpRemotePort` is sent. `npx playwright test --project=tray`: 5/5. The tray's
  supervisor tests (`cargo test` in `rust/tray`, 9/9) start the server through it and reach it
  on every interface (no `HOST`).

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016; the owner may overturn it): option 1,
  remove the select. Making it work would cut LAN remotes and Companion off for everyone with
  the default "localhost" saved, and nobody has asked to keep the server off the network.
