// Americano and Mexicano in the app: the organiser's phone creates one (players from the roster and guests), enters the
// results round by round; everyone with the link sees the table. KV "amx:<id>" (kept 4 days), "amx:index" (the ones
// of the last 2 days, for the home view). Writes need the organiser's key (given once at creation; only its hash is
// kept). New rounds are made on the organiser's phone (index.html) and stored as they are; the worker checks them.
// Notiser: to the followers of a club player when the americano starts and after each of their matches, queued in
// KV "amx:pend" and sent by the next tick.
const TTL = 4 * 86400, MAX_P = 32, MAX_R = 40, MAX_C = 8;
const FMT = new Set(["americano", "mexicano"]), PTS = new Set([16, 21, 24, 32]);
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
  return st.sort((a, b) => b.p - a.p || b.pm - a.pm || b.w - a.w || a.n.localeCompare(b.n, "sv"));
}
function validRound(t, r) {
  if (!Array.isArray(r) || !r.length || r.length > Math.min(MAX_C, t.courts)) return false;
  const used = new Set();
  return r.every(x => x && Array.isArray(x.a) && Array.isArray(x.b) && x.a.length === 2 && x.b.length === 2 &&
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
  const kind = t.fmt === "mexicano" ? "Mexicano" : "Americano";
  return [{ pids, m: { title: kind + ": " + t.name, body: t.players.length + " spelare, " + t.pts + " poäng per match. Följ tabellen i appen.", tag: "padel-amx-" + t.id, url: "./#amx/" + t.id,
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
  l = l.filter(x => x.id !== t.id && now - x.at < 2 * 86400e3);
  if (t) l.unshift({ id: t.id, name: t.name, fmt: t.fmt, n: t.players.length, at: t.created, pids: t.players.map(p => p.pid).filter(Boolean), done: !!t.done });
  await env.PUSH.put("amx:index", JSON.stringify(l.slice(0, 30)));
}
export async function amxList(env, now) {
  let l = [];
  try { l = JSON.parse((await env.PUSH.get("amx:index")) || "[]"); } catch (e) { l = []; }
  return l.filter(x => now - x.at < 2 * 86400e3);
}
export async function amxGet(env, id) {
  if (!/^[a-z2-9]{8}$/.test(id)) return null;
  try { return JSON.parse((await env.PUSH.get("amx:" + id)) || "null"); } catch (e) { return null; }
}
// POST /amx {name, fmt, pts, courts, players:[{n, pid}], round} -> {id, key}
export async function amxCreate(env, b, byPid, now) {
  const fmt = FMT.has(b && b.fmt) ? b.fmt : null, pts = Number(b && b.pts), courts = Math.max(1, Math.min(MAX_C, Number(b && b.courts) || 1));
  const players = (Array.isArray(b && b.players) ? b.players : []).map(p => {
    const pid = Number(p && p.pid), P = pid && byPid.get(pid);
    return P ? { n: P.me, pid } : { n: clean(p && p.n).slice(0, 40) };
  }).filter(p => p.n);
  if (!fmt || !PTS.has(pts) || players.length < 4 || players.length > MAX_P) return { err: "bad americano" };
  if (new Set(players.map(p => p.pid || p.n.toLowerCase())).size !== players.length) return { err: "same player twice" };
  const key = rid(16), t = { v: 1, id: rid(8), name: clean(b.name).slice(0, 60) || (fmt === "mexicano" ? "Mexicano" : "Americano"), fmt, pts, courts: Math.min(courts, Math.floor(players.length / 4)),
    players, rounds: [], created: now, upd: now, kh: await hash(key) };
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
      if (s.length !== 2 || !s.every(v => Number.isInteger(v) && v >= 0 && v <= t.pts) || s[0] + s[1] !== t.pts) return { err: "bad score" };
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
  else return { err: "bad op" };
  t.upd = now;
  await env.PUSH.put("amx:" + t.id, JSON.stringify(t), { expirationTtl: TTL });
  if (b.op === "end" || b.op === "reopen") await index(env, t, now);
  await queue(env, notes);
  return { t: publicOf(t) };
}
