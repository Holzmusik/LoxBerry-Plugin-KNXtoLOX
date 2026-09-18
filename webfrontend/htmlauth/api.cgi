#!/usr/bin/perl
# KNXtoLOX API — JSON-Action-Dispatch fuer die Single-Page-App (index.cgi).
# Ersetzt die bisherigen settings.cgi/groupaddresses.cgi/log.cgi (siehe README/
# CHANGELOG) mit einer einzigen action=-dispatch API nach dem Vorbild von
# MiraiPanel/webfrontend/htmlauth/api.php.
use LoxBerry::System;
use LoxBerry::Web;
use CGI;
use YAML::Tiny;
use JSON::PP;
use Text::CSV;
use strict;
use warnings;

my $cgi = CGI->new;

# system(@cmd) (Listenform, keine Shell, kein Injection-Risiko) erbt
# standardmaessig STDOUT/STDERR vom aufrufenden Prozess - bei einem CGI-Skript
# IST STDOUT die HTTP-Antwort! Schreibt der Kindprozess (z.B. knxproj_import.py)
# eigene Statuszeilen auf STDOUT, landen die dadurch VOR unserem eigenen
# JSON-Response im Antwort-Body, was das JSON kaputt macht (auf echter
# Hardware beobachtet: "OK: 68 Gruppenadressen exportiert nach ..." vor dem
# eigentlichen JSON). run_capture() faengt das ab, indem es STDOUT/STDERR
# waehrend des Aufrufs auf eine temporaere Datei umbiegt.
sub run_capture {
    my (@cmd) = @_;
    my $capfile = "/tmp/knxmqtt_run_$$.out";
    open(my $oldout, '>&', \*STDOUT) or return (system(@cmd), '');
    open(my $olderr, '>&', \*STDERR) or return (system(@cmd), '');
    open(STDOUT, '>', $capfile) or return (system(@cmd), '');
    open(STDERR, '>&', \*STDOUT);
    my $rc = system(@cmd);
    open(STDOUT, '>&', $oldout);
    open(STDERR, '>&', $olderr);
    close $oldout; close $olderr;
    my $output = '';
    if (open(my $cf, '<', $capfile)) { local $/; $output = <$cf>; close $cf; }
    unlink $capfile;
    return ($rc, $output);
}

# Eigenes, simples Datei-Logging statt LoxBerry::Log's benannter Methoden -
# ZWEI verschiedene geratene Methodennamen (LOGINF, dann LOGOK) existierten
# beide nachweislich nicht auf diesem System ("Can't locate object method").
# Statt eine dritte Vermutung zu riskieren: reines Perl, garantiert lauffaehig.
sub applog {
    my ($msg) = @_;
    my @t = localtime();
    my $ts = sprintf('%04d-%02d-%02d %02d:%02d:%02d', $t[5]+1900, $t[4]+1, $t[3], $t[2], $t[1], $t[0]);
    if (open(my $fh, '>>:encoding(UTF-8)', "$lbplogdir/api.log")) {
        print $fh "[$ts] $msg\n";
        close $fh;
    }
}

my $cfgfile        = "$lbpconfigdir/config.yaml";
my $gafile         = "$lbpconfigdir/groupaddresses.yaml";
my $bridgejsonfile = "$lbpconfigdir/bridge.json";
my $loxcache       = "$lbpdatadir/lox_structure.json";
my $activityfile   = "/dev/shm/knxmqtt-activity.json"; # von bin/bridge.js geschrieben (RAM/tmpfs, siehe dessen recordActivity())
my $enginelogfile  = "$lbplogdir/knxmqtt.log"; # knx-mqtt (Go-Binary), siehe templates/.../knxmqtt.service
my $bridgelogfile  = "$lbplogdir/bridge.log";  # Node-Bruecke, siehe postroot.sh's knxlox-bridge.service

my $KNXMQTT_SERVICE = 'knxmqtt.service';
my $BRIDGE_SERVICE  = 'knxlox-bridge.service';
my $KNXD_SERVICE    = 'knxd.service';

# export_csv liefert eine CSV-Datei mit eigenem Content-Type/Disposition-Header
# aus (siehe unten) — der Standard-JSON-Header wird nur fuer alle anderen
# Aktionen vorab gedruckt, sonst kaeme ein zweiter, widerspruechlicher Header.
# url_param() statt param(): action steht immer im Query-String
# (?action=...), auch bei POST mit JSON-Body. param() mischt Query-String
# und Body je nach Content-Type - bei "application/json" (unser Fall fuer
# POST) wurde der Query-String dabei nicht mehr beruecksichtigt, "action"
# kam serverseitig leer an (siehe api_log: "action= method=POST"). url_param()
# liest ausschliesslich den Query-String, unabhaengig von Methode/Content-Type.
my $action_peek = $cgi->url_param('action') // '';
if ($action_peek ne 'export_csv') {
    print $cgi->header(-type => 'application/json', -charset => 'utf-8', 'Cache-Control' => 'no-store');
}

# Alle Antworten kommen mit HTTP 200 und tragen Fehler im JSON-Body ("error"),
# statt den HTTP-Status nachtraeglich zu aendern — CGI.pm hat den Status-Header
# bereits oben mitgeschickt.
sub out { print JSON::PP->new->utf8->canonical->encode($_[0]); exit 0; }
sub err { my ($msg) = @_; applog($msg); out({ error => $msg }); }

# ── LoxBerry-Systemkonfiguration direkt lesen (general.json) ───────────────
# Gleiches Prinzip UND gleicher Pfad wie MiraiPanel/bin/bridge.js (dort
# nachweislich funktionierend): NICHT ueber ein LoxBerry::System-Perl-Global
# (z.B. $lbsconfigdir - dessen Existenz/Wert war nie verifiziert und war schon
# zweimal die Ursache aehnlicher Bugs in diesem Plugin, siehe plugin.cfg/
# LOGINF-Vorfaelle), sondern derselbe hart hinterlegte Pfad wie bei bridge.js:
# ${LBHOMEDIR:-/opt/loxberry}/config/system/general.json. Feldnamen ebenfalls
# 1:1 wie in bridge.js (Ipaddress/Port/Admin_raw/Pass_raw, Mqtt.Brokerhost/...).
sub read_general_json {
    my $home = $ENV{LBHOMEDIR} || '/opt/loxberry';
    my $file = "$home/config/system/general.json";
    return {} unless -f $file;
    local $/;
    open(my $fh, '<', $file) or return {};
    my $text = <$fh>;
    close $fh;
    my $data = eval { JSON::PP->new->utf8->decode($text) };
    return $data || {};
}

sub miniserver_list {
    my $general = read_general_json();
    my $ms = $general->{Miniserver} || $general->{Miniservers} || {};
    my @out;
    for my $msno (sort keys %$ms) {
        my $m = $ms->{$msno};
        next unless $m->{Ipaddress} || $m->{IPAddress};
        push @out, {
            msno      => $msno + 0,
            name      => $m->{Name} || "Miniserver $msno",
            ipaddress => $m->{Ipaddress} || $m->{IPAddress},
        };
    }
    return \@out;
}

sub miniserver_conn {
    my ($msno) = @_;
    return undef unless $msno;
    my $general = read_general_json();
    my $ms = $general->{Miniserver} || $general->{Miniservers} || {};
    my $m = $ms->{$msno} || $ms->{"$msno"};
    return undef unless $m && ($m->{Ipaddress} || $m->{IPAddress});
    return {
        host => $m->{Ipaddress} || $m->{IPAddress},
        port => $m->{Port} || 80,
        user => $m->{Admin_raw} || $m->{Admin} || '',
        pass => $m->{Pass_raw}  || $m->{Pass}  || '',
    };
}

sub mqtt_broker_conn {
    my $general = read_general_json();
    my $m = $general->{Mqtt} || {};
    return undef unless $m->{Brokerhost};
    return {
        host => $m->{Brokerhost},
        port => $m->{Brokerport} || 1883,
        user => $m->{Brokeruser} || '',
        pass => $m->{Brokerpass} || '',
    };
}

# Liefert LoxAPP3.json als reinen Text (aus dem 1h-Cache oder frisch
# geladen) - gemeinsam genutzt von action=lox_structure (gibt den Text
# unveraendert weiter) und action=lox_controls (parst ihn zusaetzlich fuer
# den UUID-Picker). Ausgelagert, damit beide Aktionen exakt dieselbe
# Cache-/Fetch-Logik verwenden statt sie zu duplizieren.
sub fetch_lox_structure_text {
    if (-f $loxcache && (time() - (stat($loxcache))[9]) < 3600) {
        local $/;
        open(my $fh, '<', $loxcache) or return undef;
        my $text = <$fh>;
        close $fh;
        return $text;
    }
    my $bridgejson = {};
    if (-f $bridgejsonfile) {
        local $/;
        open(my $fh, '<', $bridgejsonfile);
        $bridgejson = eval { JSON::PP->new->utf8->decode(<$fh>) } || {};
        close $fh;
    }
    my $lox = miniserver_conn($bridgejson->{loxone}{msno});
    return undef unless $lox;
    my $url = "http://$lox->{host}:$lox->{port}/data/LoxAPP3.json";
    my $auth = encode_base64_basic("$lox->{user}:$lox->{pass}");
    my $data = '';
    if (open(my $ph, '-|', 'curl', '-fsS', '--max-time', '5', '-H', "Authorization: Basic $auth", $url)) {
        local $/;
        $data = <$ph>;
        close $ph;
    }
    return undef unless $data;
    mkdir($lbpdatadir) unless -d $lbpdatadir;
    open(my $fh, '>', $loxcache); print $fh $data; close $fh;
    return $data;
}

# ── Eigene UI-Einstellungen: AUSSCHLIESSLICH in bridge.json (reines JSON,
# von uns selbst geschrieben UND gelesen, kein Fremdformat-Risiko). ──────────
# config.yaml (siehe build_config_yaml() weiter unten) ist dagegen ein reines
# SCHREIBZIEL fuer die Go-Engine knx-mqtt - wird nie wieder eingelesen, auch
# nicht fuer die eigene Web-UI. Grund: ein frueherer Versuch, bus_mode/
# gira_gateway/knxd-Felder in einer eigenen config.yaml-Sektion abzulegen und
# ueber YAML::Tiny->read() fuer die UI zurueckzulesen, fuehrte dazu, dass die
# Bus-Verbindungs-Einstellungen nach einem Seitenwechsel/Neuladen verschwanden
# - YAML::Tiny ist ein sehr eingeschraenkter YAML-Parser (kein voller
# YAML-1.1-Support) und offenbar nicht zuverlaessig genug fuer die mehrfach
# verschachtelte Struktur dieser Datei. Mit bridge.json als alleiniger
# Quelle (nur JSON::PP, ein einziges Tool fuer Schreiben+Lesen) faellt dieses
# Risiko komplett weg.
my %SETTINGS_DEFAULTS = (
    loxone       => { msno => 1 },
    log_level    => 'info',
    bus_mode     => 'gira',
    gira_gateway => '192.168.1.50',
    gira_port    => 3671,
    gira_tunnel  => JSON::PP::true,
    topic_prefix => 'knx/',
    client_id    => 'loxberry-knxmqtt',
    time_addr    => '', # KNX-Zeitgeber (DPT 10.001) - leer = deaktiviert, siehe bin/bridge.js
    date_addr    => '', # KNX-Zeitgeber (DPT 11.001) - leer = deaktiviert, siehe bin/bridge.js
    knxd         => {
        device => '/dev/ttyAMA0', own_addr => '0.0.1', pool_start => '0.0.2',
        pool_size => 10, cache => JSON::PP::true, loglevel => 'error', send_delay => 0,
        extra_ip_enabled => JSON::PP::false, extra_ip => '',
        ets_access_enabled => JSON::PP::false, ets_port => 6720, local_ip_port => 3671,
    },
);

sub load_settings {
    my %s = %SETTINGS_DEFAULTS;
    if (-f $bridgejsonfile) {
        local $/;
        open(my $fh, '<', $bridgejsonfile) or return \%s;
        my $data = eval { JSON::PP->new->utf8->decode(<$fh>) };
        close $fh;
        if ($data) {
            for my $key (keys %$data) { $s{$key} = $data->{$key}; }
        }
    }
    # loxone.msno liegt in der Datei verschachtelt (das erwartet bin/bridge.js
    # unveraendert, siehe dessen loadMiniserverConn()) - fuers Frontend-Formular
    # (currentConfigForm()/fillConfigForm() in index.cgi) als flaches
    # loxone_msno herausreichen.
    $s{loxone_msno} = ($s{loxone}{msno} || 1) + 0;
    return \%s;
}

sub save_settings {
    my ($body) = @_;
    # Immer alle Felder vollstaendig schreiben (nicht mergen) - der Body kommt
    # von currentConfigForm() im Frontend, das immer das komplette Formular
    # sendet, siehe index.cgi.
    my %s = (%SETTINGS_DEFAULTS, %$body);
    $s{loxone} = { msno => ($body->{loxone_msno} || 1) + 0 };
    delete $s{loxone_msno};
    open(my $fh, '>', $bridgejsonfile) or err("Konnte bridge.json nicht schreiben: $!");
    print $fh JSON::PP->new->utf8->pretty->canonical->encode(\%s);
    close $fh;
    return \%s;
}

sub yaml_bool { return ($_[0] ? 'true' : 'false'); }
sub yaml_str  { my ($s) = @_; $s = defined($s) ? $s : ''; $s =~ s/"/\\"/g; return "\"$s\""; }

# Gemeinsam von build_config_yaml() und der KNX-Verbindungspruefung (action=
# knx_test) genutzt, damit beide garantiert dasselbe Ziel berechnen.
sub compute_knx_endpoint {
    my ($f) = @_;
    if (($f->{bus_mode} // 'gira') eq 'knxd') {
        my $port = $f->{knxd}{local_ip_port} || 3671;
        return ('127.0.0.1', $port, 1); # 1 = tunnelMode immer an (Unicast zu knxd)
    }
    return (($f->{gira_gateway} || '192.168.1.50'), ($f->{gira_port} || 3671), ($f->{gira_tunnel} ? 1 : 0));
}

# KNXnet/IP SEARCH_REQUEST per UDP senden und auf eine SEARCH_RESPONSE warten
# (Service-Type 0x0201 -> 0x0202, Kernbestandteil des KNXnet/IP-Standards).
# Siehe Kommentar bei action=knx_test fuer die Begruendung (UDP statt TCP).
sub knxnetip_search {
    my ($host, $port) = @_;
    require IO::Socket::INET;

    my $sock = IO::Socket::INET->new(
        PeerAddr => $host, PeerPort => $port, Proto => 'udp', Timeout => 2,
    ) or return 0;

    # HPAI (Host Protocol Address Information): Adresse/Port, an die die
    # Antwort geschickt werden soll. sockhost() kann nach connect() eines
    # UDP-Sockets "0.0.0.0" liefern (Betriebssystem waehlt die Quelladresse
    # erst beim tatsaechlichen Senden) - dann 0.0.0.0 eintragen; die meisten
    # KNXnet/IP-Geraete antworten trotzdem an die tatsaechliche Absender-
    # adresse des empfangenen UDP-Pakets, nicht strikt nach HPAI-Feld.
    my $local_port = $sock->sockport() || 0;
    my @ip = split(/\./, $sock->sockhost() // '0.0.0.0');
    @ip = (0, 0, 0, 0) unless @ip == 4;

    my $header = pack('C C n n', 0x06, 0x10, 0x0201, 0x000E); # SEARCH_REQUEST
    my $hpai   = pack('C C C4 n', 0x08, 0x01, @ip, $local_port);
    $sock->send($header . $hpai);

    my $rin = '';
    vec($rin, fileno($sock), 1) = 1;
    my $ready = select($rin, undef, undef, 2);
    return 0 unless $ready;

    my $resp = '';
    $sock->recv($resp, 512);
    return 0 unless defined($resp) && length($resp) >= 6;
    my (undef, undef, $service) = unpack('C C n', $resp);
    return ($service == 0x0202) ? 1 : 0; # SEARCH_RESPONSE
}

sub build_config_yaml {
    my ($f) = @_; # flaches Formular-Hash, siehe action=config (POST)

    my ($host, $port, $tunnel_mode) = compute_knx_endpoint($f);
    my $endpoint = "$host:$port";

    my $broker = mqtt_broker_conn();
    my $mqtt_url  = $broker ? "tcp://$broker->{host}:$broker->{port}" : 'tcp://127.0.0.1:1883';
    my $mqtt_user = $broker ? $broker->{user} : '';
    my $mqtt_pass = $broker ? $broker->{pass} : '';

    my $topic_prefix = $f->{topic_prefix} || 'knx/';
    my $client_id    = $f->{client_id} || 'loxberry-knxmqtt';

    return <<"YAML";
# Automatisch von api.cgi (action=config) erzeugt — NICHT von Hand editieren,
# Aenderungen werden beim naechsten Speichern ueberschrieben.
loglevel: info

outgoingMqttMessage:
  # type MUSS "bytes" sein, solange knx.etsExport leer ist (Binary verweigert
  # sonst den Start: "Outgoing MQTT message type can only be 'bytes' when no
  # KNX addresses are imported") - auf echter Hardware entdeckt, nicht aus
  # der Doku ableitbar. Payload ist dann roh (kein JSON/base64), Adresse
  # steht im Topic-Pfad statt im Payload, siehe bin/bridge.js.
  type: bytes
  emitUsingAddress: true
  emitUsingName: false
  emitValueAsString: false
  ignoreReadCommands: false

knx:
  etsExport: ""
  endpoint: $endpoint
  tunnelMode: @{[ yaml_bool($tunnel_mode) ]}
  ignoreUnknownGroupAddresses: false
  enableLogs: false

mqtt:
  url: @{[ yaml_str($mqtt_url) ]}
  clientId: @{[ yaml_str($client_id) ]}
  username: @{[ yaml_str($mqtt_user) ]}
  password: @{[ yaml_str($mqtt_pass) ]}
  topicPrefix: @{[ yaml_str($topic_prefix) ]}
  qos: 0
  retain: false
YAML
}

# knxd's Debian-Paket bringt sein eigenes systemd-Unit mit, das /etc/knxd.conf
# als EnvironmentFile liest (KNXD_OPTS="..."). Die exakte Flag-Syntax ist NICHT
# auf echter Hardware verifiziert (siehe Plan/CHANGELOG) — hier isoliert in
# einer einzelnen Funktion, damit eine spaetere Korrektur an einer Stelle bleibt.
sub build_knxd_opts {
    my ($k) = @_;
    my @opts;
    push @opts, "-e", $k->{own_addr}                if $k->{own_addr};
    push @opts, "-E", "$k->{pool_start}:$k->{pool_size}" if $k->{pool_start};
    push @opts, "-D" if $k->{cache};
    push @opts, "--listen-tcp=" . ($k->{local_ip_port} || 3671);
    push @opts, "-b", "tpuarts:" . $k->{device}      if $k->{device};
    return join(' ', @opts);
}

sub write_knxd_conf {
    my ($k) = @_;
    my $opts = build_knxd_opts($k);
    open(my $fh, '>', '/etc/knxd.conf') or do { applog("Konnte /etc/knxd.conf nicht schreiben: $!"); return; };
    print $fh "KNXD_OPTS=\"$opts\"\n";
    close $fh;
}

sub svc_active {
    my ($name) = @_;
    my (undef, $out) = run_capture('systemctl', 'is-active', $name);
    chomp $out;
    return $out;
}

sub svc_status {
    my ($name) = @_;
    my $active = svc_active($name);
    my (undef, $pid) = run_capture('systemctl', 'show', '--property', 'MainPID', '--value', $name);
    chomp $pid;
    undef $pid if !$pid || $pid eq '0' || $active ne 'active';
    return { running => ($active eq 'active') ? JSON::PP::true : JSON::PP::false, pid => $pid, status => $active };
}

# ── Gruppenadressen-Tabelle (groupaddresses.yaml) ──────────────────────────
# Bleibt bei YAML::Tiny (eigenes Format, nur von unserem Perl-Code und der
# Node-Bridge via js-yaml gelesen — kein Go-Struct-Binding-Risiko wie bei
# config.yaml).
my @GA_FIELDS = qw(addr dpt label lox_input_uuid lox_input_name lox_output_uuid lox_output_name);

sub load_ga_rows {
    return [] unless -f $gafile;
    my $yaml = YAML::Tiny->read($gafile);
    return $yaml ? ($yaml->[0]{groupaddresses} // []) : [];
}

sub save_ga_rows {
    my ($rows) = @_;
    my $yaml = YAML::Tiny->new({ groupaddresses => $rows });
    $yaml->write($gafile);
    # bin/bridge.js liest groupaddresses.yaml NUR beim eigenen Start (kein
    # Live-Nachladen) - ohne diesen Neustart wuerde eine gerade erst per
    # UUID-Picker+Speichern (oder CSV-/ETS-Import) zugewiesene Zuordnung vom
    # laufenden Node-Prozess schlicht nie bemerkt (auf echter Hardware
    # beobachtet: leere Live-Aktivitaet trotz konfigurierter Gruppenadresse).
    # In save_ga_rows() zentralisiert, damit alle drei Aufrufstellen
    # (Speichern-Button, CSV-Import, ETS-Import) das automatisch bekommen.
    # knxmqtt.service (Go-Engine) ist von dieser Datei nicht betroffen.
    run_capture('sudo', 'systemctl', 'restart', $BRIDGE_SERVICE);
}

# ── Dispatch ────────────────────────────────────────────────────────────
my $action = $cgi->url_param('action') // '';
my $method = $ENV{REQUEST_METHOD} // 'GET';

# Debug-Logging: jeder Request landet in api.log, unabhaengig vom Ergebnis -
# damit man am Log ablesen kann, ob ein Klick im Browser ueberhaupt beim
# Server ankommt (statt zu raten, ob es ein Frontend- oder Backend-Problem ist).
applog("Request: action=$action method=$method");

sub read_json_body {
    my $raw = $cgi->param('POSTDATA');
    if (!defined($raw) || $raw eq '') {
        local $/;
        $raw = <STDIN>;
    }
    return {} unless $raw;
    applog("Body (" . length($raw) . " Bytes): " . substr($raw, 0, 500));
    my $data = eval { JSON::PP->new->utf8->decode($raw) };
    if (!$data) {
        applog("JSON-Parse-Fehler im Request-Body: $@");
    }
    return $data || {};
}

if ($action eq 'config') {
    if ($method eq 'POST') {
        my $body = read_json_body();
        my $settings = save_settings($body);

        # config.yaml (Go-Engine) ist reines Schreibziel, wird nie zurueckgelesen.
        my $yamltext = build_config_yaml($settings);
        open(my $fh, '>', $cfgfile) or err("Konnte config.yaml nicht schreiben: $!");
        print $fh $yamltext;
        close $fh;

        if (($settings->{bus_mode} // 'gira') eq 'knxd') {
            write_knxd_conf($settings->{knxd} || {});
            run_capture('sudo', 'systemctl', 'enable', $KNXD_SERVICE);
            run_capture('sudo', 'systemctl', 'restart', $KNXD_SERVICE);
        } else {
            run_capture('sudo', 'systemctl', 'disable', $KNXD_SERVICE);
            run_capture('sudo', 'systemctl', 'stop', $KNXD_SERVICE);
        }

        applog('Konfiguration gespeichert (bus_mode=' . ($settings->{bus_mode} // 'gira') . ')');
        out({ ok => JSON::PP::true });
    } else {
        my $settings = load_settings();
        my $broker = mqtt_broker_conn();
        $settings->{mqtt_broker} = $broker ? "$broker->{host}:$broker->{port}" : '';
        out($settings);
    }
}
elsif ($action eq 'miniservers') {
    out(miniserver_list());
}
elsif ($action eq 'mqtt_info') {
    my $broker = mqtt_broker_conn();
    err('MQTT Gateway ist in LoxBerry nicht konfiguriert') unless $broker;
    out({ broker => "$broker->{host}:$broker->{port}" });
}
elsif ($action eq 'lox_structure') {
    my $data = fetch_lox_structure_text();
    err('Loxone nicht erreichbar') unless $data;
    print $data;
    exit 0;
}
elsif ($action eq 'lox_controls') {
    # Fuer den UUID-Picker: ZWEI getrennte Listen statt einer, weil "Eingang"
    # und "Ausgang" grundsaetzlich verschiedene Dinge brauchen:
    #  - "controls": die Steuerung selbst (ihre eigene UUID) - das ist das
    #    generische jdev/sps/io-Kommandoziel, funktioniert fuer JEDEN
    #    Control-Typ gleich (fuer "Loxone-Eingang"/lox_input_uuid).
    #  - "states": JEDER einzelne Zustand JEDER Steuerung, mit dem
    #    Zustandsschluessel (z.B. "active", "value", "position") im Namen
    #    sichtbar gemacht (fuer "Loxone-Ausgang"/lox_output_uuid - genau
    #    diese UUID beobachtet Loxones WebSocket auf Aenderungen).
    # Vorherige Version riet nur "states.value" und fiel sonst auf die
    # Control-UUID zurueck - bei einem normalen Schalter (Zustandsschluessel
    # "active", nicht "value") landete so die falsche (Kommando- statt
    # Zustands-)UUID im Ausgang-Feld, wodurch Loxone-Aenderungen nie
    # ankamen (auf echter Hardware beobachtet, vom Nutzer selbst vermutet).
    # Bewusst KEIN Typ-Filter (z.B. "virtueller Ausgang") - dessen genaue
    # Loxone-Typbezeichnung ist nicht verifiziert, jdev/sps/io und die
    # WebSocket-Events funktionieren ohnehin generisch fuer jeden Typ.
    my $text = fetch_lox_structure_text();
    err('Loxone-Struktur nicht verfuegbar') unless $text;
    my $struct = eval { JSON::PP->new->utf8->decode($text) };
    err('Loxone-Struktur konnte nicht gelesen werden') unless $struct;

    my $rooms = $struct->{rooms} || {};
    my $controls = $struct->{controls} || {};
    my (@ctrl_out, @state_out);

    my $add = sub {
        my ($uuid, $name, $room_name, $type, $states) = @_;
        push @ctrl_out, { uuid => $uuid, name => $name, room => $room_name, type => $type };
        for my $state_key (sort keys %$states) {
            push @state_out, {
                uuid => $states->{$state_key},
                name => "$name ($state_key)",
                room => $room_name,
                type => $type,
            };
        }
    };

    for my $uuid (keys %$controls) {
        my $c = $controls->{$uuid};
        next unless $c && $c->{name};
        my $room_name = $c->{room} && $rooms->{$c->{room}} ? $rooms->{$c->{room}}{name} : '';
        $add->($uuid, $c->{name}, $room_name, $c->{type} || '', $c->{states} || {});
        # Subcontrols (z.B. einzelne Kanaele eines Bausteins) mit aufnehmen,
        # Name mit dem Eltern-Control-Namen praefixiert zur Einordnung.
        for my $sub_uuid (keys %{ $c->{subControls} || {} }) {
            my $sc = $c->{subControls}{$sub_uuid};
            next unless $sc && $sc->{name};
            $add->($sub_uuid, "$c->{name} - $sc->{name}", $room_name, $sc->{type} || '', $sc->{states} || {});
        }
    }
    my $by_room_name = sub { ($_[0]{room} cmp $_[1]{room}) || ($_[0]{name} cmp $_[1]{name}) };
    @ctrl_out  = sort { $by_room_name->($a, $b) } @ctrl_out;
    @state_out = sort { $by_room_name->($a, $b) } @state_out;
    out({ controls => \@ctrl_out, states => \@state_out });
}
elsif ($action eq 'lox_test') {
    my $bridgejson = {};
    if (-f $bridgejsonfile) {
        local $/;
        open(my $fh, '<', $bridgejsonfile);
        $bridgejson = eval { JSON::PP->new->utf8->decode(<$fh>) } || {};
        close $fh;
    }
    my $lox = miniserver_conn($bridgejson->{loxone}{msno});
    err('Kein Miniserver ausgewaehlt oder in LoxBerry konfiguriert') unless $lox;
    my $url = "http://$lox->{host}:$lox->{port}/jdev/cfg/apiKey";
    my $auth = encode_base64_basic("$lox->{user}:$lox->{pass}");
    my ($rc, undef) = run_capture('curl', '-fsS', '--max-time', '3', '-H', "Authorization: Basic $auth", $url, '-o', '/dev/null');
    out({ ok => ($rc == 0) ? JSON::PP::true : JSON::PP::false });
}
elsif ($action eq 'groupaddresses') {
    if ($method eq 'POST') {
        my $body = read_json_body();
        my $rows = $body->{groupaddresses} || [];
        save_ga_rows($rows);
        applog('Gruppenadressen gespeichert (' . scalar(@$rows) . ' Eintraege)');
        out({ ok => JSON::PP::true });
    } else {
        out({ groupaddresses => load_ga_rows() });
    }
}
elsif ($action eq 'export_csv') {
    print "Content-Type: text/csv; charset=utf-8\n";
    print "Content-Disposition: attachment; filename=groupaddresses.csv\n\n";
    print join(';', @GA_FIELDS) . "\n";
    for my $r (@{ load_ga_rows() }) {
        print join(';', map { $r->{$_} // '' } @GA_FIELDS) . "\n";
    }
    exit 0;
}
elsif ($action eq 'import_csv') {
    my $fh_up = $cgi->upload('csv_file');
    err('Keine Datei ausgewaehlt') unless $fh_up;
    my $rows = load_ga_rows();
    my %existing = map { $_->{addr} => 1 } @$rows;
    my $csv = Text::CSV->new({ binary => 1, sep_char => ';' });
    my $count = 0;
    while (my $line = <$fh_up>) {
        chomp $line;
        next if $line =~ /^\s*(#|Gruppenadresse)/i;
        if ($csv->parse($line)) {
            my @f = $csv->fields;
            next unless $f[0];
            next if $existing{$f[0]};
            push @$rows, {
                addr => $f[0], dpt => $f[1] // 'raw', label => $f[2] // '',
                lox_input_uuid => $f[3] // '', lox_input_name => $f[4] // '',
                lox_output_uuid => $f[5] // '', lox_output_name => $f[6] // '',
            };
            $count++;
        }
    }
    save_ga_rows($rows);
    applog("CSV-Import: $count neue Gruppenadressen");
    out({ ok => JSON::PP::true, imported => $count, groupaddresses => $rows });
}
elsif ($action eq 'import_ets') {
    my $upload = $cgi->upload('knxproj_file');
    my $password = $cgi->param('knxproj_password') // '';
    err('Keine Datei ausgewaehlt') unless $upload;

    my $tmpfile = "/tmp/knxmqtt_import_$$.knxproj";
    open(my $out_fh, '>', $tmpfile) or err("Konnte temporaere Datei nicht anlegen: $!");
    binmode $out_fh;
    while (my $chunk = <$upload>) { print $out_fh $chunk; }
    close $out_fh;

    my $jsonfile = "/tmp/knxmqtt_import_$$.json";
    my @cmd = ("python3", "$lbpbindir/knxproj_import.py", "--input", $tmpfile, "--output", $jsonfile);
    push @cmd, "--password", $password if length($password);
    my ($rc, $subout) = run_capture(@cmd);
    applog("knxproj_import.py: $subout") if $subout;
    unlink $tmpfile;

    if ($rc != 0 || !-f $jsonfile) {
        applog("ETS-Import fehlgeschlagen (rc=$rc)");
        err('ETS-Import fehlgeschlagen - falsches Passwort oder ungueltige Datei. Details siehe Log.');
    }

    local $/;
    open(my $jf, '<', $jsonfile) or err("Konnte Import-Ergebnis nicht lesen: $!");
    my $jsontext = <$jf>;
    close $jf;
    unlink $jsonfile;

    my $imported = JSON::PP->new->utf8->decode($jsontext);
    my $rows = load_ga_rows();
    my %existing = map { $_->{addr} => 1 } @$rows;
    my $count = 0;
    for my $item (@$imported) {
        next if $existing{$item->{addr}};
        push @$rows, {
            addr => $item->{addr}, dpt => $item->{dpt} // 'raw', label => $item->{label} // '',
            lox_input_uuid => '', lox_input_name => '', lox_output_uuid => '', lox_output_name => '',
        };
        $count++;
    }
    save_ga_rows($rows);
    applog("ETS-Import: $count neue Gruppenadressen");
    out({ ok => JSON::PP::true, imported => $count, groupaddresses => $rows });
}
elsif ($action eq 'engine_status') {
    my $s = svc_status($KNXMQTT_SERVICE);
    $s->{log} = tail_log($enginelogfile, 100);
    out($s);
}
elsif ($action eq 'bridge_status') {
    my $s = svc_status($BRIDGE_SERVICE);
    $s->{log} = tail_log($bridgelogfile, 100);
    out($s);
}
elsif ($action eq 'bridge_restart') {
    applog('Neustart von ' . $KNXMQTT_SERVICE . ' und ' . $BRIDGE_SERVICE . ' angefordert');
    my (undef, $out1) = run_capture('sudo', 'systemctl', 'restart', $KNXMQTT_SERVICE);
    my (undef, $out2) = run_capture('sudo', 'systemctl', 'restart', $BRIDGE_SERVICE);
    out({ ok => JSON::PP::true, knxmqtt => $out1, bridge => $out2 });
}
elsif ($action eq 'knx_test') {
    # Echter KNXnet/IP-Discovery-Test (SEARCH_REQUEST/SEARCH_RESPONSE) statt
    # TCP-Connect: KNXnet/IP-Tunneling laeuft ueber UDP, nicht TCP - ein reiner
    # TCP-Connect-Versuch schlaegt daher IMMER fehl, egal ob das Ziel (Gira-
    # Gateway, ein Loxone-Miniserver mit eingebautem KNX/IP-Interface, oder
    # knxd) korrekt laeuft oder nicht. SEARCH_REQUEST ist Teil des KNXnet/IP-
    # Kern-Standards (Service-Type 0x0201/0x0202) und wird ueblicherweise auch
    # per Unicast direkt an ein Geraet beantwortet (nicht nur per Multicast-
    # Discovery) - so verhalten sich in der Praxis sowohl Gira-Gateways als
    # auch Loxone-Miniserver-eigene KNX/IP-Interfaces und knxd. **Noch nicht
    # auf echter Hardware verifiziert** - falls das gegen ein bekanntermassen
    # laufendes Interface trotzdem "false" liefert, als naechstes pruefen ob
    # das Ziel eine Unicast-SEARCH_REQUEST wirklich beantwortet (z.B. mit
    # einem KNX-Diagnosewerkzeug/Wireshark) statt an dieser Funktion weiter zu
    # raten.
    my $settings = load_settings();
    my ($host, $port) = compute_knx_endpoint($settings);
    my $ok = knxnetip_search($host, $port);
    out({ ok => $ok ? JSON::PP::true : JSON::PP::false, endpoint => "$host:$port" });
}
elsif ($action eq 'knxd_devices') {
    my @devs = glob('/dev/ttyAMA* /dev/ttyUSB* /dev/ttyACM*');
    out(\@devs);
}
elsif ($action eq 'api_log') {
    # Eigenes Request-Log dieser API (siehe LOGOK-Aufrufe oben) - zeigt, ob
    # ein Klick im Browser ueberhaupt beim Server ankommt und was er damit
    # gemacht hat. Getrennt von engine_status/bridge_status, die die beiden
    # Bridge-Dienste selbst betreffen, nicht die Web-UI-API.
    out({ log => tail_log("$lbplogdir/api.log", 150) });
}
elsif ($action eq 'knx_activity') {
    # Live-Aktivitaet (letzte 50 Ereignisse beider Richtungen), von
    # bin/bridge.js in activity.json geschrieben - siehe dessen
    # recordActivity(). Fuer die Status-Seite, damit man auf einen Blick
    # sieht ob/was gerade tatsaechlich durch die Bridge laeuft, statt im
    # Rohlog suchen zu muessen.
    my $events = [];
    if (-f $activityfile) {
        local $/;
        open(my $fh, '<', $activityfile);
        $events = eval { JSON::PP->new->utf8->decode(<$fh>) } || [];
        close $fh;
    }
    out({ activity => $events });
}
else {
    err('Unbekannte Aktion');
}

sub tail_log {
    my ($file, $n) = @_;
    return '' unless -f $file;
    # :encoding(UTF-8) ist noetig, sonst liest Perl die von Node/systemd
    # geschriebenen UTF-8-Bytes als undekodierte Rohbytes - JSON::PP's
    # ->utf8-Modus kodiert diese dann NOCHMAL als UTF-8 (Doppel-Kodierung),
    # was im Browser als kaputte "?"-Zeichen bei Umlauten/Sonderzeichen
    # (z.B. dem "✓" in bridge.js' Log-Ausgabe) sichtbar wird.
    open(my $fh, '<:encoding(UTF-8)', $file) or return '';
    my @lines = <$fh>;
    close $fh;
    my $start = @lines > $n ? @lines - $n : 0;
    return join('', @lines[$start .. $#lines]);
}

# Minimaler Base64-Encoder fuer den Authorization-Header (kein MIME::Base64-
# Zwang, falls das Modul auf dem Zielsystem fehlt) — Standard-Alphabet.
sub encode_base64_basic {
    my ($str) = @_;
    require MIME::Base64;
    my $b64 = MIME::Base64::encode_base64($str, '');
    return $b64;
}
