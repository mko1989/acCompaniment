#!/usr/bin/env node
// Copies the server binary (rust/app/target/release/accompaniment) to where the tray app's
// bundle expects its sidecar: rust/tray/binaries/accompaniment-server-<target triple>[.exe] (Tauri's
// `externalBin`, rust/tray/tauri.conf.json). Run after `npm run build`; `npm run build:tray`
// does both. TAURI_TARGET_TRIPLE overrides the triple (cross builds, universal macOS).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const triple = process.env.TAURI_TARGET_TRIPLE
    || /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
const from = process.env.ACCOMPANIMENT_SERVER_BIN
    || path.join(root, 'rust', 'app', 'target', 'release', `accompaniment${exe}`);
const to = path.join(root, 'rust', 'tray', 'binaries', `accompaniment-server-${triple}${exe}`);

if (!fs.existsSync(from)) {
    console.error(`${from} is missing: build it first (npm run build)`);
    process.exit(1);
}
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);
fs.chmodSync(to, 0o755);
console.log(`staged ${path.relative(root, to)}`);
