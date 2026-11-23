#!/bin/sh
# Installs acCompaniment as a system service: the server in /opt/accompaniment, its data in
# /var/lib/accompaniment, run by the system user "accompaniment" (member of "audio"), started at
# boot. Run it again to update; the data and /etc/default/accompaniment are kept.
set -eu
if [ "$(id -u)" != 0 ]; then
    echo "Run as root: sudo ./install.sh" >&2
    exit 1
fi
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
prefix=/opt/accompaniment

if ! id accompaniment >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/accompaniment --no-create-home \
        --shell /usr/sbin/nologin accompaniment
fi
if getent group audio >/dev/null; then
    usermod -a -G audio accompaniment
fi

if systemctl is-active --quiet accompaniment; then
    systemctl stop accompaniment
fi
mkdir -p "$prefix"
rm -rf "$prefix/frontend" "$prefix/ffmpeg"
cp -R "$here/accompaniment" "$here/frontend" "$here/ffmpeg" "$here/README.txt" "$here/uninstall.sh" "$prefix/"
chmod 755 "$prefix/accompaniment" "$prefix/ffmpeg/ffmpeg" "$prefix/uninstall.sh"

install -m 644 "$here/accompaniment.service" /etc/systemd/system/accompaniment.service
if [ ! -f /etc/default/accompaniment ]; then
    install -m 644 "$here/accompaniment.default" /etc/default/accompaniment
fi
systemctl daemon-reload
systemctl enable accompaniment >/dev/null
systemctl start accompaniment

port=$(sed -n 's/^PORT=//p' /etc/default/accompaniment | tail -1)
echo "acCompaniment is installed and running."
echo "Open http://$(hostname -I 2>/dev/null | cut -d' ' -f1 || hostname):${port:-3333} in a browser."
echo "Logs: journalctl -u accompaniment -f"
