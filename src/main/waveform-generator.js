const { workerData, parentPort } = require('worker_threads');
const { audioFilePath } = workerData;
const fs = require('fs');
const { AudioContext } = require('node-web-audio-api');

async function processAudio() {
  try {
    const audioContext = new AudioContext();
    const fileBuffer = fs.readFileSync(audioFilePath);
    const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);

    console.log(`WAVEFORM_GENERATOR: ArrayBuffer byteLength: ${arrayBuffer.byteLength}`);

    const decodedBuffer = await new Promise((resolve, reject) => {
      audioContext.decodeAudioData(arrayBuffer, 
        (buffer) => {
          console.log('WAVEFORM_GENERATOR: decodeAudioData success.');
          if (!buffer || 
              typeof buffer.sampleRate !== 'number' ||
              typeof buffer.numberOfChannels !== 'number' ||
              typeof buffer.duration !== 'number' ||
              !buffer.getChannelData ||
              typeof buffer.getChannelData(0)?.length !== 'number' ) {
            console.error('WAVEFORM_GENERATOR: Decoded buffer from web-audio-api is not in the expected structure.', buffer);
            // This is still a type of decode failure, but more specific.
            reject({ decodeError: true, message: 'Decoded audio buffer from web-audio-api is not in the expected structure.'});
            return;
          }
          resolve(buffer);
        },
        (err) => {
          console.error('WAVEFORM_GENERATOR: decodeAudioData error object:', err);
          let errorMessage = 'Error decoding audio file with web-audio-api';
          if (err && err.message) errorMessage = err.message;
          else if (typeof err === 'string') errorMessage = err; // Should be an Error object from audioContext
          else if (err && typeof err.name === 'string' && typeof err.message === 'string') errorMessage = `${err.name}: ${err.message}`;
          else if (err) errorMessage = String(err); // Fallback for other error types

          reject({ decodeError: true, message: errorMessage }); // Pass structured error
        }
      );
    });

    if (!decodedBuffer) {
      throw new Error('Audio decoding failed, decodedBuffer is null/undefined.');
    }

    // Manual Peak Calculation
    const targetPoints = 2048; // Number of points for the waveform, adjust as needed
    const channelData = decodedBuffer.getChannelData(0); // Use first channel
    const totalSamples = channelData.length;
    const samplesPerPeak = Math.floor(totalSamples / targetPoints);
    const peaks = [];

    for (let i = 0; i < targetPoints; i++) {
      const segmentStart = i * samplesPerPeak;
      const segmentEnd = Math.min(segmentStart + samplesPerPeak, totalSamples);
      let maxVal = 0;
      for (let j = segmentStart; j < segmentEnd; j++) {
        const val = Math.abs(channelData[j]);
        if (val > maxVal) {
          maxVal = val;
        }
      }
      peaks.push(maxVal);
    }
    
    parentPort.postMessage({
      peaks: peaks, // This is now a flat array of positive numbers
      duration: decodedBuffer.duration,
      sampleRate: decodedBuffer.sampleRate,
      numberOfChannels: decodedBuffer.numberOfChannels
    });

  } catch (error) {
    console.error('Waveform Generation Worker Error (manual peaks):', error);
    // Check if the error object already has decodeError, otherwise wrap it
    if (error && error.decodeError) {
        parentPort.postMessage({ error: error }); // Forward the structured error
    } else {
        parentPort.postMessage({ error: { decodeError: false, message: error.message || 'Unknown error in waveform generator' } });
    }
  }
}

processAudio(); 