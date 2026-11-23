/**
 * Loopback suite: another app changing the output device's sample rate while
 * a cue plays. On macOS any client can change a device's nominal rate (here a
 * bare RtAudio player opening the loopback device at 44.1 kHz, as another app
 * or a second copy of this one would). The cue must play on and end as usual.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loopbackSuite } = require('./lib/loopback');

const audio = loopbackSuite();
const { test, sleep } = audio;

/** Opens the loopback output at `sampleRate` from another process for `seconds`. */
function otherAppAt(sampleRate, seconds) {
    const child = spawn(process.execPath, [
        path.join(__dirname, 'lib', 'baselinePlayer.js'),
        String(audio.device.output.id), String(seconds), String(sampleRate), '512',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`baseline player exited ${code}`))));
    });
}

const voices = async (cueId) => (await audio.get('/api/cues/status/playback')).status.voices
    .filter((v) => v.cueId === cueId);

test('a cue plays on when another app changes the device sample rate (WO-025)', async () => {
    const cue = await audio.toneCue({ band: 0, durationSec: 4 });
    await audio.trigger(cue);
    await audio.waitForStatus(cue, 'playing', 5000);
    await sleep(500);
    await otherAppAt(44100, 0.5);
    await sleep(500);
    const before = (await voices(cue))[0]?.positionSec;
    await sleep(500);
    const after = (await voices(cue))[0]?.positionSec;
    assert.ok(Number.isFinite(before) && Number.isFinite(after) && after > before + 0.3,
        `the cue keeps playing after the rate change (position ${before} -> ${after})`);
    // It ends at its own end (4 s), not never.
    await audio.waitForIdle(cue, 6000);
});
