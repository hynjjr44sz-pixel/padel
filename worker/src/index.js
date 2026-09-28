// padel-push: Web Push for padel.holmberg.st. A cron tick every minute polls RankedIn while an
// event is active, diffs against the last state in KV and pushes new results to the devices that follow
// the player(s) concerned. Events come from discover.js (every event the club's players in players.json
// enter on RankedIn, a few players per run) merged with events.js.
import { EVENTS, activeEvents, merge, normalize } from "./events.js";
import { parse, snapshot, unpack, notes, drawNote, summary, classResult, flip } from "./rankedin.js";
import { discover, drawPath, rubbersPath, namesPath, drawsOf, ratingPath, skillOf, API, PLAYERS, BY_PID, LEGACY } from "./discover.js";
import { parseTie, snapshotTie, tieNotes, tieSummary } from "./teamleague.js";
import { b64u, vapidKey, send } from "./webpush.js";
import { dayOf, localToDate, offsetAt } from "./tz.js";

// Push services we are willing to POST to (no open relay). PUSH_HOST_ANY=1 is for local tests only.
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:\d+)?\//;

function cors(req, env) {
  const o = req.headers.get("Origin") || "";
  const ok = o === env.ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", "Vary": "Origin" } : { "Vary": "Origin" };
}
const json = (data, status, h) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", ...h } });
async function subKey(endpoint) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return "sub:" + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function validSub(s, env) {
  try {
    if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1024 || !s.keys) return false;
    if (!(env.PUSH_HOST_ANY === "1" ? /^https?:\/\//.test(s.endpoint) : PUSH_HOSTS.test(s.endpoint))) return false;
    const p = b64u.dec(s.keys.p256dh), a = b64u.dec(s.keys.auth);
    if (!(p.length === 65 && p[0] === 4 && a.length === 16)) return false;
    // A point that is not on the curve would make every encryption for this device throw.
    await crypto.subtle.importKey("raw", p, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch (e) {
    return false;
  }
}
// Rate limits (bindings in wrangler.toml; missing in unit tests): per client IP.
async function limited(rl, req) {
  if (!rl) return false;
  try { return !(await rl.limit({ key: req.headers.get("CF-Connecting-IP") || "local" })).success; } catch (e) { return false; }
}
const MAX_SUBS = 500;
async function readBody(req) {
  if (Number(req.headers.get("Content-Length") || 0) > 4096) throw new Error("too large");
  const t = await req.text();
  if (t.length > 4096) throw new Error("too large");
  return JSON.parse(t);
}

async function handle(req, env) {
  const url = new URL(req.url), h = cors(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  // Admin test push: POST /test with X-Admin-Key = secret ADMIN_KEY (set with wrangler secret put). Off without the secret.
  if (req.method === "POST" && url.pathname === "/test") {
    if (!env.ADMIN_KEY || req.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403, {});
    return json(await testPush(env), 200, {});
  }
  // Writes only from the site (or localhost). The Origin header is only CSRF protection (any script can send it):
  // the per-IP rate limits and the cap on subscriptions are what keep KV (1000 writes, 100k reads a day) safe.
  if (req.method === "POST" && !h["Access-Control-Allow-Origin"]) return json({ error: "forbidden" }, 403, h);
  if (await limited(req.method === "POST" ? env.SUB_RL : env.API_RL, req)) return json({ error: "too many requests" }, 429, { ...h, "Retry-After": "60" });
  const route = req.method + " " + url.pathname;
  if (route === "GET /health") {
    const rec = await loadRecord(env);
    return json({ ok: true, active: activeEvents(now(env), merge(rec ? rec.events : [])).map(e => e.cls || e.name), discoveredAt: rec ? rec.at : null }, 200, h);
  }
  if (route === "GET /vapid") return json({ key: env.VAPID_PUBLIC_KEY || "", classes: await covers(env) }, env.VAPID_PUBLIC_KEY ? 200 : 503, h);
  if (route === "GET /events") {
    const t = now(env), rec = await loadRecord(env);
    const events = merge(rec ? rec.events : []).filter(e => new Date(e.windowTo) > +t - 36 * 3600e3);
    // past: events that ended in the last 60 days (for "Senaste tävlingar" and the result hero)
    // latest/live: from the live monitoring (home view: "Senaste resultat", "Spelar nu")
    // wins: club players who won a class (place 1) or lost its final (place 2) in the last 30 days ("Veckans vinnare")
    const past = (rec && rec.past) || [], lv = await liveView(env, t, events.concat(past)), wins = recentWins(await loadWins(env), t);
    // photos: roster players' RankedIn profile photos {pid: {url, thumb, placeholder}} (the page: only without own photo)
    // board: the club leaderboard per pid {sk skill, w/l/y this year's W–L, rk/rp/rd SPF standing/points/list date, up places
    // gained on that list} (home view: Topplistan; kept in "disc", so it costs no extra KV read)
    return json({ at: rec ? rec.at : null, src: "worker", events, past, latest: lv.latest, live: lv.live, wins, photos: (rec && rec.photos) || {},
      board: (rec && rec.board) || {} }, 200, { ...h, "Cache-Control": "public, max-age=120" });
  }
  if (route === "POST /subscribe") {
    let b;
    try { b = await readBody(req); } catch (e) { return json({ error: "bad json" }, 400, h); }
    const s = b && b.subscription;
    if (!(await validSub(s, env))) return json({ error: "bad subscription" }, 400, h);
    const rec = JSON.stringify({ sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      prefs: { follow: followOf((b && b.prefs) || {}) } });
    const key = await subKey(s.endpoint), was = await env.PUSH.get(key);
    if (was === null && (await env.PUSH.list({ prefix: "sub:", limit: MAX_SUBS })).keys.length >= MAX_SUBS) return json({ error: "full" }, 503, h);
    if (was !== rec) await env.PUSH.put(key, rec);   // no write when nothing changed
    return json({ ok: true }, 200, h);
  }
  if (route === "POST /unsubscribe") {
    let b;
    try { b = await readBody(req); } catch (e) { return json({ error: "bad json" }, 400, h); }
    if (!b || typeof b.endpoint !== "string") return json({ error: "endpoint missing" }, 400, h);
    const key = await subKey(b.endpoint);
    if (await env.PUSH.get(key)) await env.PUSH.delete(key);
    return json({ ok: true }, 200, h);
  }
  return json({ error: "not found" }, 404, h);
}

// prefs -> followed player ids. {follow:[pid,...]} (only roster players); the first version sent {thea, kian}
// (true when missing), which still means Thea 1675246 and Kian 1680004.
export function followOf(p) {
  p = p || {};
  if (Array.isArray(p.follow)) return [...new Set(p.follow.map(Number).filter(x => BY_PID.has(x)))].sort((a, b) => a - b).slice(0, 60);
  return [p.thea !== false && LEGACY.thea, p.kian !== false && LEGACY.kian].filter(Boolean).sort((a, b) => a - b);
}
const now = env => env.NOW ? new Date(env.NOW) : new Date();   // NOW: local tests only
const H = 3600e3, DAY = 24 * H, SUBREQUESTS = 45, FOLD_OVER = 8;

/* ---- discovered events: KV "disc" = {at, events, ended, none, past, photos, board}. Read at most every 5 min per isolate. ---- */
let MEM = { rec: undefined, readAt: 0, tryAt: 0, wins: undefined, winsAt: 0 };
export function _resetMemory() { MEM = { rec: undefined, readAt: 0, tryAt: 0, wins: undefined, winsAt: 0 }; LV = { at: 0, v: null }; }
async function loadRecord(env) {
  if (MEM.rec !== undefined && Date.now() - MEM.readAt < 5 * 60e3) return MEM.rec;
  let rec = null;
  try { rec = JSON.parse((await env.PUSH.get("disc")) || "null"); } catch (e) { rec = null; }
  MEM.rec = rec; MEM.readAt = Date.now();
  return rec;
}
async function covers(env) {
  const rec = await loadRecord(env), out = EVENTS.map(e => e.classId);
  merge(rec ? rec.events : []).forEach(e => (e.cover || []).forEach(c => { if (!out.map(String).includes(String(c))) out.push(c); }));
  return out;
}
// Every 10 minutes (minute 7, 17, ...) a batch of players, or everyone when nothing is stored yet.
// The batch rotates with the clock (no state needed), so each player is looked up every 40-50 minutes.
// No KV write unless the list changed (or 6 h passed, which also refreshes "at").
export function discoveryDue(rec, t) {
  if (Date.now() - MEM.tryAt < 5 * 60e3 && rec) return false;
  return !rec || t.getUTCMinutes() % 10 === 7;
}
const BATCH = 4;
export function discoveryBatch(t, players = PLAYERS, size = BATCH) {
  const n = players.length, slot = Math.floor(+t / 600e3), start = (slot * size) % Math.max(1, n), out = [];
  for (let i = 0; i < Math.min(size, n); i++) out.push(players[(start + i) % n]);
  return out;
}
function getter(env, budget) {
  return async path => {
    if (budget.left <= 0) { const e = new Error("subrequest budget"); e.budget = true; throw e; }
    budget.left--;
    const res = await fetch((env.API_BASE || API) + path, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error("RankedIn HTTP " + res.status + " " + path.split("?")[0]);
    return res.json();
  };
}
// max: RankedIn calls for this run (35; fewer while events are live so polling keeps its share).
export async function runDiscovery(env, t, budget, rec, log = {}, max = 35) {
  MEM.tryAt = Date.now();
  const mine = { left: Math.min(max, budget.left) }, start = mine.left;
  const res = await discover(getter(env, mine), t, rec, rec ? discoveryBatch(t) : PLAYERS);
  budget.left -= start - mine.left;
  const next = { at: t.toISOString(), events: res.events, ended: res.ended, none: res.none, past: pastOf(rec, res.events, t), photos: res.photos, board: res.board || {} };
  if (rec && rec.bat) next.bat = rec.bat;   // when the ranking check last changed the board
  const sig = r => JSON.stringify([r.events, r.ended, r.none || [], r.past || [], r.photos || {}, r.board || {}]);
  log.discovered = res.events.length;
  log.refreshed = res.refreshed.length;
  if (!rec || sig(rec) !== sig(next) || +t - new Date(rec.at) > 6 * H) {
    // rec may be this isolate's copy (up to 5 min old): the leaderboard's skill and standings, written by the ranking
    // check in between, are taken from KV so they are never overwritten with older ones.
    if (rec) {
      let cur = null;
      try { cur = JSON.parse((await env.PUSH.get("disc")) || "null"); } catch (e) { cur = null; }
      const newer = !!(cur && cur.bat && String(cur.bat) > String(rec.bat || "")), fb = newer ? cur.board || {} : {};
      if (newer) next.bat = cur.bat;
      for (const pid of Object.keys(fb)) {
        const keep = {};
        for (const k of ["sk", "rk", "rp", "rd", "up"]) if (k in fb[pid]) keep[k] = fb[pid][k];
        next.board[pid] = { ...(next.board[pid] || {}), ...keep };
      }
    }
    await env.PUSH.put("disc", JSON.stringify(next));
    log.writes = (log.writes || 0) + 1;
    rec = next;
  }
  MEM.rec = rec; MEM.readAt = Date.now();
  return rec;
}

// Events that left the list after their last day: kept 60 days (max 30) so the page can show the result.
export function pastOf(rec, events, t) {
  const keys = new Set(events.map(e => e.key)), old = (rec && rec.past) || [];
  const gone = ((rec && rec.events) || []).filter(e => !keys.has(e.key) && new Date(e.windowTo) < t);
  const out = gone.concat(old.filter(p => !gone.some(g => g.key === p.key)));
  return out.filter(p => +t - new Date(p.windowTo) < 60 * DAY)
    .sort((a, b) => String(b.windowTo).localeCompare(String(a.windowTo)) || a.key.localeCompare(b.key)).slice(0, 30);
}

// Draw published? Once an hour (minute 35) for every tournament class a club player plays that starts within
// 7 days (or is on now). KV "pub:<classId>": "0" = seen without a draw, otherwise the published draws as JSON
// ([[stage, strength], ...]; "1" in old records). The first look is the baseline (no notis); "0" -> published gives
// one notis. KV is written only when the state changes (a new stage, e.g. the playoffs, is a change: the live
// polling reads its draws from here).
const PUB_MINUTE = 35;   // not exported: workerd only accepts functions and handlers as module exports
// Draws are often published the evening before or the same morning: within 48 h of the start the check also
// runs every 15 min (minutes 5, 20, 35, 50: never a discovery minute), limited to those classes.
// New SPF ranking (published in the night to Monday): a look every hour at minute 52. One RankedIn call per list
// (women's, men's) while its ranking date is the one in KV "rankdate:<rt>:<ag>"; a new date: every player of that
// list, KV "rank:<pid>" written only when the ranking date/standing/points change; a new ranking date gives one
// notis per player. The first look is the baseline.
// The leaderboard ("board" in "disc") gets each changed standing (rk, rp, rd, up = places gained: RankedIn's StandingDiff)
// and the SPF skill (sk) of up to 20 players an hour, in turn (GetPlayerRatingAsync: the whole roster every hour); "disc" is written only when the board changed.
const RANK_MINUTE = 52, SKILLS_PER_HOUR = 20;   // the whole roster every hour (skill changes after each match)
const RANKED = PLAYERS.map(p => ({ who: p.who, pid: p.pid, name: p.name, q: p.me, rt: p.rt, ag: p.ag, rid: p.rid, list: p.gender === "F" ? "Dam huvudlista" : "Herrar huvudlista" }));
// Up to 20 players per hour (rotating when the roster is larger), one RankedIn call each while a list is new.
export async function rankingChecks(env, t, budget, log, players = RANKED, cap = 20) {
  const get = getter(env, budget), msgs = [], patch = {}, n = Math.min(cap, players.length), start = (Math.floor(+t / H) * n) % Math.max(1, players.length);
  const lists = new Map();
  for (let i = 0; i < n; i++) {
    const p = players[(start + i) % players.length], k = p.rt + ":" + p.ag;
    if (!lists.has(k)) lists.set(k, []);
    lists.get(k).push(p);
  }
  let out = false;
  for (const [lk, ps] of lists) {
    if (out) break;
    let known, date = null, all = n >= players.length;
    for (const p of ps) {
      let x;
      const q = "/Ranking/SearchRankingPlayersAsync?rankingId=1917&rankingType=" + p.rt + "&ageGroup=" + p.ag +
        "&weekFromNow=0&language=en&searchTerm=" + encodeURIComponent(p.q) + "&skip=0&take=20&rankingDate=" + dayOf(t);
      try { x = await get(q); } catch (e) { all = false; if (e.budget) { out = true; break; } console.warn("ranking", p.who, e.message); continue; }
      const me = ((x && x.Payload) || []).find(r => r && r.Participant && r.Participant.NewParticipantId === p.pid && r.ParticipantPoints);
      if (!me) continue;
      const pp = me.ParticipantPoints, cur = { d: String(pp.RankingDate).slice(0, 10), s: pp.Standing, p: pp.Points };
      if (typeof me.StandingDiff === "number") cur.u = me.StandingDiff;
      if (known === undefined) { known = await env.PUSH.get("rankdate:" + lk); date = cur.d; }
      const same = known === cur.d;   // the list has not changed since its last full round: this one call is enough
      const w = await rankOne(env, p, cur, msgs, log);
      if (w) patch[p.pid] = { rk: w.s, rp: w.p, rd: w.d, up: w.u == null ? null : w.u };
      else if (typeof cur.u === "number") patch[p.pid] = { rk: cur.s, rp: cur.p, rd: cur.d, up: cur.u };   // unchanged standing: still fill the board's climb
      if (same) { all = false; break; }
    }
    if (all && date && known !== date) {   // every player of a new list looked at: canary mode until the next list
      await env.PUSH.put("rankdate:" + lk, date);
      log.writes = (log.writes || 0) + 1;
    }
  }
  if (msgs.length) log.ranked = msgs.length;
  // Skills: after the standings, only with room left for the live polling that follows in this tick.
  const sp = players.filter(p => p.rid), hour = Math.floor(+t / H);
  for (let i = 0; i < Math.min(SKILLS_PER_HOUR, sp.length) && !out && budget.left > 15; i++) {
    const p = sp[(hour * SKILLS_PER_HOUR + i) % sp.length];
    let sk;
    try { sk = skillOf(await get(ratingPath(p.pid)), p.rid); } catch (e) { if (e.budget) break; continue; }
    patch[p.pid] = { ...(patch[p.pid] || {}), sk };
  }
  try { await boardRanks(env, t, patch, players, log); } catch (e) { console.warn("board", e.message); }
  return msgs;
}
// Written standing -> the stored one (u: places gained on this list; RankedIn's StandingDiff, else from the last list).
async function rankOne(env, p, cur, msgs, log) {
  const key = "rank:" + p.pid, raw = await env.PUSH.get(key), prev = raw ? JSON.parse(raw) : null;
  if (prev && prev.d === cur.d && prev.s === cur.s && prev.p === cur.p) return null;
  if (cur.u == null && prev && prev.d < cur.d && typeof prev.s === "number") cur = { ...cur, u: prev.s - cur.s };
  await env.PUSH.put(key, JSON.stringify(cur));
  log.writes = (log.writes || 0) + 1;
  if (!prev || prev.d >= cur.d) return cur;   // baseline or a correction of the same list: no notis
  const up = prev.s - cur.s, dp = cur.p - prev.p, f = v => v.toFixed(v >= 20 ? 1 : 2);
  msgs.push({ pids: [p.pid], m: {
    title: "Ny ranking: " + p.name + " #" + cur.s + (up ? (up > 0 ? " \u25B2\uFE0E " : " \u25BC\uFE0E ") + Math.abs(up) + (Math.abs(up) === 1 ? " plats" : " platser") : " (oförändrad)"),
    body: f(cur.p) + " p" + (dp ? " (" + (dp > 0 ? "+" : "\u2212") + Math.abs(dp).toFixed(1) + ")" : "") + " · " + p.list,
    tag: "padel-rank-" + p.pid, url: "./#" + p.who } });
  return cur;
}
// Standings into the leaderboard in "disc" (read fresh from KV, written only when something changed). Players the board
// knows nothing about yet (first run after a deploy, canary mode) get what their "rank:<pid>" key holds, once.
async function boardRanks(env, t, patch, players, log) {
  let rec = null;
  try { rec = JSON.parse((await env.PUSH.get("disc")) || "null"); } catch (e) { rec = null; }
  // Discovery may have written it in this very tick (the first run): this isolate's copy is newer than a KV read then.
  if (MEM.rec && Array.isArray(MEM.rec.events) && (!rec || String(MEM.rec.at) > String(rec.at) || String(MEM.rec.bat || "") > String(rec.bat || ""))) rec = JSON.parse(JSON.stringify(MEM.rec));
  if (!rec || !Array.isArray(rec.events)) return;   // discovery writes the record first
  const b = { ...(rec.board || {}) };
  for (const p of players) {
    if ((patch[p.pid] && "rd" in patch[p.pid]) || (b[p.pid] && "rd" in b[p.pid])) continue;
    let x = null;
    try { x = JSON.parse((await env.PUSH.get("rank:" + p.pid)) || "null"); } catch (e) { x = null; }
    patch[p.pid] = { ...(patch[p.pid] || {}), ...(x && x.d ? { rk: x.s, rp: x.p, rd: x.d, up: x.u == null ? null : x.u } : { rd: null }) };
  }
  let changed = false;
  for (const pid of Object.keys(patch)) {
    const was = b[pid] || {}, n = { ...was, ...patch[pid] };
    if (JSON.stringify(n) !== JSON.stringify(was)) { b[pid] = n; changed = true; }
  }
  if (!changed) return;
  rec.board = b; rec.bat = t.toISOString();
  await env.PUSH.put("disc", JSON.stringify(rec));
  log.writes = (log.writes || 0) + 1; log.board = 1;
  MEM.rec = rec; MEM.readAt = Date.now();
}

export async function drawChecks(env, t, list, budget, log, within = 7 * DAY) {
  const soon = list.filter(e => e.kind === "tournament" && e.tournamentId && e.classId &&
    new Date(e.windowTo) > t && new Date(e.windowFrom) - t <= within);
  const msgs = [], byT = new Map(), mine = { left: Math.min(10, budget.left - 10) }, start = mine.left;
  soon.forEach(e => { if (!byT.has(e.tournamentId)) byT.set(e.tournamentId, []); byT.get(e.tournamentId).push(e); });
  const get = getter(env, mine);
  try {
    for (const [tid, evs] of byT) {
      if (mine.left < 1) break;
      let names;
      try { names = await get(namesPath(tid)); } catch (e) { if (e.budget) break; console.warn("draw check", tid, e.message); continue; }
      for (const cid of [...new Set(evs.map(e => e.classId))]) {
        const draws = drawsOf(names, cid), key = "pub:" + cid, state = draws ? JSON.stringify(draws) : "0";
        const was = await env.PUSH.get(key);
        if (was === state) continue;
        if (was === "0" && draws) {
          if (mine.left < draws.length) continue;   // not enough budget: next hour (nothing written)
          let matches;
          try { matches = parse(await Promise.all(draws.map(([st, sg]) => fetchDraw(env, get, cid, st, sg)))); }
          catch (e) { console.warn("draw fetch", cid, e.message); continue; }
          if (!matches.length) continue;   // listed but still empty
          const legacy = Object.values(LEGACY);
          evs.filter(e => e.classId === cid).sort((a, b) => (legacy.includes(b.pid) ? 1 : 0) - (legacy.includes(a.pid) ? 1 : 0))
            .forEach(ev => msgs.push({ pids: pidsOfEv(ev), m: drawNote(ev, matches) }));
        }
        await env.PUSH.put(key, state);
        log.writes = (log.writes || 0) + 1;
      }
    }
  } finally {
    budget.left -= start - mine.left;
  }
  if (msgs.length) log.drawn = msgs.length;
  return dedupe(msgs);
}

async function fetchDraw(env, get, classId, stage, strength) {
  if (!env.FIXTURE_URL) return get(drawPath(classId, stage, strength));
  const u = env.FIXTURE_URL.replace("{classId}", classId).replace("{stage}", stage).replace("{strength}", strength || 0);
  const res = await fetch(u, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("RankedIn HTTP " + res.status);
  return res.json();
}

// Roster players a notis about this event concerns: the player, and the partner when also in the roster.
function pidsOfEv(ev) {
  const out = [Number(ev.pid)].filter(Boolean);
  if (ev.partnerId && BY_PID.has(Number(ev.partnerId))) out.push(Number(ev.partnerId));
  return out;
}
const ROSTER_BY_NAME = new Map(PLAYERS.map(p => [slugName(p.me), { pid: p.pid, who: p.who }]));
function slugName(n) { return String(n).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
// Team play day -> [{who, pid}] of its roster players (old records: the one player they were found for).
function teamRoster(ev) {
  const pids = Array.isArray(ev.pids) && ev.pids.length ? ev.pids : [ev.pid];
  return pids.map(pid => BY_PID.get(Number(pid))).filter(Boolean).map(p => ({ who: p.who, pid: p.pid }));
}
// Same tag twice: same title -> one message for all their players; otherwise the first one wins.
function dedupe(msgs) {
  const out = [], byTag = new Map();
  for (const x of msgs) {
    const k = x.m.tag + "\u0000" + x.m.title + "\u0000" + x.m.body, was = byTag.get(k);
    if (was) { x.pids.forEach(p => { if (!was.pids.includes(p)) was.pids.push(p); }); continue; }
    const y = { pids: x.pids.slice(), m: x.m };
    byTag.set(k, y); out.push(y);
  }
  return out;
}
// Several messages with one tag for one device (e.g. the tie result for two followed pairs): one notis,
// the bodies joined (a body that another one starts with is dropped, a shared start is written once).
function mergeForDevice(list) {
  const out = [], byTag = new Map();
  for (const m of list) {
    const was = byTag.get(m.tag);
    if (!was) { const c = { ...m }; byTag.set(m.tag, c); out.push(c); continue; }
    if (was.title !== m.title || was.body === m.body) continue;
    const bodies = [was.body, m.body];
    if (bodies[1].startsWith(bodies[0])) { was.body = bodies[1]; continue; }
    if (bodies[0].startsWith(bodies[1])) continue;
    let k = 0;
    while (k < bodies[0].length && bodies[0][k] === bodies[1][k]) k++;
    k = bodies[0].lastIndexOf(" ", k) + 1;
    was.body = bodies[0] + " " + bodies[1].slice(k);
  }
  return out;
}
export function _internals() { return { dedupe, mergeForDevice, pidsOfEv, teamRoster }; }

/* ---- class winners ("Veckans vinnare"): KV "wins" = {at, list}, written only when an entry is added or corrected ---- */
// Entry per class and place: 1 = a roster player's pair won the class, 2 = lost the final. Kept 30 days (max 40).
// {id: "<classId>:<place>", place, classId, tournamentId, name, cls, url, date (last match day), d, pids (roster players
//  in the pair), pair (full names), opp (the other pair, short), s (score from the pair's side; group: wins–losses), rr?}
const WINS_MINUTE = 44, WIN_KEEP = 30 * DAY;
const winAge = (x, t) => +t - Date.parse(x.date + "T12:00:00Z");
export function recentWins(list, t) { return (list || []).filter(x => x && x.date && winAge(x, t) < WIN_KEEP && winAge(x, t) > -DAY); }
export function winEntries(ev, fin, t) {
  if (!fin) return [];
  const base = { classId: ev.classId, tournamentId: ev.tournamentId || null, name: ev.name || null, cls: ev.cls || "", url: ev.url || null,
    date: String(fin.d || "").slice(0, 10) || dayOf(t), d: fin.d || "" };
  const out = [];
  if ((fin.w || []).length) out.push({ id: ev.classId + ":1", place: 1, ...base, pids: fin.w, pair: fin.win, opp: fin.opp || "", s: fin.s || "", ...(fin.rr ? { rr: 1 } : {}) });
  if ((fin.l || []).length && !fin.rr) out.push({ id: ev.classId + ":2", place: 2, ...base, pids: fin.l, pair: fin.lose, opp: fin.wopp || "", s: flip(fin.s || "") });
  return out;
}
// Class records written before "fin" existed: the final from the summary's latest results (the pairs' full names
// from the class's events: the player and the partner).
export function finFromSum(sm, evs) {
  const r = ((sm && sm.res) || []).find(x => x && x.lab === "Final");
  if (!r) return null;
  const won = (r.won || []).map(Number), lost = (r.pids || []).map(Number).filter(p => !won.includes(p));
  const pairOf = pids => { const e = evs.find(x => x.partner && pids.includes(Number(x.pid))) || evs.find(x => pids.includes(Number(x.pid))); return e ? [e.me, e.partner].filter(Boolean) : []; };
  return { d: String(r.d || "").slice(0, 16), s: r.s || "", w: won, l: lost, win: pairOf(won), lose: pairOf(lost), wopp: r.win || "", opp: r.lose || "" };
}
async function loadWins(env) {
  if (MEM.wins !== undefined && Date.now() - MEM.winsAt < 5 * 60e3 && !env.NOW) return MEM.wins;
  let rec = null;
  try { rec = JSON.parse((await env.PUSH.get("wins")) || "null"); } catch (e) { rec = null; }
  MEM.wins = (rec && Array.isArray(rec.list)) ? rec.list : []; MEM.winsAt = Date.now();
  return MEM.wins;
}
export async function addWins(env, t, entries, log) {
  entries = recentWins(entries, t);
  if (!entries.length) return 0;
  let rec = null;
  try { rec = JSON.parse((await env.PUSH.get("wins")) || "null"); } catch (e) { rec = null; }
  const list = (rec && Array.isArray(rec.list)) ? rec.list : [], sig = x => JSON.stringify([x.s, x.pids, x.pair, x.opp, x.date, x.name]);
  const fresh = entries.filter((e, i) => entries.findIndex(y => y.id === e.id) === i && !list.some(x => x.id === e.id && sig(x) === sig(e)));
  if (!fresh.length) { MEM.wins = list; MEM.winsAt = Date.now(); return 0; }
  const next = recentWins(list.filter(x => !fresh.some(e => e.id === x.id)).concat(fresh), t)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, 40);
  await env.PUSH.put("wins", JSON.stringify({ at: t.toISOString(), list: next }));
  log.writes = (log.writes || 0) + 1; log.wins = (log.wins || 0) + fresh.length;
  MEM.wins = next; MEM.winsAt = Date.now();
  return fresh.length;
}
// Once an hour (minute 44): classes of the last 9 days whose KV record shows a decided final (e.g. a class that
// ended before this code was deployed, or whose last look was missed). KV reads only; a write only for a new entry.
export async function winsBackfill(env, t, list, log, max = 20) {
  const by = new Map();
  list.filter(e => e && e.kind === "tournament" && e.classId && new Date(e.windowFrom) <= t && +t - new Date(e.windowTo) < 9 * DAY)
    .forEach(e => { const k = String(e.classId); if (!by.has(k)) by.set(k, []); by.get(k).push(e); });
  const found = [];
  for (const [cid, evs] of [...by].slice(0, max)) {
    let st = null;
    try { st = JSON.parse((await env.PUSH.get("st:" + cid)) || "null"); } catch (e) { st = null; }
    const sm = st && st._sum;
    if (!sm) continue;
    evs.sort((a, b) => (a.static ? 1 : 0) - (b.static ? 1 : 0));   // discovered entries (name, url) before events.js
    found.push(...winEntries(evs[0], sm.fin || finFromSum(sm, evs), t));
  }
  return addWins(env, t, found, log);
}

/* ---- home view: latest results and who is playing now, from the units' KV records (read at most every minute) ---- */
let LV = { at: 0, v: null };
async function liveView(env, t, events) {
  if (LV.v && Date.now() - LV.at < 60e3 && !env.NOW) return LV.v;
  const units = [];
  events.filter(e => new Date(e.windowFrom) <= t && +t - new Date(e.windowTo) < 72 * H).forEach(e => {
    if (e.kind === "teamleague") (e.ties || []).forEach(tie => units.push({ key: "st:tm" + tie.id, e, tie }));
    else if (e.classId) units.push({ key: "st:" + e.classId, e });
  });
  const seen = new Set(), list = units.filter(u => !seen.has(u.key) && seen.add(u.key)).slice(0, 16);
  const latest = [], live = {};
  await Promise.all(list.map(async u => {
    let st = null;
    try { st = JSON.parse((await env.PUSH.get(u.key)) || "null"); } catch (e) { st = null; }
    const sm = st && st._sum;
    if (!sm) return;
    const e = u.e, where = e.kind === "teamleague" ? { name: e.name, team: e.team, opp: u.tie.opp, sc: sm.sc } : { name: e.name, cls: e.cls };
    (sm.res || []).forEach(r => latest.push({ ...r, ...where, key: e.key, d: r.d || (e.date ? e.date + "T" + (u.tie.time || "12:00") : "") }));
    if (new Date(e.windowTo) < t) return;
    const own = pid => e.kind === "teamleague" ? (e.pids || [e.pid]).map(Number).includes(+pid) : +e.pid === +pid || +e.partnerId === +pid;
    const rank = (x, o) => (o ? 2 : 0) + (x.st === "next" ? 1 : 0);   // the player's own entry first, then a match still to play
    Object.keys(sm.nx || {}).forEach(pid => {
      const x = { ...sm.nx[pid], ...where, key: e.key, own: own(pid) };
      if (!live[pid] || rank(x, x.own) > rank(live[pid], live[pid].own)) live[pid] = x;
    });
  }));
  latest.sort((a, b) => String(b.d).localeCompare(String(a.d)) || String(b.mid).localeCompare(String(a.mid)));
  LV = { at: Date.now(), v: { latest: latest.slice(0, 10), live } };
  return LV.v;
}

// One cron tick. events: explicit list (tests); otherwise discovered + static. Returns what happened.
export async function tick(env, events) {
  const t = now(env), budget = { left: SUBREQUESTS }, log = { writes: 0, sent: 0, removed: 0 };
  let list, rec = null;
  if (events) list = events.map(normalize);
  else {
    rec = await loadRecord(env);
    if (discoveryDue(rec, t)) {
      // While something is live, discovery leaves room for the live polling; the first run (any minute) leaves
      // room for the draw checks too.
      const busy = rec && activeEvents(t, merge(rec.events)).length > 0;
      try { rec = await runDiscovery(env, t, budget, rec, log, busy ? 15 : rec ? 35 : 30); } catch (e) { console.warn("discovery", e.message); }
    }
    list = merge(rec ? rec.events : []);
  }
  let pubMsgs = [];
  const mm = t.getUTCMinutes(), full = mm === (env.PUB_MINUTE != null ? +env.PUB_MINUTE : PUB_MINUTE);   // PUB_MINUTE: local tests only
  if (full || (env.PUB_MINUTE == null && mm % 15 === PUB_MINUTE % 15)) {
    try { pubMsgs = await drawChecks(env, t, list, budget, log, full ? 7 * DAY : 2 * DAY); } catch (e) { console.warn("draw checks", e.message); }
  }
  if (!events && env.RANK_OFF !== "1" && mm === RANK_MINUTE) {   // RANK_OFF: local tests only
    try { pubMsgs.push(...await rankingChecks(env, t, budget, log)); } catch (e) { console.warn("ranking checks", e.message); }
  }
  if (mm === (env.WINS_MINUTE != null ? +env.WINS_MINUTE : WINS_MINUTE)) {   // WINS_MINUTE: local tests only
    try { await winsBackfill(env, t, list.concat((rec && rec.past) || []), log); } catch (e) { console.warn("wins backfill", e.message); }
  }
  const evs = activeEvents(t, list);
  if (!evs.length && !pubMsgs.length) {
    if (log.discovered != null || log.writes) return { active: 0, discovered: log.discovered, refreshed: log.refreshed, writes: log.writes };
    return { active: 0 };
  }
  log.active = evs.length;

  // Units of work: one per class (shared by every club player in it) and one per team league tie.
  const units = new Map();
  for (const ev of evs) {
    if (ev.kind === "teamleague") {
      (ev.ties || []).forEach(tie => { if (!tie.canceled) units.set("tm" + tie.id, { key: "st:tm" + tie.id, kind: "tl", tie, ev: { ...ev, roster: teamRoster(ev) }, cost: 1 }); });
    } else if (ev.classId) {
      const k = "c" + ev.classId, u = units.get(k) || { key: "st:" + ev.classId, kind: "t", classId: ev.classId, draws: null, evs: [] };
      u.evs.push(ev);
      if (!u.draws && ev.draws) u.draws = ev.draws;   // any player's entry that knows the stages
      units.set(k, u);
    }
  }
  const legacy = Object.values(LEGACY);
  units.forEach(u => {
    if (u.kind !== "t") return;
    u.known = !!u.draws;
    u.draws = u.draws || [[0, 0], [1, 0]]; u.cost = u.draws.length;
    u.evs.sort((a, b) => (legacy.includes(b.pid) ? 1 : 0) - (legacy.includes(a.pid) ? 1 : 0));   // links: Thea/Kian as before
  });
  // Free plan: 50 subrequests per invocation. RankedIn gets at most 30 (rotating when there is more),
  // pushes get the rest.
  const arr = [...units.values()], cap = Math.min(30, budget.left - 5), start = t.getUTCMinutes() % Math.max(1, arr.length);
  const get = getter(env, budget);
  let msgs = pubMsgs.slice();
  let fetches = 0;
  const wins = [], pending = [];
  // Nights (23-07 local) are between events even inside a multi-day window; off-minutes only for the hot units.
  const lh = new Date(+t + offsetAt(+t) * H).getUTCHours(), night = lh >= 23 || lh < 7, quiet = mm % 10 !== 0;
  log.units = arr.length; log.polled = 0;
  for (let i = 0; i < arr.length && !night; i++) {
    const u = arr[(start + i) % arr.length];
    if (fetches + u.cost > cap) continue;
    let prev = null;
    try { prev = JSON.parse((await env.PUSH.get(u.key)) || "null"); } catch (e) { prev = null; }
    if (!prev) {
      if (quiet && (u.kind === "tl" || !u.known)) continue;   // no lineup / draw seen yet: drawChecks and a look every 10 min
    } else if (prev._done) {   // finished: a look every 10 min for 2 hours (corrections), then stop
      if (prev._doneAt && +t - Date.parse(prev._doneAt) > 2 * H) continue;
      if (quiet) continue;
    } else if (quiet && !hot(prev, u, t)) continue;
    if (u.kind === "t") {   // the draws drawChecks saw last (a playoff stage added during the event)
      const pub = await env.PUSH.get("pub:" + u.classId);
      if (pub && pub[0] === "[") { try { u.draws = JSON.parse(pub); u.cost = u.draws.length; } catch (e) {} }
      if (fetches + u.cost > cap) continue;
    }
    fetches += u.cost; log.polled++;
    let after;
    try {
      if (u.kind === "t") {
        const matches = parse(await Promise.all(u.draws.map(([st, sg]) => fetchDraw(env, get, u.classId, st, sg))));
        if (!matches.length) continue;
        after = snapshot(matches);
        // "groups" from an older look at the draws: with a later stage it is not a groups-only class.
        const fmt = u.evs[0].format === "groups" && u.draws.some(d => d[0] > 0) ? null : u.evs[0].format;
        if (matches.every(m => m.w) && (fmt === "groups" || matches.some(m => m.kind === "ko" && m.di === 0 && m.r === m.R - 1))) after._done = 1;
        // First look at an event is the baseline: results already there never notify (same as the page).
        if (prev) u.evs.forEach(ev => notes(ev, matches, prev).forEach(m => msgs.push({ pids: pidsOfEv(ev), m })));
        after._sum = summary(matches, ROSTER_BY_NAME);
        // Class decided with a club player in the final: kept in the class record and added to "wins".
        const fin = classResult(matches, ROSTER_BY_NAME, fmt);
        if (fin && (fin.w.length || fin.l.length)) { after._sum.fin = fin; wins.push(...winEntries(u.evs[0], fin, t)); }
      } else {
        const rubbers = parseTie(await get(rubbersPath(u.tie.id)));
        if (!rubbers.length) continue;
        after = snapshotTie(rubbers);
        if (prev) tieNotes(u.ev, u.tie, rubbers, prev).forEach(n => { const { pids, ...m } = n; msgs.push({ pids, m }); });
        after._sum = tieSummary(u.ev, u.tie, rubbers);
      }
    } catch (e) {
      console.warn("fetch", u.key, e.message);
      continue;
    }
    if (after._done) after._doneAt = (prev && prev._done && prev._doneAt) || t.toISOString();
    const next = JSON.stringify(after);
    if (JSON.stringify(prev) !== next) pending.push([u.key, next]);   // free KV: 1000 writes/day
  }
  if (wins.length) try { await addWins(env, t, wins, log); } catch (e) { console.warn("wins", e.message); }
  msgs = dedupe(msgs);
  if (msgs.length) {
    // The new state is written after the pushes: if the invocation dies on the way, the next tick sends them again.
    try { await fanOut(env, msgs, budget, log); } catch (e) { console.warn("push", e.message); log.pushFailed = 1; return log; }
  }
  for (const [k, v] of pending) { await env.PUSH.put(k, v); log.writes++; }
  return log;
}

// Every minute only around the matches of the day: an undecided match today that starts within 30 min or has
// started (running late included). Undecided matches without a time: every minute, as before. Else every 10 min.
function hot(prev, u, t) {
  if (u.kind === "tl") {
    const at = u.tie.time && u.ev.date && localToDate(u.ev.date + "T" + u.tie.time);
    return !at || +t >= +at - 30 * 60e3;
  }
  const today = dayOf(t), times = [];
  let open = 0;
  for (const k of Object.keys(prev)) {
    if (k[0] === "_") continue;
    const x = unpack(prev[k]);
    if (x.w) continue;
    open++;
    const d = String(x.tc || "").slice(0, 16);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(d) && !d.endsWith("T00:00")) times.push(d);
  }
  if (!open) return false;   // everything decided, next stage not drawn yet
  if (!times.length) return true;
  return times.some(d => d.slice(0, 10) === today && +t >= +localToDate(d) - 30 * 60e3);
}

// Push: every device gets the messages about the players it follows (prefs.follow), nothing else.
async function fanOut(env, msgs, budget, log) {
  const names = [];
  let cursor;
  do {   // at most MAX_SUBS: one KV read each, well inside the per-invocation limits
    const page = await env.PUSH.list({ prefix: "sub:", cursor });
    names.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && names.length < MAX_SUBS);
  names.length = Math.min(names.length, MAX_SUBS);
  const devs = (await Promise.all(names.map(async name => {
    let rec = null;
    try { rec = JSON.parse((await env.PUSH.get(name)) || "null"); } catch (e) { rec = null; }
    if (!rec || !rec.sub) return null;
    const f = new Set(followOf(rec.prefs));
    const out = mergeForDevice(msgs.filter(x => x.pids.some(p => f.has(Number(p)))).map(x => x.m));
    return out.length ? { name, rec, out } : null;
  }))).filter(Boolean);
  // Fold into one notis per device when needed (subrequests, and CPU: about 1 ms per encrypted push), and cap
  // the number of devices.
  const pushBudget = Math.max(0, budget.left);
  let total = devs.reduce((n, d) => n + d.out.length, 0);
  if (total > Math.min(pushBudget, FOLD_OVER)) {
    devs.forEach(d => {
      if (d.out.length < 2) return;
      d.out = [{ title: d.out.length + " nya resultat", body: d.out.map(m => m.title).join("\n"), tag: "padel-sammanfattning", url: d.out[d.out.length - 1].url }];
    });
    total = devs.length;
  }
  if (total > pushBudget) {
    console.warn("push budget: " + devs.length + " devices, sending to the first " + pushBudget);
    devs.length = pushBudget;
  }
  log.devices = devs.length;
  if (!devs.length) return;
  const key = await vapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY), jwts = {};   // one VAPID JWT per push service per tick (CPU time on the free plan is 10 ms)
  await Promise.all(devs.map(async ({ name, rec, out }) => {
    for (const m of out) {
      const st = await send(rec.sub, m, env, key, jwts);
      // 404/410: gone; -1: its keys cannot be used (encryption failed), it would fail every time
      if (st === 404 || st === 410 || st === -1) { await env.PUSH.delete(name); log.removed++; return; }
      if (st >= 200 && st < 300) log.sent++;
      else console.warn("push", st, new URL(rec.sub.endpoint).host);
    }
  }));
}

async function testPush(env) {
  const key = await vapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY), jwts = {}, res = [];   // every device, whatever it follows
  const names = (await env.PUSH.list({ prefix: "sub:" })).keys.map(k => k.name).slice(0, 20);
  for (const name of names) {
    try {
      const rec = JSON.parse((await env.PUSH.get(name)) || "null");
      if (!rec || !rec.sub) continue;
      const st = await send(rec.sub, { title: "Testnotis från Nynäs Padel", body: "Push fungerar. Nästa resultat kommer hit.", tag: "padel-test", url: "./#thea" }, env, key, jwts);
      res.push({ host: new URL(rec.sub.endpoint).host, status: st });
    } catch (e) {
      res.push({ key: name, error: e.message });
    }
  }
  return { sent: res };
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => json({ error: "server error" }, 500, cors(req, env))),
  scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env).then(r => { if (r.active || r.discovered != null) console.log("tick", JSON.stringify(r)); }));
  }
};
