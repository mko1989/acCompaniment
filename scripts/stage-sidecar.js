#!/usr/bin/env node
// Copies the server binary to where the tray app's bundle expects its sidecar:
// rust/tray/binaries/accompaniment-server-<target triple>[.exe] (Tauri's `externalBin`,
// rust/tray/tauri.conf.json). `npm run build:tray` / `bundle:tray` run it after building the server.
//
//   node scripts/stage-sidecar.js                 the host's build (rust/app/target/release)
//   node scripts/stage-sidecar.js <triple>        a cross build (rust/app/target/<triple>/release)
//   node scripts/stage-sidecar.js --universal     macOS: lipo the x86_64 and aarch64 builds into
//                                                 one binary, staged for both and for
//                                                 universal-apple-darwin (Tauri builds each half,
//                                                 then merges them)
//
// ACCOMPANIMENT_SERVER_BIN overrides the source binary (host mode only).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appTarget = path.join(root, 'rust', 'app', 'target');
const binaries = path.join(root, 'rust', 'tray', 'binaries');
const arg = process.argv[2];

function exeFor(triple) {
    return triple.includes('windows') ? '.exe' : '';
}

function stage(from, triple) {
    const to = path.join(binaries, `accompaniment-server-${triple}${exeFor(triple)}`);
    fs.mkdirSync(binaries, { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o755);
    console.log(`staged ${path.relative(root, to)}`);
}

function need(file) {
    if (!fs.existsSync(file)) {
        console.error(`${file} is missing: build it first`);
        process.exit(1);
    }
    return file;
}

if (arg === '--universal') {
    const halves = ['x86_64-apple-darwin', 'aarch64-apple-darwin'];
    const inputs = halves.map((t) => need(path.join(appTarget, t, 'release', 'accompaniment')));
    const merged = path.join(appTarget, 'universal-apple-darwin', 'release', 'accompaniment');
    fs.mkdirSync(path.dirname(merged), { recursive: true });
    execFileSync('lipo', ['-create', '-output', merged, ...inputs], { stdio: 'inherit' });
    for (const triple of [...halves, 'universal-apple-darwin']) stage(merged, triple);
} else if (arg) {
    stage(need(path.join(appTarget, arg, 'release', `accompaniment${exeFor(arg)}`)), arg);
} else {
    const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
    const from = process.env.ACCOMPANIMENT_SERVER_BIN
        || path.join(appTarget, 'release', `accompaniment${exeFor(host)}`);
    stage(need(from), host);
}
