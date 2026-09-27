// padel-push: Web Push for padel.holmberg.st. A cron tick every minute polls RankedIn while an
// event is active, diffs against the last state in KV and pushes new results. Events come from
// discover.js (every event Thea and Kian enter on RankedIn, refreshed hourly) merged with events.js.
import { EVENTS, activeEvents, merge, normalize } from "./events.js";
import { parse, snapshot, notes, drawNote } from "./rankedin.js";
import { discover, drawPath, rubbersPath, namesPath, drawsOf, API } from "./discover.js";
import { parseTie, snapshotTie, tieNotes } from "./teamleague.js";
import { b64u, vapidKey, send } from "./webpush.js";
import { dayOf } from "./tz.js";

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
function validSub(s, env) {
  try {
    if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1024 || !s.keys) return false;
    if (!(env.PUSH_HOST_ANY === "1" ? /^https?:\/\//.test(s.endpoint) : PUSH_HOSTS.test(s.endpoint))) return false;
    const p = b64u.dec(s.keys.p256dh), a = b64u.dec(s.keys.auth);
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch (e) {
    return false;
  }
}
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
  // Writes only from the site (or localhost): keeps drive-by pages from filling KV (1000 writes/day).
  if (req.method === "POST" && !h["Access-Control-Allow-Origin"]) return json({ error: "forbidden" }, 403, h);
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
    return json({ at: rec ? rec.at : null, src: "worker", events, past: (rec && rec.past) || [] }, 200, { ...h, "Cache-Control": "public, max-age=300" });
  }
  if (route === "POST /subscribe") {
    let b;
    try { b = await readBody(req); } catch (e) { return json({ error: "bad json" }, 400, h); }
    const s = b && b.subscription;
    if (!validSub(s, env)) return json({ error: "bad subscription" }, 400, h);
    const p = (b && b.prefs) || {};
    const rec = JSON.stringify({ sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      prefs: { thea: p.thea !== false, kian: p.kian !== false } });
    const key = await subKey(s.endpoint);
    if ((await env.PUSH.get(key)) !== rec) await env.PUSH.put(key, rec);   // no write when nothing changed
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

const now = env => env.NOW ? new Date(env.NOW) : new Date();   // NOW: local tests only
const H = 3600e3, DAY = 24 * H, SUBREQUESTS = 45;

/* ---- discovered events: KV "disc" = {at, events, ended, partial}. Read at most every 5 min per isolate. ---- */
let MEM = { rec: undefined, readAt: 0, tryAt: 0 };
export function _resetMemory() { MEM = { rec: undefined, readAt: 0, tryAt: 0 }; }
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
// Hourly at minute 7, when nothing is stored yet, after a partial run, or when the record is 6 h old.
// No KV write unless the list changed (or 6 h passed, which also refreshes "at").
export function discoveryDue(rec, t) {
  if (Date.now() - MEM.tryAt < 5 * 60e3 && rec) return false;
  return !rec || !!rec.partial || t.getUTCMinutes() === 7 || +t - new Date(rec.at) > 6 * H;
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
export async function runDiscovery(env, t, budget, rec, log = {}) {
  MEM.tryAt = Date.now();
  const mine = { left: Math.min(35, budget.left) }, start = mine.left;
  const res = await discover(getter(env, mine), t, rec);
  budget.left -= start - mine.left;
  const next = { at: t.toISOString(), events: res.events, ended: res.ended, past: pastOf(rec, res.events, t) };
  if (res.partial) next.partial = true;
  const sig = r => JSON.stringify([r.events, r.ended, !!r.partial, r.past || []]);
  log.discovered = res.events.length;
  if (!rec || sig(rec) !== sig(next) || +t - new Date(rec.at) > 6 * H) {
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

// Draw published? Once an hour (minute 37) for every tournament class Thea/Kian plays that starts within
// 7 days (or is on now). KV "pub:<classId>": "0" = seen without a draw, "1" = draw seen. The first look is the
// baseline (no notis); "0" -> published gives one notis. KV is written only when the state changes.
const PUB_MINUTE = 37;   // not exported: workerd only accepts functions and handlers as module exports
// Draws are often published the evening before or the same morning: within 48 h of the start the check also
// runs every 15 min (minutes 7, 22, 37, 52), limited to those classes.
// New SPF ranking (published in the night to Monday): a look every hour at minute 52 (2 RankedIn calls),
// KV "rank:<pid>" written only when RankedIn's ranking date/standing/points change; a new ranking date
// gives one notis per player. The first look is the baseline.
const RANK_MINUTE = 52;
const RANKED = [
  { who: "thea", pid: 1675246, name: "Thea", q: "Holmberg", rt: 4, ag: 83, list: "Dam huvudlista" },
  { who: "kian", pid: 1680004, name: "Kian", q: "Borgström", rt: 3, ag: 82, list: "Herrar huvudlista" }
];
export async function rankingChecks(env, t, budget, log, players = RANKED) {
  const get = getter(env, budget), msgs = [];
  for (const p of players) {
    let x;
    const q = "/Ranking/SearchRankingPlayersAsync?rankingId=1917&rankingType=" + p.rt + "&ageGroup=" + p.ag +
      "&weekFromNow=0&language=en&searchTerm=" + encodeURIComponent(p.q) + "&skip=0&take=20&rankingDate=" + dayOf(t);
    try { x = await get(q); } catch (e) { if (e.budget) break; console.warn("ranking", p.who, e.message); continue; }
    const me = ((x && x.Payload) || []).find(r => r && r.Participant && r.Participant.NewParticipantId === p.pid && r.ParticipantPoints);
    if (!me) continue;
    const pp = me.ParticipantPoints, cur = { d: String(pp.RankingDate).slice(0, 10), s: pp.Standing, p: pp.Points };
    const key = "rank:" + p.pid, raw = await env.PUSH.get(key), prev = raw ? JSON.parse(raw) : null;
    if (prev && prev.d === cur.d && prev.s === cur.s && prev.p === cur.p) continue;
    await env.PUSH.put(key, JSON.stringify(cur));
    log.writes = (log.writes || 0) + 1;
    if (!prev || prev.d >= cur.d) continue;   // baseline or a correction of the same list: no notis
    const up = prev.s - cur.s, dp = cur.p - prev.p, f = v => v.toFixed(v >= 20 ? 1 : 2);
    msgs.push({ who: p.who, m: {
      title: "Ny ranking: " + p.name + " #" + cur.s + (up ? (up > 0 ? " \u25B2\uFE0E " : " \u25BC\uFE0E ") + Math.abs(up) + (Math.abs(up) === 1 ? " plats" : " platser") : " (oförändrad)"),
      body: f(cur.p) + " p" + (dp ? " (" + (dp > 0 ? "+" : "\u2212") + Math.abs(dp).toFixed(1) + ")" : "") + " · " + p.list,
      tag: "padel-rank-" + p.pid, url: "./#" + p.who } });
  }
  if (msgs.length) log.ranked = msgs.length;
  return msgs;
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
        const draws = drawsOf(names, cid), key = "pub:" + cid, state = draws ? "1" : "0";
        const was = await env.PUSH.get(key);
        if (was === state) continue;
        if (was === "0" && draws) {
          if (mine.left < draws.length) continue;   // not enough budget: next hour (nothing written)
          let matches;
          try { matches = parse(await Promise.all(draws.map(([st, sg]) => fetchDraw(env, get, cid, st, sg)))); }
          catch (e) { console.warn("draw fetch", cid, e.message); continue; }
          if (!matches.length) continue;   // listed but still empty
          evs.filter(e => e.classId === cid).forEach(ev => msgs.push({ who: ev.who, m: drawNote(ev, matches) }));
        }
        await env.PUSH.put(key, state);
        log.writes = (log.writes || 0) + 1;
      }
    }
  } finally {
    budget.left -= start - mine.left;
  }
  if (msgs.length) log.drawn = msgs.length;
  return msgs;
}

async function fetchDraw(env, get, classId, stage, strength) {
  if (!env.FIXTURE_URL) return get(drawPath(classId, stage, strength));
  const u = env.FIXTURE_URL.replace("{classId}", classId).replace("{stage}", stage).replace("{strength}", strength || 0);
  const res = await fetch(u, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("RankedIn HTTP " + res.status);
  return res.json();
}

// One cron tick. events: explicit list (tests); otherwise discovered + static. Returns what happened.
export async function tick(env, events) {
  const t = now(env), budget = { left: SUBREQUESTS }, log = { writes: 0, sent: 0, removed: 0 };
  let list;
  if (events) list = events.map(normalize);
  else {
    let rec = await loadRecord(env);
    if (discoveryDue(rec, t)) {
      try { rec = await runDiscovery(env, t, budget, rec, log); } catch (e) { console.warn("discovery", e.message); }
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
  const evs = activeEvents(t, list);
  if (!evs.length && !pubMsgs.length) {
    if (log.discovered != null || log.writes) return { active: 0, discovered: log.discovered, writes: log.writes };
    return { active: 0 };
  }
  log.active = evs.length;

  // Units of work: one per class (shared by both players) and one per team league tie.
  const units = new Map();
  for (const ev of evs) {
    if (ev.kind === "teamleague") {
      (ev.ties || []).forEach(tie => { if (!tie.canceled) units.set("tm" + tie.id, { key: "st:tm" + tie.id, kind: "tl", tie, ev, cost: 1 }); });
    } else if (ev.classId) {
      const k = "c" + ev.classId, u = units.get(k) || { key: "st:" + ev.classId, kind: "t", classId: ev.classId, draws: ev.draws || [[0, 0], [1, 0]], evs: [] };
      u.evs.push(ev); u.cost = u.draws.length;
      units.set(k, u);
    }
  }
  // Free plan: 50 subrequests per invocation. RankedIn gets at most 30 (rotating when there is more),
  // pushes get the rest.
  const arr = [...units.values()], cap = Math.min(30, budget.left - 5), start = t.getUTCMinutes() % Math.max(1, arr.length);
  const get = getter(env, budget), msgs = pubMsgs.slice();
  let fetches = 0;
  log.units = arr.length; log.polled = 0;
  for (let i = 0; i < arr.length; i++) {
    const u = arr[(start + i) % arr.length];
    if (fetches + u.cost > cap) continue;
    let prev = null;
    try { prev = JSON.parse((await env.PUSH.get(u.key)) || "null"); } catch (e) { prev = null; }
    if (prev && prev._done && t.getUTCMinutes() % 10) continue;   // finished: a look every 10 min is enough
    fetches += u.cost; log.polled++;
    let after;
    try {
      if (u.kind === "t") {
        const matches = parse(await Promise.all(u.draws.map(([st, sg]) => fetchDraw(env, get, u.classId, st, sg))));
        if (!matches.length) continue;
        after = snapshot(matches);
        const fmt = u.evs[0].format;
        if (matches.every(m => m.w) && (fmt === "groups" || matches.some(m => m.kind === "ko" && m.di === 0 && m.r === m.R - 1))) after._done = 1;
        // First look at an event is the baseline: results already there never notify (same as the page).
        if (prev) u.evs.forEach(ev => notes(ev, matches, prev).forEach(m => msgs.push({ who: ev.who, m })));
      } else {
        const rubbers = parseTie(await get(rubbersPath(u.tie.id)));
        if (!rubbers.length) continue;
        after = snapshotTie(rubbers);
        if (prev) tieNotes(u.ev, u.tie, rubbers, prev).forEach(m => msgs.push({ who: u.ev.who, m }));
      }
    } catch (e) {
      console.warn("fetch", u.key, e.message);
      continue;
    }
    const next = JSON.stringify(after);
    if (JSON.stringify(prev) !== next) { await env.PUSH.put(u.key, next); log.writes++; }   // free KV: 1000 writes/day
  }
  if (!msgs.length) return log;
  const key = await vapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const subs = [];
  let cursor;
  do {
    const page = await env.PUSH.list({ prefix: "sub:", cursor });
    subs.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  // Fold everything into one notis per device when needed, and cap the number of devices.
  const pushBudget = Math.max(0, budget.left);
  let out = msgs;
  if (subs.length * msgs.length > pushBudget && msgs.length > 1) {
    const url = msgs[msgs.length - 1].m.url;
    out = [...new Set(msgs.map(x => x.who))].map(who => {
      const ms = msgs.filter(x => x.who === who).map(x => x.m);
      return { who, m: ms.length === 1 ? ms[0] : { title: ms.length + " nya resultat", body: ms.map(m => m.title).join("\n"), tag: "padel-sammanfattning", url } };
    });
  }
  if (subs.length * out.length > pushBudget) {
    console.warn("push budget: " + subs.length + " devices, sending to the first " + Math.floor(pushBudget / out.length));
    subs.length = Math.floor(pushBudget / out.length);
  }
  const jwts = {};   // one VAPID JWT per push service per tick (CPU time on the free plan is 10 ms)
  await Promise.all(subs.map(async name => {
    const rec = JSON.parse((await env.PUSH.get(name)) || "null");
    if (!rec) return;
    for (const { who, m } of out) {
      if (rec.prefs && rec.prefs[who] === false) continue;
      const st = await send(rec.sub, m, env, key, jwts);
      if (st === 404 || st === 410) { await env.PUSH.delete(name); log.removed++; return; }
      if (st >= 200 && st < 300) log.sent++;
      else console.warn("push", st, new URL(rec.sub.endpoint).host);
    }
  }));
  return log;
}

async function testPush(env) {
  const key = await vapidKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY), jwts = {}, res = [];
  const names = (await env.PUSH.list({ prefix: "sub:" })).keys.map(k => k.name).slice(0, 20);
  for (const name of names) {
    const rec = JSON.parse((await env.PUSH.get(name)) || "null");
    if (!rec) continue;
    const st = await send(rec.sub, { title: "Testnotis från Nynäs Padel", body: "Push fungerar. Nästa resultat kommer hit.", tag: "padel-test", url: "./#thea" }, env, key, jwts);
    res.push({ host: new URL(rec.sub.endpoint).host, status: st });
  }
  return { sent: res };
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => json({ error: "server error" }, 500, cors(req, env))),
  scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env).then(r => { if (r.active || r.discovered != null) console.log("tick", JSON.stringify(r)); }));
  }
};
