#!/usr/bin/env node
/**
 * Makes sure a packaged app carries native binaries for the platform and
 * architecture it was packaged for (WO-011): the RtAudio addon - the whole
 * audio engine - and ffmpeg.
 *
 * electron-builder can't rebuild a cmake-js addon for another OS, so
 * packaging Windows or Linux on a Mac used to copy the Mac addon into those
 * installers: they installed, started, and played nothing.
 *
 * Two uses:
 *  - electron-builder `afterPack` hook (package.json build.afterPack): reads
 *    each binary's header (Mach-O / PE / ELF and its CPU) and fails the
 *    build on a mismatch. Runs for every package, on any machine.
 *  - CLI, on the platform the package is for:
 *      node scripts/check-native-binaries.js <appOutDir> [--load]
 *    does the same checks, and with --load also starts the packaged app's
 *    own runtime (ELECTRON_RUN_AS_NODE) and loads the addon from inside the
 *    package - with node_modules' build of it moved aside, so a copy that
 *    only works next to the machine's build tree (a library path pointing
 *    back into it) fails here rather than on a user's machine.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// electron-builder's Arch enum.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
// What each platform's RtAudio loader asks for (@hamitzor/rtaudio.js index.js).
const ADDON_FILE = {
    darwin: 'rtaudio-js-darwin.node',
    win32: 'rtaudio-js-win32.node',
    linux: 'rtaudio-js-linux-pulse.node',
};
const PRODUCT = 'acCompaniment';
const EXECUTABLE = {
    darwin: (out) => path.join(out, `${PRODUCT}.app`, 'Contents', 'MacOS', PRODUCT),
    win32: (out) => path.join(out, `${PRODUCT}.exe`),
    linux: (out) => path.join(out, 'accompaniment'),
};

function resourcesDir(appOutDir, platform) {
    return platform === 'darwin'
        ? path.join(appOutDir, `${PRODUCT}.app`, 'Contents', 'Resources')
        : path.join(appOutDir, 'resources');
}

/** { format: 'mach-o' | 'pe' | 'elf' | 'unknown', archs: ['x64', 'arm64', ...] } */
function describeBinary(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        const buf = head.subarray(0, n);
        // Mach-O, universal ("fat"): big-endian header, a cputype per slice.
        if (buf.readUInt32BE(0) === 0xcafebabe) {
            const count = buf.readUInt32BE(4);
            const archs = [];
            for (let i = 0; i < count; i++) archs.push(machCpu(buf.readInt32BE(8 + i * 20)));
            return { format: 'mach-o', archs };
        }
        // Mach-O, single architecture (64-bit, little-endian).
        if (buf.readUInt32LE(0) === 0xfeedfacf) {
            return { format: 'mach-o', archs: [machCpu(buf.readInt32LE(4))] };
        }
        if (buf.toString('latin1', 0, 2) === 'MZ') {
            const pe = buf.readUInt32LE(0x3c);
            if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return { format: 'unknown', archs: [] };
            const machine = buf.readUInt16LE(pe + 4);
            return { format: 'pe', archs: [{ 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[machine] || `0x${machine.toString(16)}`] };
        }
        if (buf.readUInt32BE(0) === 0x7f454c46) {
            const machine = buf.readUInt16LE(18);
            return { format: 'elf', archs: [{ 0x3e: 'x64', 0xb7: 'arm64', 0x28: 'armv7l', 0x03: 'ia32' }[machine] || `0x${machine.toString(16)}`] };
        }
        return { format: 'unknown', archs: [] };
    } finally {
        fs.closeSync(fd);
    }
}

function machCpu(cputype) {
    return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[cputype >>> 0] || `0x${(cputype >>> 0).toString(16)}`;
}

const FORMAT = { darwin: 'mach-o', win32: 'pe', linux: 'elf' };

/** Problems with the native binaries in a packaged app; empty when all is well. */
function findProblems(appOutDir, platform, arch) {
    const problems = [];
    const resources = resourcesDir(appOutDir, platform);
    const wantArchs = arch === 'universal' ? ['x64', 'arm64'] : [arch];

    const checkFile = (file, what) => {
        const { format, archs } = describeBinary(file);
        const rel = path.relative(appOutDir, file);
        if (format !== FORMAT[platform]) {
            problems.push(`${what} ${rel} is a ${format} binary, not ${FORMAT[platform]} (${platform})`);
        } else if (!wantArchs.every((a) => archs.includes(a))) {
            problems.push(`${what} ${rel} is built for ${archs.join('+') || '?'}, not ${wantArchs.join('+')}`);
        }
    };

    const addonDir = path.join(resources, 'app.asar.unpacked', 'node_modules', '@hamitzor', 'rtaudio.js', 'build', 'Release');
    if (!fs.existsSync(path.join(addonDir, ADDON_FILE[platform]))) {
        const present = fs.existsSync(addonDir) ? fs.readdirSync(addonDir).join(', ') : 'nothing';
        problems.push(`audio engine addon ${ADDON_FILE[platform]} missing from the package (has: ${present})`);
    }
    if (fs.existsSync(addonDir)) {
        for (const name of fs.readdirSync(addonDir)) {
            if (/\.(node|dll|so(\.\d+)*|dylib)$/.test(name)) checkFile(path.join(addonDir, name), 'audio engine');
        }
    }

    const ffmpeg = path.join(resources, 'ffmpeg', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(ffmpeg)) checkFile(ffmpeg, 'ffmpeg');
    else problems.push(`ffmpeg missing from the package (${path.relative(appOutDir, ffmpeg)})`);

    return problems;
}

/**
 * Loads the packaged addon with the packaged runtime, with node_modules'
 * own build of it out of the way. Returns null, or what went wrong.
 */
function loadPackagedAddon(appOutDir, platform) {
    const executable = EXECUTABLE[platform](appOutDir);
    // Through app.asar, as the app requires it: its JS dependencies are in
    // the archive, and Electron loads the .node from app.asar.unpacked.
    const addon = path.join(resourcesDir(appOutDir, platform), 'app.asar', 'node_modules', '@hamitzor', 'rtaudio.js');
    const buildDir = path.join(ROOT, 'node_modules', '@hamitzor', 'rtaudio.js', 'build');
    const hidden = `${buildDir}.check-native-binaries`;
    const moved = fs.existsSync(buildDir);
    if (moved) fs.renameSync(buildDir, hidden);
    try {
        // Loading is the test; constructing RtAudio also lists devices,
        // which a CI runner without sound may not have - that's fine.
        const script = `const { RtAudio } = require(${JSON.stringify(addon)});`
            + 'if (typeof RtAudio !== "function") throw new Error("RtAudio not exported");'
            + 'try { const n = new RtAudio().getDevices().length; console.log(`RtAudio loaded; ${n} device(s)`); }'
            + 'catch (e) { console.log(`RtAudio loaded; no devices (${e.message || e})`); }';
        const result = spawnSync(executable, ['-e', script], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 60000,
        });
        process.stdout.write(result.stdout || '');
        if (result.status !== 0) {
            return `loading the packaged addon failed (exit ${result.status}${result.signal ? `, ${result.signal}` : ''}): ${(result.stderr || result.error?.message || '').trim()}`;
        }
        return null;
    } finally {
        if (moved) fs.renameSync(hidden, buildDir);
    }
}

// electron-builder afterPack hook.
async function afterPack(context) {
    const platform = context.electronPlatformName;
    const arch = ARCH_NAMES[context.arch] || String(context.arch);
    const problems = findProblems(context.appOutDir, platform, arch);
    if (problems.length) {
        throw new Error(
            `[check-native-binaries] ${platform}-${arch} package has native binaries for the wrong platform:\n  - `
            + `${problems.join('\n  - ')}\nBuild each platform's installer on that platform `
            + '(the release workflow, .github/workflows/release.yml, does) - see work/WO-011.'
        );
    }
    console.log(`[check-native-binaries] ${platform}-${arch}: native binaries OK`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.findProblems = findProblems;
module.exports.describeBinary = describeBinary;

if (require.main === module) {
    const args = process.argv.slice(2);
    const appOutDir = path.resolve(args.find((a) => !a.startsWith('--')) || '');
    const platform = process.platform;
    const arch = args.find((a) => a.startsWith('--arch='))?.slice(7) || process.arch;
    if (!fs.existsSync(appOutDir)) {
        console.error('Usage: node scripts/check-native-binaries.js <appOutDir> [--load] [--arch=x64|arm64|universal]');
        process.exit(2);
    }
    const problems = findProblems(appOutDir, platform, arch);
    if (!problems.length && args.includes('--load')) {
        const failure = loadPackagedAddon(appOutDir, platform);
        if (failure) problems.push(failure);
    }
    if (problems.length) {
        console.error(`[check-native-binaries] ${appOutDir}:\n  - ${problems.join('\n  - ')}`);
        process.exit(1);
    }
    console.log(`[check-native-binaries] ${appOutDir}: OK (${platform}-${arch}${args.includes('--load') ? ', addon loads' : ''})`);
}
