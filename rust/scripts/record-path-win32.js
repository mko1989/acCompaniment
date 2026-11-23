#!/usr/bin/env node
// Records Node's `path.win32` on a spread of Windows paths, for the Rust port
// (rust/app/src/core/nodepath_win32.rs, WO-038):
//   node rust/scripts/record-path-win32.js > rust/app/tests/unit-cases/path-win32.jsonl
// One `{fn, args, ok, cwd, driveCwd}` per line. process.cwd() is pinned so the cases don't
// depend on this machine. Node reads a drive's own working directory (`process.env['=D:']`)
// only when it runs on Windows, so off Windows `driveCwd` is empty and drive-relative paths
// fall back to process.cwd() (the Rust port's unit test covers the Windows branch).
const path = require('path');

const cwd = 'C:\\work\\dir';
const driveCwd = process.platform === 'win32' ? { 'D:': 'D:\\dcwd\\sub' } : {};
process.cwd = () => cwd;
for (const [k, v] of Object.entries(driveCwd)) process.env[`=${k}`] = v;

const singles = [
    '', '.', '..', '/', '\\', '//', '\\\\', '///', 'a', 'a.b', '.x', 'x.', '..x', 'a..', '.',
    'C:', 'c:', 'C:\\', 'C:/', 'c:\\', 'C:\\\\', 'C:foo', 'C:foo\\bar', 'C:\\foo', 'C:\\foo\\',
    'C:\\foo\\bar.txt', 'C:/foo/bar.tar.gz', 'D:', 'D:x', 'D:\\', 'd:\\Data\\..\\x', 'E:\\a\\b\\..\\..\\..',
    'C:\\Users\\me\\.accompaniment', 'C:\\Users\\me\\.accompaniment\\audio\\song.mp3',
    '\\\\server', '\\\\server\\', '\\\\server\\share', '\\\\server\\share\\', '//server/share/dir/f.wav',
    '\\\\server\\share\\dir\\..\\..\\x', '\\\\?\\C:\\long\\path', '\\\\.\\pipe\\x',
    '\\foo', '/foo/bar', '\\foo\\..\\..\\bar', 'foo\\bar', 'foo/bar\\baz', 'foo\\\\bar', 'foo\\.\\bar',
    'foo\\..', 'foo\\..\\..', '..\\foo', '../../a/b', 'a\\b\\c\\', 'a/b/c//', 'x:y', 'a:', 'a:b:c',
    'file.txt', 'dir\\file.txt', 'dir\\.hidden', 'dir\\file.', 'dir\\..file', 'Ä\\ö ü\\ß.wav',
    'C:\\x\\Ünï.mp3', '1:\\x', 'C:..\\x', 'C:.', 'C:\\.', 'C:\\..',
];
const pairsFrom = [
    '', '.', '..', '\\', 'a', 'a\\b', '..\\x', 'C:', 'C:\\', 'C:\\foo', 'C:\\foo\\bar', 'C:\\Foo\\BAR\\baz',
    'c:\\foo', 'C:foo', 'D:', 'D:\\', 'D:\\x', 'D:y', '\\\\server\\share', '\\\\server\\share\\a',
    '\\\\SERVER\\share\\a\\b', '//server', '/abs', 'x.txt', 'C:\\foo\\..\\bar', 'audio\\a.mp3',
];
const suffixes = ['.txt', '.mp3', 'txt', 'file.txt', '\\', '.', 'b'];

const cases = [];
const add = (fn, args) => {
    let rec;
    try {
        rec = { fn, args, ok: path.win32[fn](...args) };
    } catch (e) {
        rec = { fn, args, error: String(e.message) };
    }
    cases.push({ ...rec, cwd, driveCwd });
};
for (const p of singles) {
    for (const fn of ['normalize', 'isAbsolute', 'dirname', 'basename', 'extname']) add(fn, [p]);
    add('resolve', [p]);
    for (const s of suffixes) add('basename', [p, s]);
}
for (const a of pairsFrom) {
    for (const b of pairsFrom) {
        add('join', [a, b]);
        add('resolve', [a, b]);
        add('relative', [a, b]);
    }
    add('join', [a, 'x', '..\\..\\y']);
    add('resolve', [a, 'x', '..\\..\\y']);
}
add('join', []);
add('resolve', []);
for (const c of cases) process.stdout.write(JSON.stringify(c) + '\n');
console.error(`${cases.length} cases (node ${process.version})`);
