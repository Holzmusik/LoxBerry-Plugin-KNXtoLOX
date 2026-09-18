#!/bin/bash
systemctl stop knxmqtt.service 2>/dev/null
systemctl disable knxmqtt.service 2>/dev/null
rm -f /etc/systemd/system/knxmqtt.service

systemctl stop knxlox-bridge.service 2>/dev/null
systemctl disable knxlox-bridge.service 2>/dev/null
rm -f /etc/systemd/system/knxlox-bridge.service
rm -f /etc/logrotate.d/knxmqtt

# knxd NICHT anfassen - gemeinsamer Systemdienst, der ggf. von anderer
# Software mitgenutzt wird; bleibt installiert/enabled wie er war.

systemctl daemon-reload
exit 0
