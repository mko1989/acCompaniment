# Legacy Electron app (pre-migration, archived)

This directory holds the original, monolithic Electron version of acCompaniment —
`main.js`, `src/main/`, and `src/renderer/` — from before the migration to the
Node.js server + browser frontend architecture (`server.js`, `src/backend/`,
`src/frontend/`, `electron-launcher/` at the repo root).

**It is not built, packaged, or maintained.** It's kept here purely for reference:
some features (per-cue OSC triggering, the modular waveform editor split across
several files) existed here first and haven't been ported forward yet. If you're
looking for those, this is where the original implementation lived.

`README-CONVERSION.md` and `README-NODEJS.md` here are the conversion-era docs
written while this migration was in progress; see the repo root `README.md` and
`QUICKSTART.md` for the current, maintained documentation.

It is **not runnable as-is** from this location: the code was written assuming it
lived at the repo root (relative `require()`s, `app.getAppPath()`-relative asset
paths) and `package.json`'s `"main"` now points at `electron-launcher/main.js`
instead. Treat this as read-only reference code, not a runnable target. If you
ever need to run it again, copy `main.js`, `preload.js`, `src/main/`, and
`src/renderer/` back to the repo root and point `package.json`'s `"main"` at
`main.js`.
