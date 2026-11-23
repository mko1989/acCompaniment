/**
 * The command that starts the server under test: the Rust binary,
 * rust/app/target/release/accompaniment (build it with `npm run build`).
 * ACCOMPANIMENT_SERVER_BIN runs another server binary instead, with
 * ACCOMPANIMENT_SERVER_ENV's space-separated `KEY=VALUE` pairs added to its
 * environment. Shared by the node:test harness and the Playwright fixtures.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_BIN = path.join('rust', 'app', 'target', 'release', process.platform === 'win32' ? 'accompaniment.exe' : 'accompaniment');

function serverCommand() {
    const bin = path.resolve(REPO_ROOT, process.env.ACCOMPANIMENT_SERVER_BIN || DEFAULT_BIN);
    if (!fs.existsSync(bin)) {
        throw new Error(`server binary not found: ${bin} - build it first (npm run build)`);
    }
    const env = Object.fromEntries((process.env.ACCOMPANIMENT_SERVER_ENV || '').split(/\s+/).filter(Boolean)
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    return { command: bin, args: [], env };
}

module.exports = { serverCommand, REPO_ROOT };
