#!/usr/bin/env node
/**
 * Rebuild @hamitzor/rtaudio.js as a universal (arm64 + x86_64) macOS binary
 * before packaging.
 *
 * electron-builder's universal target packs an x64 and an arm64 app and merges
 * them with lipo, but @electron/rebuild skips this addon (it uses cmake-js, not
 * node-gyp), so both halves would otherwise get whatever single-arch binary
 * `npm install` produced and the merge fails. Binaries that are already fat in
 * both halves are left alone by the merge.
 *
 * The addon is N-API, so the same binary loads under Node and Electron.
 * The rpath is set to @loader_path so the .node finds librtaudio.dylib next to
 * it inside the packaged app, rather than via this machine's absolute path.
 */

const { execFileSync } = require('child_process');
const path = require('path');

if (process.platform !== 'darwin') {
    console.log('[build-rtaudio-universal] Not macOS, skipping.');
    process.exit(0);
}

const root = path.resolve(__dirname, '..');
const pkgDir = path.dirname(require.resolve('@hamitzor/rtaudio.js/package.json', { paths: [root] }));
const cmakeJs = path.join(root, 'node_modules', '.bin', 'cmake-js');

execFileSync(cmakeJs, [
    'rebuild',
    '--CDCMAKE_OSX_ARCHITECTURES=arm64;x86_64',
    '--CDCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
    '--CDCMAKE_INSTALL_RPATH=@loader_path',
], {
    cwd: pkgDir,
    stdio: 'inherit',
    // CMake 4.x rejects the addon's old cmake_minimum_required otherwise.
    env: { ...process.env, CMAKE_POLICY_VERSION_MINIMUM: '3.5' },
});

const releaseDir = path.join(pkgDir, 'build', 'Release');
for (const file of ['rtaudio-js-darwin.node', 'librtaudio.dylib']) {
    const archs = execFileSync('lipo', ['-archs', path.join(releaseDir, file)]).toString().trim();
    if (!archs.includes('arm64') || !archs.includes('x86_64')) {
        console.error(`[build-rtaudio-universal] ${file} is not universal (archs: ${archs})`);
        process.exit(1);
    }
    console.log(`[build-rtaudio-universal] ${file}: ${archs}`);
}
