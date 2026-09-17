/**
 * Lists audio output devices on macOS via Core Audio (macos-audio-devices),
 * not via navigator.mediaDevices — avoids microphone permission prompts.
 * deviceId values are Core Audio UIDs; Chromium’s setSinkId accepts these on macOS.
 */

const logger = require('./logger');

/**
 * @returns {Promise<{ deviceId: string, label: string }[]>}
 */
async function listMacOSOutputDevices() {
  let getOutputDevices;
  try {
    ({ getOutputDevices } = require('macos-audio-devices'));
  } catch (err) {
    logger.error('macos-audio-devices could not be loaded:', err);
    throw err;
  }

  const raw = await getOutputDevices();
  const list = Array.isArray(raw) ? raw : [];

  return list
    .filter((d) => d && d.isOutput)
    .map((d) => ({
      deviceId: d.uid,
      label: d.name && String(d.name).trim() ? d.name : d.uid
    }))
    .filter((d) => d.deviceId)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

module.exports = { listMacOSOutputDevices };
