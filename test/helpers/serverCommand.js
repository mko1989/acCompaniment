/**
 * The command that starts the server under test. Normally `node start-nodejs.js`;
 * ACCOMPANIMENT_SERVER_BIN runs another server binary instead - the Rust port (rust/MAP.md,
 * "Proof") - with ACCOMPANIMENT_SERVER_ENV's space-separated `KEY=VALUE` pairs added to its
 * environment, e.g. ACCOMPANIMENT_SERVER_ENV=ACCOMPANIMENT_CORE=rust (rust/ ADR-015).
 * Shared by the node:test harness and the Playwright fixtures.
 */

const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function serverCommand(execPath = process.execPath) {
    const bin = process.env.ACCOMPANIMENT_SERVER_BIN;
    if (!bin) {
        return { command: execPath, args: [path.join(REPO_ROOT, 'start-nodejs.js')], env: {} };
    }
    const env = Object.fromEntries((process.env.ACCOMPANIMENT_SERVER_ENV || '').split(/\s+/).filter(Boolean)
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    return { command: path.resolve(REPO_ROOT, bin), args: [], env };
}

module.exports = { serverCommand };
