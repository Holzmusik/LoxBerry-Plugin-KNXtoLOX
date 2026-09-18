# Third-Party Notices

## Node-Bruecke (`bin/bridge.js`, MQTT <-> Loxone)

Bindet folgende Open-Source-Bibliotheken ein. Diese Tabelle listet die
direkten Abhängigkeiten aus `bin/package.json` mitsamt Lizenz; der
jeweilige Lizenztext ist beim Originalprojekt verlinkt.

| Modul | Lizenz | Projekt |
|---|---|---|
| mqtt | MIT | https://github.com/mqttjs/MQTT.js |
| ws | MIT | https://github.com/websockets/ws |
| js-yaml | MIT | https://github.com/nodeca/js-yaml |
| node-lox-ws-api | MIT | https://github.com/alladdin/node-lox-ws-api |

Alle vier Lizenzen erlauben uneingeschränkte Nutzung/Weitergabe (auch in
gebündelter Form), solange Copyright-Hinweis und Lizenztext erhalten
bleiben - das übernimmt diese Datei stellvertretend für alle vier.

Für eine vollständige Aufstellung (inkl. transitiver Abhängigkeiten) lokal
nachvollziehbar mit:

```
cd bin && npm install && npm ls --all
```

## Go-Binary `knx-mqtt` (KNX-Bus <-> MQTT, `postroot.sh` baut es aus dem Quellcode)

| Projekt | Lizenz | Quelle |
|---|---|---|
| pakerfeldt/knx-mqtt | MIT | https://github.com/pakerfeldt/knx-mqtt |

Wird bei jeder Installation frisch per `git clone` + `go build` aus dem
Quellcode gebaut (kein vorgefertigtes Binary im Repo) - die vollständige
transitive Abhängigkeitskette dieses Fremdprojekts lässt sich hier nicht
statisch auflisten, siehe dessen eigenes `go.mod`/`go.sum`.

## Web-Frontend (`webfrontend/`)

Nutzt ausschliesslich LoxBerry-eigene Perl-Module (`LoxBerry::System`,
`LoxBerry::Web`) sowie Perl-Core-/Standard-Module - keine zusaetzlichen
Drittanbieter-Abhaengigkeiten im Backend.
