#!/usr/bin/env node
/**
 * Rebuild @hamitzor/rtaudio.js (the audio engine's native addon) for
 * packaging on this machine's platform. electron-builder can't build it for
 * another OS - each platform's installer is built on that platform (see
 * .github/workflows/release.yml and scripts/check-native-binaries.js).
 *
 * macOS: a universal (arm64 + x86_64) binary. electron-builder's universal
 * target packs an x64 and an arm64 app and merges them with lipo, but
 * @electron/rebuild skips this addon (it uses cmake-js, not node-gyp), so
 * both halves would otherwise get whatever single-arch binary `npm install`
 * produced and the merge fails. Binaries that are already fat in both halves
 * are left alone by the merge.
 *
 * macOS and Linux: the addon finds librtaudio next to itself (rpath
 * @loader_path / $ORIGIN) inside the packaged app, rather than via this
 * machine's absolute build path - which only exists on the build machine.
 *
 * Windows: Node loads a .node's DLLs from its own folder already; the build
 * `npm install` made is used as is.
 *
 * The addon is N-API, so the same binary loads under Node and Electron.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgDir = path.dirname(require.resolve('@hamitzor/rtaudio.js/package.json', { paths: [root] }));
const cmakeJs = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'cmake-js.cmd' : 'cmake-js');
const releaseDir = path.join(pkgDir, 'build', 'Release');
// CMake 4.x rejects the addon's old cmake_minimum_required otherwise.
const env = { ...process.env, CMAKE_POLICY_VERSION_MINIMUM: '3.5' };

function rebuild(cmakeArgs) {
    execFileSync(cmakeJs, ['rebuild', ...cmakeArgs], { cwd: pkgDir, stdio: 'inherit', env });
}

if (process.platform === 'darwin') {
    rebuild([
        '--CDCMAKE_OSX_ARCHITECTURES=arm64;x86_64',
        '--CDCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
        '--CDCMAKE_INSTALL_RPATH=@loader_path',
    ]);
    for (const file of ['rtaudio-js-darwin.node', 'librtaudio.dylib']) {
        const archs = execFileSync('lipo', ['-archs', path.join(releaseDir, file)]).toString().trim();
        if (!archs.includes('arm64') || !archs.includes('x86_64')) {
            console.error(`[build-rtaudio] ${file} is not universal (archs: ${archs})`);
            process.exit(1);
        }
        console.log(`[build-rtaudio] ${file}: ${archs}`);
    }
} else if (process.platform === 'linux') {
    // PulseAudio backend (the addon's Linux default): needs libpulse-dev.
    rebuild([
        '--CDCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
        '--CDCMAKE_INSTALL_RPATH=$ORIGIN',
    ]);
    const addon = path.join(releaseDir, 'rtaudio-js-linux-pulse.node');
    if (!fs.existsSync(addon)) {
        console.error(`[build-rtaudio] ${path.basename(addon)} was not built (found: ${fs.readdirSync(releaseDir).join(', ')})`);
        process.exit(1);
    }
    console.log(`[build-rtaudio] built ${fs.readdirSync(releaseDir).join(', ')}`);
} else {
    console.log(`[build-rtaudio] ${process.platform}: using the build from npm install`);
}
