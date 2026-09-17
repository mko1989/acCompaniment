// Playwright config for real-browser end-to-end tests of the browser UI
// (src/frontend/), as opposed to the Node-level API/WebSocket smoke tests
// in test/*.test.js. See test/e2e/README.md for how this differs from and
// complements that suite.
//
// Unlike the Node-level smoke tests (each of which boots its own isolated
// server on a random free port), Playwright's `webServer` option starts one
// server for the whole run, shared by every spec file. That's why e2e specs
// scope every assertion to a cue *they* created (by its own unique id/name)
// rather than ever asserting on total cue-grid state - multiple spec files
// can run against that one shared server concurrently.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { defineConfig, devices } = require('@playwright/test');

const E2E_PORT = 34199;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accompaniment-e2e-'));

module.exports = defineConfig({
    testDir: './test/e2e',
    timeout: 30000,
    expect: { timeout: 10000 },
    fullyParallel: true,
    // All specs share one live server (with a real, CPU-hungry RtAudio
    // engine) rather than each getting an isolated instance like the
    // Node-level smoke tests do. Running many Chromium instances at once
    // against that one server, on top of real audio processing, caused a
    // real, reproducible timeout in one test (window.open() under heavy
    // contention) that never happened in isolation - not a flake to paper
    // over, a genuine resource-contention ceiling on typical dev hardware.
    workers: 2,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: `http://127.0.0.1:${E2E_PORT}`,
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: `node ${path.join(__dirname, 'start-nodejs.js')}`,
        url: `http://127.0.0.1:${E2E_PORT}/api/remote/health`,
        timeout: 30000,
        reuseExistingServer: false,
        env: {
            PORT: String(E2E_PORT),
            HOST: '127.0.0.1',
            ACCOMPANIMENT_DATA_DIR: dataDir,
        },
    },
});
