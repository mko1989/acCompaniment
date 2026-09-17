#!/usr/bin/env node
/**
 * Enumerate RtAudio output devices and channel counts (ENG1 acceptance test).
 *
 * If native module fails to load after npm install, retry with:
 *   CMAKE_POLICY_VERSION_MINIMUM=3.5 npm install
 * (CMake 4.x rejects older cmake_minimum_required in the addon.)
 */

const { RtAudio } = require('@hamitzor/rtaudio.js');

function main() {
    const rt = new RtAudio();

    console.log(`RtAudio version: ${RtAudio.getVersion()}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Default output device id: ${rt.getDefaultOutputDevice()}`);
    console.log('');

    const devices = rt.getDevices().filter((d) => d.outputChannels > 0);

    if (devices.length === 0) {
        console.error('No output devices found.');
        process.exit(1);
    }

    console.log(`Output devices (${devices.length}):`);
    console.log('');

    for (const device of devices) {
        const flags = [];
        if (device.isDefaultOutput) flags.push('default');
        console.log(
            `[${device.id}] ${device.name}`
        );
        console.log(
            `    outputChannels: ${device.outputChannels}`
            + (flags.length ? ` (${flags.join(', ')})` : '')
        );
        console.log(
            `    preferredSampleRate: ${device.preferredSampleRate}`
        );
        if (device.sampleRates.length) {
            console.log(`    sampleRates: ${device.sampleRates.join(', ')}`);
        }
        console.log('');
    }

    const multichannel = devices.filter((d) => d.outputChannels > 2);
    console.log(`Multichannel devices (>2 outputs): ${multichannel.length}`);
    if (multichannel.length === 0) {
        console.log('(Plug in an external interface to validate >2 channel routing.)');
    }

    process.exit(0);
}

try {
    main();
} catch (error) {
    console.error('Failed to load or probe RtAudio:', error.message || error);
    console.error('');
    console.error('On CMake 4.x, rebuild with:');
    console.error('  CMAKE_POLICY_VERSION_MINIMUM=3.5 npm install @hamitzor/rtaudio.js');
    process.exit(1);
}
