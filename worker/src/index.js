// padel-push: Web Push for padel.holmberg.st. A cron tick every minute polls RankedIn while an
// event in events.js is active, diffs against the last state in KV and pushes new results.
import { EVENTS, activeEvents } from "./events.js";
import { drawUrl, parse, snapshot, notes } from "./rankedin.js";
import { b64u, vapidKey, send } from "./webpush.js";

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
  // Writes only from the site (or localhost): keeps drive-by pages from filling KV (1000 writes/day).
  if (req.method === "POST" && !h["Access-Control-Allow-Origin"]) return json({ error: "forbidden" }, 403, h);
  const route = req.method + " " + url.pathname;
  if (route === "GET /health") return json({ ok: true, active: activeEvents(now(env)).map(e => e.cls) }, 200, h);
  if (route === "GET /vapid") return json({ key: env.VAPID_PUBLIC_KEY || "", classes: EVENTS.map(e => e.classId) }, env.VAPID_PUBLIC_KEY ? 200 : 503, h);
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

async function fetchStage(env, ev, stage) {
  const u = env.FIXTURE_URL ? env.FIXTURE_URL.replace("{classId}", ev.classId).replace("{stage}", stage) : drawUrl(ev.classId, stage);
  const res = await fetch(u, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("RankedIn HTTP " + res.status);
  return res.json();
}

const SUBREQUESTS = 45;
// One cron tick. Returns what happened (used by tests and logs).
export async function tick(env, events = EVENTS) {
  const evs = activeEvents(now(env), events);
  if (!evs.length) return { active: 0 };
  const msgs = [], log = { active: evs.length, writes: 0, sent: 0, removed: 0 };
  let fetches = 0;
  for (const ev of evs) {
    let matches;
    try {
      const stages = ev.stages || [0];
      fetches += stages.length;
      matches = parse(await Promise.all(stages.map(s => fetchStage(env, ev, s))));
    } catch (e) {
      console.warn("fetch", ev.classId, e.message);
      continue;
    }
    if (!matches.length) continue;
    const key = "st:" + ev.classId, prev = await env.PUSH.get(key), after = snapshot(matches), next = JSON.stringify(after);
    // First look at an event is the baseline: results already there never notify (same as the page).
    if (prev) notes(ev, matches, JSON.parse(prev)).forEach(m => msgs.push({ who: ev.who, m }));
    if (prev !== next) { await env.PUSH.put(key, next); log.writes++; }   // free KV: 1000 writes/day
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
  // Free plan: 50 subrequests per invocation (RankedIn fetches + one per push). Stay well under it:
  // fold everything into one notis per device when needed, and cap the number of devices.
  const budget = SUBREQUESTS - fetches;
  let out = msgs;
  if (subs.length * msgs.length > budget && msgs.length > 1) {
    const url = msgs[msgs.length - 1].m.url;
    out = [...new Set(msgs.map(x => x.who))].map(who => {
      const ms = msgs.filter(x => x.who === who).map(x => x.m);
      return { who, m: ms.length === 1 ? ms[0] : { title: ms.length + " nya resultat", body: ms.map(m => m.title).join("\n"), tag: "padel-sammanfattning", url } };
    });
  }
  if (subs.length * out.length > budget) {
    console.warn("push budget: " + subs.length + " devices, sending to the first " + Math.floor(budget / out.length));
    subs.length = Math.floor(budget / out.length);
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

export default {
  fetch: (req, env) => handle(req, env).catch(e => json({ error: "server error" }, 500, cors(req, env))),
  scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env).then(r => { if (r.active) console.log("tick", JSON.stringify(r)); }));
  }
};
