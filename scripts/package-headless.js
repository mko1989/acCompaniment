#!/usr/bin/env node
// Builds the headless Linux package: the server, its browser UI and ffmpeg, with a systemd
// service and install scripts (packaging/linux-headless/), as
// dist/accompaniment-<version>-linux-<arch>.tar.gz. Run on Linux after building the server.
//
//   node scripts/package-headless.js                   the host's build (rust/app/target/release)
//   node scripts/package-headless.js <target triple>   a cross build (x86_64-unknown-linux-gnu,
//                                                      aarch64-unknown-linux-gnu)
//
// ffmpeg comes from vendor/ffmpeg/linux-<arch> (npm run fetch:ffmpeg linux).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const triple = process.argv[2]
    || /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
if (!triple.includes('linux')) {
    console.error(`${triple}: the headless package is for Linux`);
    process.exit(1);
}
const arch = triple.startsWith('aarch64') ? 'arm64' : 'x64';
const version = JSON.parse(fs.readFileSync(path.join(root, 'rust/tray/tauri.conf.json'), 'utf8')).version;

const server = process.argv[2]
    ? path.join(root, 'rust/app/target', triple, 'release/accompaniment')
    : path.join(root, 'rust/app/target/release/accompaniment');
const ffmpeg = path.join(root, 'vendor/ffmpeg', `linux-${arch}`, 'ffmpeg');
for (const [file, how] of [[server, 'build the server first'], [ffmpeg, 'npm run fetch:ffmpeg linux']]) {
    if (!fs.existsSync(file)) {
        console.error(`${file} is missing: ${how}`);
        process.exit(1);
    }
}

const name = `accompaniment-${version}-linux-${arch}`;
const dist = path.join(root, 'dist');
const out = path.join(dist, name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'ffmpeg'), { recursive: true });

fs.copyFileSync(server, path.join(out, 'accompaniment'));
fs.copyFileSync(ffmpeg, path.join(out, 'ffmpeg', 'ffmpeg'));
fs.cpSync(path.join(root, 'src/frontend'), path.join(out, 'frontend'), { recursive: true });
const pkg = path.join(root, 'packaging/linux-headless');
for (const f of fs.readdirSync(pkg)) fs.copyFileSync(path.join(pkg, f), path.join(out, f));
for (const f of ['accompaniment', 'ffmpeg/ffmpeg', 'install.sh', 'uninstall.sh']) {
    fs.chmodSync(path.join(out, f), 0o755);
}

const tarball = path.join(dist, `${name}.tar.gz`);
execFileSync('tar', ['-czf', tarball, '-C', dist, name]);
console.log(`packaged ${path.relative(root, tarball)} (${(fs.statSync(tarball).size / 1048576).toFixed(1)} MiB)`);
