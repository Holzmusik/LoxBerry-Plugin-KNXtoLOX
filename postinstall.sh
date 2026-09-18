#!/bin/bash
# Postinstall (laeuft als User "loxberry"): Node.js-Abhaengigkeiten fuer die
# neue MQTT<->Loxone-Bruecke (bin/bridge.js) installieren. Der Go-Binary
# knx-mqtt selbst braucht keine npm-Abhaengigkeiten, das laeuft ueber
# postroot.sh (Download der fertigen Binary).

# $3 (pfolder) statt hart "knxmqtt" verdrahtet - real bestaetigt als
# Bugursache (2026-09-18): LoxBerry vergibt bei einer Namens-/Ordner-
# Kollision (PluginDB._calculate_md5) automatisch einen anderen
# Ordnernamen (z.B. "knxmqtt_69a"), hartcodiertes "knxmqtt" baute dann
# komplett ins Leere. Siehe postroot.sh fuer die ausfuehrliche Erklaerung.
PLUGIN_FOLDER="${3:-knxmqtt}"
LBHOME="${LBHOMEDIR:-/opt/loxberry}"
RESOLVED_PBIN="${PBIN:-${LBHOME}/bin/plugins/${PLUGIN_FOLDER}}"

echo "PBIN (verwendet): $RESOLVED_PBIN"

if [ ! -d "$RESOLVED_PBIN" ]; then
    echo "Plugin-Verzeichnis nicht gefunden: $RESOLVED_PBIN"
    exit 1
fi

cd "$RESOLVED_PBIN" || exit 1

if ! command -v node &>/dev/null; then
    echo "Node.js nicht gefunden — bitte Node.js >= 18 installieren"
    exit 1
fi

echo "Node.js: $(node --version)"
echo "Installiere Node.js Abhaengigkeiten in $RESOLVED_PBIN ..."
# --ignore-scripts verhindert, dass native Addons (utf-8-validate, bufferutil)
# per node-gyp kompiliert werden. g++ ist auf LoxBerry nicht installiert.
# Die betroffenen Module fallen auf Pure-JS zurueck und laufen einwandfrei.
npm install --omit=dev --ignore-scripts --no-fund --no-audit
echo "Node.js Abhaengigkeiten installiert"
exit 0
