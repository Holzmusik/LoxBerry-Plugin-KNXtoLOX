#!/bin/bash
# postroot.sh wird bei Installation/Update mit Root-Rechten ausgefuehrt.
#
# WICHTIG (2026-09-18, real-hardware-verifiziert): $BINDIR/$CFGDIR/$LOGDIR
# waren hier bisher HART auf "/opt/loxberry/.../knxmqtt" verdrahtet, ohne
# Bezug zum tatsaechlichen, von LoxBerry vergebenen Plugin-Ordnernamen.
# Das brach real bei einer simplen Aenderung der Autoren-E-Mail in
# plugin.cfg: LoxBerrys PluginDB._calculate_md5 hasht Autor+E-Mail+Name+
# Folder - eine geaenderte E-Mail aendert diese Pruefsumme, LoxBerry
# erkannte dadurch eine Namens-/Ordner-Kollision mit der bereits
# installierten Version und vergab automatisch einen neuen Ordnernamen mit
# Suffix (hier: "knxmqtt_69a" statt "knxmqtt"). Die alten hartcodierten
# Pfade bauten daraufhin komplett ins Leere - $BINDIR/$CFGDIR/$LOGDIR
# existierten am Ende gar nicht, die generierten systemd-Units zeigten auf
# nicht-existente Pfade ("Failed to set up standard output: No such file
# or directory"). Gleiches Muster/gleiche Ursachenklasse wie der bereits
# an den Schwester-Plugins gefixte REPLACELBP*-Unit-Bug - hier aber noch
# grundlegender, weil ueberhaupt keine dynamische Aufloesung stattfand.
# Fix: REPLACELBP*-Platzhalter nutzen (von LoxBerrys Installer NACHWEISLICH
# im Skripttext selbst per replaceenv()/sed vor der Ausfuehrung ersetzt -
# das ist der TEIL des Mechanismus, der zuverlaessig funktioniert, siehe
# Kommentare in den Schwester-Plugins), statt den Ordnernamen zu raten.

PSCRIPTFOLDER=$(dirname "$0")

BINDIR="REPLACELBPBINDIR"
CFGDIR="REPLACELBPCONFIGDIR"
LOGDIR="REPLACELBPLOGDIR"
SYSTEMDUNIT="/etc/systemd/system/knxmqtt.service"
BRIDGE_SYSTEMDUNIT="/etc/systemd/system/knxlox-bridge.service"

mkdir -p "$BINDIR" "$CFGDIR" "$LOGDIR"
chown loxberry.loxberry "$LOGDIR" 2>/dev/null || true

# Abhaengigkeiten fuer Gruppenadressen-Tabelle (groupaddresses.yaml, YAML::Tiny),
# Konfigurationsdatei (JSON::PP) und ETS-Import (python3)
apt-get install -y libyaml-tiny-perl libtext-csv-perl libjson-pp-perl python3-pip
pip3 install pyzipper --break-system-packages || echo "WARNUNG: pyzipper konnte nicht installiert werden - ETS-Import mit Passwort wird nicht funktionieren."

# knxd wird unconditional installiert (nicht nur wenn bus_mode=knxd default ist),
# damit ein spaeterer Moduswechsel Gira->knxd ueber die Web-UI ohne erneute
# Plugin-Installation funktioniert. Bleibt disabled, bis die Web-UI (api.cgi,
# action=config) bus_mode=knxd tatsaechlich aktiviert.
echo "Installiere knxd..."
apt-get install -y knxd knxd-tools 2>&1 || echo "WARNUNG: knxd konnte nicht installiert werden - der knxd-Bus-Modus wird nicht funktionieren."

# Initiale /etc/knxd.conf nur anlegen, falls noch keine existiert (spaeter
# ausschliesslich ueber api.cgi's build_knxd_opts()/write_knxd_conf()
# ueberschrieben, sobald der Nutzer Werte in der Web-UI speichert). Das
# Debian-knxd-Paket bringt sein eigenes systemd-Unit mit (liest diese Datei
# als EnvironmentFile) - wir erzeugen hier KEIN eigenes knxd-Unit.
if [ ! -f /etc/knxd.conf ]; then
  cat > /etc/knxd.conf <<'EOF'
KNXD_OPTS="-e 0.0.1 -E 0.0.2:10 -D --listen-tcp=3671 -b tpuarts:/dev/ttyAMA0"
EOF
fi
systemctl disable knxd.service 2>/dev/null || true

# knx-mqtt Binary: es gibt KEINE GitHub-Releases fuer pakerfeldt/knx-mqtt
# (verifiziert: "There aren't any releases here") - der urspruengliche
# Download-Versuch gegen eine erfundene Release-URL (v0.5.0/knx-mqtt_arm64)
# schlug deshalb immer mit HTTP 404 fehl. Stattdessen aus dem Quellcode bauen
# (Einstiegspunkt: cmd/main.go, go.mod verlangt Go >=1.23, Toolchain 1.24.3).
#
# Debians golang-go-Paket ist oft aelter als 1.21 (die Version, ab der Go
# selbststaendig die in go.mod per "toolchain"-Zeile geforderte neuere
# Version nachladen kann) - deshalb hier zuerst pruefen und bei Bedarf das
# offizielle Go-Tarball direkt von go.dev installieren, statt auf ein evtl.
# zu altes Distributions-Go zu vertrauen.
NEED_GO_INSTALL=1
if command -v go &>/dev/null; then
  GO_VER="$(go version | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/go//')"
  GO_MAJOR="${GO_VER%%.*}"
  GO_MINOR="${GO_VER##*.}"
  if [ "${GO_MAJOR:-0}" -gt 1 ] || { [ "${GO_MAJOR:-0}" -eq 1 ] && [ "${GO_MINOR:-0}" -ge 21 ]; }; then
    NEED_GO_INSTALL=0
  fi
fi

if [ "$NEED_GO_INSTALL" = "1" ]; then
  echo "Kein ausreichend aktuelles Go gefunden (>=1.21 fuer automatischen Toolchain-Nachlad noetig) - installiere offizielles Go-Tarball..."
  case "$(dpkg --print-architecture)" in
    arm64) GOTAR_ARCH="arm64" ;;
    armhf) GOTAR_ARCH="armv6l" ;;
    amd64) GOTAR_ARCH="amd64" ;;
    *) GOTAR_ARCH="arm64" ;;
  esac
  GO_BOOTSTRAP_VERSION="go1.24.3"
  curl -fsSL "https://go.dev/dl/${GO_BOOTSTRAP_VERSION}.linux-${GOTAR_ARCH}.tar.gz" -o /tmp/go.tar.gz \
    && rm -rf /usr/local/go \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm -f /tmp/go.tar.gz
  export PATH="/usr/local/go/bin:$PATH"
fi

if ! command -v go &>/dev/null; then
  echo "FEHLER: Go-Compiler konnte nicht installiert werden - knx-mqtt kann nicht gebaut werden." >&2
  exit 1
fi
echo "Go-Version: $(go version)"

apt-get install -y git

# Fester Commit statt "main": die Bridge haengt vom genauen MQTT-Verhalten
# von knx-mqtt ab (Topic-Format, wie Read-Telegramme veroeffentlicht werden -
# dort weicht der Code vom README ab). Ein ungetesteter Upstream-Stand darf
# nicht unbemerkt bei einer Neuinstallation landen. Zum Aktualisieren: neuen
# Commit gegen bin/bridge.js pruefen und hier eintragen.
KNXMQTT_REPO="https://github.com/pakerfeldt/knx-mqtt.git"
KNXMQTT_COMMIT="e2e9c388ef91e5c778b72bd8752e2e1eeff350df"

GOBUILD_DIR="$(mktemp -d)"
echo "Baue knx-mqtt ($KNXMQTT_COMMIT) aus dem Quellcode in $GOBUILD_DIR ..."
git -C "$GOBUILD_DIR" init -q \
  && git -C "$GOBUILD_DIR" fetch -q --depth 1 "$KNXMQTT_REPO" "$KNXMQTT_COMMIT" \
  && git -C "$GOBUILD_DIR" checkout -q FETCH_HEAD \
  && (cd "$GOBUILD_DIR" && go build -o "$BINDIR/knx-mqtt" ./cmd)
rm -rf "$GOBUILD_DIR"
chmod +x "$BINDIR/knx-mqtt" 2>/dev/null

if [ ! -x "$BINDIR/knx-mqtt" ]; then
  echo "FEHLER: Bauen des knx-mqtt Binaries aus dem Quellcode fehlgeschlagen." >&2
  exit 1
fi

# Von preupgrade.sh gesicherte Einstellungen wiederherstellen (siehe dort):
# LoxBerrys eigener Installer loescht "$CFGDIR" bei JEDEM Update komplett,
# BEVOR postroot.sh ueberhaupt laeuft (real bestaetigt, 2026-09-18: nach
# einem Update waren config.yaml/bridge.json weg - dieses Plugin hatte
# bislang, anders als die Schwester-Plugins, gar kein preupgrade.sh, das
# das abgefangen haette). Bei einer echten Erstinstallation existiert kein
# Backup (preupgrade.sh laeuft dann gar nicht erst) - dann greift wie
# bisher die mitgelieferte Default-Config unten.
BACKUP_DIR="/tmp/knxmqtt-preupgrade-backup"
if [ -f "$BACKUP_DIR/config.yaml" ]; then
  cp -a "$BACKUP_DIR/config.yaml" "$CFGDIR/config.yaml"
  echo "config.yaml aus Preupgrade-Backup wiederhergestellt"
fi
if [ -f "$BACKUP_DIR/bridge.json" ]; then
  cp -a "$BACKUP_DIR/bridge.json" "$CFGDIR/bridge.json"
  echo "bridge.json aus Preupgrade-Backup wiederhergestellt"
fi
if [ -f "$BACKUP_DIR/groupaddresses.yaml" ]; then
  cp -a "$BACKUP_DIR/groupaddresses.yaml" "$CFGDIR/groupaddresses.yaml"
  echo "groupaddresses.yaml aus Preupgrade-Backup wiederhergestellt"
fi
rm -rf "$BACKUP_DIR"

# Migration v0.3.0: bestehende config.yaml (vom Backup wiederhergestellt,
# nur beim Speichern in der Web-UI neu erzeugt) auf ignoreReadCommands: true
# umstellen - sonst kommen Bus-Leseanfragen bis zum naechsten Speichern
# weiter als leere Werte bei der Bridge an.
if [ -f "$CFGDIR/config.yaml" ]; then
  sed -i 's/^\([[:space:]]*ignoreReadCommands:[[:space:]]*\)false/\1true/' "$CFGDIR/config.yaml"
fi

# Default-Config anlegen, falls noch keine existiert (wird spaeter ueber Web-UI ueberschrieben)
if [ ! -f "$CFGDIR/config.yaml" ]; then
  cp "$PSCRIPTFOLDER/config/config.yaml.default" "$CFGDIR/config.yaml"
fi
if [ ! -f "$CFGDIR/bridge.json" ]; then
  cp "$PSCRIPTFOLDER/config/bridge.json" "$CFGDIR/bridge.json"
fi
# postroot.sh laeuft als root - jede hier neu angelegte/kopierte Datei in
# CFGDIR gehoert sonst root, obwohl api.cgi (laeuft als "loxberry") sie
# spaeter beim Speichern ueberschreiben koennen muss.
chown -R loxberry.loxberry "$CFGDIR" 2>/dev/null || true

# knx-mqtt (Go-Binary, KNX-Bus <-> MQTT) systemd-Unit installieren.
# WICHTIG: sed statt cp (siehe Kommentar oben) - die Vorlage nutzt jetzt
# REPLACELBP*-Platzhalter statt hartcodierter Pfade.
sed \
  -e "s#REPLACELBPBINDIR#$BINDIR#g" \
  -e "s#REPLACELBPCONFIGDIR#$CFGDIR#g" \
  -e "s#REPLACELBPLOGDIR#$LOGDIR#g" \
  "$PSCRIPTFOLDER/templates/system/etc/systemd/system/knxmqtt.service" > "$SYSTEMDUNIT"

# Neue Node-Bruecke (bin/bridge.js, MQTT <-> Loxone) systemd-Unit dynamisch
# erzeugen - nutzt bereits die oben korrekt aufgeloesten $BINDIR/$LOGDIR,
# kein eigener Platzhalter-Ersatz noetig (gleiches Heredoc-Muster wie
# MiraiPanel/postroot.sh).
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "WARNUNG: Node.js nicht gefunden - knxlox-bridge.service wird nicht gestartet"
else
  cat > "$BRIDGE_SYSTEMDUNIT" <<EOF
[Unit]
Description=KNXtoLOX Node-Bruecke (MQTT <-> Loxone)
After=network-online.target mosquitto.service knxmqtt.service
Wants=network-online.target

[Service]
Type=simple
Environment=LBHOMEDIR=/opt/loxberry
ExecStart=${NODE_BIN} ${BINDIR}/bridge.js
WorkingDirectory=${BINDIR}
Restart=on-failure
RestartSec=5
User=loxberry
StandardOutput=append:${LOGDIR}/bridge.log
StandardError=append:${LOGDIR}/bridge.log

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$BRIDGE_SYSTEMDUNIT"
fi

systemctl daemon-reload
systemctl enable knxmqtt.service
systemctl restart knxmqtt.service
if [ -f "$BRIDGE_SYSTEMDUNIT" ]; then
  systemctl enable knxlox-bridge.service
  systemctl restart knxlox-bridge.service
fi

# Logrotate installieren (2026-09-18: ohne das wachsen Logdateien
# unbegrenzt - real beobachtet: bridge.log auf 4,6MB und wachsend, siehe
# Session-Notizen zum easeemqtt/knxmqtt/miraibridge-Vorfall). Deckt sowohl
# knxmqtt.log (Go-Binary) als auch bridge.log (Node-Bruecke) ab. sed statt
# cp, aus demselben Grund wie oben bei der systemd-Unit.
sed \
  -e "s#REPLACELBPLOGDIR#$LOGDIR#g" \
  "$PSCRIPTFOLDER/templates/system/etc/logrotate.d/knxmqtt" > /etc/logrotate.d/knxmqtt

echo "KNX-MQTT Plugin Installation abgeschlossen."
exit 0
