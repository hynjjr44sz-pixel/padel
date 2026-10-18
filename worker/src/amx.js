// Americano and Mexicano in the app: the organiser's phone creates one (players from the roster and guests), enters the
// results round by round; everyone with the link sees the table. KV "amx:<id>" (30 days from the last change; for good
// once it is ended), "amx:index" (the last week's, for the home view), "amx:pl:<pid>" (a club player's ended ones, with
// place and record: the player page). Writes need the organiser's key (given once at creation; only its hash is
// kept). New rounds are made on the organiser's phone (index.html) and stored as they are; the worker checks them.
// Notiser: to the followers of a club player when the americano starts and after each of their matches, queued in
// KV "amx:pend" and sent by the next tick.
const TTL = 30 * 86400, MAX_P = 32, MAX_R = 40, MAX_C = 8, LIST_DAYS = 7;
// fmt: americano (new partner each round), mexicano (pairs by the table), lag (fixed pairs). mode: "pts" (the match is
// pts points, the two scores add up to it), "games" (first to pts games, one more on a tie-break), "free" (any score:
// timed matches).
const FMT = new Set(["americano", "mexicano", "lag"]), PTS = new Set([16, 21, 24, 32]), GAMES = new Set([3, 4, 5, 6, 7, 8, 9]);
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// a player's picture: a small uploaded photo (data: URL, made on the phone) or a drawn figure (a seed)
function look(p) {
  const o = {};
  if (typeof p.img === "string" && p.img.length <= 24000 && IMG.test(p.img)) o.img = p.img;
  if (Number.isInteger(p.fig) && p.fig >= 0 && p.fig < 1e6) o.fig = p.fig;
  return o;
}
export function validScore(t, s) {
  if (!Array.isArray(s) || s.length !== 2 || !s.every(v => Number.isInteger(v) && v >= 0 && v <= 99)) return false;
  const mode = t.mode || "pts", n = t.pts;
  if (mode === "pts") return s[0] + s[1] === n;
  if (mode === "games") { const hi = Math.max(s[0], s[1]), lo = Math.min(s[0], s[1]); return s[0] !== s[1] && (hi === n || (hi === n + 1 && lo >= n - 1)) && lo < hi; }
  return true;
}
const rid = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(x => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join(""); };
async function hash(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join(""); }
const clean = s => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim();

export function publicOf(t) { const { kh, ...o } = t; return o; }
// Standings: points, matches, won/drawn/lost, +/- (points for minus against); sorted by points, then +/-, then wins.
export function standings(t) {
  const st = t.players.map((p, i) => ({ i, n: p.n, pid: p.pid || null, p: 0, m: 0, w: 0, d: 0, l: 0, pm: 0 }));
  (t.rounds || []).forEach(r => r.forEach(x => {
    if (!x.s) return;
    [[x.a, x.s[0], x.s[1]], [x.b, x.s[1], x.s[0]]].forEach(([side, f, a]) => side.forEach(i => {
      const o = st[i]; o.p += f; o.m++; o.pm += f - a; if (f > a) o.w++; else if (f < a) o.l++; else o.d++;
    }));
  }));
  // points first when the match is played to a sum of points; otherwise won matches first
  return st.sort((a, b) => (t.mode && t.mode !== "pts" ? b.w - a.w || b.pm - a.pm || b.p - a.p : b.p - a.p || b.pm - a.pm || b.w - a.w) || a.n.localeCompare(b.n, "sv"));
}
function validRound(t, r) {
  if (!Array.isArray(r) || !r.length || r.length > Math.min(MAX_C, t.courts)) return false;
  const used = new Set(), team = side => !t.teams || t.teams.some(p => (p[0] === side[0] && p[1] === side[1]) || (p[0] === side[1] && p[1] === side[0]));
  return r.every(x => x && Array.isArray(x.a) && Array.isArray(x.b) && x.a.length === 2 && x.b.length === 2 && team(x.a) && team(x.b) &&
    x.a.concat(x.b).every(i => Number.isInteger(i) && i >= 0 && i < t.players.length && !used.has(i) && used.add(i)));
}
const firsts = (t, side) => side.map(i => t.players[i].n.split(" ")[0]).join(" & ");
// -> [{pids, m}] for the club players of a scored match (one notis per match; both sides' followers)
export function scoreNotes(t, r, m) {
  const x = t.rounds[r][m], st = standings(t), url = "./#amx/" + t.id;
  const place = i => { const me = st.find(o => o.i === i); return 1 + st.filter(o => o.p > me.p || (o.p === me.p && (o.pm > me.pm || (o.pm === me.pm && o.w > me.w)))).length; };   // shared on a tie
  const out = [];
  [[x.a, x.s[0], x.s[1], x.b], [x.b, x.s[1], x.s[0], x.a]].forEach(([side, f, a, opp]) => {
    const pids = side.map(i => t.players[i].pid).filter(Boolean);
    if (!pids.length) return;
    const res = f > a ? "vann" : f < a ? "förlorade" : "spelade lika", resEs = f > a ? "ganaron" : f < a ? "perdieron" : "empataron";
    const pl = side.filter(i => t.players[i].pid).map(i => t.players[i].n.split(" ")[0] + " " + place(i) + ":a").join(", ");
    out.push({ pids, m: { title: t.name + ": " + firsts(t, side) + " " + res + " " + f + "–" + a, body: "Mot " + firsts(t, opp) + ". Runda " + (r + 1) + ". Tabellen: " + pl + ".",
      tag: "padel-amx-" + t.id + "-" + r + "-" + m, url, es: { title: t.name + ": " + firsts(t, side) + " " + resEs + " " + f + "–" + a, body: "Contra " + firsts(t, opp) + ". Ronda " + (r + 1) + "." } } });
  });
  return out;
}
export function startNote(t) {
  const pids = t.players.map(p => p.pid).filter(Boolean);
  if (!pids.length) return [];
  const kind = t.fmt === "mexicano" ? "Mexicano" : t.fmt === "lag" ? "Lagamericano" : "Americano";
  const how = t.mode === "games" ? "först till " + t.pts + " game" : t.mode === "free" ? "på tid" : t.pts + " poäng per match";
  return [{ pids, m: { title: kind + ": " + t.name, body: t.players.length + " spelare, " + how + ". Följ tabellen i appen.", tag: "padel-amx-" + t.id, url: "./#amx/" + t.id,
    es: { title: kind + ": " + t.name, body: t.players.length + " jugadores, " + t.pts + " puntos por partido. Sigue la tabla en la app." } } }];
}
async function queue(env, notes) {
  if (!notes.length) return;
  let p = [];
  try { p = JSON.parse((await env.PUSH.get("amx:pend")) || "[]"); } catch (e) { p = []; }
  await env.PUSH.put("amx:pend", JSON.stringify(p.concat(notes).slice(-60)));
}
// The tick: queued notiser -> sent with the others; the queue emptied.
export async function amxPending(env) {
  const raw = await env.PUSH.get("amx:pend");
  if (!raw || raw === "[]") return [];
  await env.PUSH.put("amx:pend", "[]");
  try { return JSON.parse(raw); } catch (e) { return []; }
}
async function index(env, t, now) {
  let l = [];
  try { l = JSON.parse((await env.PUSH.get("amx:index")) || "[]"); } catch (e) { l = []; }
  l = l.filter(x => x.id !== t.id && now - x.at < LIST_DAYS * 86400e3);
  if (!t.gone) l.unshift({ id: t.id, name: t.name, fmt: t.fmt, n: t.players.length, at: t.created, pids: t.players.map(p => p.pid).filter(Boolean), done: !!t.done });
  await env.PUSH.put("amx:index", JSON.stringify(l.slice(0, 30)));
}
export async function amxList(env, now) {
  let l = [];
  try { l = JSON.parse((await env.PUSH.get("amx:index")) || "[]"); } catch (e) { l = []; }
  return l.filter(x => now - x.at < LIST_DAYS * 86400e3);
}
// The archive rows of an ended americano: per club player the place (shared on a tie; pairs in Lagamericano), of how
// many, won–lost and points.
export function archiveRows(t) {
  const st = standings(t), byW = t.mode && t.mode !== "pts";
  const better = (o, me) => byW ? o.w > me.w || (o.w === me.w && (o.pm > me.pm || (o.pm === me.pm && o.p > me.p))) : o.p > me.p || (o.p === me.p && (o.pm > me.pm || (o.pm === me.pm && o.w > me.w)));
  const units = t.teams ? t.teams.map(p => st.find(o => o.i === p[0])) : st, of = units.length;
  return st.filter(o => o.pid).map(o => {
    const me = t.teams ? units.find(u => t.teams.some(p => p.includes(o.i) && p.includes(u.i))) : o;
    return { pid: o.pid, row: { id: t.id, name: t.name, fmt: t.fmt, d: new Date(t.upd).toISOString().slice(0, 10), place: 1 + units.filter(u => better(u, me)).length, of, w: o.w, l: o.l, p: o.p } };
  });
}
async function archive(env, t, remove) {
  for (const r of archiveRows(t)) {
    const k = "amx:pl:" + r.pid;
    let l = [];
    try { l = JSON.parse((await env.PUSH.get(k)) || "[]"); } catch (e) { l = []; }
    l = l.filter(x => x.id !== t.id);
    if (!remove) l.unshift(r.row);
    await env.PUSH.put(k, JSON.stringify(l.slice(0, 50)));
  }
}
export async function amxArchive(env, pid) {
  try { return JSON.parse((await env.PUSH.get("amx:pl:" + Number(pid))) || "[]"); } catch (e) { return []; }
}
export async function amxGet(env, id) {
  if (!/^[a-z2-9]{8}$/.test(id)) return null;
  try { return JSON.parse((await env.PUSH.get("amx:" + id)) || "null"); } catch (e) { return null; }
}
// POST /amx {name, fmt, pts, courts, players:[{n, pid}], round} -> {id, key}
export async function amxCreate(env, b, byPid, now) {
  const fmt = FMT.has(b && b.fmt) ? b.fmt : null, mode = ["pts", "games", "free"].includes(b && b.mode) ? b.mode : "pts", pts = Number(b && b.pts), courts = Math.max(1, Math.min(MAX_C, Number(b && b.courts) || 1));
  const players = (Array.isArray(b && b.players) ? b.players : []).map(p => {
    const pid = Number(p && p.pid), P = pid && byPid.get(pid);
    return P ? { n: P.me, pid } : { n: clean(p && p.n).slice(0, 40), ...look(p || {}) };
  }).filter(p => p.n);
  if (!fmt || (mode === "pts" && !PTS.has(pts)) || (mode === "games" && !GAMES.has(pts)) || players.length < 4 || players.length > MAX_P) return { err: "bad americano" };
  if (new Set(players.map(p => p.pid || p.n.toLowerCase())).size !== players.length) return { err: "same player twice" };
  let teams = null;
  if (fmt === "lag") {   // fixed pairs: every player in exactly one
    teams = Array.isArray(b.teams) ? b.teams : [];
    const seen = new Set();
    if (players.length % 2 || teams.length !== players.length / 2 || !teams.every(p => Array.isArray(p) && p.length === 2 && p.every(i => Number.isInteger(i) && i >= 0 && i < players.length && !seen.has(i) && seen.add(i)))) return { err: "bad teams" };
  }
  const key = rid(16), t = { v: 1, id: rid(8), name: clean(b.name).slice(0, 60) || (fmt === "mexicano" ? "Mexicano" : fmt === "lag" ? "Lagamericano" : "Americano"), fmt, mode, pts: mode === "free" ? null : pts,
    courts: Math.min(courts, Math.floor(players.length / 4)), players, ...(teams ? { teams } : {}), rounds: [], created: now, upd: now, kh: await hash(key) };
  if (!validRound(t, b.round)) return { err: "bad round" };
  t.rounds.push(b.round.map(x => ({ c: x.c || null, a: x.a, b: x.b, s: null })));
  await env.PUSH.put("amx:" + t.id, JSON.stringify(t), { expirationTtl: TTL });
  await index(env, t, now);
  await queue(env, startNote(t));
  return { id: t.id, key, t: publicOf(t) };
}
// POST /amx/<id> {key, op: "score" {r, m, s:[x,y]} | "round" {round} | "end" | "reopen"} -> the americano
export async function amxUpdate(env, id, b, now) {
  const t = await amxGet(env, id);
  if (!t) return { err: "not found", status: 404 };
  if (!b || typeof b.key !== "string" || (await hash(b.key)) !== t.kh) return { err: "forbidden", status: 403 };
  let notes = [];
  if (b.op === "score") {
    const r = Number(b.r), m = Number(b.m), x = t.rounds[r] && t.rounds[r][m], s = Array.isArray(b.s) ? b.s.map(Number) : null;
    if (!x) return { err: "no such match" };
    if (s === null || b.s === null) { x.s = null; }
    else {
      if (!validScore(t, s)) return { err: "bad score" };
      const first = !x.s || x.s[0] !== s[0] || x.s[1] !== s[1];
      x.s = s;
      if (first) notes = scoreNotes(t, r, m);
    }
  } else if (b.op === "round") {
    if (t.rounds.length >= MAX_R) return { err: "too many rounds" };
    if (!validRound(t, b.round)) return { err: "bad round" };
    t.rounds.push(b.round.map(x => ({ c: x.c || null, a: x.a, b: x.b, s: null })));
  } else if (b.op === "drop") {   // the last round, while nothing in it is scored
    const last = t.rounds[t.rounds.length - 1];
    if (t.rounds.length < 2 || last.some(x => x.s)) return { err: "cannot drop" };
    t.rounds.pop();
  } else if (b.op === "end" || b.op === "reopen") t.done = b.op === "end";
  else if (b.op === "delete") {   // gone: the record, the home list, the players' archives
    await env.PUSH.delete("amx:" + t.id);
    t.gone = true;
    await index(env, t, now);
    if (t.done) await archive(env, t, true);
    return { deleted: true };
  }
  else if (b.op === "look") {   // a guest's picture: a new figure or an uploaded photo (null: back to the figure)
    const p = t.players[Number(b.i)];
    if (!p || p.pid) return { err: "no such guest" };
    delete p.img; delete p.fig;
    Object.assign(p, look(b));
  }
  else return { err: "bad op" };
  t.upd = now;
  // ended: kept for good (the players' archives link to it); otherwise 30 days from the last change
  await env.PUSH.put("amx:" + t.id, JSON.stringify(t), t.done ? undefined : { expirationTtl: TTL });
  if (b.op === "end" || b.op === "reopen") { await index(env, t, now); await archive(env, t, b.op === "reopen"); }
  else if (t.done) await archive(env, t, false);   // a result changed after the end
  await queue(env, notes);
  return { t: publicOf(t) };
}
