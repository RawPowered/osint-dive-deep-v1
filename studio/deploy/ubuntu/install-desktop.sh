#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "Run this installer with sudo." >&2; exit 1; }
DESKTOP_USER="${SUDO_USER:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) DESKTOP_USER="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$DESKTOP_USER" && "$DESKTOP_USER" != "root" ]] || { echo "Pass --user YOUR_ADMIN_USER when sudo cannot determine the desktop user." >&2; exit 1; }
id "$DESKTOP_USER" >/dev/null 2>&1 || { echo "User does not exist: $DESKTOP_USER" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y xfce4 xfce4-goodies xfce4-terminal xrdp dbus-x11 firefox
adduser xrdp ssl-cert >/dev/null 2>&1 || true

USER_HOME="$(getent passwd "$DESKTOP_USER" | cut -d: -f6)"
printf '%s\n' 'startxfce4' > "$USER_HOME/.xsession"
chown "$DESKTOP_USER:$DESKTOP_USER" "$USER_HOME/.xsession"
chmod 0600 "$USER_HOME/.xsession"

# Bind RDP to loopback. Reach it through an SSH tunnel instead of exposing 3389.
if grep -q '^address=' /etc/xrdp/xrdp.ini; then
  sed -i 's/^address=.*/address=127.0.0.1/' /etc/xrdp/xrdp.ini
else
  sed -i '/^\[Globals\]/a address=127.0.0.1' /etc/xrdp/xrdp.ini
fi
systemctl enable --now xrdp
systemctl restart xrdp

DESKTOP_DIR="$USER_HOME/Desktop"
install -d -o "$DESKTOP_USER" -g "$DESKTOP_USER" "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/DiveDeep.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=DiveDeep
Comment=Open the local DiveDeep operator interface
Exec=firefox http://127.0.0.1:8501
Icon=applications-internet
Terminal=false
Categories=Network;Utility;
DESKTOP
cat > "$DESKTOP_DIR/DiveDeep Logs.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=DiveDeep Worker Logs
Comment=Follow the local DiveDeep worker service
Exec=xfce4-terminal --command="bash -lc 'sudo journalctl -u divedeep-worker -f'"
Icon=utilities-terminal
Terminal=false
Categories=System;Utility;
DESKTOP
chown "$DESKTOP_USER:$DESKTOP_USER" "$DESKTOP_DIR"/*.desktop
chmod 0755 "$DESKTOP_DIR"/*.desktop

cat <<MSG

XFCE and xRDP are installed for $DESKTOP_USER.
RDP is bound to 127.0.0.1 and is not public.

From your own computer, create a tunnel:
  ssh -L 13389:127.0.0.1:3389 $DESKTOP_USER@YOUR_SERVER_IP

Then open your Remote Desktop client and connect to:
  127.0.0.1:13389

Use the normal Linux password for $DESKTOP_USER. Set one with:
  sudo passwd $DESKTOP_USER
MSG
