// Prints the RtAudio device list as JSON. Run as its own process (see
// loopback.js) so discovery is synchronous and leaves no RtAudio object
// behind in the test process.
const { RtAudio } = require('@hamitzor/rtaudio.js');

const rt = new RtAudio();
const devices = rt.getDevices().map((d) => ({
    id: d.id,
    name: d.name,
    inputChannels: d.inputChannels,
    outputChannels: d.outputChannels,
    sampleRates: d.sampleRates,
    preferredSampleRate: d.preferredSampleRate,
}));
process.stdout.write(JSON.stringify(devices));
process.exit(0);
