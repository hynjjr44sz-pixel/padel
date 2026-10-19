import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";
import { kindOf, rpeOf, whenOf, minutesOf, parseImport, stravaRun, hrmaxByAge } from "../src/health.js";

const ORIGIN = "https://padel.holmberg.st";
const kv = () => { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; };
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
const bearer = t => ({ Authorization: "Bearer " + t });
// as a Genväg sends it: no Origin
const shortcut = (env, path, body) => worker.fetch(new Request("https://w" + path, { method: "POST", headers: { "Content-Type": "text/plain" }, body }), env);

test("hälsodata: parsing what a Genväg or a watch sends", () => {
  assert.equal(kindOf("Padel"), "padel"); assert.equal(kindOf("Paddle Sports"), "padel"); assert.equal(kindOf("Löpning"), "lop");
  assert.equal(kindOf("TrailRun"), "lop"); assert.equal(kindOf("Traditional Strength Training"), "gym"); assert.equal(kindOf("WeightTraining"), "gym");
  assert.equal(kindOf("Cykling"), "fys"); assert.equal(kindOf("Yoga"), "fys"); assert.equal(kindOf("Golf"), "annat");
  assert.equal(rpeOf("padel", 150, 200), 6); assert.equal(rpeOf("padel", 175, 200), 8); assert.equal(rpeOf("padel", null, 0), 6); assert.equal(rpeOf("fys", null, 0), 5);
  assert.equal(rpeOf("lop", 185, 0), 9);   // no max known: 195
  assert.equal(hrmaxByAge(2006, Date.parse("2026-10-19")), 194); assert.equal(hrmaxByAge(null, 0), 0);
  assert.equal(whenOf("2026-10-18T18:30:00+02:00"), Date.parse("2026-10-18T16:30:00Z"));
  assert.equal(whenOf("2026-10-18 18:30"), Date.parse("2026-10-18T16:30:00Z"));
  assert.equal(whenOf("18 okt. 2026 kl. 18:30"), Date.parse("2026-10-18T16:30:00Z"));
  assert.equal(whenOf("nonsense"), null);
  assert.equal(minutesOf("45 min"), 45); assert.equal(minutesOf("1:02:30"), 62.5); assert.equal(minutesOf("2700 s"), 45); assert.equal(minutesOf("2700"), 45); assert.equal(minutesOf("90"), 90); assert.equal(minutesOf("1,5 h"), 90);
  const p = parseImport("Padel;2026-10-18T18:30:00+02:00;2026-10-18T20:00:00+02:00;142;181;640\ndag;2026-10-19;52;61;7,5\n\nskräp");
  assert.equal(p.workouts.length, 1); assert.equal(p.workouts[0].end, "2026-10-18T20:00:00+02:00"); assert.deepEqual(p.days, [{ day: "2026-10-19", rhr: "52", hrv: "61", sleep: "7,5" }]);
  assert.equal(parseImport("Gym;2026-10-18 07:00;55 min").workouts[0].min, "55 min");
  assert.equal(parseImport(JSON.stringify({ workouts: [{ type: "Padel", start: "x", min: 60 }] })).workouts[0].min, 60);
});

test("hälsodata: an Apple Hälsa link; workouts in once, estimated RPE changed, the days, Strava off without secrets", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const acct = async (body) => { const a = await (await call(env, "POST", "/admin", { op: "add", ...body }, ak)).json(); return { id: a.id, tok: (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token }; };
  const thea = await acct({ pid: 1675246 }), kian = await acct({ pid: 1680004 }), javier = await acct({ name: "Javier Castilla", roles: ["tranare"] });
  await call(env, "POST", "/admin", { op: "coach", id: javier.id, pids: [1675246] }, ak);
  // only the player (or a parent) makes a link: not another player, not the coach
  assert.equal((await call(env, "POST", "/hk/key", { pid: 1675246 }, bearer(kian.tok))).status, 403);
  assert.equal((await call(env, "POST", "/hk/key", { pid: 1675246 }, bearer(javier.tok))).status, 403);
  // the consent first; Thea born 2015 (under 13): only a parent may give it
  assert.deepEqual(await (await call(env, "POST", "/hk/key", { pid: 1675246 }, bearer(thea.tok))).json(), { error: "consent" });
  assert.equal((await call(env, "POST", "/hk/profile", { pid: 1675246, born: 2030 }, bearer(thea.tok))).status, 400);
  assert.equal((await call(env, "POST", "/hk/profile", { pid: 1675246, born: 2015 }, bearer(javier.tok))).status, 403);
  assert.equal((await call(env, "POST", "/hk/profile", { pid: 1675246, born: 2015 }, bearer(thea.tok))).status, 200);
  assert.equal((await call(env, "POST", "/hk/key", { pid: 1675246, consent: true }, bearer(thea.tok))).status, 403);
  await call(env, "POST", "/hk/profile", { pid: 1675246, born: 2006 }, bearer(thea.tok));   // 20: she may herself
  const { key } = await (await call(env, "POST", "/hk/key", { pid: 1675246, consent: true }, bearer(thea.tok))).json();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM hkeys WHERE hash = ?").get(key).n, 0);   // only the hash is kept
  assert.equal((await shortcut(env, "/hk/" + "x".repeat(43), "Padel;2026-10-18 18:30;60")).status, 404);
  const body = "Padel;2026-10-18T18:30:00+02:00;2026-10-18T20:00:00+02:00;160;190;700\nTraditional Strength Training;2026-10-17 07:00;45 min\nGång;2026-10-17 12:00;3 min\nLöpning;2026-08-01 07:00;30\ndag;2026-10-19;52;61;7,5";
  let r = await (await shortcut(env, "/hk/" + key, body)).json();
  assert.deepEqual(r, { ok: true, added: 2, days: 1 });   // too short and too old left out
  r = await (await shortcut(env, "/hk/" + key, body)).json();
  assert.equal(r.added, 0);                                 // the same again: nothing twice
  const g = await (await call(env, "GET", "/train?pid=1675246", null, bearer(javier.tok))).json();   // the coach sees them
  assert.deepEqual(g.sessions.map(x => [x.day, x.kind, x.min, x.rpe, x.src, x.hr, x.est]), [["2026-10-18", "padel", 90, 7, "apple", 160, 1], ["2026-10-17", "gym", 45, 6, "apple", null, 1]]);
  assert.deepEqual(g.days, [{ day: "2026-10-19", rhr: 52, hrv: 61, sleep: 7.5 }]);
  assert.deepEqual([g.born, g.hrmax], [2006, 190]);
  // the player sets how hard it was
  assert.equal((await call(env, "POST", "/train", { op: "rpe", id: g.sessions[0].id, rpe: 8 }, bearer(kian.tok))).status, 403);
  assert.equal((await call(env, "POST", "/train", { op: "rpe", id: g.sessions[0].id, rpe: 8 }, bearer(thea.tok))).status, 200);
  const s0 = (await (await call(env, "GET", "/train?pid=1675246", null, bearer(thea.tok))).json()).sessions[0];
  assert.deepEqual([s0.rpe, s0.est], [8, 0]);
  // a deleted import does not come back with the next sync
  await call(env, "POST", "/train", { op: "del", id: s0.id }, bearer(thea.tok));
  assert.equal((await (await shortcut(env, "/hk/" + key, body)).json()).added, 0);
  // JSON works too; what is connected
  r = await (await shortcut(env, "/hk/" + key, JSON.stringify({ workouts: [{ type: "Padel", start: "2026-10-19T08:00:00+02:00", min: 60, hr: 150 }] }))).json();
  assert.equal(r.added, 1);
  const c = await (await call(env, "GET", "/hk?pid=1675246", null, bearer(thea.tok))).json();
  assert.equal(c.apple.n, 3); assert.deepEqual(c.strava, { ready: false, on: null }); assert.equal(c.consent.parent, false); assert.equal(c.born, 2006);
  assert.equal((await call(env, "GET", "/hk?pid=1675246", null, bearer(javier.tok))).status, 403);
  assert.equal((await call(env, "POST", "/strava/start", { pid: 1675246 }, bearer(thea.tok))).status, 503);
  // a new link replaces the old; off removes it
  const k2 = (await (await call(env, "POST", "/hk/key", { pid: 1675246 }, bearer(thea.tok))).json()).key;
  assert.equal((await shortcut(env, "/hk/" + key, body)).status, 404);
  assert.equal((await call(env, "POST", "/hk/key", { pid: 1675246, op: "off" }, bearer(thea.tok))).status, 200);
  assert.equal((await shortcut(env, "/hk/" + k2, body)).status, 404);
  // the consent taken back: the health data gone, a new connection asks again
  assert.equal((await call(env, "POST", "/hk/profile", { pid: 1675246, op: "revoke" }, bearer(thea.tok))).status, 200);
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM health_day").get().n, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM sess_ext WHERE hr IS NOT NULL").get().n, 0);
  assert.equal((await call(env, "POST", "/hk/key", { pid: 1675246 }, bearer(thea.tok))).status, 400);
  // clearing the history takes the watch data too
  await call(env, "POST", "/train/clear", { pid: 1675246 }, bearer(thea.tok));
  assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM health_day").get().n + env.DB.db.prepare("SELECT count(*) AS n FROM sess_ext").get().n, 0);
});

test("hälsodata: Strava connect, the activities read, a refreshed token, off", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32), STRAVA_ID: "123", STRAVA_SECRET: "s".repeat(40) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const a = await (await call(env, "POST", "/admin", { op: "add", pid: 1675246 }, ak)).json(), tok = (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token;
  assert.equal((await call(env, "POST", "/strava/start", { pid: 1675246 }, bearer(tok))).status, 400);   // the consent first
  const st = await (await call(env, "POST", "/strava/start", { pid: 1675246, consent: true }, bearer(tok))).json();
  const u = new URL(st.url), state = u.searchParams.get("state");
  assert.equal(u.searchParams.get("redirect_uri"), "https://w/strava/back"); assert.equal(u.searchParams.get("scope"), "activity:read_all");
  const real = globalThis.fetch, seen = [];
  const acts = [{ id: 9, sport_type: "Padel", start_date: "2026-10-18T16:00:00Z", moving_time: 5400, has_heartrate: true, average_heartrate: 150, max_heartrate: 188 },
    { id: 10, sport_type: "Run", start_date: "2026-10-17T05:00:00Z", moving_time: 1800, has_heartrate: false, perceived_exertion: 7 }];
  globalThis.fetch = async (url, o) => {
    seen.push(String(url) + " " + ((o && o.body) || ""));
    if (/oauth\/token/.test(url)) return Response.json(/refresh_token/.test(o.body) && /grant_type":"refresh/.test(o.body) ? { access_token: "A2", refresh_token: "R2", expires_at: 1792000000 } : { access_token: "A1", refresh_token: "R1", expires_at: Date.parse("2026-10-19T09:00:00Z") / 1000, athlete: { id: 77, firstname: "Thea", lastname: "H" } });
    if (/athlete\/activities/.test(url)) return Response.json(seen.filter(x => /activities/.test(x)).length > 1 ? [] : acts);
    return new Response("{}");
  };
  try {
    // a wrong state or a refused scope: nothing stored
    let res = await worker.fetch(new Request("https://w/strava/back?state=" + "0".repeat(32) + "&code=c&scope=read,activity:read_all"), env);
    assert.equal(res.status, 302); assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM strava").get().n, 0);
    res = await worker.fetch(new Request("https://w/strava/back?state=" + state + "&code=c&scope=read,activity:read_all"), env);
    assert.equal(res.headers.get("Location"), ORIGIN + "/#traning");
    assert.equal(env.PUSH.m.has("sts:" + state), false);
    // the token had expired already: refreshed, then the activities
    const g = await (await call(env, "GET", "/train?pid=1675246", null, bearer(tok))).json();
    assert.deepEqual(g.sessions.map(x => [x.day, x.kind, x.min, x.rpe, x.est, x.src]), [["2026-10-18", "padel", 90, 6, 1, "strava"], ["2026-10-17", "lop", 30, 7, 0, "strava"]]);
    assert.ok(seen.some(x => /grant_type":"refresh_token/.test(x)));
    const c = await (await call(env, "GET", "/hk?pid=1675246", null, bearer(tok))).json();
    assert.equal(c.strava.on.name, "Thea H");
    // the cron an hour later: polled again, nothing new
    env.NOW = "2026-10-19T11:23:00Z";
    assert.equal(await stravaRun(env, Date.parse(env.NOW), { left: 45 }), 0);
    assert.equal(env.DB.db.prepare("SELECT access FROM strava").get().access, "A2");
    assert.equal((await call(env, "POST", "/strava/off", { pid: 1675246 }, bearer(tok))).status, 200);
    assert.ok(seen.some(x => /deauthorize/.test(x)));
    assert.equal(env.DB.db.prepare("SELECT count(*) AS n FROM strava").get().n, 0);
  } finally { globalThis.fetch = real; }
});
