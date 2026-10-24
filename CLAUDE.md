# acCompaniment - working notes for Claude

Node soundboard: Express + WebSocket server (`src/backend/`), browser UI
(`src/frontend/`), RtAudio engine on a worker thread
(`src/backend/audioEngineWorker.js`), Electron tray launcher
(`electron-launcher/`), Companion module (`companion-module-highpass-accompaniment/`).
See README.md for running and the test scripts.

## Bugs are resolved through work orders

Every bug - found by a test, a review, a user report or while working on
something else - gets a **work order** in `work/` before any fix is written.
The work order is the record of what was wrong, what was proposed, what was
actually done and who decided what. Don't fix a bug without one, and don't
fix one silently as part of unrelated work.

### Workflow

1. **Open.** Copy the template below to `work/WO-NNN-short-slug.md` (next free
   number, never reused) and add a row to the index in `work/README.md`.
   Status `Open`.
2. **Reproduce.** Write a test that fails because of the bug, and mark it as
   a known failure that names the work order, so the suite stays green but
   the bug stays visible:
   - node:test: `test(name, { todo: 'WO-NNN: what is wrong' }, fn)`
   - Playwright: `test.fail(true, 'WO-NNN: what is wrong')`
   Audible behavior goes in the loopback suites (`test/audio/`,
   `test/audio-ui/`); the rest next to the existing tests for that area.
   Record the test in the work order.
3. **Investigate and propose.** Find the root cause (file:line, re-verified
   - line numbers drift), write the proposed solution and its acceptance
   criteria. Where there's a real choice (behavior users rely on, a design
   trade-off), list the options with a recommendation.
4. **Decide.** The owner decides; Claude does not. Set status `Awaiting
   decision` and ask. Record the decision in the work order with the date
   and who made it, in their words where possible. A decision is never
   rewritten - if it changes, add a new dated entry under it.
5. **Implement.** Status `In progress`. Fix it as decided. Remove the
   `todo` / `test.fail` marker from the reproduction test so it now has to
   pass, and add any further tests the fix needs.
6. **Verify and close.** Run the suites that cover the area (`npm test`;
   `npm run test:audio` and `npm run test:audio:ui` for anything audible).
   Fill in *What has been done* - files changed, tests added, results - set
   status `Done` and update the index. A work order that is decided against
   is closed `Won't fix`, with the reason in the decision, and its
   reproduction test is either kept as a documented `todo` or changed to
   assert the accepted behavior.

Work orders are never deleted. One bug per work order; if a fix uncovers
another bug, open another work order and link them.

### Statuses

`Open` → `Awaiting decision` → `In progress` → `Done`, or `Won't fix`.

### Template

```markdown
# WO-NNN: <one-line title>

| | |
|---|---|
| Status | Open |
| Severity | Critical / High / Medium / Low |
| Feature | <the feature or area affected> |
| Opened | YYYY-MM-DD, by <who> (<how it was found>) |
| Reproduction test | `<file>` - "<test name>" |
| Related | WO-NNN, ... |

## Feature
What the feature is supposed to do, briefly, for someone who doesn't know it.

## Problem
What goes wrong, how to reproduce it, what the user hears or sees, and the
root cause with file:line references.

## Proposed solution
The fix, files to change, and acceptance criteria. Options with a
recommendation where there's a choice to make.

## What has been done
Dated entries: investigation, tests written, code changed, test results.

## Decision
Dated entries: what was decided, by whom. "Pending" until the owner decides.
```

## Tests

- `npm run test:unit`, `npm run test:smoke`, `npm run test:e2e` - see README.md.
- `npm run test:audio` / `npm run test:audio:ui` - loopback audio suites: need a
  loopback device (BlackHole on this machine, picked automatically). Every
  take is saved to `test-recordings/audio*/` as a WAV + Audacity labels. They
  retry a test only when its recording has a dropout in it; virtual devices
  (and this Mac generally - see WO-009) drop the odd buffer on their own.
- The server tests play to the default output at low volume; don't run them
  at the same time as the audio suites (CPU contention causes dropouts).
- The dropout tests (in `test/audio/calibration.test.js`) measure the
  machine as much as the app: run them with other heavy apps closed. Under
  load even a bare RtAudio player drops out (WO-009).
