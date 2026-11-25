#!/usr/bin/env python3
"""Valheim server dashboard collector (stdlib only).

Reads the dedicated server's logs and world save on this Mac, keeps all history
in a local SQLite database, and publishes sanitized status.json / history.json
to the `data` branch of the dashboard repo.

Usage:
  valheim_collector.py run        # loop forever (launchd)
  valheim_collector.py once       # one cycle: ingest + export (+ push unless --no-push)
  valheim_collector.py export DIR # one cycle, write JSON to DIR, no push
Options: --no-push

Nothing private is ever written to the JSON: no IP addresses, no server password,
no file paths, no raw log lines, no PlayFab/Steam IDs.
"""
import glob
import hashlib
import json
import logging
import os
import re
import sqlite3
import struct
import subprocess
import sys
import time
import zlib

VERSION = "1.0"
HOME = os.path.expanduser("~")

CFG = {
    "server_name": "Rethen_LAN_FTW",
    "world_name": "eleventh heaven",
    "log_dir": os.path.join(HOME, "Library/Logs/ValheimServer"),
    "world_dir": os.path.join(HOME, "Library/Application Support/IronGate/Valheim/worlds_local"),
    "data_dir": os.path.join(HOME, "Library/Application Support/ValheimStatus"),
    "remote": "git@github-valheim:andilar/Valheim_Status.git",
    "branch": "data",
    "interval": 120,          # seconds between cycles
    # internet latency of the server Mac: anycast resolvers, nearby everywhere, reliably answer ICMP.
    # The second target is only used when the first fails completely.
    # Only the label is published (the sanitizer rejects anything that looks like an IP).
    "ping_targets": [("1.1.1.1", "Cloudflare"), ("8.8.8.8", "Google")],
    "ping_count": 5,
    "git_name": "Valheim Status Collector",
    "git_email": "2079761+andilar@users.noreply.github.com",
}

DAY_SECONDS = 1800  # one in-game day

BOSSES = [  # progression order
    ("defeated_eikthyr", "Eikthyr", "Wiesen"),
    ("defeated_gdking", "Der Älteste", "Schwarzwald"),
    ("defeated_bonemass", "Bonemass", "Sumpf"),
    ("defeated_dragon", "Moder", "Berge"),
    ("defeated_goblinking", "Yagluth", "Ebenen"),
    ("defeated_queen", "Die Königin", "Nebellande"),
    ("defeated_fader", "Fader", "Aschlande"),
]
# Keys of newer content (e.g. defeated_writhan, elakingmole_defeated, jotun_killed) are not mapped:
# their meaning is unverified, so they are published as raw "unknown keys" only.
MILESTONES = [
    ("killedtroll", "Erster Troll getötet"),
    ("killed_surtling", "Erster Surtling getötet"),
    ("killedbat", "Erste Fledermaus getötet"),
    ("defeated_serpent", "Seeschlange getötet"),
    ("bosshildir1", "Hildir: Brenna besiegt"),
    ("bosshildir2", "Hildir: Geirrhafa besiegt"),
    ("bosshildir3", "Hildir: Zil & Thungr besiegt"),
    ("hildir1", "Hildir-Quest 1 abgegeben"),
    ("hildir2", "Hildir-Quest 2 abgegeben"),
    ("hildir3", "Hildir-Quest 3 abgegeben"),
    ("ashlandsocean", "Ozean der Aschlande erreicht"),
]
IGNORED_KEYS = {"activebosses 0"}  # runtime state, not progress
KNOWN_KEYS = {k for k, _, _ in BOSSES} | {k for k, _ in MILESTONES}

log = logging.getLogger("collector")

# ---------------------------------------------------------------- log parsing

TS_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2}):(\d{2}): (.*)$")
MARK_RE = re.compile(r"^=== (Valheim server starting|stop requested|Valheim server exited(?: \((-?\d+)\))?) (.+?)(?:, saving\.\.\.)? ===$")

PATTERNS = [  # (kind, regex) applied to the message part of a timestamped line
    ("version", re.compile(r"^Valheim version: ([\w.]+)")),
    ("ready", re.compile(r"^Game server connected$")),
    ("join", re.compile(r"^Player joined server .* now (\d+) player\(s\)")),
    ("lost", re.compile(r"^Player connection lost server .* now (\d+) player\(s\)")),
    ("handshake", re.compile(r"^Got handshake from client (\S+)")),
    ("char", re.compile(r"^Got character ZDOID from (.+?) : (-?\d+):(\d+)\s*$")),
    ("keep", re.compile(r"^Keep socket for (\S+), try to reconnect")),
    ("rpcdisc", re.compile(r"^RPC_Disconnect$")),
    ("conn", re.compile(r"^\s*Connections (\d+) ZDOS:")),  # periodic peer count
    ("savenum", re.compile(r"^World save \(1/5\).*Save number (\d+)")),
    ("savedone", re.compile(r"^World save \(5/5\) done\. Total time \[(\d+)ms\]")),
    ("day", re.compile(r"^Time [\d.,]+, day:(\d+)")),  # logged when players sleep
    ("joincode", re.compile(r"^Created new join code (\d+)")),
    ("joincode", re.compile(r"^Session \".*\" registered with join code (\d+)")),
    ("joincode", re.compile(r"^Session \".*\" with join code (\d+) and IP .* is active")),
    ("quit", re.compile(r"^Game - OnApplicationQuit$")),
]


def parse_ts(m):
    mo, d, y, H, M, S = (int(x) for x in m.groups()[:6])
    return int(time.mktime((y, mo, d, H, M, S, 0, 0, -1)))


def parse_marker_date(s):
    # e.g. "Wed Nov 25 09:41:33 CET 2026" (timezone token ignored, local time)
    parts = s.split()
    if len(parts) >= 6:
        s = " ".join(parts[:4] + parts[-1:])
    try:
        return int(time.mktime(time.strptime(s, "%a %b %d %H:%M:%S %Y")))
    except ValueError:
        return None


def parse_line(line):
    """Return (ts, kind, a, b) or None. `ts` may be None for unparsable markers."""
    m = TS_RE.match(line)
    if m:
        msg = m.group(7)
        for kind, rx in PATTERNS:
            p = rx.match(msg)
            if p:
                g = p.groups()
                if kind == "char":
                    name, x, y = g
                    if x == "0" and y == "0":
                        return parse_ts(m), "death", name, None
                    return parse_ts(m), "char", name, None
                return parse_ts(m), kind, (g[0] if g else None), None
        return parse_ts(m), None, None, None  # timestamp only (keeps last_ts fresh)
    m = MARK_RE.match(line.strip())
    if m:
        what, rc, date = m.groups()
        ts = parse_marker_date(date)
        if what.startswith("Valheim server starting"):
            return ts, "m_start", None, None
        if what == "stop requested":
            return ts, "m_stop", None, None
        return ts, "m_exit", rc, None
    return None

# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE, inode INTEGER, offset INTEGER DEFAULT 0,
  first_ts INTEGER, last_ts INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, file_id INTEGER, line_no INTEGER, ts INTEGER, kind TEXT,
  a TEXT, b TEXT, h TEXT, occ INTEGER, UNIQUE(ts, h, occ));
CREATE INDEX IF NOT EXISTS ev_file ON events(file_id, line_no);
CREATE TABLE IF NOT EXISTS world_keys (
  key TEXT PRIMARY KEY, first_seen INTEGER, initial INTEGER, save_number INTEGER);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS pings (
  ts INTEGER PRIMARY KEY, target TEXT, avg REAL, min REAL, max REAL, jitter REAL, loss REAL);
"""


def db_open(path):
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    return con


def meta_get(con, k, default=None):
    r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return json.loads(r[0]) if r else default


def meta_set(con, k, v):
    con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (k, json.dumps(v)))


def log_files():
    d = CFG["log_dir"]
    files = glob.glob(os.path.join(d, "archive", "*.log")) + glob.glob(os.path.join(d, "valheim-*.log"))
    return sorted({os.path.realpath(f) for f in files}, key=lambda f: os.stat(f).st_mtime)


def ingest_file(con, path):
    st = os.stat(path)
    row = con.execute("SELECT id, inode, offset, last_ts FROM files WHERE path=?", (path,)).fetchone()
    if row is None:
        cur = con.execute("INSERT INTO files(path, inode, offset) VALUES(?, ?, 0)", (path, st.st_ino))
        fid, offset, last_ts = cur.lastrowid, 0, None
    else:
        fid, inode, offset, last_ts = row
        if inode != st.st_ino or st.st_size < offset:  # replaced or truncated: re-read (dedup protects)
            log.info("file changed, re-reading %s", os.path.basename(path))
            offset = 0
            con.execute("DELETE FROM events WHERE file_id=?", (fid,))
    if st.st_size == offset:
        return 0
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return 0
    data = data[: end + 1]
    occ_cache = {}  # line_no below is the byte offset: monotonic within a file
    prev_last_ts = last_ts
    n = 0
    first_ts = None
    pos = offset
    for raw in data.split(b"\n")[:-1]:
        pos += len(raw) + 1
        line = raw.decode("utf-8", "replace").rstrip("\r")
        p = parse_line(line)
        if p is None:
            continue
        ts, kind, a, b = p
        if ts is not None:
            last_ts = ts if last_ts is None else max(last_ts, ts)
            first_ts = first_ts or ts
        if kind is None or ts is None:
            continue
        h = hashlib.sha1(line.encode()).hexdigest()[:16]
        key = (ts, h)
        if key not in occ_cache:
            # identical lines in the same second are numbered; only a chunk boundary inside
            # that second can have earlier copies already stored for this file
            occ_cache[key] = con.execute("SELECT COUNT(*) FROM events WHERE file_id=? AND ts=? AND h=?",
                                         (fid, ts, h)).fetchone()[0] if offset and ts == prev_last_ts else 0
        occ = occ_cache[key]
        occ_cache[key] += 1
        cur = con.execute(
            "INSERT OR IGNORE INTO events(file_id, line_no, ts, kind, a, b, h, occ) VALUES(?,?,?,?,?,?,?,?)",
            (fid, pos, ts, kind, a, b, h, occ))
        n += cur.rowcount
    con.execute("UPDATE files SET offset=?, inode=?, last_ts=?, first_ts=COALESCE(first_ts, ?) WHERE id=?",
                (offset + len(data), st.st_ino, last_ts, first_ts, fid))
    return n


SCHEMA_VERSION = 2


def ingest_logs(con):
    if meta_get(con, "schema_version", 1) < SCHEMA_VERSION:
        # new line patterns: re-read every file once (duplicates are ignored by the unique key)
        con.execute("UPDATE files SET offset=0")
        con.execute("DELETE FROM events WHERE kind='worldtime'")  # was server uptime, not world time
        meta_set(con, "schema_version", SCHEMA_VERSION)
    total = 0
    for path in log_files():
        try:
            total += ingest_file(con, path)
        except OSError as e:
            log.warning("cannot read %s: %s", os.path.basename(path), e)
    con.commit()
    return total

# ---------------------------------------------------------------- runs & sessions


def load_runs(con):
    """Split events into server runs (one per launch). Returns list of dicts."""
    files = {r[0]: r[1] for r in con.execute("SELECT id, last_ts FROM files")}
    runs, cur = [], None
    for fid, ts, kind, a in con.execute("SELECT file_id, ts, kind, a FROM events ORDER BY file_id, line_no"):
        if (cur is None or cur["file"] != fid or kind == "m_start"
                or (kind == "version" and cur["version"] is not None)):
            cur = {"file": fid, "events": [], "version": None}
            runs.append(cur)
        if kind == "version":
            cur["version"] = a
        cur["events"].append((ts, kind, a))
    out = []
    for i, r in enumerate(runs):
        ev = sorted(r["events"], key=lambda e: e[0])
        if r["version"] is None and not any(e[1] == "m_start" for e in ev):
            continue  # stray lines without a launch
        end = ev[-1][0]
        if (i + 1 == len(runs) or runs[i + 1]["file"] != r["file"]) and files.get(r["file"]):
            end = max(end, files[r["file"]])
        kinds = {e[1] for e in ev}
        out.append({"start": ev[0][0], "end": end, "events": ev, "version": r["version"],
                    "clean": "m_stop" in kinds or "quit" in kinds,
                    "exited": "m_exit" in kinds or "quit" in kinds, "ready": "ready" in kinds})
    out.sort(key=lambda r: r["start"])
    for i, r in enumerate(out):
        r["last"] = i == len(out) - 1
    return out


class Sess:
    __slots__ = ("cid", "name", "start", "end", "last_active", "dropped", "uncertain", "reason", "deaths")

    def __init__(self, cid, name, start):
        self.cid, self.name, self.start = cid, name, start
        self.end = None
        self.last_active = start
        self.dropped = None
        self.uncertain = False
        self.reason = None
        self.deaths = []


def build_sessions(run, live):
    """Reconstruct player sessions for one server run.

    Returns (sessions, deaths). live=True keeps sessions of the running server open.
    See REQUIREMENTS.md F2 for the attribution rules.
    """
    sessions, deaths = [], []
    open_ = {}            # client id -> Sess
    pending = []          # [(client id, ts)] handshakes still waiting for a character name
    unresolved = []       # times of unnamed quits (RPC_Disconnect) not yet attributed
    guessed = {}          # client id -> Sess closed by a guess (reopened if proven wrong)

    def close(s, ts, reason, uncertain):
        s.end = max(ts, s.start)
        s.reason, s.uncertain = reason, uncertain
        open_.pop(s.cid, None)
        if uncertain:
            guessed[s.cid] = s

    def by_name(name):
        return next((s for s in open_.values() if s.name == name), None)

    def still_here(cid, ts):
        """Player shows activity: undo a wrong guess that closed their session."""
        s = guessed.pop(cid, None)
        if s and cid not in open_ and s.end <= ts:
            if s.reason == "disconnect":
                unresolved.append(s.end)
                unresolved.sort()
            s.end, s.reason, s.uncertain = None, None, False
            open_[cid] = s
        return open_.get(cid)

    def still_here_name(name, ts):
        for cid, g in list(guessed.items()):
            if g.name == name:
                still_here(cid, ts)
        return by_name(name)

    def close_for_quit(cands, t):
        # nobody active after the quit can be the one who left; among the rest,
        # the least recently active player is the best guess
        pool = [s for s in cands if s.last_active <= t] or cands
        s = min(pool, key=lambda s: (s.last_active, s.start))
        close(s, t, "disconnect", len(pool) > 1)

    def reconcile(n, ts, use_dropped):
        while len(open_) > n:
            dropped = sorted((s for s in open_.values() if s.dropped), key=lambda s: s.dropped)
            if use_dropped and dropped:
                close(dropped[0], dropped[0].dropped, "timeout", False)
            elif unresolved:
                close_for_quit([s for s in open_.values() if not s.dropped] or list(open_.values()),
                               unresolved.pop(0))
            elif use_dropped:
                s = min(open_.values(), key=lambda s: (s.last_active, s.start))
                close(s, ts, "count", True)
            else:
                break

    ev = run["events"]
    handshake_ts = [e[0] for e in ev if e[1] == "handshake"]
    hi = 0
    for ts, kind, a in ev:
        if kind == "handshake":
            s = open_.get(a)
            if s:  # a new connection means the previous one has ended
                if s.dropped:
                    close(s, s.dropped, "timeout", False)
                else:
                    t = next((u for u in unresolved if u >= s.last_active), None)
                    if t is not None:
                        unresolved.remove(t)
                    close(s, t if t is not None else ts, "disconnect", t is None)
            guessed.pop(a, None)
            pending = [p for p in pending if p[0] != a and ts - p[1] < 300]
            pending.append((a, ts))
        elif kind == "char":
            s = by_name(a)
            if s:
                s.last_active = ts  # respawn
            elif pending:
                cid, hts = pending.pop(0)
                s = Sess(cid, a, hts)
                s.last_active = ts
                open_[cid] = s
                sessions.append(s)
            else:  # name without handshake (log started mid-session or a wrong guess)
                s = still_here_name(a, ts)
                if s is None:
                    s = Sess("name:" + a, a, ts)
                    open_[s.cid] = s
                    sessions.append(s)
                s.last_active = ts
        elif kind == "death":
            s = by_name(a) or still_here_name(a, ts)
            deaths.append((a, ts))
            if s:
                s.last_active = ts
        elif kind == "keep":
            s = open_.get(a) or still_here(a, ts)
            if s:
                s.dropped = s.dropped or ts
                s.last_active = ts
        elif kind == "join":
            while hi < len(handshake_ts) and handshake_ts[hi] < ts:
                hi += 1
            if not (hi < len(handshake_ts) and handshake_ts[hi] - ts <= 5):
                # no handshake follows: a kept socket reconnected
                dropped = sorted((s for s in open_.values() if s.dropped), key=lambda s: s.dropped)
                if dropped:
                    dropped[0].dropped = None
                    dropped[0].last_active = ts
        elif kind == "rpcdisc":
            unresolved.append(ts)
        elif kind in ("lost", "conn"):
            n = int(a)
            if n == 0:
                for s in sorted(open_.values(), key=lambda s: (s.last_active, s.start)):
                    if s.dropped:
                        close(s, s.dropped, "timeout", False)
                    elif unresolved:
                        close_for_quit([x for x in open_.values() if not x.dropped], unresolved.pop(0))
                    else:
                        close(s, ts, "count", True)
                unresolved.clear()
                pending.clear()
                guessed.clear()
            elif kind == "conn":
                # the periodic connection count is authoritative
                reconcile(n, ts, True)
                if len(open_) == n:
                    unresolved.clear()
            else:
                # counts on "connection lost" lines still include kept sockets
                reconcile(n, ts, False)

    if not live:
        for s in list(open_.values()):
            close(s, run["end"], "server_stop", False)
    return sessions, deaths


def compute(con, live_pid):
    runs = load_runs(con)
    sessions, deaths, runs_out = [], [], []
    for r in runs:
        live = r["last"] and live_pid is not None and not r["exited"]
        r["live"] = live
        ss, dd = build_sessions(r, live)
        sessions += ss
        deaths += dd
        if live:
            state = "online" if r["ready"] else "starting"
        elif r["version"] is None:
            state = "failed"  # launched but Valheim never started up
        else:
            state = "stopped" if r["clean"] else "crashed"
        runs_out.append({"start": r["start"], "end": None if live else r["end"], "state": state,
                         "version": r["version"]})
    return runs, runs_out, sessions, deaths

# ---------------------------------------------------------------- world save


def read_varint(b, i):
    n = shift = 0
    while True:
        c = b[i]
        i += 1
        n |= (c & 0x7F) << shift
        if not c & 0x80:
            return n, i
        shift += 7
        if shift > 28:
            raise ValueError("varint too long")


KEY_CHARS = re.compile(rb"^[a-z0-9_ ]+$")


def parse_global_keys(raw):
    """Find the global keys list: int32 count followed by that many short lowercase strings."""
    anchors = [raw.find(k.encode()) for k in ("defeated_", "killed", "hildir", "activebosses")]
    anchors = [a for a in anchors if a >= 0]
    if not anchors:
        return []  # brand-new world: no keys yet
    anchor = min(anchors)
    for start in range(anchor - 1, max(-1, anchor - 64 * 1024), -1):
        if start < 4:
            break
        count = struct.unpack_from("<i", raw, start - 4)[0]
        if not 0 < count <= 1000:
            continue
        try:
            i, keys = start, []
            for _ in range(count):
                n, i = read_varint(raw, i)
                if not 0 < n <= 100:
                    raise ValueError
                s = raw[i:i + n]
                if len(s) != n or not KEY_CHARS.match(s):
                    raise ValueError
                keys.append(s.decode())
                i += n
        except (ValueError, IndexError, struct.error):
            continue
        if i > anchor:
            return keys
    raise ValueError("global keys list not found")


def newest_save():
    wdir = os.path.join(CFG["world_dir"], CFG["world_name"])
    best = None
    for ok in glob.glob(os.path.join(glob.escape(wdir), "_main.*.ok")):
        m = re.search(r"_main\.(\d+)\.ok$", ok)
        db2 = ok[:-3] + ".db2"
        if m and os.path.exists(db2):
            n = int(m.group(1))
            if best is None or n > best[0]:
                best = (n, db2)
    return best


def read_world(con):
    """Update world_keys from the newest complete save. Returns status dict."""
    status = meta_get(con, "world_status", {"ok": False, "error": "not read yet"})
    found = newest_save()
    if not found:
        status.update(ok=False, error="no complete save found")
        return status
    num, path = found
    if status.get("save_number") == num and status.get("ok") and "net_time" in status:
        return status
    try:
        with open(path, "rb") as f:
            data = f.read()
        net_time = None
        if len(data) >= 12:
            ver, t = struct.unpack_from("<id", data, 0)
            if 0 < ver < 1000 and 0 <= t < 1e10:
                net_time = t
        gz = data.find(b"\x1f\x8b", 0, 64)
        if gz < 0:
            raise ValueError("no gzip stream")
        raw = zlib.decompress(data[gz:], 16 + zlib.MAX_WBITS)
        keys = parse_global_keys(raw)
    except Exception as e:  # fail safe: keep last known keys
        log.warning("world save %d unreadable: %s", num, e)
        status.update(ok=False, error="save could not be parsed", at=int(time.time()))
        meta_set(con, "world_status", status)
        con.commit()
        return status
    first_read = con.execute("SELECT COUNT(*) FROM world_keys").fetchone()[0] == 0 and not meta_get(con, "world_read_once")
    now = int(time.time())
    for k in keys:
        if k in IGNORED_KEYS:
            continue
        con.execute("INSERT OR IGNORE INTO world_keys(key, first_seen, initial, save_number) VALUES(?,?,?,?)",
                    (k, now, 1 if first_read else 0, num))
    meta_set(con, "world_read_once", True)
    meta_set(con, "current_keys", sorted(k for k in keys if k not in IGNORED_KEYS))
    status = {"ok": True, "save_number": num, "at": now, "mtime": int(os.path.getmtime(path)),
              "net_time": net_time}
    meta_set(con, "world_status", status)
    con.commit()
    return status


def backups():
    out = []
    for d in glob.glob(os.path.join(glob.escape(CFG["world_dir"]), glob.escape(CFG["world_name"]) + "_backup_*")):
        m = re.search(r"_backup_(auto-)?(\d{8})-?(\d{6})$", d)
        if m:
            t = time.mktime(time.strptime(m.group(2) + m.group(3), "%Y%m%d%H%M%S"))
            out.append({"at": int(t), "auto": bool(m.group(1))})
    return sorted(out, key=lambda b: b["at"], reverse=True)

# ---------------------------------------------------------------- live process


def server_process():
    try:
        out = subprocess.run(["pgrep", "-f", "valheim_server/Valheim"], capture_output=True, text=True, timeout=10).stdout
        pids = [int(p) for p in out.split()]
    except Exception:
        return None
    if not pids:
        return None
    pid = pids[0]
    try:
        out = subprocess.run(["ps", "-o", "%cpu=,rss=", "-p", str(pid)], capture_output=True, text=True, timeout=10).stdout.split()
        return {"pid": pid, "cpu": float(out[0].replace(",", ".")), "mem_mb": round(int(out[1]) / 1024)}
    except Exception:
        return {"pid": pid, "cpu": None, "mem_mb": None}

# ---------------------------------------------------------------- network

PING_LOSS_RE = re.compile(r"(\d+) packets transmitted, (\d+) (?:packets )?received")
PING_RTT_RE = re.compile(r"= ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms")


def measure_ping():
    """Ping the targets in order; return the first that answers at all (or 100 % loss)."""
    n = CFG["ping_count"]
    result = None
    for target, label in CFG["ping_targets"]:
        try:
            out = subprocess.run(["/sbin/ping", "-c", str(n), "-i", "0.2", "-t", "5", "-q", target],
                                 capture_output=True, text=True, timeout=15).stdout
        except Exception as e:
            log.warning("ping %s failed: %s", target, e)
            continue
        m = PING_LOSS_RE.search(out)
        sent, recv = (int(m.group(1)), int(m.group(2))) if m else (n, 0)
        r = {"target": label, "loss": 100.0 * (sent - recv) / max(sent, 1),
             "avg": None, "min": None, "max": None, "jitter": None}
        rtt = PING_RTT_RE.search(out)
        if recv and rtt:
            r.update(min=float(rtt.group(1)), avg=float(rtt.group(2)), max=float(rtt.group(3)),
                     jitter=float(rtt.group(4)))
            return r
        result = result or r
    return result or {"target": CFG["ping_targets"][0][1], "loss": 100.0, "avg": None, "min": None,
                      "max": None, "jitter": None}


def record_ping(con):
    r = measure_ping()
    con.execute("INSERT OR REPLACE INTO pings(ts, target, avg, min, max, jitter, loss) VALUES(?,?,?,?,?,?,?)",
                (int(time.time()), r["target"], r["avg"], r["min"], r["max"], r["jitter"], r["loss"]))
    con.commit()


def ping_export(con, now):
    last = con.execute("SELECT ts, target, avg, min, max, jitter, loss FROM pings ORDER BY ts DESC LIMIT 1").fetchone()
    current = None
    if last:
        current = dict(zip(("at", "target", "avg_ms", "min_ms", "max_ms", "jitter_ms", "loss_pct"), last))
        current = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in current.items()}

    def r1(v):
        return None if v is None else round(v, 1)
    # full resolution for 48 h, hourly aggregates for 90 days
    recent = [[ts, r1(avg), r1(loss)] for ts, avg, loss in con.execute(
        "SELECT ts, avg, loss FROM pings WHERE ts >= ? ORDER BY ts", (now - 48 * 3600,))]
    hourly = [[h * 3600, r1(a), r1(mx), r1(l)] for h, a, mx, l in con.execute(
        "SELECT ts / 3600 AS h, AVG(avg), MAX(max), AVG(loss) FROM pings WHERE ts >= ? GROUP BY h ORDER BY h",
        (now - 90 * 86400,))]
    return current, {"recent": recent, "hourly": hourly}

# ---------------------------------------------------------------- export


def last_event(run, kind):
    for ts, k, a in reversed(run["events"]):
        if k == kind:
            return ts, a
    return None, None


def export(con, outdir):
    proc = server_process()
    runs, runs_out, sessions, deaths = compute(con, proc["pid"] if proc else None)
    world = read_world(con)
    now = int(time.time())
    cur = runs[-1] if runs else None

    server = {"name": CFG["server_name"], "world": CFG["world_name"], "state": "offline",
              "since": None, "version": None, "join_code": None, "cpu": None, "mem_mb": None}
    if cur and cur["live"]:
        server.update(state=runs_out[-1]["state"], since=cur["start"], version=cur["version"],
                      cpu=proc["cpu"], mem_mb=proc["mem_mb"])
        server["join_code"] = last_event(cur, "joincode")[1]
    elif cur:
        server.update(state="crashed" if runs_out[-1]["state"] == "crashed" else "offline",
                      since=cur["end"], version=cur["version"])
    try:
        st = os.statvfs(HOME)
        server["disk_free_bytes"] = st.f_bavail * st.f_frsize
    except OSError:
        server["disk_free_bytes"] = None

    # last save across all runs
    last_save = None
    for r in reversed(runs):
        ts, ms = last_event(r, "savedone")
        if ts:
            _, num = last_event(r, "savenum")
            last_save = {"at": ts, "duration_ms": int(ms), "number": int(num) if num else None}
            break
    # in-game day: world clock from the save header (the log's "World time" is only the
    # server's uptime); fall back to the day printed when players last slept
    day, day_at = None, None
    if world.get("net_time") is not None:
        day, day_at = int(world["net_time"] // DAY_SECONDS), world.get("mtime")
    else:
        for r in reversed(runs):
            ts, d = last_event(r, "day")
            if ts:
                day, day_at = int(d), ts
                break
    keys = {r[0]: (r[1], r[2]) for r in con.execute("SELECT key, first_seen, initial FROM world_keys")}
    current = set(meta_get(con, "current_keys", []))

    def key_info(k):
        if k in current or k in keys:
            fs, initial = keys.get(k, (None, 1))
            return {"defeated": True, "defeated_at": None if initial else fs}
        return {"defeated": False, "defeated_at": None}

    bosses = [dict(key=k, name=n, biome=b, **key_info(k)) for k, n, b in BOSSES]
    milestones = [dict(key=k, name=n, **key_info(k)) for k, n in MILESTONES]
    unknown = sorted(k for k in (current | set(keys)) if k not in KNOWN_KEYS and k not in IGNORED_KEYS)
    defeated = sum(1 for b in bosses if b["defeated"])
    tier = next((b["biome"] for b in bosses if not b["defeated"]), "Tiefer Norden")

    ping_now, ping_hist = ping_export(con, now)
    online = sorted(({"name": s.name, "since": s.start} for s in sessions if s.end is None and s.start),
                    key=lambda p: p["since"])
    status = {
        "schema": 1, "generated_at": now, "collector_version": VERSION, "interval_s": CFG["interval"],
        "server": server, "last_save": last_save,
        "world": {"day": day, "day_at": day_at,
                  "save_ok": world.get("ok", False), "save_error": None if world.get("ok") else world.get("error"),
                  "save_read_at": world.get("at")},
        "players_online": online,
        "network": ping_now,
        "progress": {"defeated": defeated, "total": len(BOSSES), "current_tier": tier,
                     "bosses": bosses, "new_bosses": [], "milestones": milestones,
                     "unknown_keys": unknown},
        "last_backup": (backups() or [None])[0],
    }
    history = {
        "schema": 1, "generated_at": now,
        "sessions": [{"player": s.name, "start": s.start, "end": s.end,
                      "uncertain": s.uncertain} for s in sorted(sessions, key=lambda s: s.start) if s.start],
        "deaths": [{"player": n, "at": t} for n, t in sorted(deaths, key=lambda d: d[1])],
        "runs": runs_out,
        "backups": backups()[:50],
        "ping": ping_hist,
    }
    os.makedirs(outdir, exist_ok=True)
    for name, obj in (("status.json", status), ("history.json", history)):
        tmp = os.path.join(outdir, name + ".tmp")
        with open(tmp, "w") as f:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
        os.replace(tmp, os.path.join(outdir, name))
    assert_sanitized(outdir)
    return status, history


PRIVATE_RE = re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|playfab/|/Users/|password|Steam_\d|\b7656\d{13}\b", re.I)


def assert_sanitized(outdir):
    """Last line of defence: refuse to publish anything that looks private."""
    for name in ("status.json", "history.json"):
        with open(os.path.join(outdir, name)) as f:
            text = f.read()
        m = PRIVATE_RE.search(text)
        if m:
            raise RuntimeError("refusing to publish %s: private-looking content near offset %d" % (name, m.start()))

# ---------------------------------------------------------------- publish


def git(repo, *args, env=None, timeout=60):
    e = dict(os.environ, GIT_AUTHOR_NAME=CFG["git_name"], GIT_AUTHOR_EMAIL=CFG["git_email"],
             GIT_COMMITTER_NAME=CFG["git_name"], GIT_COMMITTER_EMAIL=CFG["git_email"], **(env or {}))
    return subprocess.run(["git", "-C", repo] + list(args), env=e, check=True, capture_output=True,
                          text=True, timeout=timeout).stdout.strip()


def publish(outdir):
    """Force-push outdir's JSON files as one parentless commit to the data branch."""
    repo = os.path.join(CFG["data_dir"], "publish.git")
    if not os.path.isdir(repo):
        subprocess.run(["git", "init", "--bare", "-q", repo], check=True)
    env = {"GIT_INDEX_FILE": os.path.join(repo, "publish.index")}
    git(repo, "read-tree", "--empty", env=env)
    for name in sorted(os.listdir(outdir)):
        if name.endswith(".json"):
            blob = git(repo, "hash-object", "-w", os.path.join(outdir, name))
            git(repo, "update-index", "--add", "--cacheinfo", "100644,%s,%s" % (blob, name), env=env)
    tree = git(repo, "write-tree", env=env)
    commit = git(repo, "commit-tree", tree, "-m", "Dashboard data " + time.strftime("%Y-%m-%d %H:%M"))
    git(repo, "push", "--force", "-q", CFG["remote"], "%s:refs/heads/%s" % (commit, CFG["branch"]), timeout=90)
    n = meta_get_file("pushes", 0) + 1
    meta_set_file("pushes", n)
    if n % 200 == 0:  # every push leaves an unreferenced commit behind
        subprocess.run(["git", "-C", repo, "gc", "--prune=now", "-q"], capture_output=True)
    return commit


def _state_path():
    return os.path.join(CFG["data_dir"], "state.json")


def meta_get_file(k, default=None):
    try:
        with open(_state_path()) as f:
            return json.load(f).get(k, default)
    except (OSError, ValueError):
        return default


def meta_set_file(k, v):
    try:
        with open(_state_path()) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    d[k] = v
    with open(_state_path(), "w") as f:
        json.dump(d, f)

# ---------------------------------------------------------------- main


def cycle(con, outdir, push):
    n = ingest_logs(con)
    try:
        record_ping(con)
    except Exception as e:  # never let the network probe break the export
        log.warning("ping failed: %s", e)
    status, _ = export(con, outdir)
    s = status["server"]
    log.info("cycle: +%d events, server %s, %d online", n, s["state"], len(status["players_online"]))
    if push:
        publish(outdir)


def main(argv):
    push = "--no-push" not in argv
    args = [a for a in argv if not a.startswith("--")]
    cmd = args[0] if args else "once"
    os.makedirs(CFG["data_dir"], exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    if cmd == "run":  # daemon: own size-capped log next to the server logs
        from logging.handlers import RotatingFileHandler
        h = RotatingFileHandler(os.path.join(CFG["log_dir"], "collector.log"), maxBytes=1_000_000, backupCount=3)
    else:
        h = logging.StreamHandler()
    h.setFormatter(fmt)
    logging.basicConfig(level=logging.INFO, handlers=[h])
    con = db_open(os.path.join(CFG["data_dir"], "collector.db"))
    if cmd == "export":
        outdir = args[1] if len(args) > 1 else "."
        cycle(con, outdir, False)
        return 0
    outdir = os.path.join(CFG["data_dir"], "out")
    if cmd == "once":
        cycle(con, outdir, push)
        return 0
    if cmd == "run":
        log.info("collector %s started, interval %ds", VERSION, CFG["interval"])
        backoff = 0
        while True:
            t0 = time.time()
            try:
                cycle(con, outdir, push)
                backoff = 0
            except Exception as e:
                backoff = min(backoff + 1, 5)
                log.exception("cycle failed: %s", e)
            time.sleep(max(10, CFG["interval"] * (1 + backoff) - (time.time() - t0)))
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
