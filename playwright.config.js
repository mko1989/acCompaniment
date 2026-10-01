// Playwright config for real-browser end-to-end tests of the browser UI
// (src/frontend/), as opposed to the Node-level API/WebSocket tests in
// test/*.test.js.
//
// Two projects:
// - chromium (test/e2e/): the browser UI. Each worker boots its own server
//   with its own temp data directory, and every test starts from a clean
//   slate on it (test/e2e/fixtures.js).
// - electron (test/electron/): the tray launcher, launched as a real
//   Electron app against an isolated data directory and port
//   (test/electron/fixtures.js).
// Specs import { test, expect } from their folder's fixtures.js.

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    timeout: 30000,
    expect: { timeout: 10000 },
    fullyParallel: true,
    // Each worker runs its own server with a real, CPU-hungry RtAudio
    // engine; more than a couple at once on typical dev hardware causes
    // genuine resource-contention timeouts, not flakes to paper over.
    workers: 2,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: [['list']],
    use: {
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', testDir: './test/e2e', use: { ...devices['Desktop Chrome'] } },
        { name: 'electron', testDir: './test/electron', timeout: 90000 },
    ],
});
