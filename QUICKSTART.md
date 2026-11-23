# Quick Start - acCompaniment

## Prerequisites
- Rust (stable, via https://rustup.rs)
- ffmpeg for AAC/M4A files: `npm run fetch:ffmpeg` (into `vendor/ffmpeg/`), one on the `PATH`,
  or `FFMPEG_PATH`

## Build and run
```bash
cargo build --release --manifest-path rust/app/Cargo.toml
rust/app/target/release/accompaniment
```
(or `npm start`, which does both)

The server prints its address; open http://localhost:3333 in a browser. Other machines on the
network can use the machine's address (the config sidebar shows it).

## Settings (environment)
- `PORT` - HTTP and WebSocket port (default: the app config's, else 3333)
- `HOST` - interface to listen on (default: all)
- `ACCOMPANIMENT_DATA_DIR` - where cues, audio files, projects and config live
  (default `~/.accompaniment`)
- `ACCOMPANIMENT_FRONTEND_DIR` - the browser UI's files (default the repo's `src/frontend`)
- `FFMPEG_PATH` - ffmpeg to use

```bash
PORT=8080 rust/app/target/release/accompaniment
```

## Troubleshooting
- **Port already in use**: the server exits with "port ... is already in use"; stop the other
  instance or set `PORT`.
- **No sound**: pick the output device in the config sidebar; check the server's log for the
  "cpal stream open" line and for engine errors.
- **A file won't play**: AAC/M4A, files with more than 2 channels and a few others need ffmpeg.

Stop the server with Ctrl+C.
