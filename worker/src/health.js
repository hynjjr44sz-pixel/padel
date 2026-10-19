// Träning, hälsodata: workouts (and a day's resting pulse, HRV and sleep) from the player's own watch, into the
// sessions the load is counted from. Two ways in:
// - Apple Hälsa (iPhone, Apple Watch) through a Genväg (Shortcut) on the phone: the player makes a personal import
//   link (POST /hk/<key>, the key is the secret, only its SHA-256 is kept) and the Genväg posts the latest workouts.
// - Strava (Garmin, Polar, Suunto, Coros, Wahoo, Android ...: most watches sync there): OAuth with the club's Strava
//   app (secrets STRAVA_ID, STRAVA_SECRET; off without them); the cron reads new activities once an hour.
// An imported session's RPE is estimated from the heart rate (else the kind) and marked so: the player can change it.
// Private as the rest of Träning: the player, parents and linked coaches see it; only the player or a parent connects.
import { sha, clean, log, ORG } from "./auth.js";
import { localToDate, dayOf } from "./tz.js";

const B64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY_RE = /^\d{4}-\d\d-\d\d$/, BACK = 30 * 864e5, MAX_W = 60;
const own = (me, pid) => !!me && !!pid && (me.pid === pid || (me.kids || []).includes(pid));
const yearOf = t => new Date(t).getUTCFullYear();
// The max pulse by age (Tanaka: 208 - 0.7 x age) until the watch has measured a higher one
export const hrmaxByAge = (born, t) => born ? Math.round(208 - 0.7 * (yearOf(t) - born)) : 0;
// Before the first connection: the consent, given by the player (13 or older) or a parent. {err} or null.
async function consent(env, me, pid, b, t) {
  if (await env.DB.prepare("SELECT pid FROM hconsent WHERE pid = ?").bind(pid).first()) return null;
  if (!b || b.consent !== true) return { err: "consent", status: 400 };
  const parent = me.pid !== pid;
  const p = await env.DB.prepare("SELECT born FROM pinfo WHERE pid = ?").bind(pid).first();
  if (!parent && p && p.born && yearOf(t) - p.born < 13) return { err: "parent", status: 403 };   // under 13: a parent says yes
  await env.DB.batch([env.DB.prepare("INSERT INTO hconsent (pid, user, parent, at) VALUES (?, ?, ?, ?)").bind(pid, me.id, parent ? 1 : 0, t), log(env, t, me.id, "health-consent", { pid, parent })]);
  return null;
}
// POST /hk/born {pid, born}: the birth year (the player or a parent); {pid, op: "revoke"}: the consent taken back, the
// connections off and the watch's health data deleted (the training sessions stay, without pulse and kcal)
export async function hkProfile(env, me, b, t) {
  const pid = Number(b && b.pid);
  if (!own(me, pid)) return { err: "forbidden", status: 403 };
  if (b.op === "revoke") {
    const row = await env.DB.prepare("SELECT access FROM strava WHERE pid = ?").bind(pid).first();
    if (row) try { await fetch(STRAVA + "/oauth/deauthorize", { method: "POST", headers: { Authorization: "Bearer " + row.access }, signal: AbortSignal.timeout(8000) }); } catch (e) {}
    await env.DB.batch([...["hkeys", "strava", "hconsent", "health_day", "hrmax"].map(tb => env.DB.prepare("DELETE FROM " + tb + " WHERE pid = ?").bind(pid)),
      env.DB.prepare("UPDATE sess_ext SET hr = NULL, hrmax = NULL, kcal = NULL WHERE pid = ?").bind(pid), log(env, t, me.id, "health-revoke", { pid })]);
    return { ok: true };
  }
  const born = b.born == null || b.born === "" ? null : Math.round(Number(b.born));
  if (born !== null && !(born >= 1930 && born <= yearOf(t) - 5)) return { err: "born", status: 400 };
  await env.DB.prepare("INSERT OR REPLACE INTO pinfo (pid, born) VALUES (?, ?)").bind(pid, born).run();
  return { ok: true };
}

// The watch's name of a workout -> one of the kinds (train.js KINDS)
export function kindOf(type) {
  const s = String(type || "").toLowerCase();
  if (/padel|paddle|tennis|squash|badminton|pickleball|racquet|racket/.test(s)) return "padel";
  if (/run|löp|lop|jogg/.test(s)) return "lop";
  if (/weight|strength|styrk|crossfit|functional|funktion|core|gym|kraft/.test(s)) return "gym";
  if (/hiit|interval|ride|cycl|cykl|bike|spinning|swim|sim|walk|prom|hike|vandr|row|rodd|elliptic|stair|trapp|yoga|pilates|mobil|stretch|rörlig|cardio|kondition|ski|skid/.test(s)) return "fys";
  return "annat";
}
// RPE (1-10) from the average pulse as a share of the player's max (the highest seen; 195 until one is known)
export function rpeOf(kind, hr, max) {
  if (!(hr >= 60 && hr <= 230)) return kind === "fys" || kind === "annat" ? 5 : 6;
  const p = hr / (max >= 160 && max <= 230 ? max : 195);
  return p < .6 ? 3 : p < .7 ? 4 : p < .75 ? 5 : p < .8 ? 6 : p < .85 ? 7 : p < .9 ? 8 : p < .95 ? 9 : 10;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
// A date the way a Genväg writes it: ISO 8601 (with or without an offset), "2026-10-19 18:30" or "19 okt. 2026 18:30"
export function whenOf(s) {
  s = String(s || "").trim();
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(s)) { const t = Date.parse(s); return isNaN(t) ? null : t; }
  const m = /^(\d{1,2})\s+([a-zåäö]{3})[a-zåäö]*\.?\s+(\d{4})(?:,?\s+(?:kl\.?\s*)?(\d{1,2})[:.](\d\d))?/i.exec(s);
  if (m && MON[m[2].toLowerCase()]) s = m[3] + "-" + String(MON[m[2].toLowerCase()]).padStart(2, "0") + "-" + m[1].padStart(2, "0") + (m[4] ? "T" + m[4].padStart(2, "0") + ":" + m[5] : "");
  const d = localToDate(s);
  return d ? +d : null;
}
// "45 min", "1:02:03", "2700 s", "0.75 h", or a bare number (minutes up to 360, else seconds) -> minutes
export function minutesOf(s) {
  s = String(s == null ? "" : s).trim().replace(",", ".");
  let m;
  if ((m = /^(\d+):(\d\d):(\d\d)$/.exec(s))) return +m[1] * 60 + +m[2] + +m[3] / 60;
  if ((m = /^(\d+):(\d\d)$/.exec(s))) return +m[1] + +m[2] / 60;
  if ((m = /^([\d.]+)\s*(s|sek|sec|seconds?|sekunder)$/i.exec(s))) return +m[1] / 60;
  if ((m = /^([\d.]+)\s*(h|tim|timmar|hr|hours?)$/i.exec(s))) return +m[1] * 60;
  if ((m = /^([\d.]+)\s*(m|min|minuter|minutes?)?$/i.exec(s))) return +m[1] > 360 ? +m[1] / 60 : +m[1];
  return NaN;
}
const num = v => { const n = Number(String(v == null ? "" : v).replace(",", ".").replace(/[^\d.]/g, "")); return isFinite(n) && n > 0 ? n : null; };

// The Genväg's body: JSON {workouts: [{type, start, end | min, hr, hrmax, kcal}], days: [{day, rhr, hrv, sleep}]} or
// text, one per line: "typ;start;slut[;puls;maxpuls;kcal]" and "dag;datum;vilopuls;hrv;sömn (timmar)"
export function parseImport(body) {
  const out = { workouts: [], days: [] };
  let j = null;
  if (typeof body === "string") { try { j = JSON.parse(body); } catch (e) { j = null; } } else j = body;
  if (j && typeof j === "object") {
    for (const w of [].concat(j.workouts || [])) if (w) out.workouts.push({ type: w.type, start: w.start, end: w.end, min: w.min != null ? w.min : w.duration, hr: w.hr, hrmax: w.hrmax, kcal: w.kcal });
    for (const d of [].concat(j.days || [], j.day ? [j.day] : [])) if (d) out.days.push(d);
    return out;
  }
  for (const line of String(body || "").split(/\r?\n/)) {
    const f = line.split(/[;|\t]/).map(x => x.trim());
    if (f.length < 3 || !f[0]) continue;
    if (/^(dag|day)$/i.test(f[0])) out.days.push({ day: f[1], rhr: f[2], hrv: f[3], sleep: f[4] });
    else out.workouts.push({ type: f[0], start: f[1], end: whenOf(f[2]) ? f[2] : null, min: whenOf(f[2]) ? null : f[2], hr: f[3], hrmax: f[4], kcal: f[5] });
  }
  return out;
}

// Workouts in a common form -> new sessions (those already imported are left), the days -> health_day
// w: [{ext, type, start (ms), min, hr, hrmax, kcal, rpe?}]
export async function importInto(env, user, pid, src, ws, days, t) {
  const mx = await env.DB.prepare("SELECT bpm FROM hrmax WHERE pid = ?").bind(pid).first(), pi = await env.DB.prepare("SELECT born FROM pinfo WHERE pid = ?").bind(pid).first();
  let max = mx ? mx.bpm : 0;
  const seen = Math.max(0, ...ws.map(w => w.hrmax >= 150 && w.hrmax <= 230 ? Math.round(w.hrmax) : 0));
  const st = [];
  if (seen > max) { max = seen; st.push(env.DB.prepare("INSERT OR REPLACE INTO hrmax (pid, bpm) VALUES (?, ?)").bind(pid, max)); }
  const have = new Set((await env.DB.prepare("SELECT ext FROM sess_ext WHERE pid = ? AND src = ?").bind(pid, src).all()).results.map(r => r.ext));
  let n = 0;
  for (const w of ws) {
    const mins = Math.round(w.min);
    if (!w.start || !(mins >= 5 && mins <= 360) || w.start < t - BACK || w.start > t + 36e5 || have.has(w.ext)) continue;
    have.add(w.ext);
    const kind = kindOf(w.type), est = !(w.rpe >= 1 && w.rpe <= 10), rpe = est ? rpeOf(kind, w.hr, Math.max(max, hrmaxByAge(pi && pi.born, t))) : Math.round(w.rpe), id = rid();
    const hr = w.hr >= 40 && w.hr <= 230 ? Math.round(w.hr) : null, kcal = w.kcal > 0 && w.kcal < 5000 ? Math.round(w.kcal) : null;
    st.push(env.DB.prepare("INSERT INTO sessions (id, org, pid, day, kind, min, rpe, note, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ORG, pid, dayOf(w.start), kind, mins, rpe, clean(w.type, 60) || null, user, t),
      env.DB.prepare("INSERT INTO sess_ext (session, pid, src, ext, hr, hrmax, kcal, est) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, pid, src, w.ext, hr, w.hrmax >= 60 && w.hrmax <= 240 ? Math.round(w.hrmax) : null, kcal, est ? 1 : 0));
    if (++n >= MAX_W) break;
  }
  let nd = 0;
  for (const d of days.slice(0, 14)) {
    const day = DAY_RE.test(String(d.day || "")) ? d.day : (whenOf(d.day) ? dayOf(whenOf(d.day)) : null);
    if (!day || day < dayOf(t - 60 * 864e5) || day > dayOf(t + 864e5)) continue;
    const rhr = num(d.rhr), hrv = num(d.hrv), sl = num(d.sleep);
    const v = [rhr >= 30 && rhr <= 120 ? Math.round(rhr) : null, hrv >= 5 && hrv <= 300 ? Math.round(hrv) : null, sl > 0 && sl <= 16 ? Math.round(sl * 10) / 10 : sl > 16 && sl <= 960 ? Math.round(sl / 6) / 10 : null];
    if (v.every(x => x === null)) continue;
    st.push(env.DB.prepare("INSERT INTO health_day (pid, day, rhr, hrv, sleep, src) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pid, day) DO UPDATE SET rhr = coalesce(excluded.rhr, rhr), hrv = coalesce(excluded.hrv, hrv), sleep = coalesce(excluded.sleep, sleep), src = excluded.src").bind(pid, day, ...v, src));
    nd++;
  }
  if (st.length) await env.DB.batch(st);
  return { added: n, days: nd };
}

// ---- Apple Hälsa (a Genväg) ----
// POST /hk/key {pid} -> {key} (once; a new one replaces the old); {pid, op: "off"} removes it
export async function hkKey(env, me, b, t) {
  const pid = Number(b && b.pid);
  if (!own(me, pid)) return { err: "forbidden", status: 403 };
  await env.DB.prepare("DELETE FROM hkeys WHERE pid = ? AND user = ?").bind(pid, me.id).run();
  if (b.op === "off") return { ok: true };
  const c = await consent(env, me, pid, b, t);
  if (c) return c;
  const key = B64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([env.DB.prepare("INSERT INTO hkeys (hash, user, pid, created, n) VALUES (?, ?, ?, ?, 0)").bind(await sha(key), me.id, pid, t), log(env, t, me.id, "hk-key", { pid })]);
  return { key };
}
// POST /hk/<key> (from the Genväg; no login, no Origin) -> {ok, added, days}
export async function hkImport(env, key, raw, t) {
  if (!KEY_RE.test(key || "")) return { err: "not found", status: 404 };
  const k = await env.DB.prepare("SELECT hash, user, pid FROM hkeys WHERE hash = ?").bind(await sha(key)).first();
  if (!k) return { err: "not found", status: 404 };
  const p = parseImport(raw), ws = [];
  for (const w of p.workouts) {
    const start = whenOf(w.start), end = whenOf(w.end);
    const min = end && start ? (end - start) / 6e4 : minutesOf(w.min);
    if (!start || !(min > 0)) continue;
    ws.push({ ext: new Date(Math.floor(start / 6e4) * 6e4).toISOString().slice(0, 16) + "|" + kindOf(w.type), type: w.type, start, min, hr: num(w.hr), hrmax: num(w.hrmax), kcal: num(w.kcal) });
  }
  if (!ws.length && !p.days.length) return { err: "nothing", status: 400 };
  const r = await importInto(env, k.user, k.pid, "apple", ws, p.days, t);
  await env.DB.prepare("UPDATE hkeys SET last = ?, n = n + ? WHERE hash = ?").bind(t, r.added, k.hash).run();
  return { ok: true, ...r };
}

// ---- Strava ----
const STRAVA = "https://www.strava.com";
export const stravaReady = env => !!(env.STRAVA_ID && env.STRAVA_SECRET);
// POST /strava/start {pid} -> {url} to send the browser to (the state lives 10 min in KV)
export async function stravaStart(env, me, b, base, t) {
  const pid = Number(b && b.pid);
  if (!stravaReady(env)) return { err: "off", status: 503 };
  if (!own(me, pid)) return { err: "forbidden", status: 403 };
  const c = await consent(env, me, pid, b, t);
  if (c) return c;
  const state = rid() + rid();
  await env.PUSH.put("sts:" + state, JSON.stringify({ user: me.id, pid }), { expirationTtl: 600 });
  return { url: STRAVA + "/oauth/mobile/authorize?" + new URLSearchParams({ client_id: env.STRAVA_ID, redirect_uri: base + "/strava/back", response_type: "code", approval_prompt: "auto", scope: "activity:read_all", state }) };
}
// GET /strava/back?code&state (Strava sends the browser here) -> where to send it on (the page's Träning)
export async function stravaBack(env, q, t) {
  const to = env.ORIGIN + "/#traning";
  const state = /^[0-9a-f]{32}$/.test(q.get("state") || "") ? q.get("state") : null, code = q.get("code");
  if (!state || !code || !stravaReady(env)) return to;
  const s = JSON.parse((await env.PUSH.get("sts:" + state)) || "null");
  await env.PUSH.delete("sts:" + state);
  if (!s || !/activity:read/.test(q.get("scope") || "")) return to;
  const r = await fetch(STRAVA + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env.STRAVA_ID, client_secret: env.STRAVA_SECRET, code, grant_type: "authorization_code" }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) return to;
  const d = await r.json();
  if (!d.access_token || !d.athlete) return to;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO strava (pid, user, athlete, name, access, refresh, exp, after, last, polled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)")
      .bind(s.pid, s.user, d.athlete.id, clean([d.athlete.firstname, d.athlete.lastname].filter(Boolean).join(" "), 60) || null, d.access_token, d.refresh_token, d.expires_at, Math.floor((t - 14 * 864e5) / 1000)),
    log(env, t, s.user, "strava", { pid: s.pid }),
  ]);
  try { await stravaPoll(env, await env.DB.prepare("SELECT * FROM strava WHERE pid = ?").bind(s.pid).first(), t, { left: 3 }); } catch (e) {}
  return to;
}
// POST /strava/off {pid}
export async function stravaOff(env, me, b) {
  const pid = Number(b && b.pid);
  if (!own(me, pid)) return { err: "forbidden", status: 403 };
  const row = await env.DB.prepare("SELECT access FROM strava WHERE pid = ?").bind(pid).first();
  if (row) try { await fetch(STRAVA + "/oauth/deauthorize", { method: "POST", headers: { Authorization: "Bearer " + row.access }, signal: AbortSignal.timeout(8000) }); } catch (e) {}
  await env.DB.prepare("DELETE FROM strava WHERE pid = ?").bind(pid).run();
  return { ok: true };
}
// One athlete's new activities (2-3 subrequests)
export async function stravaPoll(env, row, t, budget) {
  if (!row || budget.left < 2) return 0;
  let access = row.access;
  if (row.exp * 1000 < t + 60e3) {
    budget.left--;
    const r = await fetch(STRAVA + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env.STRAVA_ID, client_secret: env.STRAVA_SECRET, grant_type: "refresh_token", refresh_token: row.refresh }), signal: AbortSignal.timeout(10000) });
    if (r.status === 400 || r.status === 401) { await env.DB.prepare("DELETE FROM strava WHERE pid = ?").bind(row.pid).run(); return 0; }   // revoked on Strava
    if (!r.ok) throw new Error("strava token " + r.status);
    const d = await r.json();
    access = d.access_token;
    await env.DB.prepare("UPDATE strava SET access = ?, refresh = ?, exp = ? WHERE pid = ?").bind(d.access_token, d.refresh_token, d.expires_at, row.pid).run();
  }
  budget.left--;
  const r = await fetch(STRAVA + "/api/v3/athlete/activities?after=" + row.after + "&per_page=50", { headers: { Authorization: "Bearer " + access }, signal: AbortSignal.timeout(10000) });
  if (r.status === 401) { await env.DB.prepare("DELETE FROM strava WHERE pid = ?").bind(row.pid).run(); return 0; }
  if (!r.ok) throw new Error("strava activities " + r.status);
  const acts = await r.json(), ws = [];
  let after = row.after;
  for (const a of Array.isArray(acts) ? acts : []) {
    const start = Date.parse(a.start_date);
    if (isNaN(start)) continue;
    after = Math.max(after, Math.floor(start / 1000));
    ws.push({ ext: String(a.id), type: a.sport_type || a.type || a.name, start, min: (a.moving_time || a.elapsed_time || 0) / 60, hr: a.has_heartrate ? a.average_heartrate : null, hrmax: a.has_heartrate ? a.max_heartrate : null, kcal: a.calories || (a.kilojoules ? a.kilojoules / 4.184 : null), rpe: a.perceived_exertion });
  }
  const res = await importInto(env, row.user, row.pid, "strava", ws, [], t);
  await env.DB.prepare("UPDATE strava SET after = ?, polled = ?, last = CASE WHEN ? > 0 THEN ? ELSE last END WHERE pid = ?").bind(after, t, res.added, t, row.pid).run();
  return res.added;
}
// Cron (once an hour): the athletes polled longest ago, as far as the budget goes (a reserve left for the rest)
export async function stravaRun(env, t, budget) {
  if (!stravaReady(env) || !env.DB) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM strava WHERE polled < ? ORDER BY polled LIMIT 10").bind(t - 50 * 60e3).all()).results;
  let n = 0;
  for (const row of rows) {
    if (budget.left < 12) break;
    try { n += await stravaPoll(env, row, t, budget); } catch (e) { console.warn("strava", row.pid, e.message); await env.DB.prepare("UPDATE strava SET polled = ? WHERE pid = ?").bind(t, row.pid).run(); }
  }
  return n;
}

// GET /hk?pid= -> what is connected for the player (only the player or a parent)
export async function connOf(env, me, pid) {
  if (!own(me, pid)) return { err: "forbidden", status: 403 };
  const k = await env.DB.prepare("SELECT created, last, n FROM hkeys WHERE pid = ? AND user = ?").bind(pid, me.id).first();
  const s = await env.DB.prepare("SELECT name, last, polled FROM strava WHERE pid = ?").bind(pid).first();
  const c = await env.DB.prepare("SELECT parent, at FROM hconsent WHERE pid = ?").bind(pid).first(), pi = await env.DB.prepare("SELECT born FROM pinfo WHERE pid = ?").bind(pid).first();
  return { consent: c ? { parent: !!c.parent, at: c.at } : null, born: pi ? pi.born : null, apple: k ? { created: k.created, last: k.last, n: k.n } : null, strava: { ready: stravaReady(env), on: s ? { name: s.name, last: s.last, polled: s.polled } : null } };
}
