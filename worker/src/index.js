// padel-push: Web Push for padel.holmberg.st. A cron tick every minute polls RankedIn while an
// event is active, diffs against the last state in KV and pushes new results to the devices that follow
// the player(s) concerned. Events come from discover.js (every event the club's players in players.json
// enter on RankedIn, a few players per run) merged with events.js.
import { fetchBhs, fetchBhsHistory, bhsLogin } from "./bhs.js";
import { EVENTS, activeEvents, merge, normalize } from "./events.js";
import { parse, snapshot, unpack, notes, drawNote, summary, classResult, flip } from "./rankedin.js";
import { discover, drawPath, rubbersPath, namesPath, drawsOf, ratingPath, skillOf, API, PLAYERS, BY_PID, LEGACY } from "./discover.js";
import { parseTie, snapshotTie, tieNotes, tieSummary } from "./teamleague.js";
import { b64u, vapidKey, send } from "./webpush.js";
import { dayOf, localToDate, offsetAt } from "./tz.js";
import { calendarDue, calendarStep, sameCalendar, registrations, runOf } from "./calendar.js";
import { prune, playersOf, parseLive, nextLive, skillsDue, ratingsOf, liveBody, ID_RE, LIVE_MEM_MS, LIVE_CALM_MS, LIVE_MAX_WRITES } from "./relay.js";

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
// Push fan-out (see fanOut): up to MAX_SUBS devices. The cap only keeps KV and the outbox bounded.
const MAX_SUBS = 5000;
async function readBody(req, max = 4096) {
  if (Number(req.headers.get("Content-Length") || 0) > max) throw new Error("too large");
  const t = await req.text();
  if (t.length > max) throw new Error("too large");
  return JSON.parse(t);
}
// Subscriptions: the record is also the key's KV metadata when it fits (1024 bytes), so the fan-out reads every device
// with one KV list per 1000 devices instead of a get each.
// KV's limit is 1024 bytes of serialized metadata (the record's quotes are escaped in it).
const metaOf = rec => new TextEncoder().encode(JSON.stringify({ r: rec })).length <= 1024 ? { metadata: { r: rec } } : undefined;
// Devices counted by this isolate (the cap check on a new subscription lists at most every 10 min).
let SUBN = { n: 0, at: 0 };
async function subCount(env) {
  if (SUBN.at && Date.now() - SUBN.at < 10 * 60e3 && SUBN.n < MAX_SUBS - 50) return SUBN.n;
  let n = 0, cursor;
  do {
    const page = await env.PUSH.list({ prefix: "sub:", cursor });
    n += page.keys.length;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && n < MAX_SUBS);
  SUBN = { n, at: Date.now() };
  return n;
}

// Constant-time compare of the fan-out secret (crypto.subtle.timingSafeEqual in workerd; plain compare elsewhere).
function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a || "")), y = new TextEncoder().encode(String(b || ""));
  if (x.length !== y.length) return false;
  if (crypto.subtle && crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function handle(req, env) {
  const url = new URL(req.url), h = cors(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  // Admin test push: POST /test with X-Admin-Key = secret ADMIN_KEY (set with wrangler secret put). Off without the secret.
  if (req.method === "POST" && url.pathname === "/test") {
    if (!env.ADMIN_KEY || req.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403, {});
    return json(await testPush(env), 200, {});
  }
  // Admin: the nightly Backhandsmash round now (after a change of the parser), -> a short summary
  if (req.method === "POST" && url.pathname === "/bhs-run") {
    if (!env.ADMIN_KEY || !sameSecret(req.headers.get("X-Admin-Key"), env.ADMIN_KEY)) return json({ error: "forbidden" }, 403, {});
    let b2 = {};
    try { b2 = (await readBody(req)) || {}; } catch (e) {}
    try {
      const log = {}, v = b2.hist ? await runBhsHist(env, now(env), { left: SUBREQUESTS }, log) : await runBhs(env, now(env), { left: SUBREQUESTS }, log);
      if (b2.hist) return json({ ok: true, written: log.bhsHist, members: Object.keys((v.hist || {}).members || {}).length, rank: Object.keys((v.hist || {}).rank || {}) }, 200, {});
      return json({ ok: true, at: v.at, written: log.bhs, groups: v.groups.map(g => ({ series: g.series, name: g.name, players: g.pids.length, rows: g.rows.length, res: g.res.length, next: (g.next || []).length })) }, 200, {});
    } catch (e) { return json({ ok: false, error: String(e && e.message) }, 200, {}); }
  }
  // Admin: log in to Backhandsmash with the captain's account and return a few pages (to build and check the parser).
  if (req.method === "POST" && url.pathname === "/bhs-probe") {
    if (!env.ADMIN_KEY || !sameSecret(req.headers.get("X-Admin-Key"), env.ADMIN_KEY)) return json({ error: "forbidden" }, 403, {});
    let b = {};
    try { b = await readBody(req); } catch (e) {}
    try {
      const s2 = await bhsLogin(env), out = [];
      for (const p of (Array.isArray(b.paths) ? b.paths : []).slice(0, 6)) {
        const r = await s2.get(p);
        out.push({ path: p, status: r.status, url: r.url, len: r.html.length, html: r.html.slice(0, 300000) });
      }
      return json({ ok: true, pages: out }, 200, {});
    } catch (e) { return json({ ok: false, error: String(e && e.message) }, 200, {}); }
  }
  // Internal: a batch of pushes from this worker's own cron tick (service binding SELF). Secret FANOUT_KEY; off without it.
  if (url.pathname === "/fanout") {
    if (req.method !== "POST" || !env.FANOUT_KEY || !sameSecret(req.headers.get("X-Fanout-Key"), env.FANOUT_KEY)) return json({ error: "forbidden" }, 403, {});
    let b;
    try { b = await readBody(req, 8 << 20); } catch (e) { return json({ error: "bad json" }, 400, {}); }
    if (!b || !Array.isArray(b.jobs)) return json({ error: "bad json" }, 400, {});
    return json(await fanoutRoute(env, b.jobs, Math.max(0, b.depth | 0)), 200, {});   // a batch (depth >= 1) never calls on
  }
  // Writes only from the site (or localhost). The Origin header is only CSRF protection (any script can send it):
  // the per-IP rate limits and the cap on subscriptions are what keep KV (1000 writes, 100k reads a day) safe.
  if (req.method === "POST" && !h["Access-Control-Allow-Origin"]) return json({ error: "forbidden" }, 403, h);
  if (await limited(req.method === "POST" ? env.SUB_RL : url.pathname === "/live" ? env.LIVE_RL || env.API_RL : env.API_RL, req)) return json({ error: "too many requests" }, 429, { ...h, "Retry-After": "60" });
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
    const bhs = await loadBhs(env);
    return json({ at: rec ? rec.at : null, checked: checkedAt(rec, t), src: "worker", events, past, latest: lv.latest, live: lv.live, wins, photos: (rec && rec.photos) || {}, bhs: bhs ? { at: bhs.at, groups: bhs.groups, hist: bhs.hist || null } : null,
      board: (rec && rec.board) || {} }, 200, { ...h, "Cache-Control": "public, max-age=120" });
  }
  if (route === "GET /live") return liveRoute(req, env, url, h);
  if (route === "GET /cal") {
    // "Förslag på tävlingar": sanctioned tournaments within 200 km, next 8 weeks (built nightly), with the roster's
    // entries as the discovery record has them now. Separate from /events (which stays small), cached an hour.
    const cal = await loadCal(env), rec = await loadRecord(env);
    const out = cal ? { ...cal, events: cal.events.map(e => ({ ...e })) } : { v: 1, at: null, caps: null, events: [] };
    const regs = registrations(rec, out.events.map(e => e.id));
    if (rec) out.events.forEach(e => { e.regs = regs.filter(r => r.tid === e.id).map(r => ({ pid: r.pid, classId: r.classId })); });
    return json(out, 200, { ...h, "Cache-Control": "public, max-age=3600" });
  }
  if (route === "POST /subscribe") {
    let b;
    try { b = await readBody(req); } catch (e) { return json({ error: "bad json" }, 400, h); }
    const s = b && b.subscription;
    if (!(await validSub(s, env))) return json({ error: "bad subscription" }, 400, h);
    // lang: "es" only (Swedish is the default, so the records of Swedish devices stay as they were)
    const prefs = { follow: followOf((b && b.prefs) || {}) };
    if (langOf(b && b.prefs) === "es") prefs.lang = "es";
    const rec = JSON.stringify({ sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, prefs });
    const key = await subKey(s.endpoint);
    // getWithMetadata: a record stored before the metadata existed is written once more (the page posts on every visit).
    let was, meta = true;
    if (env.PUSH.getWithMetadata) { const x = await env.PUSH.getWithMetadata(key); was = x.value; meta = !metaOf(rec) || !!(x.metadata && x.metadata.r === rec); }
    else was = await env.PUSH.get(key);
    if (was === null && (await subCount(env)) >= MAX_SUBS) return json({ error: "full" }, 503, h);
    if (was !== rec || !meta) { await env.PUSH.put(key, rec, metaOf(rec)); if (was === null) SUBN.n++; SUBS.at = 0; }   // no write when nothing changed
    return json({ ok: true }, 200, h);
  }
  if (route === "POST /unsubscribe") {
    let b;
    try { b = await readBody(req); } catch (e) { return json({ error: "bad json" }, 400, h); }
    if (!b || typeof b.endpoint !== "string") return json({ error: "endpoint missing" }, 400, h);
    const key = await subKey(b.endpoint);
    if (await env.PUSH.get(key)) { await env.PUSH.delete(key); SUBS.at = 0; SUBN.at = 0; }
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
// Language of a device's notiser: "sv" (default) or "es".
export function langOf(p) { return p && p.lang === "es" ? "es" : "sv"; }
// A message as one device gets it: the Spanish title/body for "es" (Swedish where one is missing); "es" itself is never sent.
export function localize(m, lang) {
  const { es, ...out } = m;
  if (lang === "es" && es) { if (es.title) out.title = es.title; if (es.body != null) out.body = es.body; }
  return out;
}
const now = env => env.NOW ? new Date(env.NOW) : new Date();   // NOW: local tests only
const H = 3600e3, DAY = 24 * H, SUBREQUESTS = 45, FOLD_OVER = 8;

/* ---- discovered events: KV "disc" = {at, events, ended, none, past, photos, board}. Read at most every 5 min per isolate. ---- */
let MEM = { rec: undefined, readAt: 0, tryAt: 0, wins: undefined, winsAt: 0 };
export function _resetMemory() { BHSM = { v: undefined, at: 0 }; MEM = { rec: undefined, readAt: 0, tryAt: 0, wins: undefined, winsAt: 0 }; LV = { at: 0, v: null }; CAL = { v: undefined, at: 0 }; LIVE = { rec: null, at: 0 }; SUBS = { list: null, at: 0 }; SUBN = { n: 0, at: 0 }; LIVE_N = { min: 0, n: 0 }; }
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
// When RankedIn was last looked at: the discovery runs every 10 min (minute 7, 17, ...) but writes only on a change or
// after 6 h. A record written within the last 6 h 20 min shows the rounds run, so the last round's time is given; an
// older one (rounds failing) gives its own time.
export function checkedAt(rec, t) {
  if (!rec || !rec.at) return null;
  const at = +new Date(rec.at), slot = Math.floor((+t - 7 * 60e3) / 600e3) * 600e3 + 7 * 60e3;
  return +t - at < 6 * H + 20 * 60e3 ? new Date(Math.max(at, slot)).toISOString() : rec.at;
}
// Backhandsmash series (bhs.js): once a night at 01:33 UTC (03:33 in summer), and at once when nothing is stored yet
// (then only at minute 33, an hour's KV read). Written only when a table or result changed.
let BHSM = { v: undefined, at: 0 };
async function loadBhs(env) {
  if (BHSM.v !== undefined && Date.now() - BHSM.at < 10 * 60e3) return BHSM.v;
  let v = null;
  try { v = JSON.parse((await env.PUSH.get("bhs")) || "null"); } catch (e) { v = null; }
  BHSM = { v, at: Date.now() };
  return v;
}
export async function bhsDue(env, t) {
  if (t.getUTCMinutes() !== 33) return false;
  if (t.getUTCHours() === 1) return true;
  const v = await loadBhs(env);
  return !v || +t - Date.parse(v.at) > 26 * H;
}
// The series' history (rounds, league ranking): its own run at minute 43 after the tables (01:43 UTC), or when missing.
export async function bhsHistDue(env, t) {
  if (t.getUTCMinutes() !== 43) return false;
  const v = await loadBhs(env);
  if (!v || !v.groups || !v.groups.length) return false;
  return t.getUTCHours() === 1 || !v.hist || +t - Date.parse(v.hist.at) > 26 * H;
}
export async function runBhsHist(env, t, budget, log = {}) {
  const v = await loadBhs(env), h = await fetchBhsHistory(budget, v.groups);
  const next = { ...v, hist: { at: t.toISOString(), ...h } };
  if (v.hist && JSON.stringify({ m: v.hist.members, r: v.hist.rank }) === JSON.stringify({ m: h.members, r: h.rank }) && +t - Date.parse(v.hist.at) < 6 * DAY) { log.bhsHist = 0; return v; }
  await env.PUSH.put("bhs", JSON.stringify(next));
  BHSM = { v: next, at: Date.now() };
  log.writes = (log.writes || 0) + 1; log.bhsHist = Object.keys(h.members).length;
  return next;
}
export async function runBhs(env, t, budget, log = {}) {
  const r = await fetchBhs(budget, undefined, env), was = await loadBhs(env);
  if (r.err) console.warn("backhandsmash schedule", r.err);
  if (was && JSON.stringify(was.groups) === JSON.stringify(r.groups) && +t - Date.parse(was.at) < 6 * DAY) { log.bhs = 0; return was; }
  const v = { at: t.toISOString(), groups: r.groups, ...(was && was.hist ? { hist: was.hist } : {}) };
  await env.PUSH.put("bhs", JSON.stringify(v));
  BHSM = { v, at: Date.now() };
  log.writes = (log.writes || 0) + 1; log.bhs = r.groups.length;
  return v;
}
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
  const move = (one, many, same) => up ? (up > 0 ? " \u25B2\uFE0E " : " \u25BC\uFE0E ") + Math.abs(up) + (Math.abs(up) === 1 ? one : many) : same;
  const pts = f(cur.p) + " p" + (dp ? " (" + (dp > 0 ? "+" : "\u2212") + Math.abs(dp).toFixed(1) + ")" : "") + " · ";
  msgs.push({ pids: [p.pid], m: {
    title: "Ny ranking: " + p.name + " #" + cur.s + move(" plats", " platser", " (oförändrad)"),
    body: pts + p.list,
    tag: "padel-rank-" + p.pid, url: "./#" + p.who,
    es: { title: "Nuevo ranking: " + p.name + " #" + cur.s + move(" puesto", " puestos", " (sin cambios)"), body: pts + (/^Dam/.test(p.list) ? "Lista principal femenina" : "Lista principal masculina") } } });
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

/* ---- "Förslag på tävlingar": KV "cal" (built nightly by calendar.js, written only when it changed), "calw" (work in progress) ---- */
let CAL = { v: undefined, at: 0 };
async function loadCal(env) {
  if (CAL.v !== undefined && Date.now() - CAL.at < 10 * 60e3 && !env.NOW) return CAL.v;
  let v = null;
  try { v = JSON.parse((await env.PUSH.get("cal")) || "null"); } catch (e) { v = null; }
  CAL = { v: v && Array.isArray(v.events) ? v : null, at: Date.now() };
  return CAL.v;
}
// One step of the calendar (every 6 h from 03:23 local, a step per tick until done): at most 40 RankedIn calls, and
// never more than the tick has left (5 kept for pushes). KV: "calw" written when the step got somewhere, "cal" when
// the finished calendar differs from the stored one.
export async function runCalendar(env, t, budget, rec, log = {}) {
  let w = null, prev = null;
  try { w = JSON.parse((await env.PUSH.get("calw")) || "null"); } catch (e) { w = null; }
  if (w && w.done && w.day === dayOf(t) && (w.run || w.day + "@3") === runOf(t)) return null;
  try { prev = JSON.parse((await env.PUSH.get("cal")) || "null"); } catch (e) { prev = null; }
  // On a live day the calendar steps small (10 calls a tick) so live polling keeps its budget; it finishes within its window.
  const cap = activeEvents(t, merge((rec && rec.events) || [])).length ? 10 : 40;
  const mine = { left: Math.max(0, Math.min(cap, budget.left - 5)) }, start = mine.left, was = JSON.stringify(w);
  const r = await calendarStep(getter(env, mine), t, w, prev, rec);
  budget.left -= start - mine.left;
  log.cal = start - mine.left;
  if (r.cal && !sameCalendar(prev, r.cal)) {
    await env.PUSH.put("cal", JSON.stringify(r.cal));
    log.writes = (log.writes || 0) + 1; log.calWritten = 1;
    CAL = { v: r.cal, at: Date.now() };
  }
  const next = JSON.stringify(r.cal ? { day: r.w.day, done: 1 } : r.w);
  if (next !== was) { await env.PUSH.put("calw", next); log.writes = (log.writes || 0) + 1; }
  return r.cal;
}

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
  if (!events && env.BHS_OFF !== "1" && (await bhsHistDue(env, t))) {
    try { await runBhsHist(env, t, budget, log); } catch (e) { console.warn("backhandsmash history", e.message); }
  }
  if (!events && env.BHS_OFF !== "1" && (await bhsDue(env, t))) {   // BHS_OFF: local tests only
    try { await runBhs(env, t, budget, log); } catch (e) { console.warn("backhandsmash", e.message); }
  }
  if (!events && env.CAL_OFF !== "1" && calendarDue(t, env)) {   // CAL_OFF / CAL_ANY: local tests only
    try { await runCalendar(env, t, budget, rec, log); } catch (e) { console.warn("calendar", e.message); }
  }
  const evs = activeEvents(t, list);
  if (!evs.length && !pubMsgs.length) {
    // Pushes left over from an earlier tick (outbox) still go out.
    try { await fanOut(env, [], budget, log); } catch (e) { console.warn("outbox", e.message); }
    if (log.sent || log.removed || log.queued) return { active: 0, sent: log.sent, removed: log.removed, queued: log.queued || 0, writes: log.writes };
    if (log.discovered != null || log.writes || log.cal != null) return { active: 0, discovered: log.discovered, refreshed: log.refreshed, writes: log.writes, ...(log.cal != null ? { cal: log.cal } : {}) };
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
  const wins = [], pending = [], relay = {};
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
        const datas = await Promise.all(u.draws.map(([st, sg]) => fetchDraw(env, get, u.classId, st, sg)));
        // Live relay (GET /live): the draws as the page reads them
        const pr = prune(datas);
        relay[String(u.classId)] = { data: pr, dr: u.draws, p: playersOf(pr) };
        const matches = parse(datas);
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
        const raw = await get(rubbersPath(u.tie.id));
        relay["tm" + u.tie.id] = { data: raw };
        const rubbers = parseTie(raw);
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
    // Relay hint for the page (GET /live "every"): a match of this unit on now or soon -> poll every minute, else every 5.
    const rid = u.kind === "t" ? String(u.classId) : "tm" + u.tie.id;
    if (relay[rid] && !after._done && hot(after, u, t)) relay[rid].h = 1;
    const next = JSON.stringify(after);
    if (JSON.stringify(prev) !== next) pending.push([u.key, next]);   // free KV: 1000 writes/day
  }
  if (wins.length) try { await addWins(env, t, wins, log); } catch (e) { console.warn("wins", e.message); }
  if (!night) try { await relayStep(env, t, relay, arr, budget, log, pending); } catch (e) { console.warn("relay", e.message); }
  msgs = dedupe(msgs);
  // The new state is written after the pushes (sent, or queued in the outbox): if the invocation dies on the way, the
  // next tick sends them again. Also runs without new messages: it drains the outbox.
  try { await fanOut(env, msgs, budget, log); } catch (e) { console.warn("push", e.message); log.pushFailed = 1; return log; }
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

/* ---- live relay: KV "live" (relay.js), written at most once per tick and only when the data changed ---- */
const SK_MINUTE = 3, SK_PER_TICK = 20;   // skills of the players in live draws: every 10 min (minute 3, 13, ...), refreshed after 3 h
async function relayStep(env, t, relay, units, budget, log, pending) {
  const mm = t.getUTCMinutes(), skTime = mm % 10 === (env.SK_MINUTE != null ? +env.SK_MINUTE : SK_MINUTE);   // SK_MINUTE: local tests only
  if (!Object.keys(relay).length && !skTime) return;
  const prev = parseLive(await env.PUSH.get("live")), skills = {}, day = dayOf(t), wn = prev.wd === day ? prev.wn : 0;
  if (wn >= LIVE_MAX_WRITES) return;   // the day's cap is reached: the relay is empty until tomorrow
  if (skTime && budget.left > 8) {
    const items = { ...prev.items };
    Object.keys(relay).forEach(id => { items[id] = { ...(items[id] || {}), p: relay[id].p }; });
    const due = skillsDue({ items, sk: prev.sk }, t, Math.min(SK_PER_TICK, budget.left - 6)), get = getter(env, budget);
    for (const pid of due) {
      try { skills[pid] = ratingsOf(await get(ratingPath(pid))); } catch (e) { if (e.budget) break; }
    }
    if (due.length) log.skills = Object.keys(skills).length;
  }
  const keep = new Set(units.map(u => u.kind === "t" ? String(u.classId) : "tm" + u.tie.id));
  const next = nextLive(prev, relay, skills, t, keep);
  if (!next) return;
  // A new result, time or court (the unit's state changed, as for the notiser) or new skills: now. Anything else the
  // page shows (a live score): at most every 3 minutes.
  const urgent = Object.keys(skills).length > 0 || Object.keys(relay).some(id => pending.some(([k]) => k === "st:" + id));
  if (!urgent && prev.at && +t - Date.parse(prev.at) < LIVE_CALM_MS) return;
  next.wd = day; next.wn = wn + 1;
  if (next.wn >= LIVE_MAX_WRITES) { next.items = {}; next.sk = {}; log.relayOff = 1; console.warn("relay: " + LIVE_MAX_WRITES + " writes today, off until tomorrow"); }
  pending.push(["live", JSON.stringify(next)]);
  log.relay = 1;
  LIVE = { rec: next, at: Date.now(), bodies: new Map() };
}
// GET /live?ids=164681,tm167486[&since=<v>]: {v, at, items: {id: {v, at, dr?, data}}, sk: {pid: {rid: skill}}}.
// Ids the relay does not have are missing from items (the page asks RankedIn for those). If-None-Match -> 304,
// since=<v> unchanged -> {v, same: 1}. The record is read from KV at most every 25 s per isolate.
let LIVE = { rec: null, at: 0, bodies: new Map() };
// Load shedding: the free plan has 100k requests a day for everything (cron, pushes, the page). Past LIVE_ALL (a rate
// limit with ONE key for every caller: about 100 /live calls a minute per Cloudflare location, i.e. at most ~72k in a
// 12-hour day) or LIVE_SHED calls a minute in one isolate, the apps are told to ask RankedIn themselves for 30 min
// ({shed: 1}): the apps that got through keep the relay, the rest poll RankedIn as before the relay existed.
const LIVE_SHED = 150;
let LIVE_N = { min: 0, n: 0 };
async function overAll(env) {
  if (!env.LIVE_ALL) return false;
  try { return !(await env.LIVE_ALL.limit({ key: "all" })).success; } catch (e) { return false; }
}
async function liveRoute(req, env, url, h) {
  const m = Math.floor(Date.now() / 60e3);
  if (LIVE_N.min !== m) LIVE_N = { min: m, n: 0 };
  if (++LIVE_N.n > (+env.LIVE_SHED || LIVE_SHED) || await overAll(env)) return json({ shed: 1, every: 1800 }, 200, { ...h, "Cache-Control": "no-store" });
  const ids = [...new Set(String(url.searchParams.get("ids") || "").split(","))].filter(x => ID_RE.test(x)).slice(0, 12);
  if (!ids.length) return json({ error: "ids" }, 400, h);
  if (!LIVE.rec || Date.now() - LIVE.at >= LIVE_MEM_MS || env.NOW) {
    LIVE = { rec: parseLive(await env.PUSH.get("live")), at: Date.now(), bodies: new Map() };
  }
  const k = ids.join(",");
  let out = LIVE.bodies.get(k);
  if (!out) { out = liveBody(LIVE.rec, ids); if (LIVE.bodies.size > 200) LIVE.bodies.clear(); LIVE.bodies.set(k, out); }
  const etag = "\"" + out.v + "\"", hd = { ...h, "Content-Type": "application/json", "ETag": etag, "Cache-Control": "no-cache", "Access-Control-Expose-Headers": "ETag" };
  if ((req.headers.get("If-None-Match") || "") === etag) return new Response(null, { status: 304, headers: hd });
  if (url.searchParams.get("since") === out.v) return new Response(JSON.stringify({ v: out.v, same: 1 }), { status: 200, headers: hd });
  return new Response(out.body, { status: 200, headers: hd });
}

/* ---- push fan-out ----
   The tick hands every push to ONE call of this worker (service binding SELF, POST /fanout, secret FANOUT_KEY), which
   splits it into batches of FANOUT_BATCH pushes, each sent by a further call (its own 50 subrequests and 10 ms CPU).
   A request may use 32 Worker invocations: cron + dispatcher + 29 batches (MAX_CHILDREN). Whatever does not fit, or a
   batch that failed, goes to KV "outbox" (one key, written only when it changed) and goes out first on the next tick.
   Without SELF/FANOUT_KEY (local tests, the first deploy before the secret exists) the tick sends in-process as before. */
const FANOUT_BATCH = 20, MAX_CHILDREN = 29, OUTBOX_MAX_AGE = H;   // a push waits at most an hour (its TTL)
const batchSize = env => Math.max(1, +env.FANOUT_BATCH || FANOUT_BATCH);   // FANOUT_BATCH: tuning / tests
const fanoutReady = env => !!env.FANOUT_KEY && !!(env.SELF || env.FANOUT_URL);
const pushesOf = jobs => jobs.reduce((n, j) => n + j.m.length, 0);
// Every device record, read with the KV list (metadata) and a get only for records without it. Kept 3 min per isolate.
let SUBS = { list: null, at: 0 };
async function subscribers(env) {
  if (SUBS.list && Date.now() - SUBS.at < 3 * 60e3 && !env.NOW) return SUBS.list;
  const keys = [];
  let cursor;
  do {
    const page = await env.PUSH.list({ prefix: "sub:", cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && keys.length < MAX_SUBS);
  const list = (await Promise.all(keys.slice(0, MAX_SUBS).map(async k => {
    let rec = null;
    try { rec = JSON.parse((k.metadata && k.metadata.r) || (await env.PUSH.get(k.name)) || "null"); } catch (e) { rec = null; }
    return rec && rec.sub ? { name: k.name, rec } : null;
  }))).filter(Boolean);
  SUBS = { list, at: Date.now() };
  return list;
}
// Push: every device gets the messages about the players it follows (prefs.follow), nothing else, in its language
// (prefs.lang). Jobs: {n: KV key, s: subscription, m: [messages as that device gets them], q: queued at (ms)}.
async function fanOut(env, msgs, budget, log) {
  const raw = await env.PUSH.get("outbox");
  let old = [];
  try { old = (JSON.parse(raw || "null") || {}).jobs || []; } catch (e) { old = []; }
  const nowMs = +now(env);
  old = old.filter(j => nowMs - (j.q || 0) < OUTBOX_MAX_AGE);
  const cap = fanoutReady(env) ? MAX_CHILDREN * batchSize(env) : Math.max(0, budget.left);
  const jobs = old.slice();   // the outbox first
  if (msgs.length) {
    const devs = (await subscribers(env)).map(({ name, rec }) => {
      const f = new Set(followOf(rec.prefs)), lang = langOf(rec.prefs);
      const out = mergeForDevice(msgs.filter(x => x.pids.some(p => f.has(Number(p)))).map(x => localize(x.m, lang)));
      return out.length ? { n: name, s: rec.sub, m: out, q: nowMs, lang } : null;
    }).filter(Boolean);
    // Fold into one notis per device when there are many pushes (subrequests, and CPU: about 0.3 ms per encrypted push).
    const total = pushesOf(devs);
    if (total > Math.min(Math.max(0, cap - pushesOf(old)), FOLD_OVER)) {
      devs.forEach(d => {
        if (d.m.length < 2) return;
        const title = d.lang === "es" ? d.m.length + (d.m.length === 1 ? " resultado nuevo" : " resultados nuevos") : d.m.length + " nya resultat";
        d.m = [{ title, body: d.m.map(m => m.title).join("\n"), tag: "padel-sammanfattning", url: d.m[d.m.length - 1].url }];
      });
    }
    log.devices = devs.length;
    devs.forEach(d => { delete d.lang; });   // the jobs (and the outbox) keep only what is sent
    jobs.push(...devs);
  }
  let rest = [];
  if (jobs.length) {
    if (old.length) log.drained = old.length;
    rest = await dispatch(env, jobs, budget, log, cap);
  }
  if (rest.length > MAX_SUBS) rest.length = MAX_SUBS;
  const next = rest.length ? JSON.stringify({ at: new Date(nowMs).toISOString(), jobs: rest }) : null;
  if (rest.length) { console.warn("push: " + rest.length + " devices wait in the outbox"); log.queued = rest.length; }
  if (next !== raw && !(next === null && raw === null)) {
    if (next) await env.PUSH.put("outbox", next); else await env.PUSH.delete("outbox");
    log.writes = (log.writes || 0) + 1;
  }
}
// Sends what fits this tick; returns the jobs that did not go out (for the outbox).
async function dispatch(env, jobs, budget, log, cap) {
  const take = [], rest = [];
  let n = 0;
  for (const j of jobs) { if (n + j.m.length <= cap && (take.length || budget.left > 0)) { take.push(j); n += j.m.length; } else rest.push(j); }
  if (!take.length) return rest;
  let r;
  if (fanoutReady(env)) {
    budget.left--;
    try { r = await callSelf(env, take, 0); } catch (e) {
      console.warn("fanout", e.message); log.fanoutFailed = 1;
      // 4xx: refused before anything was sent (e.g. the secret differs between versions): send in-process as before,
      // so a misconfiguration cannot hold every push back. 5xx / network: batches may have gone out, so the outbox.
      if (!(e.status >= 400 && e.status < 500)) return jobs;
      r = await sendJobs(env, take, Math.max(0, budget.left));
      budget.left -= r.used;
    }
    if (!log.fanoutFailed) log.children = r.children || 1;
    if (r.failed) log.childFailed = r.failed;
  } else {
    r = await sendJobs(env, take, budget.left);
    budget.left -= r.used;
  }
  log.sent = (log.sent || 0) + (r.sent || 0); log.removed = (log.removed || 0) + (r.removed || 0);
  if (SUBS.list && (r.gone || []).length) { const g = new Set(r.gone); SUBS.list = SUBS.list.filter(x => !g.has(x.name)); }
  return (r.rest || []).concat(rest);
}
async function callSelf(env, jobs, depth) {
  const init = { method: "POST", headers: { "Content-Type": "application/json", "X-Fanout-Key": env.FANOUT_KEY }, body: JSON.stringify({ jobs, depth }) };
  // FANOUT_URL: the worker's own URL, for wrangler dev without the binding
  const res = env.SELF ? await env.SELF.fetch(new Request("https://self/fanout", init)) : await fetch(env.FANOUT_URL.replace(/\/$/, "") + "/fanout", init);
  if (!res.ok) throw Object.assign(new Error("fanout HTTP " + res.status), { status: res.status });
  return res.json();
}
// POST /fanout: a batch (sent here) or, from the tick (depth 0), everything: split into batches for further calls.
async function fanoutRoute(env, jobs, depth) {
  jobs = jobs.filter(j => j && typeof j.n === "string" && j.n.startsWith("sub:") && j.s && typeof j.s.endpoint === "string" && Array.isArray(j.m) && j.m.length);
  const B = batchSize(env);
  if (depth >= 1 || pushesOf(jobs) <= B || !(env.SELF || env.FANOUT_URL)) return sendJobs(env, jobs, B);
  const batches = [], rest = [];
  let cur = [], n = 0;
  for (const j of jobs) {
    if (n + j.m.length > B && cur.length) { batches.push(cur); cur = []; n = 0; }
    cur.push(j); n += j.m.length;
  }
  if (cur.length) batches.push(cur);
  batches.slice(MAX_CHILDREN).forEach(b => rest.push(...b));
  const res = await Promise.all(batches.slice(0, MAX_CHILDREN).map(b => callSelf(env, b, depth + 1).catch(e => { console.warn("fanout batch", e.message); return { rest: b, failed: 1 }; })));
  const out = { sent: 0, removed: 0, gone: [], rest, children: res.length, failed: 0 };
  res.forEach(r => { out.sent += r.sent || 0; out.removed += r.removed || 0; out.gone.push(...(r.gone || [])); out.rest.push(...(r.rest || [])); out.failed += r.failed || 0; });
  return out;
}
// Sends up to max pushes in this invocation (one VAPID JWT per push service). 404/410 (gone) and -1 (keys unusable,
// it would fail every time) remove the subscription.
async function sendJobs(env, jobs, max) {
  const take = [], rest = [];
  let n = 0;
  for (const j of jobs) { if (n + j.m.length <= max) { take.push(j); n += j.m.length; } else rest.push(j); }
  const out = { sent: 0, removed: 0, gone: [], rest, used: 0 };
  if (!take.length) return out;
  const key = await vapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY), jwts = {};
  await Promise.all(take.map(async ({ n: name, s: sub, m: list }) => {
    if (!(env.PUSH_HOST_ANY === "1" ? /^https?:\/\//.test(sub.endpoint) : PUSH_HOSTS.test(sub.endpoint))) return;   // never an open relay
    for (const m of list) {
      out.used++;
      const st = await send(sub, m, env, key, jwts);
      if (st === 404 || st === 410 || st === -1) { await env.PUSH.delete(name); out.removed++; out.gone.push(name); return; }
      if (st >= 200 && st < 300) out.sent++;
      else console.warn("push", st, new URL(sub.endpoint).host);
    }
  }));
  return out;
}

async function testPush(env) {
  const key = await vapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY), jwts = {}, res = [];   // every device, whatever it follows
  const names = (await env.PUSH.list({ prefix: "sub:" })).keys.map(k => k.name).slice(0, 20);
  for (const name of names) {
    try {
      const rec = JSON.parse((await env.PUSH.get(name)) || "null");
      if (!rec || !rec.sub) continue;
      const st = await send(rec.sub, localize({ title: "Testnotis från Nynäs Padel", body: "Push fungerar. Nästa resultat kommer hit.", tag: "padel-test", url: "./#thea",
        es: { title: "Notificación de prueba de Nynäs Padel", body: "Las notificaciones funcionan. Los próximos resultados llegarán aquí." } }, langOf(rec.prefs)), env, key, jwts);
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
    ctx.waitUntil(tick(env).then(r => { if (r.active || r.discovered != null || r.cal != null) console.log("tick", JSON.stringify(r)); }));
  }
};
