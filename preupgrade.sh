#!/bin/bash
# preupgrade.sh laeuft bei einem UPDATE (nicht bei der Erstinstallation) als
# User "loxberry", BEVOR LoxBerrys eigener Installer die vorherige Version
# entfernt ("purge_installation" in sbin/plugininstall.pl - loescht bei
# JEDEM Update komplett "config/plugins/<folder>/", inklusive config.yaml,
# bridge.json UND groupaddresses.yaml). Sichert alle drei an einen Ort
# ausserhalb von config/plugins/... - postroot.sh (das NACH der Neuanlage
# des Ordners laeuft) stellt sie wieder her. Gleiches Muster wie bei den
# Schwester-Plugins EaseeMQTT/froniusmqtt/MiraiPanel - hier bislang (bis
# 2026-09-18) gefehlt, dadurch gingen bei einem Update tatsaechlich alle
# Einstellungen (Gruppenadressen-Zuordnungen inklusive) verloren.
#
# Echte Parameterreihenfolge (siehe plugininstall.pl, identisch zu
# postroot.sh): $1=tempfile $2=pname $3=pfolder $4=pversion $5=lbhomedir
# $6=tempfolder
LBHOMEDIR="${5:-/opt/loxberry}"
PFOLDER="${3:-knxmqtt}"
CFGDIR="$LBHOMEDIR/config/plugins/$PFOLDER"
BACKUP_DIR="/tmp/knxmqtt-preupgrade-backup"

mkdir -p "$BACKUP_DIR"
[ -f "$CFGDIR/config.yaml" ] && cp -a "$CFGDIR/config.yaml" "$BACKUP_DIR/config.yaml"
[ -f "$CFGDIR/bridge.json" ] && cp -a "$CFGDIR/bridge.json" "$BACKUP_DIR/bridge.json"
[ -f "$CFGDIR/groupaddresses.yaml" ] && cp -a "$CFGDIR/groupaddresses.yaml" "$BACKUP_DIR/groupaddresses.yaml"

exit 0
