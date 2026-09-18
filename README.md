# LoxBerry-Plugin-KNXtoLOX (intern: knxmqtt)

Bidirektionale KNX <-> Loxone Bruecke fuer LoxBerry ueber MQTT, optisch und
architektonisch an das MiraiPanel-Plugin angelehnt. Auf der Loxone-Seite werden
virtuelle Ein-/Ausgaenge angesprochen (`jdev/sps/io/<uuid>/<value>`), es werden
nur explizit in der Gruppenadressen-Tabelle konfigurierte Adressen ueberhaupt
verarbeitet (Allowlist-Prinzip, kein Wildcard-Traffic).

## Architektur

```
KNX-Bus -> Gira KNX/IP-Gateway ODER lokales knxd (NCN5121/CM5-Board)
        -> knx-mqtt (Go-Binary, systemd: knxmqtt.service)
        -> MQTT-Broker (LoxBerrys lokales Mosquitto)
        -> bin/bridge.js (Node, systemd: knxlox-bridge.service)
        -> Loxone virtuelle Ein-/Ausgaenge (node-lox-ws-api)
```

Zwei unabhaengige Dienste teilen sich die Arbeit:

- **knx-mqtt** (`pakerfeldt/knx-mqtt`, aus dem Quellcode gebaut - es gibt keine
  fertigen GitHub-Releases dafuer) übernimmt ausschliesslich KNX-Bus <-> MQTT.
  Konfiguration in `config/config.yaml` - wird von der Web-UI bei jedem
  Speichern komplett neu geschrieben, NIE zurueckgelesen (reines Schreibziel).
- **bin/bridge.js** (eigener Node-Daemon) übernimmt MQTT <-> Loxone. Liest
  `config/bridge.json` (eigene UI-Einstellungen, u.a. Miniserver-Nummer) und
  `config/groupaddresses.yaml` (die Zuordnungstabelle) nur beim eigenen Start -
  kein Live-Reload. Die Web-UI startet ihn deshalb automatisch neu, sobald die
  Gruppenadressen-Tabelle gespeichert wird.

Miniserver- und MQTT-Broker-Zugangsdaten werden nirgends im Plugin dupliziert,
sondern bei jedem Bedarf direkt aus LoxBerrys `config/system/general.json`
gelesen.

## Web-UI

Eine einzige Single-Page-App (`webfrontend/htmlauth/index.cgi` + `api.cgi`,
JSON-Action-Dispatch), Design 1:1 an MiraiPanels `.mp-app`-System angelehnt
(`.kx-app`-Klasse). Seiten: Uebersicht (Dienst-Status, Export/Import),
Bus-Verbindung (Gira/knxd-Umschalter, KNX-Zeitgeber), MQTT, Gruppenadressen
(Tabelle, ETS-/CSV-Import/Export, UUID-Picker), Status (Live-Aktivitaet der
letzten 50 Ereignisse, Rohlogs beider Dienste), Debug (Web-UI-eigenes Log).

### Gruppenadressen-Tabelle

Jede Zeile: `addr` (KNX-Gruppenadresse), `dpt` (Freitext, z.B. "9.001" -
keine feste Liste, da reale ETS-Projekte weit mehr Subtypen enthalten als
sich sinnvoll vorab pflegen liessen), `label`, sowie zwei getrennte
Loxone-UUID-Felder:

- `lox_input_uuid`: KNX-Zustand geaendert -> wird per `jdev/sps/io` auf diese
  UUID geschrieben (Kommando-Ziel, meist ein virtueller Eingang).
- `lox_output_uuid`: diese Loxone-Zustands-UUID wird per WebSocket beobachtet;
  Aenderungen werden als KNX-Bus-Schreibbefehl publiziert. **Wichtig**: das
  muss die tatsaechliche Zustands-UUID sein (z.B. `states.active` bei einem
  Schalter), nicht die UUID der Steuerung selbst - der eingebaute UUID-Picker
  unterscheidet das bereits (zwei getrennte Listen fuer Eingang/Ausgang).

### DPT-Codec (`bin/dptCodec.js`)

Dispatcht nach KNX-Hauptgruppe (Zahl vor dem Punkt), nicht nach exaktem
Subtyp - deckt damit praktisch jeden real vorkommenden DPT ab, ohne ihn
einzeln zu kennen: 1.x (bool), 3.x (4-Bit), 5.x (8-Bit, 5.001 mit
Prozent-Skalierung), 6.x (8-Bit signed), 7.x/8.x (16-Bit), 9.x (KNX-Float16),
10.x/11.x (Zeit/Datum, nur fuer den Zeitgeber), 12.x/13.x (32-Bit),
14.x (IEEE-754-Float), 17.x/18.x/20.x (Szene/Enum, 1 Byte roh). Unbekannte
Hauptgruppen fallen auf Rohbyte-Durchreichung zurueck statt zu werfen.

## ETS-Projekt-Import (`bin/knxproj_import.py`)

Liest Gruppenadressen/DPT/Namen einmalig aus einer `.knxproj`-Datei aus
(offline, keine laufende ETS-Kopplung). Der unverschluesselte Fall ist ueber
Standard-ZIP+XML-Parsing abgedeckt.

**Wichtig:** Ist das Projekt in ETS mit einem Passwort geschuetzt,
unterscheidet sich das Verschluesselungsschema je nach ETS-Version und ist
nicht vollstaendig oeffentlich dokumentiert. Das Skript versucht den
Standardfall (AES-ZIP via `pyzipper`) - schlaegt das fehl, liefert es eine
klare Fehlermeldung statt falscher Daten.

## KNX-Zeitgeber

Optional: pusht die LoxBerry-Systemzeit einmal pro Minute auf zwei
konfigurierbare Gruppenadressen (DPT 10.001 Uhrzeit, DPT 11.001 Datum) -
leer lassen = deaktiviert.

## Konfiguration sichern & wiederherstellen

Export/Import buendelt Bus-/MQTT-Einstellungen UND die komplette
Gruppenadressen-Tabelle in einer Datei (z.B. vor einer Neuinstallation).
Enthaelt keine Zugangsdaten - die kommen ohnehin aus LoxBerry selbst.

## Installation

1. Plugin als ZIP ueber "Plugin installieren" hochladen.
2. `postroot.sh` baut `knx-mqtt` aus dem Quellcode (braucht Internetzugriff
   fuer `go.dev`/GitHub), installiert `knxd`+`knxd-tools`, richtet beide
   systemd-Dienste ein.
3. Unter "Bus-Verbindung": Gira-Gateway ODER knxd auswaehlen und
   konfigurieren, Verbindung testen.
4. Unter "Gruppenadressen": ETS-Projekt oder CSV importieren, Loxone-Ziele
   per UUID-Picker zuweisen.
5. Unter "Status": Live-Aktivitaet pruefen, ob Ereignisse tatsaechlich
   durchlaufen.

## Bekannte offene Punkte

- knxd's tatsaechliche `KNXD_OPTS`-Flag-Syntax (`api.cgi build_knxd_opts()`)
  ist noch nicht auf einem echten NCN5121-Board verifiziert.
- Der KNXnet/IP-Verbindungstest (`action=knx_test`, Unicast-SEARCH_REQUEST)
  ist noch nicht gegen alle Zielgeraetetypen verifiziert.
- MQTT-Passwort liegt (wie bei knx-mqtt vorgegeben) im Klartext in
  `config.yaml`.
- Mehrsprachigkeit der Web-UI: aktuell nur Deutsch.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Drittanbieter-Abhängigkeiten stehen in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
