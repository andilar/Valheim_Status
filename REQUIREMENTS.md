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
- Session list: player, join time, leave time, duration
- Total playtime per player, last seen, sessions count
- Deaths per player (from respawn `Got character ZDOID from X : 0:0` lines — verify)

### F3 History & charts
- Players online over time (day / week / all)
- Playtime per player per week
- Server uptime / restarts / crashes timeline
- World backups: list and time of last backup

### F4 Data collection
- Background collector tails `latest.log`, follows the symlink across restarts
- One-time import of all existing logs (session logs + `archive/`), deduplicated
- Survives collector and server restarts without double-counting

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
- In-game chat, player positions/map, boss progress (need mods or world-save parsing)
- Server controls and settings editing (planned v2)

## Resolved
- Dashboard is fully public: player names, playtime and join code are shown.
- IP address is never shown (public or LAN); players join via join code.
- Live updates every 10 s were considered and rejected: GitHub's ~5 min CDN cache and API rate limits
  make it impossible, and pushing every 10 s would risk the GitHub account. Decision: GitHub-only,
  push every ~2 min, live status is ~2–5 min old.
