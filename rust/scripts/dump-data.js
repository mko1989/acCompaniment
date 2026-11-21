#!/usr/bin/env node
/**
 * Prints the state of a data dir, for `rust-anything app record --db-dump`: after every recorded
 * request, what the server has on disk becomes part of the case, so the Rust port must write the
 * same files (rust/DECISIONS.md ADR-006).
 *
 * Every file, sorted by path: JSON and text files in full (byte for byte, so formatting counts),
 * anything else as size and SHA-256. Left out: the PCM cache (internal, may change format) and
 * temporary files of atomic writes and temp/ (uploads in progress, waveform cache).
 *
 * Usage: node rust/scripts/dump-data.js [data dir]   (default: rust/app-fixtures/data)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(process.argv[2] || 'rust/app-fixtures/data');
const SKIP_DIRS = new Set(['pcm-cache', 'pcmCache', 'cache', 'temp']);
const TEXT = new Set(['.json', '.txt', '.log', '.md']);

function walk(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(full, out);
        } else if (e.isFile() && !/\.tmp\./.test(e.name)) {
            out.push(full);
        }
    }
}

const files = [];
walk(root, files);
// Order must not depend on random ids (new workspaces, cues and audio files are named by UUID):
// sort by the relative path and contents with every UUID blanked, then by the real path. Compare
// by UTF-16 code units, the same in any language.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const entries = files.map((f) => {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const bytes = fs.readFileSync(f);
    const text = TEXT.has(path.extname(rel).toLowerCase()) ? bytes.toString('utf8') : null;
    const key = `${rel.replace(UUID, 'U')}\u0000${(text ?? '').replace(UUID, 'U')}`;
    return { rel, bytes, text, key };
});
entries.sort((a, b) => cmp(a.key, b.key) || cmp(a.rel, b.rel));
for (const { rel, bytes, text } of entries) {
    if (text !== null) {
        process.stdout.write(`=== ${rel}\n${text}\n`);
    } else {
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        process.stdout.write(`=== ${rel} (${bytes.length} bytes, sha256 ${hash})\n`);
    }
}
