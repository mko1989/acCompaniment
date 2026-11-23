#!/bin/sh
# Removes the acCompaniment service and program. The data in /var/lib/accompaniment and
# /etc/default/accompaniment are kept; pass --purge to delete them and the "accompaniment" user.
set -eu
if [ "$(id -u)" != 0 ]; then
    echo "Run as root: sudo $0" >&2
    exit 1
fi
systemctl disable --now accompaniment 2>/dev/null || true
rm -f /etc/systemd/system/accompaniment.service
systemctl daemon-reload
rm -rf /opt/accompaniment
if [ "${1:-}" = "--purge" ]; then
    rm -rf /var/lib/accompaniment /etc/default/accompaniment
    userdel accompaniment 2>/dev/null || true
    echo "acCompaniment and its data are removed."
else
    echo "acCompaniment is removed. Its data is kept in /var/lib/accompaniment (--purge deletes it)."
fi
