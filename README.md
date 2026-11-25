# Valheim Server Status

Öffentliches Dashboard für den Valheim-Server **Rethen_LAN_FTW** (Welt „eleventh heaven“):
Live-Status, Join-Code, wer online ist, Spielzeit-Rangliste, Verlauf und Boss-Fortschritt.

**Seite:** https://andilar.github.io/Valheim_Status/

Anforderungen und Entscheidungen: [REQUIREMENTS.md](REQUIREMENTS.md)

## So funktioniert es

```
Server-Mac                                         GitHub
──────────                                         ──────
Valheim-Logs ─┐                                    Branch main  → GitHub Pages (index.html, assets/)
Welt-Save ────┼─> valheim_collector.py ─ alle 2 min ─> Branch data (status.json, history.json)
              │        │                                        ▲
              │        └─ SQLite (bleibt auf dem Mac)           │ fetch alle 60 s
              └──────────────────────────────────── Browser ────┘
```

- Der **Collector** (`collector/valheim_collector.py`, nur Python-Standardbibliothek) liest die
  Server-Logs inkrementell in eine SQLite-Datenbank. Die Datenbank hält die Historie dauerhaft,
  unabhängig davon, ob die Logs gelöscht werden. Die Bosse liest er aus dem neuesten vollständigen
  Welt-Save, ausschließlich lesend.
- Bei jedem Durchlauf rekonstruiert er Sessions und Server-Läufe und exportiert zwei bereinigte
  JSON-Dateien. Die pusht er als einzelnen Commit per Force-Push auf den Branch `data`.
  Dabei entsteht keine wachsende Historie und kein Pages-Rebuild.
- Die Seite (`index.html`, `assets/`) lädt die JSON-Dateien von
  `raw.githubusercontent.com/andilar/Valheim_Status/data/…`. GitHub cacht diese Dateien bis zu 5 Minuten.

### Ping
Bei jedem Durchlauf schickt der Collector 5 Pings an **1.1.1.1** (Cloudflare). Antwortet der gar nicht,
geht die Messung an 8.8.8.8 (Google). Beide sind Anycast-Adressen, also überall in der Nähe und sehr
zuverlässig. Veröffentlicht werden nur der Name des Ziels, Ø/Min/Max, Jitter und Paketverlust.
Die Messung zeigt die Internetverbindung des Server-Macs, nicht den Ping der Spieler. Den gibt das
Server-Log nicht her.

### Was nie veröffentlicht wird
Auch keine einzelnen Sessions: `history.json` enthält nur Summen. Pro Spieler und Tag sind das Spielzeit,
Anzahl Sessions, längste Session und Tode. Pro Stunde steht dort nur, wie viele Spieler gleichzeitig online waren,
ohne Namen. Wer gerade online ist (Name und „online seit“), steht weiterhin in `status.json`.
Server-Passwort, IP-Adressen, Dateipfade, rohe Log-Zeilen, PlayFab/Steam-IDs und die SQLite-Datei.
`assert_sanitized()` bricht den Export ab, falls doch etwas danach aussieht.

## Betrieb auf dem Mac

| Was | Wo |
|---|---|
| Collector (läuft von hier) | `~/ValheimServer/valheim_collector.py` (Kopie aus diesem Repo) |
| Datenbank & Push-Repo | `~/Library/Application Support/ValheimStatus/` |
| Collector-Log | `~/Library/Logs/ValheimServer/collector.log` |
| Dienst | `com.andilar.valheim-collector` |

macOS lässt launchd-Dienste nicht in `~/Documents` lesen. Deshalb läuft der Dienst aus einer Kopie
in `~/ValheimServer/`.

**Als Boot-Daemon installieren** (läuft dann auch ohne Anmeldung, wie der Server):
```sh
sudo ~/Documents/Github/Valheim_Status/collector/install_collector.sh
```
Bis dahin läuft der Collector als LaunchAgent, also nur, solange jemand am Mac angemeldet ist.

**Nach Änderungen am Collector:**
```sh
~/Documents/Github/Valheim_Status/collector/update_collector.sh
```

**Von Hand testen:**
```sh
python3 collector/valheim_collector.py once --no-push   # ein Durchlauf, kein Push
python3 collector/valheim_collector.py export .local-data
python3 -m http.server 8765    # dann http://127.0.0.1:8765/?data=.local-data/
```

## Wie Sessions erkannt werden

Das Server-Log nennt beim Einloggen den Spieler: Auf `Got handshake from client …` folgt
`Got character ZDOID from <Name>`. Beim normalen Ausloggen (`RPC_Disconnect`) steht dagegen kein Name.
Der Collector löst das so auf:

- Ein Verbindungsabbruch (`Keep socket for …`) nennt den Client. Folgt kurz darauf ein `Player joined`
  ohne neuen Handshake, war es ein Reconnect und die Session läuft weiter.
- Unbenannte Logouts ordnet er über die Spielerzahl zu: `Connections N` alle 10 Minuten sowie
  „now N player(s)“. Wer danach noch aktiv ist (stirbt, respawnt), kann es nicht gewesen sein.
  Sonst trifft es den am längsten inaktiven Spieler.
- Erweist sich eine Zuordnung später als falsch (der Spieler ist noch aktiv), wird sie korrigiert.
  Unsichere Enden zeigt die Seite mit **≈** an.
- Tode: `Got character ZDOID from <Name> : 0:0`.
- Server-Läufe erkennt er an den Markern von `start_valheim.sh` (`=== … starting / stop requested / exited`)
  und an `OnApplicationQuit`. Ein Lauf ohne sauberes Ende gilt als Absturz oder Stromausfall.

Weil jeder Durchlauf alles aus den gespeicherten Events neu berechnet, wirken Verbesserungen an der
Logik automatisch auch auf die alten Daten.
