acCompaniment - headless Linux server
=====================================

The acCompaniment soundboard without a desktop: a server that plays the audio on this machine
and serves the controls as a web page. Use it from a browser on any device on the network, or
from Bitfocus Companion.

Contents
  accompaniment          the server
  frontend/              the browser UI it serves
  ffmpeg/ffmpeg          decoder for AAC/M4A and a few other formats
  install.sh             installs it as a service that starts at boot (systemd)
  uninstall.sh           removes it again
  accompaniment.service  the systemd unit install.sh sets up
  accompaniment.default  settings, installed as /etc/default/accompaniment

Install as a service
  tar xzf accompaniment-*-linux-*.tar.gz
  cd accompaniment-*-linux-*/
  sudo ./install.sh

  Then open http://<this machine's address>:3333 in a browser.
  The service runs as the system user "accompaniment" (in the "audio" group) and keeps its
  projects, media and settings in /var/lib/accompaniment.

  Status:   systemctl status accompaniment
  Logs:     journalctl -u accompaniment -f
  Restart:  sudo systemctl restart accompaniment
  Settings: /etc/default/accompaniment (port, address, data folder)
  Remove:   sudo /opt/accompaniment/uninstall.sh    (add --purge to delete the data too)

Run it without installing
  ./accompaniment
  It keeps its data in ~/.accompaniment; Ctrl+C stops it. Settings come from the environment:
  PORT, HOST, ACCOMPANIMENT_DATA_DIR.

Audio
  The server plays through ALSA. Pick the output device in the browser UI (App config ->
  Audio Output). On a machine without a desktop that is the sound card itself, which the
  "audio" group may use. On a desktop that runs PipeWire or PulseAudio, a system service can't
  reach the logged-in user's sound server: there, run ./accompaniment as that user instead (or
  use the desktop app with the tray icon).

Requirements
  64-bit Linux (x86-64 or ARM64, e.g. a Raspberry Pi 4/5 with a 64-bit OS), glibc 2.35 or newer
  (Ubuntu 22.04, Debian 12, Raspberry Pi OS bookworm and later), ALSA (libasound2), systemd for
  the service.
