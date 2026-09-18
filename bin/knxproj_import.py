#!/usr/bin/env python3
"""
knxproj_import.py

Liest Gruppenadressen (Adresse, Datenpunkttyp, Name) aus einer ETS-Projektdatei
(.knxproj) aus und schreibt sie als JSON-Liste heraus. Einmaliger, offline
laufender Import - keine laufende ETS-Kopplung.

Aufruf:
    python3 knxproj_import.py --input projekt.knxproj --output out.json [--password PASSWORT]

WICHTIGER HINWEIS zum Passwortschutz:
Ein .knxproj ist im Kern ein ZIP-Archiv mit XML-Dateien. Ist das Projekt in ETS
mit einem Projekt-Passwort exportiert worden, verschlüsselt ETS den Archivinhalt.
Das genaue Verschlüsselungsschema unterscheidet sich zwischen ETS-Versionen
(ETS5 vs. ETS6) und ist nicht öffentlich vollständig dokumentiert. Dieses Skript
versucht zunächst den Standardfall (AES-verschlüsseltes ZIP, wie es einige
ETS-Exportwege nutzen) über die Bibliothek 'pyzipper'. Schlägt das fehl, bricht
das Skript mit einer klaren Fehlermeldung ab, statt falsche Daten zu liefern.

==> Dieser Teil sollte gegen die reale Projektdatei getestet werden. Falls die
    Entschlüsselung nicht auf Anhieb funktioniert, muss das Verfahren anhand
    der tatsächlichen ETS-Version/Exportvariante angepasst werden.
"""

import argparse
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import pyzipper
    HAVE_PYZIPPER = True
except ImportError:
    HAVE_PYZIPPER = False

# ETS-XML nutzt Namespaces wie xmlns="http://knx.org/xml/project/XX"
# Wir ignorieren den Namespace beim Suchen, um versionsunabhaengig zu bleiben.
def strip_ns(tag):
    return tag.split('}')[-1] if '}' in tag else tag


def open_archive(path, password):
    """Oeffnet das .knxproj-Archiv, versucht bei Bedarf mit Passwort zu entschluesseln."""
    if password:
        if not HAVE_PYZIPPER:
            sys.exit("FEHLER: Passwort angegeben, aber 'pyzipper' ist nicht installiert "
                     "(pip install pyzipper --break-system-packages). "
                     "Ohne dieses Modul kann ein passwortgeschuetztes Projekt nicht gelesen werden.")
        try:
            return pyzipper.AESZipFile(path)
        except Exception as e:
            sys.exit(f"FEHLER: Archiv konnte nicht als AES-verschluesseltes ZIP geoeffnet werden: {e}\n"
                      f"Das Verschluesselungsschema dieser ETS-Version weicht vermutlich vom "
                      f"Standardfall ab - bitte Import-Skript anhand der realen Datei anpassen.")
    else:
        return zipfile.ZipFile(path)


def extract_group_addresses(archive, password):
    """Sucht die Projekt-XML-Datei(en) mit den Gruppenadressen und parst sie."""
    results = []
    pwd_bytes = password.encode('utf-8') if password else None

    project_files = [n for n in archive.namelist() if n.lower().endswith('.xml') and '/0.xml' in n.lower()
                      or (n.lower().endswith('.xml') and 'project' in n.lower())]
    # Fallback: alle XML-Dateien durchsuchen, falls obige Heuristik nichts findet
    if not project_files:
        project_files = [n for n in archive.namelist() if n.lower().endswith('.xml')]

    for name in project_files:
        try:
            if isinstance(archive, zipfile.ZipFile):
                data = archive.read(name, pwd=pwd_bytes) if pwd_bytes else archive.read(name)
            else:
                data = archive.read(name, password=pwd_bytes) if pwd_bytes else archive.read(name)
        except Exception:
            continue

        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            continue

        for elem in root.iter():
            if strip_ns(elem.tag) == 'GroupAddress':
                addr_raw = elem.get('Address')
                name_attr = elem.get('Name', '')
                dpts = elem.get('DatapointType', '')  # z.B. "DPST-1-1"
                dpt = _normalize_dpt(dpts)
                addr = _decode_address(addr_raw)
                if addr:
                    results.append({"addr": addr, "dpt": dpt, "label": name_attr})

    return results


def _normalize_dpt(dpst):
    """Wandelt ETS-interne Notation 'DPST-9-1' in unser Format '9.001' um."""
    if not dpst:
        return "raw"
    try:
        parts = dpst.split('-')
        main, sub = int(parts[1]), int(parts[2])
        return f"{main}.{sub:03d}"
    except (IndexError, ValueError):
        return "raw"


def _decode_address(raw):
    """ETS speichert Gruppenadressen z.T. als 16-Bit-Ganzzahl statt 'x/y/z' Text."""
    if raw is None:
        return None
    if '/' in raw:
        return raw
    try:
        val = int(raw)
        main = (val >> 11) & 0x1F
        middle = (val >> 8) & 0x7
        sub = val & 0xFF
        return f"{main}/{middle}/{sub}"
    except ValueError:
        return raw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--password', default='')
    args = parser.parse_args()

    archive = open_archive(args.input, args.password)
    results = extract_group_addresses(archive, args.password)

    if not results:
        sys.exit("FEHLER: Keine Gruppenadressen gefunden. Entweder falsches Passwort, "
                  "unerwartetes Projektformat, oder die Heuristik zum Auffinden der "
                  "Projekt-XML muss angepasst werden.")

    Path(args.output).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"OK: {len(results)} Gruppenadressen exportiert nach {args.output}")


if __name__ == '__main__':
    main()
