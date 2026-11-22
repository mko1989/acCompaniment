#!/usr/bin/env node
/**
 * Differential check of the Rust core's data layer (B1, rust/DECISIONS.md ADR-015) against the
 * original Node managers: each op script runs on two fresh copies of its fixture, one driven by
 * rust/scripts/drive-data.js (Node) and one by `drive-data` (rust/app), and after every op the
 * op's result and the whole data dir (rust/scripts/dump-data.js) must match.
 *
 * Normalized, and nothing else: ISO timestamps (and the dashed ones in backup names), generated
 * UUIDs (mapped by first appearance, per side), the temp paths of the two copies.
 *
 * Usage: node rust/scripts/diff-data.js [ops files...]   (default: rust/scripts/data-ops/*.json)
 * Build first: cargo build --manifest-path rust/app/Cargo.toml --bin drive-data
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'rust', 'app-fixtures');
const RUST_BIN = path.join(REPO, 'rust', 'app', 'target', 'debug', 'drive-data');
const { readBundle } = require(path.join(REPO, 'src', 'backend', 'projectBundle'));

function seedIds() {
    const ids = {};
    const ws = path.join(FIXTURES, 'data', 'cues', 'workspaces');
    for (const f of fs.readdirSync(ws)) {
        const w = JSON.parse(fs.readFileSync(path.join(ws, f), 'utf8'));
        ids.SEED_WS = w.id;
        for (const c of w.cues) ids[`CUE:${c.name}`] = c.id;
    }
    const md = path.join(FIXTURES, 'data', 'audio', 'metadata');
    for (const f of fs.readdirSync(md)) {
        const m = JSON.parse(fs.readFileSync(path.join(md, f), 'utf8'));
        ids[`AUDIO:${m.relativePath}`] = m.id;
    }
    return ids;
}

function template(text, ids) {
    return text.replace(/\$\{([^}]+)\}/g, (m, k) => (k in ids ? ids[k] : m));
}

function fixtureDir(name, work) {
    if (name === 'seed') return path.join(FIXTURES, 'data');
    if (name === 'empty') {
        const d = path.join(work, 'empty-fixture');
        fs.mkdirSync(d, { recursive: true });
        return d;
    }
    if (name === 'legacy') {
        const d = path.join(work, 'legacy-fixture');
        const r = spawnSync(process.execPath, [path.join(__dirname, 'make-legacy-fixture.js'), d], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return d;
    }
    throw new Error(`unknown fixture ${name}`);
}

function normalize(text, roots) {
    for (const r of roots) text = text.split(r).join('<ROOT>');
    text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>');
    text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, '<TS>');
    text = text.replace(/corrupted_\d+_/g, 'corrupted_<MS>_');
    const map = new Map();
    text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (u) => {
        if (!map.has(u)) map.set(u, `<U${map.size + 1}>`);
        return map.get(u);
    });
    return text;
}

function blocks(text) {
    return text.split(/^(?=### \d+ )/m).filter(Boolean);
}

function firstDiff(a, b) {
    const la = a.split('\n');
    const lb = b.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) return `line ${i + 1}:\n  node: ${(la[i] ?? '<none>').slice(0, 400)}\n  rust: ${(lb[i] ?? '<none>').slice(0, 400)}`;
    }
    return '';
}

async function zipSummary(zip, extractDir) {
    try {
        const r = await readBundle(zip, extractDir);
        const audio = r.audio.map((a) => ({ name: a.name, sha: crypto.createHash('sha256').update(fs.readFileSync(a.path)).digest('hex') }));
        return JSON.stringify({ project: r.project, audio, missing: r.missingAudio });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

async function main() {
    const files = process.argv.slice(2).length
        ? process.argv.slice(2)
        : fs.readdirSync(path.join(__dirname, 'data-ops')).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(__dirname, 'data-ops', f));
    const ids = seedIds();
    let total = 0;
    let matched = 0;
    let failures = 0;
    for (const file of files) {
        const spec = JSON.parse(template(fs.readFileSync(file, 'utf8'), ids));
        const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-diff-')));
        const fixture = fixtureDir(spec.fixture || 'seed', work);
        const opsFile = path.join(work, 'ops.json');
        fs.writeFileSync(opsFile, JSON.stringify(spec.ops));
        const out = {};
        for (const side of ['node', 'rust']) {
            const base = path.join(work, side);
            const data = path.join(base, 'data');
            const outDir = path.join(base, 'out');
            fs.mkdirSync(outDir, { recursive: true });
            fs.cpSync(fixture, data, { recursive: true, preserveTimestamps: true });
            const cmd = side === 'node' ? [process.execPath, path.join(__dirname, 'drive-data.js')] : [RUST_BIN];
            const r = spawnSync(cmd[0], [...cmd.slice(1), data, opsFile, outDir, FIXTURES], { encoding: 'utf8', maxBuffer: 1 << 30 });
            if (r.status !== 0) {
                console.error(`${side} driver failed on ${path.basename(file)}:\n${r.stderr}`);
            }
            out[side] = normalize(r.stdout, [base]);
        }
        const nb = blocks(out.node);
        const rb = blocks(out.rust);
        let fileMatched = 0;
        for (let i = 0; i < Math.max(nb.length, rb.length); i++) {
            total += 1;
            if (nb[i] === rb[i]) {
                matched += 1;
                fileMatched += 1;
            } else if (failures < 25) {
                failures += 1;
                const title = (nb[i] || rb[i] || '').split('\n')[0];
                console.log(`MISMATCH ${path.basename(file)} ${title}\n${firstDiff(nb[i] || '', rb[i] || '')}\n`);
            }
        }
        // Every bundle Rust wrote must read back in the original exactly as the original's own.
        for (const zip of fs.readdirSync(path.join(work, 'node', 'out')).filter((z) => z.endsWith('.zip'))) {
            total += 1;
            const n = await zipSummary(path.join(work, 'node', 'out', zip), path.join(work, 'x-node', zip));
            const r = await zipSummary(path.join(work, 'rust', 'out', zip), path.join(work, 'x-rust', zip));
            const nn = normalize(n, [path.join(work, 'node'), path.join(work, 'x-node')]);
            const rr = normalize(r, [path.join(work, 'rust'), path.join(work, 'x-rust')]);
            if (nn === rr) {
                matched += 1;
                fileMatched += 1;
            } else {
                console.log(`MISMATCH ${path.basename(file)} bundle ${zip} read by Node\n${firstDiff(nn, rr)}\n`);
            }
        }
        console.log(`${path.basename(file)}: ${fileMatched}/${Math.max(nb.length, rb.length)} ops (+ bundles) match`);
        if (!process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
        else console.log(`  kept ${work}`);
    }
    console.log(`\n${matched}/${total} match`);
    process.exit(matched === total ? 0 : 1);
}

main();
