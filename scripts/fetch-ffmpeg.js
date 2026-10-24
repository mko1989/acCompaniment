#!/usr/bin/env node
/**
 * Download the static ffmpeg binaries that get bundled into the packaged app
 * (see build.*.extraResources in package.json), into vendor/ffmpeg/.
 *
 * The decoder used to rely on an `ffmpeg` on the PATH, which only worked on
 * machines that happened to have one installed (e.g. via Homebrew) - and even
 * then not when the app is launched from Finder, which gets a minimal PATH.
 *
 * Binaries come from the ffmpeg-static project's GitHub releases. On macOS the
 * arm64 and x64 builds are merged with lipo into one universal binary, so the
 * same file sits in both halves of electron-builder's universal app and the
 * merge leaves it alone.
 *
 * Usage: node scripts/fetch-ffmpeg.js [darwin] [win32] [linux]
 * (defaults to the current platform). Already-downloaded files are reused.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RELEASE = 'b6.1.1';
const BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

const TARGETS = {
    darwin: ['darwin-arm64', 'darwin-x64'],
    win32: ['win32-x64'],
    linux: ['linux-x64', 'linux-arm64'],
};

const vendorDir = path.resolve(__dirname, '..', 'vendor', 'ffmpeg');

function binaryPath(target) {
    const exe = target.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg';
    return path.join(vendorDir, target, exe);
}

async function download(target) {
    const dest = binaryPath(target);
    const stamp = path.join(path.dirname(dest), 'RELEASE');
    if (fs.existsSync(dest) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === RELEASE) {
        console.log(`[fetch-ffmpeg] ${target}: already present (${RELEASE})`);
        return dest;
    }

    const url = `${BASE_URL}/ffmpeg-${target}.gz`;
    console.log(`[fetch-ffmpeg] ${target}: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`download failed for ${target}: HTTP ${res.status}`);
    }
    const binary = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, binary, { mode: 0o755 });
    fs.writeFileSync(stamp, RELEASE + '\n');
    return dest;
}

function makeUniversal(arm64, x64) {
    const dest = binaryPath('darwin-universal');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    execFileSync('lipo', ['-create', arm64, x64, '-output', dest]);
    fs.chmodSync(dest, 0o755);
    const archs = execFileSync('lipo', ['-archs', dest]).toString().trim();
    if (!archs.includes('arm64') || !archs.includes('x86_64')) {
        throw new Error(`darwin-universal ffmpeg is not universal (archs: ${archs})`);
    }
    console.log(`[fetch-ffmpeg] darwin-universal: ${archs}`);
}

async function main() {
    const platforms = process.argv.slice(2);
    if (platforms.length === 0) platforms.push(process.platform);

    for (const platform of platforms) {
        const targets = TARGETS[platform];
        if (!targets) {
            throw new Error(`unknown platform "${platform}" (expected one of: ${Object.keys(TARGETS).join(', ')})`);
        }
        const paths = [];
        for (const target of targets) {
            paths.push(await download(target));
        }
        if (platform === 'darwin') {
            if (process.platform !== 'darwin') {
                throw new Error('building the universal macOS ffmpeg needs lipo, so it has to run on macOS');
            }
            makeUniversal(paths[0], paths[1]);
        }
    }
}

main().catch((err) => {
    console.error(`[fetch-ffmpeg] ${err.message}`);
    process.exit(1);
});
