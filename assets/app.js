/* Valheim server dashboard. Reads status.json / history.json published by the collector. */
(function () {
  "use strict";

  var DEFAULT_DATA = "https://raw.githubusercontent.com/andilar/Valheim_Status/data/";
  var REFRESH_MS = 60000;
  var STALE_S = 10 * 60;      // no push for 10 min: warn
  var UNKNOWN_S = 20 * 60;    // no push for 20 min: live status unknown
  var SLOTS = 8;

  var state = { status: null, history: null, range: "all", fetchError: null };
  var colorOf = {};

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "class") e.className = attrs[k];
      else if (k === "style") e.setAttribute("style", attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs || {}) {
      if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function now() { return Date.now() / 1000; }

  function dataBase() {
    var p = new URLSearchParams(location.search).get("data");
    // only allow relative overrides (local testing), never another site
    if (p && !/^[a-z]+:|^\/\//i.test(p)) return p.replace(/\/?$/, "/");
    return DEFAULT_DATA;
  }

  function dur(sec, short) {
    sec = Math.max(0, Math.round(sec));
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (short && (d || h)) return (d * 24 + h) + " h " + m + " m";  // playtime: always hours
    if (d) return d + " d " + h + " h";
    if (h) return h + " h " + m + " min";
    if (m) return m + " min";
    return sec + " s";
  }
  function hours(sec) { return (sec / 3600).toLocaleString("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: sec < 36000 ? 1 : 0 }) + " h"; }
  var fmtDT = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  var fmtDTY = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  var fmtD = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  var fmtDM = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });
  var fmtHM = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
  function dt(ts) {
    if (!ts) return "–";
    var d = new Date(ts * 1000);
    return (d.getFullYear() === new Date().getFullYear() ? fmtDT : fmtDTY).format(d);
  }
  function ago(ts) {
    if (!ts) return "–";
    var s = now() - ts;
    if (s < 60) return "gerade eben";
    return "vor " + dur(s);
  }
  function gb(bytes) { return (bytes / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " GB"; }

  function startOfDay(ts) { var d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
  function startOfWeek(ts) {
    var d = new Date(ts * 1000); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime() / 1000;
  }
  function startOfMonth(ts) { var d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime() / 1000; }
  function addDays(ts, n) { var d = new Date(ts * 1000); d.setDate(d.getDate() + n); return d.getTime() / 1000; }

  // ---------------------------------------------------------------- tooltip
  var tip = $("tip");
  function showTip(evt, title, rows) {
    clear(tip);
    tip.appendChild(el("div", { class: "t", text: title }));
    rows.forEach(function (r) {
      var row = el("div", { class: "r" });
      if (r.color) row.appendChild(el("span", { class: "key", style: "background:" + r.color }));
      row.appendChild(el("b", { text: r.value }));
      if (r.label) row.appendChild(el("span", { text: r.label }));
      tip.appendChild(row);
    });
    tip.classList.remove("hidden");
    var x, y;
    if (evt.clientX != null && evt.type !== "focus") { x = evt.clientX; y = evt.clientY; }
    else { var b = evt.target.getBoundingClientRect(); x = b.left + b.width / 2; y = b.top; }
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = x + 14, top = y - h - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 16;
    tip.style.left = left + "px"; tip.style.top = top + "px";
  }
  function hideTip() { tip.classList.add("hidden"); }
  document.addEventListener("scroll", hideTip, { passive: true });

  // ---------------------------------------------------------------- data shaping
  function sessions() { return (state.history && state.history.sessions) || []; }
  function sessEnd(s) { return s.end == null ? now() : s.end; }

  function assignColors() {
    // colour follows the player (order of first appearance), never their rank
    var order = [];
    sessions().forEach(function (s) { if (order.indexOf(s.player) < 0) order.push(s.player); });
    colorOf = {};
    order.forEach(function (p, i) { colorOf[p] = i < SLOTS ? "var(--s" + (i + 1) + ")" : "var(--ink-2)"; });
  }
  function color(p) { return colorOf[p] || "var(--ink-2)"; }

  function rangeBounds() {
    var t = now(), r = state.range;
    var first = t;
    sessions().forEach(function (s) { if (s.start < first) first = s.start; });
    ((state.history && state.history.runs) || []).forEach(function (x) { if (x.start < first) first = x.start; });
    if (r === "day") return [t - 86400, t];
    if (r === "week") return [startOfWeek(t), t];
    if (r === "month") return [startOfMonth(t), t];
    return [Math.min(first, t - 3600), t];
  }
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

  function playerTotals(r0, r1) {
    var m = {};
    sessions().forEach(function (s) {
      var o = overlap(s.start, sessEnd(s), r0, r1);
      if (o <= 0) return;
      var p = m[s.player] || (m[s.player] = { player: s.player, total: 0, sessions: 0, longest: 0, deaths: 0 });
      p.total += o; p.sessions += 1; p.longest = Math.max(p.longest, sessEnd(s) - s.start);
    });
    ((state.history && state.history.deaths) || []).forEach(function (d) {
      if (d.at < r0 || d.at > r1) return;
      var p = m[d.player] || (m[d.player] = { player: d.player, total: 0, sessions: 0, longest: 0, deaths: 0 });
      p.deaths += 1;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.total - a.total; });
  }

  // ---------------------------------------------------------------- live status
  var STATES = {
    online: ["good", "Online"], starting: ["warning", "Startet"], offline: ["", "Offline"],
    stopped: ["", "Offline"], crashed: ["critical", "Abgestürzt"], unknown: ["", "Unbekannt"]
  };

  function liveState() {
    var st = state.status;
    if (!st) return "unknown";
    if (now() - st.generated_at > UNKNOWN_S) return "unknown";
    return st.server.state;
  }

  function renderHeader() {
    var st = state.status, s = st.server, ls = liveState();
    $("srv-name").textContent = s.name;
    $("srv-world").textContent = "Welt „" + s.world + "“" + (s.version ? " · Valheim " + s.version : "");
    var badge = $("state-badge"), m = STATES[ls] || STATES.unknown;
    badge.className = "badge " + m[0];
    badge.lastChild.textContent = m[1];
    $("updated").textContent = "Daten " + ago(st.generated_at);
    $("updated").title = "Zuletzt vom Server-Mac aktualisiert: " + dt(st.generated_at);
    document.title = (ls === "online" ? "● " : "") + s.name + " · Valheim";

    var banner = $("banner"), age = now() - st.generated_at;
    banner.className = "banner hidden";
    if (state.fetchError) {
      banner.className = "banner";
      banner.textContent = "Neue Daten konnten nicht geladen werden (" + state.fetchError + "). Angezeigt wird der letzte Stand.";
    } else if (age > STALE_S) {
      banner.className = "banner" + (age > UNKNOWN_S ? " critical" : "");
      banner.textContent = "Seit " + dur(age) + " keine neuen Daten vom Server-Mac. Der Mac ist vielleicht aus oder offline, der Status kann veraltet sein.";
    }
  }

  function tile(label, value, hint, cls) {
    var t = el("div", { class: "card tile" + (cls ? " " + cls : "") }, el("div", { class: "label", text: label }));
    t.appendChild(value instanceof Node ? value : el("div", { class: "value", text: value }));
    if (hint instanceof Node) t.appendChild(hint);
    else if (hint) t.appendChild(el("div", { class: "hint", text: hint }));
    return t;
  }

  function renderTiles() {
    var st = state.status, s = st.server, ls = liveState(), tiles = clear($("tiles"));
    var live = ls === "online" || ls === "starting";

    // players online (hero)
    var online = live ? st.players_online : [];
    var list = el("ul", { class: "online-list" });
    online.forEach(function (p) {
      list.appendChild(el("li", null, el("span", { class: "swatch", style: "background:" + color(p.name) }),
        el("b", { text: p.name }), el("span", { class: "sub", text: "online seit " + dur(now() - p.since) })));
    });
    if (!online.length) list.appendChild(el("li", { class: "sub", text: live ? "Gerade ist niemand online." : "Server ist nicht erreichbar." }));
    tiles.appendChild(tile("Spieler online", el("div", { class: "value num", text: String(online.length) }), list, "hero"));

    var since = s.since ? (live ? "seit " + dur(now() - s.since) : ago(s.since)) : "";
    tiles.appendChild(tile("Status", (STATES[ls] || STATES.unknown)[1], since ? (live ? "läuft " + since : "zuletzt " + since) : null));

    if (live && s.join_code) {
      var v = el("div", { class: "value code", text: s.join_code });
      var btn = el("button", { class: "copy", type: "button", text: "Kopieren" });
      btn.addEventListener("click", function () {
        if (navigator.clipboard) navigator.clipboard.writeText(s.join_code).then(function () {
          btn.textContent = "Kopiert"; setTimeout(function () { btn.textContent = "Kopieren"; }, 1500);
        }, function () {});
      });
      v.appendChild(btn);
      tiles.appendChild(tile("Join-Code", v, "Im Spiel unter „Server beitreten“"));
    } else {
      tiles.appendChild(tile("Join-Code", "–", "Nur wenn der Server läuft"));
    }

    if (st.world.day != null) tiles.appendChild(tile("Ingame-Tag", "Tag " + st.world.day.toLocaleString("de-DE"),
      "Stand " + (st.world.day_at ? ago(st.world.day_at) : "letzter Save")));
    if (st.last_save) tiles.appendChild(tile("Letzter Save", ago(st.last_save.at),
      "Nr. " + (st.last_save.number || "?") + " · " + st.last_save.duration_ms + " ms"));
    if (live && s.cpu != null) tiles.appendChild(tile("Server-Last", s.cpu.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " % CPU",
      (s.mem_mb / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " GB RAM"));
    var net = st.network;
    if (net && now() - net.at < UNKNOWN_S) {
      if (net.avg_ms == null) tiles.appendChild(tile("Ping", "kein Internet", "zu " + net.target + " · 100 % Verlust"));
      else tiles.appendChild(tile("Ping", Math.round(net.avg_ms) + " ms",
        pingQuality(net.avg_ms, net.loss_pct) + " · zu " + net.target +
        (net.loss_pct ? " · " + Math.round(net.loss_pct) + " % Verlust" : "")));
    }
    if (s.disk_free_bytes != null) tiles.appendChild(tile("Freier Speicher", gb(s.disk_free_bytes), "auf dem Server-Mac"));
    if (st.last_backup) tiles.appendChild(tile("Letztes Backup", ago(st.last_backup.at), dt(st.last_backup.at)));
  }

  function pingQuality(ms, loss) {
    if (loss >= 20 || ms >= 150) return "schlecht";
    if (loss > 0 || ms >= 60) return "ok";
    return "gut";
  }

  // ---------------------------------------------------------------- progress
  function bossCard(b) {
    var status = b.defeated ? (b.defeated_at ? "✓ besiegt am " + fmtD.format(new Date(b.defeated_at * 1000)) : "✓ besiegt") : "○ noch nicht besiegt";
    return el("div", { class: "boss" + (b.defeated ? " done" : "") },
      el("div", { class: "n", text: b.name }), el("div", { class: "b", text: b.biome + (b.unverified ? " · Name ungeprüft" : "") }),
      el("div", { class: "s", text: status }));
  }
  function renderProgress() {
    var p = state.status.progress, w = state.status.world;
    $("progress-text").textContent = p.defeated + " von " + p.total + " Hauptbossen besiegt · aktuelles Biom: " + p.current_tier;
    $("progress-fill").style.width = (100 * p.defeated / p.total) + "%";
    var bar = $("progress-bar");
    bar.setAttribute("aria-valuemax", p.total); bar.setAttribute("aria-valuenow", p.defeated);
    bar.setAttribute("aria-label", p.defeated + " von " + p.total + " Bossen besiegt");
    var bosses = clear($("bosses"));
    p.bosses.forEach(function (b) { bosses.appendChild(bossCard(b)); });
    var nb = clear($("new-bosses"));
    p.new_bosses.forEach(function (b) { nb.appendChild(bossCard(b)); });
    $("new-bosses-wrap").classList.toggle("hidden", !p.new_bosses.length);
    var ms = clear($("milestones"));
    p.milestones.forEach(function (m) {
      ms.appendChild(el("span", { class: "chip " + (m.defeated ? "done" : "todo"), text: (m.defeated ? "✓ " : "○ ") + m.name }));
    });
    var uk = clear($("unknown"));
    p.unknown_keys.forEach(function (k) { uk.appendChild(el("span", { class: "chip", text: k })); });
    $("unknown-wrap").classList.toggle("hidden", !p.unknown_keys.length);
    var notes = [];
    if (p.bosses.some(function (b) { return b.defeated && !b.defeated_at; }))
      notes.push("„besiegt“ ohne Datum: Das war vor Beginn der Aufzeichnung, der Save enthält kein Datum.");
    if (!w.save_ok) notes.push("Der Welt-Save konnte zuletzt nicht gelesen werden, angezeigt wird der letzte bekannte Stand.");
    $("progress-note").textContent = notes.join(" ");
  }

  // ---------------------------------------------------------------- history
  function renderLeaderboard(r0, r1) {
    var lb = clear($("leaderboard")), rows = playerTotals(r0, r1);
    if (!rows.length) { lb.appendChild(el("div", { class: "empty", text: "In diesem Zeitraum hat niemand gespielt." })); return; }
    var max = rows[0].total || 1;
    rows.forEach(function (p, i) {
      var fill = el("div", { class: "fill", style: "width:" + (100 * p.total / max) + "%;background:" + color(p.player) });
      lb.appendChild(el("div", { class: "lb-row" },
        el("span", { class: "rank num", text: String(i + 1) }), el("span", { class: "name", text: p.player, title: p.player }),
        el("div", { class: "track" }, fill),
        el("span", { class: "val num", text: dur(p.total, true) })));
    });
  }

  function niceTicks(r0, r1, width) {
    var span = r1 - r0, n = Math.max(2, Math.floor(width / 90)), ticks = [], fmt;
    var steps = [3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400, 91 * 86400];
    var step = steps.find(function (s) { return span / s <= n; }) || steps[steps.length - 1];
    var t = step < 86400 ? Math.ceil(r0 / step) * step : startOfDay(r0);
    if (step >= 86400) { while (t < r0) t = addDays(t, 1); }
    fmt = step < 86400 ? function (x) { return fmtHM.format(new Date(x * 1000)); } : function (x) { return fmtDM.format(new Date(x * 1000)); };
    var guard = 0;
    while (t <= r1 && guard++ < 50) {
      ticks.push({ t: t, label: fmt(t) });
      t = step < 86400 ? t + step : addDays(t, Math.round(step / 86400));
    }
    return ticks;
  }

  function chartFrame(node, height) {
    clear(node);
    var w = Math.max(280, node.clientWidth || 560);
    var svg = sv("svg", { viewBox: "0 0 " + w + " " + height, width: w, height: height, role: "img" });
    node.appendChild(svg);
    return { svg: svg, w: w, h: height, l: 28, r: 8, t: 8, b: 22 };
  }

  function yAxis(f, max, steps) {
    var g = sv("g");
    for (var i = 0; i <= steps; i++) {
      var v = max * i / steps, y = f.h - f.b - (f.h - f.t - f.b) * i / steps;
      g.appendChild(sv("line", { x1: f.l, x2: f.w - f.r, y1: y, y2: y, stroke: i ? "var(--grid)" : "var(--axis)", "stroke-width": 1 }));
      g.appendChild(sv("text", { x: f.l - 6, y: y + 4, "text-anchor": "end", text: f.yfmt ? f.yfmt(v) : String(Math.round(v)) }));
    }
    f.svg.appendChild(g);
  }

  function renderOnline(r0, r1) {
    var node = $("chart-online"), f = chartFrame(node, 190);
    // step function: player count over time
    var ev = [];
    sessions().forEach(function (s) {
      var a = Math.max(s.start, r0), b = Math.min(sessEnd(s), r1);
      if (b > a) { ev.push([a, 1]); ev.push([b, -1]); }
    });
    ev.sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
    var pts = [[r0, 0]], c = 0;
    ev.forEach(function (e) { c += e[1]; pts.push([e[0], c]); });
    pts.push([r1, c]);
    var max = Math.max(2, pts.reduce(function (m, p) { return Math.max(m, p[1]); }, 0));
    f.svg.setAttribute("aria-label", "Spieler online im gewählten Zeitraum, höchstens " + max + " gleichzeitig");
    yAxis(f, max, max <= 4 ? max : 4);
    var X = function (t) { return f.l + (f.w - f.l - f.r) * (t - r0) / (r1 - r0); };
    var Y = function (v) { return f.h - f.b - (f.h - f.t - f.b) * v / max; };
    niceTicks(r0, r1, f.w - f.l).forEach(function (tk) {
      f.svg.appendChild(sv("text", { x: X(tk.t), y: f.h - 6, "text-anchor": "middle", text: tk.label }));
    });
    var d = "M" + X(pts[0][0]) + "," + Y(0), prev = 0;
    pts.forEach(function (p) { d += "L" + X(p[0]) + "," + Y(prev) + "L" + X(p[0]) + "," + Y(p[1]); prev = p[1]; });
    f.svg.appendChild(sv("path", { d: d + "L" + X(r1) + "," + Y(0) + "Z", fill: "var(--s1)", "fill-opacity": 0.12, stroke: "none" }));
    f.svg.appendChild(sv("path", { d: d, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

    var cross = sv("line", { y1: f.t, y2: f.h - f.b, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
    f.svg.appendChild(cross);
    var hit = sv("rect", { x: f.l, y: 0, width: f.w - f.l - f.r, height: f.h, fill: "transparent", tabindex: 0 });
    f.svg.appendChild(hit);
    function at(evt) {
      var box = f.svg.getBoundingClientRect();
      var px = evt.clientX != null && evt.type !== "focus" ? (evt.clientX - box.left) * f.w / box.width : f.w - f.r;
      var t = r0 + (r1 - r0) * Math.min(1, Math.max(0, (px - f.l) / (f.w - f.l - f.r)));
      var names = sessions().filter(function (s) { return s.start <= t && sessEnd(s) > t; });
      cross.setAttribute("x1", X(t)); cross.setAttribute("x2", X(t)); cross.setAttribute("visibility", "visible");
      showTip(evt, dt(t), [{ value: String(names.length), label: names.length === 1 ? "Spieler" : "Spieler", color: "var(--s1)" }].concat(
        names.map(function (s) { return { value: s.player, color: color(s.player) }; })));
    }
    hit.addEventListener("pointermove", at); hit.addEventListener("focus", at);
    hit.addEventListener("pointerleave", function () { cross.setAttribute("visibility", "hidden"); hideTip(); });
    hit.addEventListener("blur", function () { cross.setAttribute("visibility", "hidden"); hideTip(); });

    // table: peak per day
    var byDay = {};
    for (var i = 1; i < pts.length; i++) {
      var k = startOfDay(pts[i][0]); byDay[k] = Math.max(byDay[k] || 0, pts[i][1]);
    }
    table($("tbl-online"), ["Tag", "Max. gleichzeitig"], Object.keys(byDay).sort().reverse().slice(0, 60).map(function (k) {
      return [fmtD.format(new Date(k * 1000)), byDay[k]];
    }), [false, true]);
  }

  function buckets(r0, r1) {
    var out = [], t, next, label;
    if (state.range === "day") {
      t = Math.floor(r0 / 3600) * 3600; next = function (x) { return x + 3600; };
      label = function (x) { return fmtHM.format(new Date(x * 1000)); };
      $("h-playtime").textContent = "Spielzeit pro Stunde";
    } else if (state.range === "all" && r1 - r0 > 45 * 86400) {
      t = startOfWeek(r0); next = function (x) { return addDays(x, 7); };
      label = function (x) { return "KW ab " + fmtDM.format(new Date(x * 1000)); };
      $("h-playtime").textContent = "Spielzeit pro Woche";
    } else {
      t = startOfDay(r0); next = function (x) { return addDays(x, 1); };
      label = function (x) { return fmtDM.format(new Date(x * 1000)); };
      $("h-playtime").textContent = "Spielzeit pro Tag";
    }
    var guard = 0;
    while (t < r1 && guard++ < 400) { var n = next(t); out.push({ a: t, b: n, label: label(t) }); t = n; }
    return out;
  }

  function renderPlaytime(r0, r1) {
    var node = $("chart-playtime"), f = chartFrame(node, 200), bs = buckets(r0, r1);
    var players = Object.keys(colorOf);
    bs.forEach(function (b) {
      b.v = {}; b.total = 0;
      sessions().forEach(function (s) {
        var o = overlap(s.start, sessEnd(s), Math.max(b.a, r0), Math.min(b.b, r1));
        if (o > 0) { b.v[s.player] = (b.v[s.player] || 0) + o; b.total += o; }
      });
    });
    var active = players.filter(function (p) { return bs.some(function (b) { return b.v[p]; }); });
    var leg = clear($("legend-playtime"));
    active.forEach(function (p) { leg.appendChild(el("span", null, el("span", { class: "swatch", style: "background:" + color(p) }), p)); });

    var maxS = Math.max(3600, bs.reduce(function (m, b) { return Math.max(m, b.total); }, 0));
    var stepH = maxS <= 4 * 3600 ? 3600 : Math.ceil(maxS / 4 / 3600) * 3600, steps = Math.ceil(maxS / stepH);
    var max = stepH * steps;
    f.yfmt = function (v) { return Math.round(v / 3600) + " h"; };
    f.l = 34;
    yAxis(f, max, steps);
    var plotW = f.w - f.l - f.r, band = plotW / bs.length, bw = Math.max(2, Math.min(24, band * 0.7));
    var Y = function (v) { return (f.h - f.t - f.b) * v / max; };
    var labelEvery = Math.ceil(bs.length / Math.max(2, Math.floor(plotW / 56))), hits = [];
    bs.forEach(function (b, i) {
      var x = f.l + band * i + (band - bw) / 2, base = f.h - f.b;
      var segs = active.filter(function (p) { return b.v[p]; });
      segs.forEach(function (p, j) {
        var hgt = Y(b.v[p]), top = j === segs.length - 1;
        var gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
        var y = base - hgt, hh = Math.max(0.5, hgt - gap);
        var r = top ? Math.min(4, bw / 2, hh) : 0;
        f.svg.appendChild(sv("path", { d: roundTop(x, y, bw, hh, r), fill: color(p) }));
        base = y;
      });
      if (i % labelEvery === 0) f.svg.appendChild(sv("text", { x: x + bw / 2, y: f.h - 6, "text-anchor": "middle", text: b.label.replace("KW ab ", "") }));
      var hit = sv("rect", { x: f.l + band * i, y: f.t, width: band, height: f.h - f.t - f.b, fill: "transparent", tabindex: 0 });
      function on(evt) {
        hit.setAttribute("fill", "var(--grid)"); hit.setAttribute("fill-opacity", 0.35);
        var rows = active.filter(function (p) { return b.v[p]; }).map(function (p) { return { value: dur(b.v[p], true), label: p, color: color(p) }; });
        if (!rows.length) rows = [{ value: "niemand gespielt" }];
        else if (rows.length > 1) rows.push({ value: dur(b.total, true), label: "gesamt" });
        showTip(evt, b.label, rows);
      }
      function off() { hit.setAttribute("fill", "transparent"); hideTip(); }
      hit.addEventListener("pointermove", on); hit.addEventListener("focus", on);
      hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
      hits.push(hit);
    });
    hits.forEach(function (h) { f.svg.appendChild(h); }); // on top of the bars: whole column is the hit target
    f.svg.setAttribute("aria-label", "Gestapelte Spielzeit je Spieler, " + bs.length + " Abschnitte");
    table($("tbl-playtime"), ["Zeitraum"].concat(active).concat(["Gesamt"]),
      bs.filter(function (b) { return b.total; }).reverse().map(function (b) {
        return [b.label].concat(active.map(function (p) { return b.v[p] ? hours(b.v[p]) : "–"; })).concat([hours(b.total)]);
      }), [false].concat(active.map(function () { return true; })).concat([true]));
  }

  function roundTop(x, y, w, h, r) {
    return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y +
      "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z";
  }

  var RUNSTATE = { stopped: "normal beendet", crashed: "unerwartet beendet (Absturz/Stromausfall)", failed: "Start fehlgeschlagen", online: "läuft", starting: "startet" };

  function renderUptime(r0, r1) {
    var node = $("chart-uptime"), runs = (state.history.runs || []), f = chartFrame(node, 64);
    f.l = 0; f.r = 0;
    var X = function (t) { return f.w * (t - r0) / (r1 - r0); };
    var barY = 10, barH = 20;
    f.svg.appendChild(sv("rect", { x: 0, y: barY, width: f.w, height: barH, rx: 4, fill: "var(--muted-fill)" }));
    var up = 0, restarts = 0, crashes = 0;
    runs.forEach(function (r) {
      var a = Math.max(r.start, r0), e = r.end == null ? r1 : r.end, b = Math.min(e, r1);
      if (r.start >= r0 && r.start <= r1) restarts++;
      if ((r.state === "crashed" || r.state === "failed") && e >= r0 && e <= r1) crashes++;
      if (b <= a) return;
      up += b - a;
      var rect = sv("rect", { x: X(a), y: barY, width: Math.max(1.5, X(b) - X(a)), height: barH, fill: "var(--good)", tabindex: 0 });
      function on(evt) {
        showTip(evt, dt(r.start) + " – " + (r.end == null ? "jetzt" : dt(r.end)), [
          { value: dur(e - r.start), label: "Laufzeit", color: "var(--good)" }, { value: RUNSTATE[r.state] || r.state }]);
      }
      rect.addEventListener("pointermove", on); rect.addEventListener("focus", on);
      rect.addEventListener("pointerleave", hideTip); rect.addEventListener("blur", hideTip);
      f.svg.appendChild(rect);
      if (r.state === "crashed" || r.state === "failed") {
        var cx = X(b), col = r.state === "crashed" ? "var(--critical)" : "var(--serious)";
        f.svg.appendChild(sv("path", { d: "M" + (cx - 4) + "," + (barY - 8) + "l8,8m0,-8l-8,8", stroke: col, "stroke-width": 2, "stroke-linecap": "round" }));
      }
    });
    var ticks = niceTicks(r0, r1, f.w);
    ticks.forEach(function (tk) {
      var x = X(tk.t);
      if (x < 16 || x > f.w - 16) return;
      f.svg.appendChild(sv("text", { x: x, y: barY + barH + 16, "text-anchor": "middle", text: tk.label }));
    });
    f.svg.setAttribute("aria-label", "Server-Laufzeit im Zeitraum");
    var leg = clear($("legend-uptime"));
    leg.appendChild(el("span", null, el("span", { class: "swatch", style: "background:var(--good)" }), "läuft"));
    leg.appendChild(el("span", null, el("span", { class: "swatch", style: "background:var(--muted-fill)" }), "aus"));
    leg.appendChild(el("span", null, el("b", { style: "color:var(--critical)", text: "✕" }), "Absturz / Stromausfall"));
    leg.appendChild(el("span", null, el("b", { style: "color:var(--serious)", text: "✕" }), "Fehlstart"));
    $("uptime-summary").textContent = "Verfügbar " + (100 * up / (r1 - r0)).toLocaleString("de-DE", { maximumFractionDigits: 1 }) +
      " % · " + restarts + (restarts === 1 ? " Start · " : " Starts · ") + crashes + (crashes === 1 ? " unerwarteter Stopp" : " unerwartete Stopps");
    table($("tbl-uptime"), ["Start", "Ende", "Dauer", "Ende-Art"], runs.slice().reverse().filter(function (r) {
      return (r.end == null ? r1 : r.end) >= r0;
    }).map(function (r) {
      return [dt(r.start), r.end == null ? "läuft" : dt(r.end), dur((r.end == null ? now() : r.end) - r.start), RUNSTATE[r.state] || r.state];
    }), [false, false, true, false]);
  }

  function renderPing(r0, r1) {
    var p = state.history.ping || { recent: [], hourly: [] };
    // fine resolution where it exists (48 h), hourly averages beyond that
    var fine = r1 - r0 <= 48 * 3600 + 60;
    var pts = (fine ? p.recent.map(function (x) { return { t: x[0], v: x[1], loss: x[2] }; })
                    : p.hourly.map(function (x) { return { t: x[0], v: x[1], max: x[2], loss: x[3] }; }))
      .filter(function (x) { return x.t >= r0 - 3600 && x.t <= r1; });
    var node = $("chart-ping"), f = chartFrame(node, 170);
    if (!pts.length) {
      clear(node).appendChild(el("div", { class: "empty", text: "Noch keine Messwerte in diesem Zeitraum." }));
      $("ping-summary").textContent = ""; clear($("tbl-ping")); return;
    }
    var vals = pts.filter(function (x) { return x.v != null; }).map(function (x) { return x.v; });
    var top = Math.max(20, vals.length ? Math.max.apply(null, vals) : 20);
    var step = top <= 20 ? 5 : top <= 50 ? 10 : top <= 100 ? 25 : top <= 250 ? 50 : 100;
    var max = Math.ceil(top / step) * step;
    f.l = 40; f.yfmt = function (v) { return Math.round(v) + " ms"; };
    yAxis(f, max, Math.round(max / step));
    var X = function (t) { return f.l + (f.w - f.l - f.r) * (Math.max(r0, t) - r0) / (r1 - r0); };
    var Y = function (v) { return f.h - f.b - (f.h - f.t - f.b) * Math.min(v, max) / max; };
    niceTicks(r0, r1, f.w - f.l).forEach(function (tk) {
      f.svg.appendChild(sv("text", { x: X(tk.t), y: f.h - 6, "text-anchor": "middle", text: tk.label }));
    });
    // line breaks at gaps (no data for > 3 intervals) and at total loss
    var gapS = fine ? 600 : 3 * 3600, d = "", prev = null;
    pts.forEach(function (x) {
      if (x.v == null) { prev = null; return; }
      d += (prev && x.t - prev.t <= gapS ? "L" : "M") + X(x.t).toFixed(1) + "," + Y(x.v).toFixed(1);
      prev = x;
    });
    f.svg.appendChild(sv("path", { d: d, fill: "none", stroke: "var(--s1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    pts.forEach(function (x) {
      if (x.loss >= 100 || x.v == null) {
        var cx = X(x.t), cy = f.h - f.b - 6;
        f.svg.appendChild(sv("path", { d: "M" + (cx - 4) + "," + (cy - 4) + "l8,8m0,-8l-8,8", stroke: "var(--critical)", "stroke-width": 2, "stroke-linecap": "round" }));
      }
    });
    var cross = sv("line", { y1: f.t, y2: f.h - f.b, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
    var dot = sv("circle", { r: 4, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
    f.svg.appendChild(cross); f.svg.appendChild(dot);
    var hit = sv("rect", { x: f.l, y: 0, width: f.w - f.l - f.r, height: f.h, fill: "transparent", tabindex: 0 });
    f.svg.appendChild(hit);
    function on(evt) {
      var box = f.svg.getBoundingClientRect();
      var px = evt.clientX != null && evt.type !== "focus" ? (evt.clientX - box.left) * f.w / box.width : f.w - f.r;
      var t = r0 + (r1 - r0) * (px - f.l) / (f.w - f.l - f.r), best = pts[0];
      pts.forEach(function (x) { if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; });
      cross.setAttribute("x1", X(best.t)); cross.setAttribute("x2", X(best.t)); cross.setAttribute("visibility", "visible");
      if (best.v != null) { dot.setAttribute("cx", X(best.t)); dot.setAttribute("cy", Y(best.v)); dot.setAttribute("visibility", "visible"); }
      else dot.setAttribute("visibility", "hidden");
      var rows = [{ value: best.v == null ? "keine Antwort" : best.v.toLocaleString("de-DE") + " ms", label: fine ? "Ping" : "Ø Ping (Stunde)", color: "var(--s1)" }];
      if (best.max != null) rows.push({ value: best.max.toLocaleString("de-DE") + " ms", label: "Spitze" });
      rows.push({ value: (best.loss || 0).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " %", label: "Paketverlust" });
      showTip(evt, dt(best.t), rows);
    }
    function off() { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); }
    hit.addEventListener("pointermove", on); hit.addEventListener("focus", on);
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
    f.svg.setAttribute("aria-label", "Ping des Server-Macs ins Internet im Zeitraum");

    var inRange = pts.filter(function (x) { return x.t >= r0; });
    var ok = inRange.filter(function (x) { return x.v != null; });
    var avg = ok.reduce(function (a, x) { return a + x.v; }, 0) / (ok.length || 1);
    var loss = inRange.reduce(function (a, x) { return a + (x.loss || 0); }, 0) / (inRange.length || 1);
    var net = state.status.network;
    $("ping-summary").textContent = (ok.length ? "Ø " + avg.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " ms · " : "") +
      "Paketverlust Ø " + loss.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " %" +
      " · gemessen alle 2 Minuten" + (net ? " zu " + net.target : "") + ". Zeigt die Internetverbindung des Servers, nicht den Ping der Spieler.";
    table($("tbl-ping"), ["Zeit", "Ø Ping", "Paketverlust"], inRange.slice().reverse().slice(0, 100).map(function (x) {
      return [dt(x.t), x.v == null ? "–" : x.v.toLocaleString("de-DE") + " ms", (x.loss || 0).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " %"];
    }), [false, true, true]);
  }

  function table(node, head, rows, right) {
    clear(node);
    if (!rows.length) { node.appendChild(el("div", { class: "empty", text: "Keine Daten im Zeitraum." })); return; }
    var t = el("table"), tr = el("tr");
    head.forEach(function (h, i) { tr.appendChild(el("th", { class: right && right[i] ? "r" : "", text: h })); });
    t.appendChild(el("thead", null, tr));
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      r.forEach(function (c, i) {
        var td = el("td", { class: right && right[i] ? "r" : "" });
        if (c instanceof Node) td.appendChild(c); else td.textContent = c == null ? "–" : String(c);
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    node.appendChild(t);
  }

  function renderPlayerStats(r0, r1) {
    var rows = playerTotals(r0, r1), all = {};
    sessions().forEach(function (s) {
      var a = all[s.player] || (all[s.player] = { first: s.start, last: sessEnd(s), online: false });
      a.first = Math.min(a.first, s.start); a.last = Math.max(a.last, sessEnd(s)); if (s.end == null) a.online = true;
    });
    table($("player-stats"), ["Spieler", "Spielzeit", "Sessions", "Ø Session", "Längste", "Tode", "Zuerst gesehen", "Zuletzt gesehen"],
      rows.map(function (p) {
        var a = all[p.player] || {};
        var name = el("span", null, el("span", { class: "swatch", style: "display:inline-block;margin-right:6px;background:" + color(p.player) }), p.player);
        return [name, dur(p.total, true), p.sessions, p.sessions ? dur(p.total / p.sessions, true) : "–", dur(p.longest, true), p.deaths,
          a.first ? fmtD.format(new Date(a.first * 1000)) : "–", a.online ? "jetzt online" : (a.last ? dt(a.last) : "–")];
      }), [false, true, true, true, true, true, false, false]);
  }

  function renderSessions(r0, r1) {
    var list = sessions().filter(function (s) { return overlap(s.start, sessEnd(s), r0, r1) > 0; }).slice().reverse().slice(0, 25);
    table($("sessions"), ["Spieler", "Beginn", "Ende", "Dauer"], list.map(function (s) {
      var d = el("span", null, dur(sessEnd(s) - s.start, true));
      if (s.uncertain) d.insertBefore(el("span", { class: "flag", title: "Geschätzt: Das Log sagt nicht genau, wann dieser Spieler gegangen ist.", text: "≈ " }), d.firstChild);
      return [s.player, dt(s.start), s.end == null ? "online" : fmtHM.format(new Date(s.end * 1000)), d];
    }), [false, false, false, true]);
  }

  function renderBackups() {
    var b = (state.history.backups || []).slice(0, 10);
    table($("backups"), ["Zeitpunkt", "", "Art"], b.map(function (x) { return [dt(x.at), ago(x.at), x.auto ? "automatisch" : "manuell"]; }), [false, false, false]);
  }

  function renderHistory() {
    if (!state.history) return;
    var rb = rangeBounds(), r0 = rb[0], r1 = rb[1];
    $("range-text").textContent = state.range === "all" ? "seit " + fmtD.format(new Date(r0 * 1000)) : fmtDT.format(new Date(r0 * 1000)) + " bis jetzt";
    renderLeaderboard(r0, r1);
    renderOnline(r0, r1);
    renderPlaytime(r0, r1);
    renderUptime(r0, r1);
    renderPing(r0, r1);
    renderPlayerStats(r0, r1);
    renderSessions(r0, r1);
    renderBackups();
  }

  function render() {
    if (!state.status) return;
    assignColors();
    renderHeader();
    renderTiles();
    renderProgress();
    renderHistory();
  }

  // ---------------------------------------------------------------- loading
  function getJSON(name) {
    var bust = Math.floor(Date.now() / 60000);
    return fetch(dataBase() + name + "?t=" + bust, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function load() {
    document.body.style.opacity = "";
    return Promise.all([getJSON("status.json"), getJSON("history.json")]).then(function (res) {
      state.status = res[0]; state.history = res[1]; state.fetchError = null;
      render();
    }).catch(function (e) {
      state.fetchError = e.message || "Netzwerkfehler";
      if (state.status) render();
      else { $("srv-world").textContent = "Daten konnten nicht geladen werden (" + state.fetchError + ")."; }
    });
  }

  // range filter
  var saved = null;
  try { saved = localStorage.getItem("vs-range"); } catch (e) { /* storage unavailable */ }
  if (saved && /^(day|week|month|all)$/.test(saved)) state.range = saved;
  Array.prototype.forEach.call(document.querySelectorAll("#range button"), function (b) {
    b.setAttribute("aria-pressed", b.dataset.range === state.range ? "true" : "false");
    b.addEventListener("click", function () {
      state.range = b.dataset.range;
      try { localStorage.setItem("vs-range", state.range); } catch (e) { /* ignore */ }
      Array.prototype.forEach.call(document.querySelectorAll("#range button"), function (x) {
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      });
      renderHistory();
    });
  });

  // theme toggle: auto -> light -> dark
  var theme = null;
  try { theme = localStorage.getItem("vs-theme"); } catch (e) { /* ignore */ }
  function applyTheme() {
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
    $("theme-btn").title = "Farbschema: " + (theme === "light" ? "hell" : theme === "dark" ? "dunkel" : "automatisch");
  }
  applyTheme();
  $("theme-btn").addEventListener("click", function () {
    theme = theme === "light" ? "dark" : theme === "dark" ? null : "light";
    try { if (theme) localStorage.setItem("vs-theme", theme); else localStorage.removeItem("vs-theme"); } catch (e) { /* ignore */ }
    applyTheme();
  });

  var rt;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(renderHistory, 150); });
  load();
  setInterval(load, REFRESH_MS);
  setInterval(function () { if (state.status) { renderHeader(); } }, 15000);
})();
