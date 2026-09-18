#!/usr/bin/perl
# KNXtoLOX Haupt-UI — eine einzige Single-Page-App, ersetzt die bisherigen
# settings.html/groupaddresses.html/log.cgi. Optik 1:1 an MiraiPanel angelehnt
# (siehe MiraiPanel/webfrontend/htmlauth/index.php), Klasse .mp-app -> .kx-app.
use LoxBerry::System;
use LoxBerry::Web;
use CGI;
use strict;
use warnings;

my $cgi = CGI->new;
print $cgi->header(-charset => 'utf-8');
LoxBerry::Web::lbheader("KNX-MQTT Bridge");
print <<'HTML';
<style>
.kx-app {
  --bg:      var(--lb-bg, #f7f7f7);
  --surface: var(--lb-card-bg, #fff);
  --surf2:   var(--lb-input-bg, #f5f5f5);
  --brd:     var(--lb-border-color, #e5e5e5);
  --txt:     var(--lb-text, #171717);
  --txt2:    var(--lb-text-muted, #737373);
  --acc:     var(--lb-primary, #6dac20);
  --warn:    var(--lb-warning, #ca8a04);
  --danger:  var(--lb-danger, #dc2626);
  --radius:  var(--lb-radius, 12px);
  color: var(--txt); font: 14px/1.5 system-ui, sans-serif;
}
.kx-app, .kx-app * { box-sizing: border-box; margin: 0; padding: 0; }

.kx-app .shell { display: flex; min-height: 640px; background: var(--bg); border-radius: var(--radius); overflow: hidden; border: 1px solid var(--brd); }
.kx-app .sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--brd); display: flex; flex-direction: column; flex-shrink: 0; }
.kx-app .sidebar-logo { padding: 20px 18px 12px; font-size: 17px; font-weight: 700; color: var(--acc); letter-spacing: -.3px; border-bottom: 1px solid var(--brd); }
.kx-app .sidebar-logo span { color: var(--txt2); font-weight: 400; font-size: 12px; display: block; margin-top: 2px; }
.kx-app .nav { flex: 1; padding: 8px 0; }
.kx-app .nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 18px; cursor: pointer; color: var(--txt2); border-left: 3px solid transparent; transition: all .15s; }
.kx-app .nav-item:hover { color: var(--txt); background: var(--surf2); }
.kx-app .nav-item.active { color: var(--acc); border-left-color: var(--acc); background: rgba(102,205,0,.07); }
.kx-app .main { flex: 1; overflow: hidden; padding: 28px; min-height: 0; display: flex; flex-direction: column; }

.kx-app .page { display: none; }
.kx-app .page.active { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; }
.kx-app h2 { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
.kx-app h3 { font-size: 14px; font-weight: 600; margin-bottom: 14px; color: var(--txt2); text-transform: uppercase; letter-spacing: .5px; }
.kx-app .card { background: var(--surface); border: 1px solid var(--brd); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
.kx-app .card-title { font-size: 15px; font-weight: 600; margin-bottom: 16px; }
.kx-app .card-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.kx-app .card-title-row .card-title { margin-bottom: 0; }
.kx-app .card-toggle { cursor: pointer; color: var(--txt2); font-size: 12px; user-select: none; }
.kx-app .card-toggle:hover { color: var(--txt); }
.kx-app .log-hidden { display: none; }
.kx-app .hint { font-size: 12px; color: var(--txt2); margin-top: 6px; }

.kx-app select {
  /* !important auf Farb-/Rahmen-Eigenschaften: irgendetwas (LoxBerrys eigenes
     Chrome-CSS oder Browser-Zwangsfarben fuer native Formularelemente)
     ueberschreibt sonst genau diese Werte bei <select>/<input type=checkbox>,
     obwohl alle anderen Elemente (Textfelder, Buttons, Cards) korrekt das
     dunkle Theme uebernehmen - auf echter Hardware beobachtet. */
  background-color: var(--surf2) !important;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center;
  appearance: none; -webkit-appearance: none; -moz-appearance: none;
  border: 1px solid var(--brd) !important; border-radius: 8px; padding: 9px 32px 9px 12px;
  color: var(--txt) !important; font-size: 14px; outline: none; cursor: pointer;
}
.kx-app select:focus { border-color: var(--acc) !important; box-shadow: 0 0 0 3px rgba(102,205,0,.15); }
.kx-app select option { background: var(--surf2) !important; color: var(--txt) !important; }
.kx-app input[type=text], .kx-app input[type=number], .kx-app input[type=password], .kx-app input[type=file] {
  background: var(--surf2); border: 1px solid var(--brd); border-radius: 8px; padding: 9px 12px; color: var(--txt); font-size: 14px; outline: none;
}
.kx-app input:focus { border-color: var(--acc); }
/* Eigener div-basierter Toggle statt <input type=checkbox>: jQuery Mobile
   (Teil von LoxBerrys Chrome) "verbessert" native Checkboxen automatisch zu
   seinem eigenen .ui-checkbox/.ui-btn-Widget - weder data-enhance="false"
   auf dem Container noch data-role="none" auf dem <input> selbst hat das
   auf echter Hardware verhindert (beides ausprobiert, siehe Git-Historie/
   Notizen). Ein <div> hat fuer jQuery Mobile kein erkennbares
   Formular-Element-Muster und wird deshalb gar nicht erst angefasst.
   Zustand wird ueber data-checked="true"/"false" gehalten, siehe
   toggleSwitch()/isToggled()/setToggled() im Script unten. */
.kx-app .toggle {
  width: 36px; height: 20px; min-width: 36px; flex-shrink: 0;
  border-radius: 10px; background: var(--surf2); border: 1px solid var(--brd);
  position: relative; cursor: pointer; transition: background .15s, border-color .15s;
}
.kx-app .toggle::after {
  content: ''; position: absolute; top: 1px; left: 1px;
  width: 16px; height: 16px; border-radius: 50%; background: var(--txt2);
  transition: transform .15s, background .15s;
}
.kx-app .toggle[data-checked="true"] { background: var(--acc); border-color: var(--acc); }
.kx-app .toggle[data-checked="true"]::after { transform: translateX(16px); background: #000; }
.kx-app .checkfield label { flex: 1; cursor: pointer; }

.kx-app .field { margin-bottom: 14px; }
.kx-app .field label { display: block; font-size: 12px; color: var(--txt2); margin-bottom: 5px; }
.kx-app .field input, .kx-app .field select { width: 100%; }
.kx-app .row { display: flex; gap: 12px; }
.kx-app .row .field { flex: 1; }
.kx-app .checkfield { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }

.kx-app .btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 500; transition: opacity .15s; }
.kx-app .btn:hover { opacity: .85; }
.kx-app .btn-primary { background: var(--acc); color: #000; }
.kx-app .btn-secondary { background: var(--surf2); color: var(--txt); border: 1px solid var(--brd); }
.kx-app .btn-danger { background: var(--danger); color: #fff; }
.kx-app .btn-sm { padding: 6px 12px; font-size: 13px; }
.kx-app .btn-group { display: flex; gap: 10px; margin-top: 18px; margin-bottom: 20px; flex-wrap: wrap; }

.kx-app table.ga-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.kx-app table.ga-table th { text-align: left; color: var(--txt2); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--brd); font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
/* !important: gleiche Verteidigung wie bei select/toggle oben - LoxBerrys
   eigenes Chrome-CSS greift auch Tabellenzellen an und ueberschreibt sonst
   Textfarben mit einem zu dunklen/kontrastarmen Grauton auf dem dunklen Theme. */
.kx-app table.ga-table td { padding: 5px 8px; border-bottom: 1px solid var(--brd); color: var(--txt) !important; }
.kx-app table.ga-table input, .kx-app table.ga-table select { width: 100%; padding: 6px 8px; font-size: 13px; }
.kx-app table.ga-table .ga-del { cursor: pointer; color: var(--danger); font-size: 16px; }
.kx-app table.ga-table td.mono { font-variant-numeric: tabular-nums; color: var(--txt2) !important; white-space: nowrap; }
.kx-app .dir-badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.kx-app .dir-badge.knx-lox { background: rgba(109,172,32,.16); color: #8fd13f; }
.kx-app .dir-badge.lox-knx { background: rgba(202,138,4,.16); color: #e0ad1f; }
.kx-app .dir-badge.zeitgeber { background: rgba(59,130,246,.16); color: #6ea8fe; }

.kx-app .badge { font-size: 11px; padding: 3px 8px; border-radius: 20px; background: var(--surf2); color: var(--txt2); border: 1px solid var(--brd); }
.kx-app .status-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--surf2); border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
.kx-app .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--txt2); flex-shrink: 0; }
.kx-app .status-dot.ok { background: var(--acc); }
.kx-app .status-dot.err { background: var(--danger); }
.kx-app pre.log { background: #111; color: #0f0; padding: 12px; border-radius: 8px; overflow: auto; max-height: 45vh; font-size: 12px; }
.kx-app .toast { position: fixed; bottom: 24px; right: 24px; background: var(--surf2); border: 1px solid var(--brd); border-radius: 10px; padding: 12px 18px; font-size: 13px; box-shadow: 0 4px 20px rgba(0,0,0,.5); transform: translateY(80px); opacity: 0; transition: all .25s; z-index: 999; }
.kx-app .toast.show { transform: translateY(0); opacity: 1; }
.kx-app .toast.ok  { border-color: var(--acc); }
.kx-app .toast.err { border-color: var(--danger); }
.kx-app .divider { border: none; border-top: 1px solid var(--brd); margin: 20px 0; }

/* UUID-Picker-Modal (Gruppenadressen-Tabelle -> Loxone-Objekt auswaehlen) */
.kx-app .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; align-items: center; justify-content: center; }
.kx-app .modal-backdrop.show { display: flex; }
.kx-app .modal { background: var(--surface); border: 1px solid var(--brd); border-radius: var(--radius); width: 480px; max-width: 92vw; max-height: 80vh; display: flex; flex-direction: column; padding: 20px; }
.kx-app .modal-list { overflow-y: auto; flex: 1; margin-top: 10px; display: flex; flex-direction: column; gap: 2px; }
.kx-app .modal-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.kx-app .modal-item:hover { background: var(--surf2); }
.kx-app .modal-item .name { font-weight: 500; }
.kx-app .modal-item .meta { font-size: 11px; color: var(--txt2); }

@media (max-width: 680px) {
  .kx-app .shell { flex-direction: column; min-height: 0; overflow: visible; border-radius: 0; border: none; }
  .kx-app .sidebar { width: 100%; flex-direction: row; flex-shrink: 0; border-right: none; border-bottom: 1px solid var(--brd); }
  .kx-app .sidebar-logo { display: none; }
  .kx-app .nav { flex-direction: row; padding: 0; overflow-x: auto; }
  .kx-app .nav-item { flex-direction: column; gap: 3px; padding: 10px 14px; font-size: 11px; white-space: nowrap; border-left: none; border-bottom: 3px solid transparent; min-height: 52px; justify-content: center; align-items: center; }
  .kx-app .nav-item.active { border-left-color: transparent; border-bottom-color: var(--acc); }
  .kx-app .main { padding: 16px; overflow-y: visible; display: block; }
  .kx-app .row { flex-direction: column; gap: 0; }
  .kx-app .toast { left: 12px; right: 12px; bottom: 12px; }
}
</style>

<!-- LoxBerrys Chrome laedt jQuery Mobile, das <select>/<input> automatisch in
     eigene Widgets "aufwertet" (z.B. <select> -> <div class="ui-select"> mit
     eigenem <div class="ui-btn"><span>), was unser .kx-app-CSS komplett
     aussticht UND den sichtbaren Button nie mit programmatisch gesetzten
     Werten synchronisiert (auf echter Hardware beobachtet: leere
     <span>&nbsp;</span> trotz korrekt befuellter <option>-Liste).
     data-enhance="false" auf dem Container ALLEIN reichte nicht (weiterhin
     beobachtet) - der zuverlaessige Weg ist data-role="none" DIREKT auf
     jedem einzelnen <select>/<input> (siehe unten), das ist jQuery Mobiles
     dokumentierter Pro-Element-Opt-out. data-enhance="false" bleibt als
     zusaetzliche Absicherung stehen, ist aber nicht mehr der tragende Fix. -->
<div class="kx-app" data-enhance="false">
<div class="shell">

<aside class="sidebar">
  <div class="sidebar-logo">KNXtoLOX<span>KNX &lt;-&gt; Loxone Bruecke</span></div>
  <nav class="nav">
    <div class="nav-item active" data-page="overview">Uebersicht</div>
    <div class="nav-item" data-page="bus">Bus-Verbindung</div>
    <div class="nav-item" data-page="mqtt">MQTT</div>
    <div class="nav-item" data-page="groupaddresses">Gruppenadressen</div>
    <div class="nav-item" data-page="status">Status</div>
    <div class="nav-item" data-page="debug">Debug</div>
  </nav>
</aside>

<main class="main">

  <section id="page-overview" class="page active">
    <h2>Übersicht</h2>
    <div class="card">
      <div class="card-title">Dienste</div>
      <div class="status-bar"><span class="status-dot" id="dot-engine"></span><span id="txt-engine">knx-mqtt (KNX-Bus &lt;-&gt; MQTT) ...</span></div>
      <div class="status-bar"><span class="status-dot" id="dot-bridge"></span><span id="txt-bridge">Node-Bridge (MQTT &lt;-&gt; Loxone) ...</span></div>
    </div>
    <div class="card">
      <div class="card-title">Gruppenadressen</div>
      <div id="ga-summary" class="hint">laedt ...</div>
    </div>
    <div class="card">
      <div class="card-title">Konfiguration sichern &amp; wiederherstellen</div>
      <div class="hint" style="margin-bottom:14px">
        Sichert Bus-Verbindung, MQTT-Einstellungen und die komplette
        Gruppenadressen-Tabelle als Datei — z.B. vor einer Neuinstallation
        des Plugins. Enthaelt keine Zugangsdaten (Miniserver/MQTT-Broker
        kommen ohnehin aus LoxBerry selbst, nicht aus dieser Datei).
      </div>
      <div class="btn-group">
        <button class="btn btn-secondary" onclick="exportConfig()">Konfiguration exportieren</button>
        <button class="btn btn-secondary" onclick="document.getElementById('import-file-input').click()">Konfiguration importieren…</button>
        <input type="file" id="import-file-input" data-role="none" accept="application/json,.json" style="display:none" onchange="importConfig(this.files[0])">
      </div>
    </div>
  </section>

  <section id="page-bus" class="page">
    <h2>Bus-Verbindung</h2>
    <div class="card">
      <div class="field">
        <label>Modus</label>
        <select id="bus_mode" data-role="none">
          <option value="gira">Gira KNX/IP-Gateway</option>
          <option value="knxd">Eigenes Board (knxd, z.B. NCN5121)</option>
        </select>
      </div>
    </div>

    <div class="card" id="card-gira">
      <div class="card-title">Gira KNX/IP-Gateway</div>
      <div class="row">
        <div class="field"><label>Gateway-IP</label><input type="text" id="gira_gateway" data-role="none" placeholder="192.168.1.50"></div>
        <div class="field"><label>Port</label><input type="number" id="gira_port" data-role="none" placeholder="3671"></div>
      </div>
      <div class="checkfield"><div class="toggle" id="gira_tunnel" onclick="toggleSwitch('gira_tunnel')"></div><label onclick="toggleSwitch('gira_tunnel')">Tunneling (statt Routing/Multicast)</label></div>
    </div>

    <div class="card" id="card-knxd" style="display:none">
      <div class="card-title">knxd</div>
      <div class="row">
        <div class="field">
          <label>Serielles Geraet</label>
          <select id="knxd_device" data-role="none"></select>
        </div>
        <div class="field"><label>Eigene KNX-Adresse</label><input type="text" id="knxd_own_addr" data-role="none" placeholder="0.0.1"></div>
      </div>
      <div class="row">
        <div class="field"><label>Adresspool Start</label><input type="text" id="knxd_pool_start" data-role="none" placeholder="0.0.2"></div>
        <div class="field"><label>Adresspool Groesse</label><input type="number" id="knxd_pool_size" data-role="none" placeholder="10"></div>
      </div>
      <div class="checkfield"><div class="toggle" id="knxd_cache" onclick="toggleSwitch('knxd_cache')"></div><label onclick="toggleSwitch('knxd_cache')">Zustands-Cache aktivieren</label></div>
      <details>
        <summary style="cursor:pointer;color:var(--txt2);margin-bottom:12px;">Erweitert</summary>
        <div class="row">
          <div class="field">
            <label>Log-Level</label>
            <select id="knxd_loglevel" data-role="none"><option>error</option><option>warn</option><option>info</option><option>debug</option></select>
          </div>
          <div class="field"><label>Sendeverzoegerung (ms)</label><input type="number" id="knxd_send_delay" data-role="none" placeholder="0"></div>
        </div>
        <div class="checkfield"><div class="toggle" id="knxd_extra_ip_enabled" onclick="toggleSwitch('knxd_extra_ip_enabled')"></div><label onclick="toggleSwitch('knxd_extra_ip_enabled')">Zusaetzliches paralleles Gira-Gateway</label></div>
        <div class="field"><label>Extra-IP</label><input type="text" id="knxd_extra_ip" data-role="none"></div>
        <div class="checkfield"><div class="toggle" id="knxd_ets_access_enabled" onclick="toggleSwitch('knxd_ets_access_enabled')"></div><label onclick="toggleSwitch('knxd_ets_access_enabled')">ETS-Netzwerkzugriff erlauben</label></div>
        <div class="field"><label>ETS-Zugriffsport</label><input type="number" id="knxd_ets_port" data-role="none" placeholder="6720"></div>
        <div class="field"><label>Lokaler KNXnet/IP-Port</label><input type="number" id="knxd_local_ip_port" data-role="none" placeholder="3671"></div>
      </details>
    </div>

    <div class="card">
      <div class="card-title">KNX-Zeitgeber</div>
      <div class="hint" style="margin-bottom:14px">
        Sendet die aktuelle LoxBerry-Systemzeit einmal pro Minute auf die
        angegebenen Gruppenadressen (Standard-KNX-Typen DPT 10.001 Uhrzeit /
        DPT 11.001 Datum) — damit koennen KNX-Uhren/Displays am Bus die
        richtige Zeit anzeigen. Leer lassen = deaktiviert.
      </div>
      <div class="row">
        <div class="field"><label>Uhrzeit-Gruppenadresse</label><input type="text" id="time_addr" data-role="none" placeholder="z.B. 0/0/1"></div>
        <div class="field"><label>Datum-Gruppenadresse</label><input type="text" id="date_addr" data-role="none" placeholder="z.B. 0/0/2"></div>
      </div>
    </div>

    <div class="btn-group">
      <button class="btn btn-primary" onclick="saveConfig()">Speichern</button>
      <button class="btn btn-secondary" onclick="testKnx()">KNX-Verbindung testen</button>
      <button class="btn btn-secondary" onclick="testLox()">Loxone-Verbindung testen</button>
      <button class="btn btn-secondary" onclick="restartServices()">Dienste neu starten</button>
    </div>
  </section>

  <section id="page-mqtt" class="page">
    <h2>MQTT</h2>
    <div class="card">
      <div class="status-bar"><span class="status-dot ok"></span><span id="mqtt-broker-info">MQTT-Broker (aus LoxBerry) ...</span></div>
      <div class="hint">Broker-Adresse/Zugangsdaten kommen automatisch aus LoxBerrys MQTT-Gateway-Konfiguration.</div>
      <div class="divider"></div>
      <div class="row">
        <div class="field"><label>Topic-Prefix</label><input type="text" id="topic_prefix" data-role="none" placeholder="knx/"></div>
        <div class="field"><label>Client-ID (knx-mqtt)</label><input type="text" id="client_id" data-role="none" placeholder="loxberry-knxmqtt"></div>
      </div>
      <div class="field">
        <label>Miniserver</label>
        <select id="loxone_msno" data-role="none"></select>
      </div>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="saveConfig()">Speichern</button>
    </div>
  </section>

  <section id="page-groupaddresses" class="page">
    <h2>Gruppenadressen</h2>
    <div class="card">
      <div class="card-title">ETS-Projekt importieren</div>
      <div class="row">
        <div class="field"><label>.knxproj-Datei</label><input type="file" id="knxproj_file" data-role="none"></div>
        <div class="field"><label>Passwort (optional)</label><input type="password" id="knxproj_password" data-role="none"></div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="importEts()">Importieren</button>
      <span class="hint" id="ets-status"></span>
    </div>
    <div class="card">
      <div class="card-title">CSV Import/Export</div>
      <div class="row">
        <div class="field"><label>CSV-Datei</label><input type="file" id="csv_file" data-role="none"></div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="importCsv()">Importieren</button>
      <button class="btn btn-secondary btn-sm" onclick="location.href='api.cgi?action=export_csv'">Exportieren</button>
    </div>
    <div class="card">
      <div class="card-title">Tabelle</div>
      <div class="hint" style="margin-bottom:10px">
        DPT als Freitext (z.B. "9.001") - die Vorschlagsliste zeigt gaengige
        Typen, ist aber keine feste Auswahl: jeder in der ETS vorkommende
        Datenpunkttyp kann eingetragen werden, auch wenn er nicht in der
        Liste steht.
      </div>
      <!-- Freitext+Datalist statt fester <select>-Optionen: reale ETS-Projekte
           nutzen deutlich mehr DPT-Subtypen als eine von uns gepflegte Liste
           je abdecken koennte. Ein <select> ohne passende <option> wuerde
           beim naechsten Speichern still auf die erste Option zurueckfallen
           und den echten (importierten) DPT ueberschreiben - siehe Notizen. -->
      <datalist id="dpt-suggestions">
        <option value="1.001"><option value="1.010"><option value="3.007">
        <option value="5.001"><option value="5.004"><option value="5.010">
        <option value="6.010">
        <option value="7.001"><option value="8.001">
        <option value="9.001"><option value="9.004"><option value="9.007"><option value="9.008">
        <option value="12.001"><option value="13.001"><option value="13.010">
        <option value="14.001">
        <option value="17.001"><option value="18.001"><option value="20.102">
        <option value="raw">
      </datalist>
      <div style="overflow-x:auto">
        <table class="ga-table">
          <thead><tr>
            <th>Gruppenadresse</th><th>DPT</th><th>Bezeichnung</th>
            <th>Loxone-Eingang (KNX-&gt;Lox)</th><th>Loxone-Ausgang (Lox-&gt;KNX)</th><th></th>
          </tr></thead>
          <tbody id="ga-tbody"></tbody>
        </table>
      </div>
      <div class="btn-group">
        <button class="btn btn-secondary btn-sm" onclick="addGaRow()">+ Zeile</button>
        <button class="btn btn-primary" onclick="saveGaRows()">Speichern</button>
      </div>
    </div>
  </section>

  <section id="page-status" class="page">
    <h2>Status</h2>
    <div class="card">
      <div class="card-title">Live-Aktivitaet</div>
      <div class="hint">Letzte 50 Gruppenadressen-Ereignisse in beide Richtungen (nur konfigurierte Adressen) - aeltere Eintraege fallen automatisch raus, die Liste waechst also nie unbegrenzt.</div>
      <div style="overflow:auto; max-height:340px; margin-top:10px">
        <table class="ga-table">
          <thead><tr><th>Zeit</th><th>Richtung</th><th>Adresse</th><th>Bezeichnung</th><th>DPT</th><th>Wert</th></tr></thead>
          <tbody id="activity-tbody"><tr><td colspan="6" class="hint">noch keine Ereignisse</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-title-row">
        <div class="card-title">knx-mqtt (KNX-Bus &lt;-&gt; MQTT)</div>
        <span class="card-toggle" id="toggle-engine" onclick="toggleLog('engine')">Log anzeigen ▾</span>
      </div>
      <div class="status-bar"><span class="status-dot" id="dot-engine2"></span><span id="txt-engine2">...</span></div>
      <pre class="log log-hidden" id="log-engine"></pre>
    </div>
    <div class="card">
      <div class="card-title-row">
        <div class="card-title">Node-Bridge (MQTT &lt;-&gt; Loxone)</div>
        <span class="card-toggle" id="toggle-bridge" onclick="toggleLog('bridge')">Log anzeigen ▾</span>
      </div>
      <div class="status-bar"><span class="status-dot" id="dot-bridge2"></span><span id="txt-bridge2">...</span></div>
      <pre class="log log-hidden" id="log-bridge"></pre>
    </div>
    <div class="btn-group">
      <button class="btn btn-secondary" onclick="restartServices()">Beide Dienste neu starten</button>
    </div>
  </section>

  <section id="page-debug" class="page">
    <h2>Debug</h2>
    <div class="card">
      <div class="hint">UI-Version: <span id="ui-build"></span> — hilft zu pruefen, ob nach einer
        Neuinstallation tatsaechlich der neue Stand geladen wurde (Browser-Cache!).</div>
    </div>
    <div class="card">
      <div class="card-title">Web-UI-Anfragen (Browser, dieser Tab)</div>
      <div class="hint">Jede Aktion (Speichern, Test, ...) wird hier protokolliert, auch wenn kein Toast erscheint.</div>
      <pre class="log" id="log-client"></pre>
    </div>
    <div class="card">
      <div class="card-title">api.cgi (Server)</div>
      <div class="hint">Zeigt, ob eine Anfrage vom Browser ueberhaupt beim Server ankommt.</div>
      <pre class="log" id="log-api"></pre>
    </div>
  </section>

</main>
</div>
<div class="toast" id="toast"></div>

<div class="modal-backdrop" id="uuid-picker-backdrop" onclick="if(event.target===this) closeUuidPicker()">
  <div class="modal">
    <div class="card-title">Loxone-Objekt auswaehlen</div>
    <input type="text" id="uuid-picker-search" data-role="none" placeholder="Suche nach Name/Raum/Praefix ..." oninput="renderUuidPickerList()">
    <div class="modal-list" id="uuid-picker-list"></div>
    <div class="btn-group" style="margin-top:10px;margin-bottom:0">
      <button class="btn btn-secondary btn-sm" onclick="closeUuidPicker()">Abbrechen</button>
    </div>
  </div>
</div>
</div>

<script>
const API = 'api.cgi';
let GA_ROWS = [];

// Build-Marker: von Hand bei jeder relevanten Aenderung an dieser Datei
// hochzaehlen. Zeigt auf der Debug-Seite (und in der Konsole), ob nach einer
// Neuinstallation tatsaechlich der neue Stand geladen wurde - haeufigste
// Fehlerquelle beim Debuggen "aus der Ferne" ist sonst der Browser-Cache
// oder ein vergessener Reinstall.
const UI_BUILD = '2026-07-24-3';
console.log('[KNXtoLOX] index.cgi UI_BUILD=' + UI_BUILD);

// Client-seitiger Mitschnitt jeder api()/uploadForm()-Anfrage - sichtbar auf
// der Debug-Seite, auch wenn kein Toast erscheint oder die Konsole nicht
// geoeffnet ist. Ring-Puffer (max. 200 Eintraege).
const CLIENT_LOG = [];
function clientLog(line) {
  const ts = new Date().toLocaleTimeString('de-DE');
  CLIENT_LOG.push('[' + ts + '] ' + line);
  if (CLIENT_LOG.length > 200) CLIENT_LOG.shift();
  const el = document.getElementById('log-client');
  if (el) el.textContent = CLIENT_LOG.join('\n');
  console.log('[KNXtoLOX] ' + line);
}

// api() wirft NIE - liefert immer entweder die geparste JSON-Antwort oder ein
// {error:"..."} zurueck. Grund: ohne das stirbt bei einem Netzwerkfehler oder
// einer nicht-JSON-Antwort (z.B. LoxBerry-Login-Seite bei abgelaufener
// Session, oder ein Perl-Fehler mit HTML-Ausgabe) die aufrufende async-
// Funktion lautlos (unhandled promise rejection) - kein Toast, keine
// sichtbare Fehlermeldung, obwohl "eigentlich etwas passiert" waere.
async function api(action, opts) {
  opts = opts || {};
  const url = API + '?action=' + encodeURIComponent(action);
  const init = { method: opts.method || 'GET' };
  if (opts.body) { init.body = JSON.stringify(opts.body); init.headers = {'Content-Type':'application/json'}; }
  clientLog('-> ' + (init.method) + ' action=' + action + (opts.body ? ' body=' + JSON.stringify(opts.body).slice(0, 200) : ''));
  let res, text;
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (e) {
    clientLog('<- ' + action + ': NETZWERKFEHLER ' + e.message);
    console.error('api(' + action + '): Netzwerkfehler', e);
    return { error: 'Netzwerkfehler: ' + e.message };
  }
  try {
    const data = JSON.parse(text);
    clientLog('<- ' + action + ': HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 200));
    return data;
  } catch (e) {
    clientLog('<- ' + action + ': HTTP ' + res.status + ', KEIN JSON: ' + text.slice(0, 150));
    console.error('api(' + action + '): keine gueltige JSON-Antwort (HTTP ' + res.status + '):', text.slice(0, 500));
    return { error: 'Unerwartete Antwort vom Server (HTTP ' + res.status + ') - siehe Browser-Konsole (F12)' };
  }
}

function toast(msg, ok) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(() => t.className = 'toast', 2500);
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + item.dataset.page).classList.add('active');
  });
});

document.getElementById('bus_mode').addEventListener('change', (e) => {
  document.getElementById('card-gira').style.display = e.target.value === 'gira' ? '' : 'none';
  document.getElementById('card-knxd').style.display = e.target.value === 'knxd' ? '' : 'none';
});

// Eigener Toggle statt <input type=checkbox> (siehe CSS-Kommentar bei
// .kx-app .toggle) - Zustand liegt im data-checked-Attribut.
function toggleSwitch(id) { setToggled(id, !isToggled(id)); }
function isToggled(id) { const el = document.getElementById(id); return el && el.dataset.checked === 'true'; }
function setToggled(id, val) { const el = document.getElementById(id); if (el) el.dataset.checked = val ? 'true' : 'false'; }

function currentConfigForm() {
  return {
    bus_mode: document.getElementById('bus_mode').value,
    gira_gateway: document.getElementById('gira_gateway').value,
    gira_port: parseInt(document.getElementById('gira_port').value || '3671', 10),
    gira_tunnel: isToggled('gira_tunnel'),
    topic_prefix: document.getElementById('topic_prefix').value || 'knx/',
    client_id: document.getElementById('client_id').value || 'loxberry-knxmqtt',
    time_addr: document.getElementById('time_addr').value.trim(),
    date_addr: document.getElementById('date_addr').value.trim(),
    loxone_msno: parseInt(document.getElementById('loxone_msno').value || '1', 10),
    knxd: {
      device: document.getElementById('knxd_device').value,
      own_addr: document.getElementById('knxd_own_addr').value,
      pool_start: document.getElementById('knxd_pool_start').value,
      pool_size: parseInt(document.getElementById('knxd_pool_size').value || '10', 10),
      cache: isToggled('knxd_cache'),
      loglevel: document.getElementById('knxd_loglevel').value,
      send_delay: parseInt(document.getElementById('knxd_send_delay').value || '0', 10),
      extra_ip_enabled: isToggled('knxd_extra_ip_enabled'),
      extra_ip: document.getElementById('knxd_extra_ip').value,
      ets_access_enabled: isToggled('knxd_ets_access_enabled'),
      ets_port: parseInt(document.getElementById('knxd_ets_port').value || '6720', 10),
      local_ip_port: parseInt(document.getElementById('knxd_local_ip_port').value || '3671', 10),
    },
  };
}

function fillConfigForm(c) {
  document.getElementById('bus_mode').value = c.bus_mode || 'gira';
  document.getElementById('bus_mode').dispatchEvent(new Event('change'));
  document.getElementById('gira_gateway').value = c.gira_gateway || '';
  document.getElementById('gira_port').value = c.gira_port || 3671;
  setToggled('gira_tunnel', c.gira_tunnel);
  document.getElementById('topic_prefix').value = c.topic_prefix || 'knx/';
  document.getElementById('client_id').value = c.client_id || 'loxberry-knxmqtt';
  document.getElementById('time_addr').value = c.time_addr || '';
  document.getElementById('date_addr').value = c.date_addr || '';
  const k = c.knxd || {};
  document.getElementById('knxd_own_addr').value = k.own_addr || '';
  document.getElementById('knxd_pool_start').value = k.pool_start || '';
  document.getElementById('knxd_pool_size').value = k.pool_size || 10;
  setToggled('knxd_cache', k.cache);
  document.getElementById('knxd_loglevel').value = k.loglevel || 'error';
  document.getElementById('knxd_send_delay').value = k.send_delay || 0;
  setToggled('knxd_extra_ip_enabled', k.extra_ip_enabled);
  document.getElementById('knxd_extra_ip').value = k.extra_ip || '';
  setToggled('knxd_ets_access_enabled', k.ets_access_enabled);
  document.getElementById('knxd_ets_port').value = k.ets_port || 6720;
  document.getElementById('knxd_local_ip_port').value = k.local_ip_port || 3671;
  document.getElementById('mqtt-broker-info').textContent = 'MQTT-Broker (aus LoxBerry): ' + (c.mqtt_broker || 'nicht konfiguriert');
  if (k.device) {
    const sel = document.getElementById('knxd_device');
    if (![...sel.options].some(o => o.value === k.device)) {
      const opt = document.createElement('option'); opt.value = k.device; opt.textContent = k.device; sel.appendChild(opt);
    }
    sel.value = k.device;
  }
}

async function loadConfig() {
  const c = await api('config');
  fillConfigForm(c);
  window._loxoneMsno = c.loxone_msno;
}

async function saveConfig() {
  const body = currentConfigForm();
  const r = await api('config', { method: 'POST', body });
  toast(r.ok ? 'Gespeichert' : (r.error || 'Fehler'), !!r.ok);
}

async function testKnx() {
  const r = await api('knx_test');
  toast(r.ok ? ('KNX-Ziel erreichbar (' + r.endpoint + ')') : ('KNX-Ziel nicht erreichbar (' + (r.endpoint || '') + ')'), !!r.ok);
}

async function testLox() {
  const r = await api('lox_test');
  toast(r.ok ? 'Loxone-Verbindung OK' : 'Loxone nicht erreichbar', !!r.ok);
}

async function restartServices() {
  const r = await api('bridge_restart', { method: 'POST' });
  toast(r.ok ? 'Dienste neu gestartet' : 'Fehler beim Neustart', !!r.ok);
}

async function loadMiniservers() {
  const list = await api('miniservers');
  const sel = document.getElementById('loxone_msno');
  sel.innerHTML = '';
  (list || []).forEach(ms => {
    const opt = document.createElement('option');
    opt.value = ms.msno; opt.textContent = ms.name + ' (' + ms.ipaddress + ')';
    sel.appendChild(opt);
  });
  if (window._loxoneMsno) sel.value = window._loxoneMsno;
}

async function loadKnxdDevices() {
  const devs = await api('knxd_devices');
  const sel = document.getElementById('knxd_device');
  sel.innerHTML = '';
  (devs || []).forEach(d => {
    const opt = document.createElement('option'); opt.value = d; opt.textContent = d; sel.appendChild(opt);
  });
}

// ── Gruppenadressen-Tabelle ──────────────────────────────────
function gaRowHtml(row, idx) {
  row = row || {};
  const f = (k) => (row[k] || '').toString().replace(/"/g, '&quot;');
  const uuidCell = (field, nameField) =>
    '<td>' +
      '<div style="display:flex;gap:4px">' +
        '<input type="text" data-role="none" data-f="' + field + '" value="' + f(field) + '" placeholder="Loxone-UUID">' +
        '<button type="button" class="btn btn-secondary btn-sm" style="padding:6px 8px" onclick="openUuidPicker(' + idx + ',\'' + field + '\')" title="Aus Loxone-Struktur auswaehlen">Wählen</button>' +
      '</div>' +
      (row[nameField] ? '<div class="hint">' + f(nameField) + '</div>' : '') +
    '</td>';
  return '<tr data-idx="' + idx + '">' +
    '<td><input type="text" data-role="none" data-f="addr" value="' + f('addr') + '"></td>' +
    '<td><input type="text" data-role="none" data-f="dpt" list="dpt-suggestions" value="' + f('dpt') + '" placeholder="z.B. 9.001"></td>' +
    '<td><input type="text" data-role="none" data-f="label" value="' + f('label') + '"></td>' +
    uuidCell('lox_input_uuid', 'lox_input_name') +
    uuidCell('lox_output_uuid', 'lox_output_name') +
    '<td><span class="ga-del" onclick="delGaRow(' + idx + ')">&times;</span></td>' +
    '</tr>';
}

function renderGaTable() {
  document.getElementById('ga-tbody').innerHTML = GA_ROWS.map((r, i) => gaRowHtml(r, i)).join('');
  document.getElementById('ga-summary').textContent =
    GA_ROWS.length + ' Gruppenadresse(n), ' +
    GA_ROWS.filter(r => r.lox_input_uuid).length + ' -> Loxone, ' +
    GA_ROWS.filter(r => r.lox_output_uuid).length + ' <- Loxone';
}

function addGaRow() { GA_ROWS.push({}); renderGaTable(); }
function delGaRow(idx) { GA_ROWS.splice(idx, 1); renderGaTable(); }

function collectGaRowsFromDom() {
  document.querySelectorAll('#ga-tbody tr').forEach(tr => {
    const idx = parseInt(tr.dataset.idx, 10);
    tr.querySelectorAll('[data-f]').forEach(el => { GA_ROWS[idx][el.dataset.f] = el.value; });
  });
  return GA_ROWS.filter(r => r.addr);
}

async function loadGaRows() {
  const r = await api('groupaddresses');
  GA_ROWS = r.groupaddresses || [];
  renderGaTable();
}

async function saveGaRows() {
  const rows = collectGaRowsFromDom();
  const r = await api('groupaddresses', { method: 'POST', body: { groupaddresses: rows } });
  // api.cgi startet die Node-Bridge bei Erfolg automatisch neu (sie liest
  // groupaddresses.yaml nur beim eigenen Start), daher der Hinweis hier.
  toast(r.ok ? 'Gespeichert - Bridge wird neu gestartet ...' : (r.error || 'Fehler'), !!r.ok);
  GA_ROWS = rows;
  renderGaTable();
}

// ── UUID-Picker: Loxone-Objekt fuer lox_input_uuid/lox_output_uuid waehlen ──
// Zwei getrennte Listen vom Server (siehe api.cgi action=lox_controls):
// "controls" (Steuerungs-UUID, fuer lox_input_uuid - jdev/sps/io-Kommandoziel,
// funktioniert generisch fuer jeden Control-Typ) und "states" (eine Zeile
// PRO Zustandsschluessel jeder Steuerung, z.B. "Wohnzimmer Schalter (active)",
// fuer lox_output_uuid - genau diese UUID meldet Loxones WebSocket bei
// Aenderung). Vorher wurde fuer den Ausgang nur "states.value" geraten, was
// bei einem normalen Schalter (Zustandsschluessel "active") ins Leere lief.
// Beide Listen werden einmal geladen und im Speicher behalten (LoxAPP3.json
// aendert sich nicht waehrend einer Sitzung) - Filterung passiert rein
// clientseitig per Freitext, bewusst OHNE festen Typ-Filter.
let UUID_PICKER_CONTROLS = null;
let UUID_PICKER_STATES = null;
let UUID_PICKER_TARGET = null; // { idx, field }
let UUID_PICKER_FILTERED = [];

async function openUuidPicker(idx, field) {
  UUID_PICKER_TARGET = { idx, field };
  document.getElementById('uuid-picker-backdrop').classList.add('show');
  document.getElementById('uuid-picker-search').value = '';
  if (!UUID_PICKER_CONTROLS) {
    const r = await api('lox_controls');
    if (r.error) { toast(r.error, false); UUID_PICKER_CONTROLS = []; UUID_PICKER_STATES = []; }
    else { UUID_PICKER_CONTROLS = r.controls || []; UUID_PICKER_STATES = r.states || []; }
  }
  renderUuidPickerList();
}

function closeUuidPicker() {
  document.getElementById('uuid-picker-backdrop').classList.remove('show');
}

function renderUuidPickerList() {
  const q = (document.getElementById('uuid-picker-search').value || '').toLowerCase();
  const isOutput = UUID_PICKER_TARGET && UUID_PICKER_TARGET.field === 'lox_output_uuid';
  const source = isOutput ? UUID_PICKER_STATES : UUID_PICKER_CONTROLS;
  UUID_PICKER_FILTERED = (source || []).filter(c =>
    !q || (c.name + ' ' + c.room + ' ' + c.type).toLowerCase().includes(q)
  );
  const list = document.getElementById('uuid-picker-list');
  list.innerHTML = UUID_PICKER_FILTERED.slice(0, 200).map((c, i) =>
    '<div class="modal-item" onclick="pickUuidControl(' + i + ')">' +
      '<div class="name">' + c.name.replace(/</g, '&lt;') + '</div>' +
      '<div class="meta">' + (c.room ? c.room + ' - ' : '') + c.type + '</div>' +
    '</div>'
  ).join('') || '<div class="hint">keine Treffer</div>';
}

function pickUuidControl(i) {
  const c = UUID_PICKER_FILTERED[i];
  if (!c || !UUID_PICKER_TARGET) return;
  collectGaRowsFromDom(); // unsaved Eingaben in anderen Zeilen/Feldern nicht verlieren
  const { idx, field } = UUID_PICKER_TARGET;
  const isOutput = field === 'lox_output_uuid';
  GA_ROWS[idx][field] = c.uuid;
  GA_ROWS[idx][isOutput ? 'lox_output_name' : 'lox_input_name'] = c.name;
  renderGaTable();
  closeUuidPicker();
}

// ── Konfiguration sichern & wiederherstellen ─────────────────────
// Reine Frontend-Funktionen nach dem Muster von MiraiPanel: exportConfig()
// buendelt Bus-/MQTT-Einstellungen UND die Gruppenadressen-Tabelle in einer
// Datei, importConfig() schickt beides an dieselben "config"/
// "groupaddresses"-Endpunkte, die auch die normalen Speichern-Buttons
// verwenden - kein eigener Backend-Code noetig.
async function exportConfig() {
  const settings = await api('config');
  const ga = await api('groupaddresses');
  const bundle = { settings, groupaddresses: ga.groupaddresses || [] };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `knxtolox-config_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Konfiguration exportiert', true);
}

async function importConfig(file) {
  if (!file) return;
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch (e) {
    toast('Datei ist kein gueltiges JSON', false);
    return;
  }
  if (typeof bundle.settings !== 'object' || !Array.isArray(bundle.groupaddresses)) {
    toast('Datei sieht nicht wie eine KNXtoLOX-Konfiguration aus', false);
    return;
  }
  if (!confirm(`Aktuelle Konfiguration durch die importierte Datei ersetzen (${bundle.groupaddresses.length} Gruppenadresse(n))? Das kann nicht rueckgaengig gemacht werden.`)) {
    return;
  }
  const r1 = await api('config', { method: 'POST', body: bundle.settings });
  const r2 = await api('groupaddresses', { method: 'POST', body: { groupaddresses: bundle.groupaddresses } });
  if (!r1.ok || !r2.ok) {
    toast('Import teilweise fehlgeschlagen: ' + (r1.error || r2.error || 'unbekannter Fehler'), false);
    return;
  }
  await loadConfig();
  await loadGaRows();
  toast('Konfiguration importiert - starte Dienste neu ...', true);
  await api('bridge_restart', { method: 'POST' });
}

async function uploadForm(action, fd) {
  clientLog('-> POST (multipart) action=' + action);
  let res, text;
  try {
    res = await fetch(API + '?action=' + encodeURIComponent(action), { method: 'POST', body: fd });
    text = await res.text();
  } catch (e) {
    clientLog('<- ' + action + ': NETZWERKFEHLER ' + e.message);
    console.error('uploadForm(' + action + '): Netzwerkfehler', e);
    return { error: 'Netzwerkfehler: ' + e.message };
  }
  try {
    const data = JSON.parse(text);
    clientLog('<- ' + action + ': HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 200));
    return data;
  } catch (e) {
    clientLog('<- ' + action + ': HTTP ' + res.status + ', KEIN JSON: ' + text.slice(0, 150));
    console.error('uploadForm(' + action + '): keine gueltige JSON-Antwort (HTTP ' + res.status + '):', text.slice(0, 500));
    return { error: 'Unerwartete Antwort vom Server (HTTP ' + res.status + ') - siehe Browser-Konsole (F12)' };
  }
}

async function importCsv() {
  const fh = document.getElementById('csv_file').files[0];
  if (!fh) { toast('Keine Datei ausgewaehlt', false); return; }
  const fd = new FormData(); fd.append('csv_file', fh);
  const r = await uploadForm('import_csv', fd);
  toast(r.ok ? (r.imported + ' Gruppenadresse(n) importiert') : (r.error || 'Fehler'), !!r.ok);
  if (r.ok) { GA_ROWS = r.groupaddresses; renderGaTable(); }
}

async function importEts() {
  const fh = document.getElementById('knxproj_file').files[0];
  if (!fh) { toast('Keine Datei ausgewaehlt', false); return; }
  const fd = new FormData();
  fd.append('knxproj_file', fh);
  fd.append('knxproj_password', document.getElementById('knxproj_password').value || '');
  const r = await uploadForm('import_ets', fd);
  document.getElementById('ets-status').textContent = r.ok ? (r.imported + ' Gruppenadresse(n) importiert') : (r.error || 'Fehler');
  toast(r.ok ? 'ETS-Import erfolgreich' : (r.error || 'Fehler'), !!r.ok);
  if (r.ok) { GA_ROWS = r.groupaddresses; renderGaTable(); }
}

// ── Status ────────────────────────────────────────────────────
const SERVICE_LABELS = {
  engine: 'knx-mqtt (KNX-Bus <-> MQTT)',
  bridge: 'Node-Bridge (MQTT <-> Loxone)',
};

function applyServiceStatus(prefix, s) {
  const ok = !!s.running;
  document.querySelectorAll('#dot-' + prefix + ', #dot-' + prefix + '2').forEach(el => el.className = 'status-dot ' + (ok ? 'ok' : 'err'));
  const txt = (ok ? 'aktiv' : 'inaktiv') + (s.pid ? ' (PID ' + s.pid + ')' : '');
  const t1 = document.getElementById('txt-' + prefix); if (t1) t1.textContent = SERVICE_LABELS[prefix] + ': ' + txt;
  const t2 = document.getElementById('txt-' + prefix + '2'); if (t2) t2.textContent = txt;
  const log = document.getElementById('log-' + (prefix === 'engine' ? 'engine' : 'bridge'));
  if (log && s.log !== undefined) log.textContent = s.log;
}

// Rohlogs sind standardmaessig eingeklappt (nur Status-Dot + Zusammenfassung
// sichtbar) - die Live-Aktivitaet-Tabelle deckt den Alltagsfall ("laeuft
// meine Gruppenadresse durch?") ab, der Rohlog wird nur fuer echtes
// Debugging gebraucht. Zustand bleibt rein clientseitig (kein Reload noetig,
// pollStatus() aendert nur den Textinhalt, nie die log-hidden-Klasse).
function toggleLog(name) {
  const pre = document.getElementById('log-' + name);
  const btn = document.getElementById('toggle-' + name);
  if (!pre || !btn) return;
  const show = pre.classList.toggle('log-hidden') === false;
  btn.textContent = show ? 'Log verbergen ▴' : 'Log anzeigen ▾';
}

function renderActivity(events) {
  const tbody = document.getElementById('activity-tbody');
  if (!tbody) return;
  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="hint">noch keine Ereignisse</td></tr>';
    return;
  }
  const esc = s => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // dir-Klasse fuers Badge-CSS (siehe .dir-badge.*) getrennt vom reinen
  // Anzeigetext, damit jede Richtung farblich auf einen Blick unterscheidbar
  // ist statt nur als Fliesstext (bisher auf dunklem Grund schwer lesbar).
  const DIRS = {
    'knx->lox':  { cls: 'knx-lox',  txt: 'KNX -&gt; Lox' },
    'lox->knx':  { cls: 'lox-knx',  txt: 'Lox -&gt; KNX' },
    'zeitgeber': { cls: 'zeitgeber', txt: 'Zeitgeber -&gt; KNX' },
  };
  tbody.innerHTML = events.map(ev => {
    // ev.ts kommt von bin/bridge.js bereits als lokale "YYYY-MM-DD HH:MM:SS"-
    // Zeichenkette (kein UTC/ISO mehr) - hier nur noch durchreichen.
    const time = ev.ts || '';
    const d = DIRS[ev.direction] || { cls: '', txt: esc(ev.direction) };
    return '<tr>' +
      '<td class="mono">' + esc(time) + '</td>' +
      '<td><span class="dir-badge ' + d.cls + '">' + d.txt + '</span></td>' +
      '<td class="mono">' + esc(ev.addr) + '</td>' +
      '<td>' + esc(ev.label) + '</td>' +
      '<td>' + esc(ev.dpt) + '</td>' +
      '<td class="mono">' + esc(ev.value) + '</td>' +
    '</tr>';
  }).join('');
}

async function pollStatus() {
  const e = await api('engine_status');
  if (!e.error) applyServiceStatus('engine', e);
  const b = await api('bridge_status');
  if (!b.error) applyServiceStatus('bridge', b);
  const l = await api('api_log');
  const el = document.getElementById('log-api');
  if (el && l.log !== undefined) el.textContent = l.log;
  const a = await api('knx_activity');
  if (!a.error) renderActivity(a.activity);
}

async function step(name, fn) {
  try { await fn(); }
  catch (e) {
    console.error('init-Schritt "' + name + '" fehlgeschlagen:', e);
    toast('Fehler beim Laden (' + name + '): ' + e.message, false);
  }
}

(async function init() {
  document.getElementById('ui-build').textContent = UI_BUILD;
  await step('config', loadConfig);
  await step('miniservers', loadMiniservers);
  await step('knxd_devices', loadKnxdDevices);
  await step('groupaddresses', loadGaRows);
  await step('status', pollStatus);
  setInterval(pollStatus, 5000);
})();
</script>
HTML

LoxBerry::Web::lbfooter();
