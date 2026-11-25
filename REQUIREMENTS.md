# Valheim Server Dashboard — Requirements (v1)

Server: `Rethen_LAN_FTW`, world `eleventh heaven`, macOS 12 Mac running as launchd daemon
`com.andilar.valheim-server`. Log source: `~/Library/Logs/ValheimServer/latest.log` (+ dated session logs, `archive/`).

## Decisions
| Topic     | Decision |
|-----------|----------|
| Audience  | Owner + friends, reachable over the internet |
| Controls  | Read-only in v1 (start/stop/backup/settings later) |
| History   | Kept forever in SQLite, independent of log rotation |
| Stack     | Python collector on the Mac (stdlib) + static page on GitHub Pages |
| Hosting   | GitHub Pages from repo `andilar/Valheim_Status` (public) |

## Functional requirements

### F1 Live status
- Server state: online / offline / starting / crashed, uptime since last start
- Current join code, server name, world name (no IP address)
- Players online now (character names) and count
- Last world save: time, duration, save number; free disk space
- Server process CPU and memory

### F2 Players
- **Online now**: character names currently on the server, and since when ("Ragnar — online 1 h 12 min")
- **Leaderboard: most time played**, ranked by total playtime, with period filter (this week / month / all time)
- Per-player stats: total playtime, sessions, average and longest session, first seen, last seen, deaths
- Session list: player, join time, leave time, duration
- Deaths per player: `Got character ZDOID from X : 0:0` = death, followed by a respawn line

**Attribution logic (log limitations)**
- Join: `Player joined` → `Got handshake from client playfab/<ID>` → `Got character ZDOID from <Name>` links the client ID to the character name.
- Leave: `Keep socket for playfab/<ID>` (connection drop) names the client exactly; a normal quit (`RPC_Disconnect`) does not.
- Unnamed leaves are resolved by the `now N player(s)` count; when the count reaches 0 all sessions are closed.
- A leave that can't be attributed with certainty is flagged; the session is closed at the best estimate and corrected when the count later disagrees.
- Server restart or crash closes all open sessions at the last log timestamp.
- Client IDs are used internally only, never published.

### F3 History & charts
- Players online over time (day / week / all)
- Playtime per player per week
- Server uptime / restarts / crashes timeline
- World backups: list and time of last backup

### F4 Data collection
- Background collector tails `latest.log`, follows the symlink across restarts
- One-time import of all existing logs (session logs + `archive/`), deduplicated
- Survives collector and server restarts without double-counting

### F5 Boss overview & world progress
Source: **world save**, not the log. The log only says "sending global keys", without names.
`~/Library/Application Support/IronGate/Valheim/worlds_local/eleventh heaven/_main.<N>.db2`
(16-byte header, then gzip). It contains the world's *global keys* list
(length-prefixed strings, preceded by an int32 count).

- Boss cards in progression order, defeated / not defeated:
  | Boss | Key | Biome |
  |------|-----|-------|
  | Eikthyr | `defeated_eikthyr` | Grasland |
  | Der Uralte | `defeated_gdking` | Düsterwald |
  | Knochenwanst | `defeated_bonemass` | Sumpfland |
  | Moder | `defeated_dragon` | Gebirge |
  | Yagluth | `defeated_goblinking` | Ebenen |
  | Die Königin | `defeated_queen` | Nebellande |
  | Fader | `defeated_fader` | Aschenlande |
  | Kall Fimbulbringer | unknown (shown as "status unknown" until mapped) | Hoher Norden |
- Mini-bosses & milestones: Hildir quests (`hildir1-3`), troll/surtling/bat/serpent first kills, Ashlands ocean.
- "World progress" bar: bosses defeated / total; current biome tier derived from it.
- Keys of newer content (`defeated_writhan`, `elakingmole_defeated`, `jotun_killed`) are **not** bosses defeated
  as named; meaning unverified, so they are shown only as raw keys until mapped by the owner.
- In-game day: world clock (`netTime`, float64 seconds) from the save header (int32 version, float64 netTime,
  before the gzip stream) ÷ 1800 s per day. Fallback: the `Time …, day:N` line logged when players sleep.
  The log's `World time` in autobackup lines is only the server's uptime, **not** the world clock.
- Date a boss was defeated: no timestamp in the save. The collector records the date a key first appears
  (accurate from now on; existing kills are shown as "defeated, date unknown").
- Unknown keys (new game updates or mods) are shown with their raw name instead of being dropped.
- Read the newest complete save only (the one with a matching `.ok` file); read-only, never lock or write the save.
- Parser is heuristic (no official format spec); must fail safe: on parse error keep last known state and flag it.

**Not available server-side:** player skill levels, inventory and character level are stored on each
player's own PC, not on the server.

**Never published from the save:** Steam IDs, PlayFab IDs and account names listed in the `.fwl2` file.

## Non-functional requirements

### N1 Architecture & security (public site)
- Mac: collector parses logs into local SQLite (never leaves the Mac).
- Mac: every ~2 min it exports a sanitized `status.json` / `history.json` and force-pushes them as a
  single commit to branch `data` (no history bloat, no Pages rebuild).
- GitHub Pages serves the static dashboard from `main`; the page fetches the JSON from the `data` branch.
- Push auth: SSH deploy key with write access to this repo only (`~/.ssh/valheim_status_deploy`).
- The site is public, so no real login is possible. Treat everything published as public.
- Never published: server password, public and LAN IP address, file paths, raw log lines, PlayFab/Steam IDs, the SQLite file.
- Nothing on GitHub can change the server (read-only by design).

### N2 Operations
- Collector runs as launchd daemon, starts at boot, restarts on crash
- Low footprint (must not affect game server performance)
- Own log in `~/Library/Logs/ValheimServer/collector.log`
- Page shows "data last updated" and marks status stale/offline if the Mac stops pushing

### N3 UI
- Works on phone and desktop, light/dark
- Auto-refresh every 60 s; data is up to ~5 min old (push interval + GitHub caching), shown on the page

## Out of scope (v1)
- In-game chat, player positions/map (need mods); player skills (stored on clients)
- Server controls and settings editing (planned v2)

## Resolved
- Dashboard is fully public: player names, playtime and join code are shown.
- IP address is never shown (public or LAN); players join via join code.
- Live updates every 10 s were considered and rejected: GitHub's ~5 min CDN cache and API rate limits
  make it impossible, and pushing every 10 s would risk the GitHub account. Decision: GitHub-only,
  push every ~2 min, live status is ~2–5 min old.
