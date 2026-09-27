import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { tick } from "../src/index.js";
import { makeSubscription, makeVapid } from "./helpers.mjs";

const F = n => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const EV = [{ who: "thea", me: "Thea Holmberg Löving", cls: "Damer C", classId: 164681,
  activeFrom: "2026-09-27T08:00:00+02:00", activeTo: "2026-09-27T22:00:00+02:00" }];

function kv() {
  const m = new Map(), ops = { get: 0, put: 0, delete: 0, list: 0 };
  return { m, ops,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; m.set(k, v); },
    async delete(k) { ops.delete++; m.delete(k); },
    async list({ prefix }) { ops.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
// Fake network: RankedIn answers with the current fixture, push endpoints with their configured status.
function net(state) {
  const pushes = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("GetDrawsForStageAndStrengthAsync")) { state.rankedin++; return new Response(F(state.fixture)); }
    pushes.push({ url, init });
    return new Response(null, { status: state.status[url] || 201 });
  };
  return pushes;
}
async function subscribe(env, sub) {
  const res = await worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" },
    body: JSON.stringify({ subscription: sub, prefs: { thea: true, kian: true } }) }), env);
  return res;
}

test("inactive: returns at once, no KV and no fetch", async () => {
  const state = { fixture: "dc_1031.json", rankedin: 0, status: {} }, pushes = net(state), PUSH = kv();
  const r = await tick({ PUSH, NOW: "2026-09-28T10:00:00+02:00" }, EV);
  assert.deepEqual(r, { active: 0 });
  assert.deepEqual(PUSH.ops, { get: 0, put: 0, delete: 0, list: 0 });
  assert.equal(state.rankedin + pushes.length, 0);
});

test("baseline, no-change and change ticks; KV written only on change; 410 removes the subscription", async () => {
  const v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-09-27T12:00:00+02:00" };
  const a = await makeSubscription("https://fcm.googleapis.com/fcm/send/a"), gone = await makeSubscription("https://web.push.apple.com/gone");
  const state = { fixture: "dc_1031.json", rankedin: 0, status: { [gone.sub.endpoint]: 410 } }, pushes = net(state);

  assert.equal((await subscribe(env, a.sub)).status, 200);
  assert.equal((await subscribe(env, gone.sub)).status, 200);
  const puts = PUSH.ops.put;
  assert.equal((await subscribe(env, a.sub)).status, 200);
  assert.equal(PUSH.ops.put, puts, "re-subscribing the same device does not write");
  const bad = await subscribe(env, { ...a.sub, endpoint: "https://evil.example/x" });
  assert.equal(bad.status, 400, "only real push services");

  let r = await tick(env, EV);
  assert.deepEqual([r.writes, r.sent, pushes.length], [1, 0, 0], "first tick = baseline, silent");
  r = await tick(env, EV);
  assert.deepEqual([r.writes, r.sent, pushes.length], [0, 0, 0], "nothing changed: no KV write");

  state.fixture = "dc_1112.json";
  r = await tick(env, EV);
  assert.equal(r.writes, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.sent, 1);
  const toA = pushes.filter(p => p.url === a.sub.endpoint);
  const msgs = await Promise.all(toA.map(async p => JSON.parse(await a.decrypt(p.init.body))));
  assert.deepEqual(msgs.map(m => m.title), ["Thea och Cassandra möter Pettersson Österberg / Ekeland"]);
  assert.equal(pushes.filter(p => p.url === gone.sub.endpoint).length, 1, "stops after the 410");
  assert.equal([...PUSH.m.keys()].filter(k => k.startsWith("sub:")).length, 1);

  const before = PUSH.ops.put;
  r = await tick(env, EV);
  assert.deepEqual([r.writes, r.sent, PUSH.ops.put - before], [0, 0, 0]);
});

test("HTTP API: CORS, vapid, unsubscribe", async () => {
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st" };
  const call = (path, init = {}, origin = "https://padel.holmberg.st") => worker.fetch(new Request("https://w" + path, { ...init, headers: { Origin: origin } }), env);
  let res = await call("/vapid");
  assert.equal((await res.json()).key, v.VAPID_PUBLIC_KEY);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://padel.holmberg.st");
  res = await call("/vapid", {}, "http://localhost:8765");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:8765");
  res = await call("/vapid", {}, "https://evil.example");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await call("/health")).status, 200);
  const s = await makeSubscription("https://updates.push.services.mozilla.com/wpush/v2/x");
  await call("/subscribe", { method: "POST", body: JSON.stringify({ subscription: s.sub }) });
  assert.equal(PUSH.m.size, 1);
  await call("/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: s.sub.endpoint }) });
  assert.equal(PUSH.m.size, 0);
  assert.equal((await call("/subscribe", { method: "POST", body: "{" })).status, 400);
  assert.equal((await call("/nope")).status, 404);
});

test("free-plan subrequest budget: many devices, never more than 45 fetches", async () => {
  const v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-09-27T12:00:00+02:00" };
  const state = { fixture: "dc_1031.json", rankedin: 0, status: {} }, pushes = net(state);
  const devs = [];
  for (let i = 0; i < 60; i++) { const d = await makeSubscription("https://fcm.googleapis.com/fcm/send/d" + i); devs.push(d); await subscribe(env, d.sub); }
  await tick(env, EV);
  state.fixture = "dc_1112.json";
  const r = await tick(env, EV);
  assert.ok(state.rankedin + pushes.length <= 45 + 1, "fetches this tick: " + (pushes.length + 1));
  assert.equal(pushes.length, 44);
  const first = devs.find(d => d.sub.endpoint === pushes[0].url);
  const m = JSON.parse(await first.decrypt(pushes[0].init.body));
  assert.equal(m.title, "Thea och Cassandra möter Pettersson Österberg / Ekeland");
  assert.equal(r.sent, 44);
});

test("POST needs the site's Origin; /vapid lists the watched classes", async () => {
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st" };
  const s = await makeSubscription("https://fcm.googleapis.com/fcm/send/o");
  const res = await worker.fetch(new Request("https://w/subscribe", { method: "POST", body: JSON.stringify({ subscription: s.sub }) }), env);
  assert.equal(res.status, 403);
  const evil = await worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ subscription: s.sub }) }), env);
  assert.equal(evil.status, 403);
  assert.equal(PUSH.ops.put, 0);
  const vk = await (await worker.fetch(new Request("https://w/vapid"), env)).json();
  assert.ok(vk.classes.includes(164681) && vk.classes.includes(173729));
});

test("validation: non-https / foreign hosts / bad keys / oversized body rejected", async () => {
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st" };
  const post = body => worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" }, body }), env);
  const s = await makeSubscription("https://fcm.googleapis.com/fcm/send/v");
  for (const ep of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://evil.example/fcm.googleapis.com/x", "javascript:alert(1)"])
    assert.equal((await post(JSON.stringify({ subscription: { ...s.sub, endpoint: ep } }))).status, 400, ep);
  assert.equal((await post(JSON.stringify({ subscription: { ...s.sub, keys: { p256dh: "AAAA", auth: s.sub.keys.auth } } }))).status, 400);
  assert.equal((await post(JSON.stringify({ subscription: s.sub, pad: "x".repeat(5000) }))).status, 400);
  assert.equal(PUSH.ops.put, 0);
});

test("events.js: windows valid, offsets match Europe/Stockholm (CEST/CET) at that moment", async () => {
  const { EVENTS, activeEvents } = await import("../src/events.js");
  const off = d => { const p = new Intl.DateTimeFormat("en", { timeZone: "Europe/Stockholm", timeZoneName: "longOffset" }).formatToParts(d).find(x => x.type === "timeZoneName").value; return p.replace("GMT", ""); };
  for (const e of EVENTS) for (const t of [e.activeFrom, e.activeTo]) {
    assert.match(t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/, t);
    assert.equal(t.slice(-6), off(new Date(t)), e.cls + " " + t + " has the wrong UTC offset");
  }
  for (const e of EVENTS) assert.ok(new Date(e.activeTo) > new Date(e.activeFrom), e.cls);
  assert.deepEqual(activeEvents(new Date("2026-09-27T05:59:59Z")).map(e => e.cls), []);        // 07:59:59 CEST
  assert.deepEqual(activeEvents(new Date("2026-09-27T06:00:00Z")).map(e => e.cls), ["Damer C"]);  // 08:00 CEST
  assert.deepEqual(activeEvents(new Date("2026-10-11T21:00:01Z")).map(e => e.cls), []);        // 23:00:01 CEST
});
