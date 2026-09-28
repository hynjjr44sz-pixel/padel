// Push fan-out: the tick hands its pushes to its own worker (service binding SELF, POST /fanout with FANOUT_KEY), which
// splits them into batches for further calls; what does not fit waits in KV "outbox" and goes first on the next tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { tick, _resetMemory } from "../src/index.js";
import { makeSubscription, makeVapid, kv } from "./helpers.mjs";

const F = n => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const EV = [{ who: "thea", me: "Thea Holmberg Löving", cls: "Damer C", classId: 164681,
  activeFrom: "2026-09-27T08:00:00+02:00", activeTo: "2026-09-27T22:00:00+02:00" }];

// One key pair for every fake device (encryption only needs a valid point); endpoints differ.
const ONE = await makeSubscription("https://fcm.googleapis.com/fcm/send/x");
function seed(PUSH, n, follow = [1675246]) {
  for (let i = 0; i < n; i++) {
    const rec = JSON.stringify({ sub: { endpoint: "https://fcm.googleapis.com/fcm/send/d" + i, keys: ONE.sub.keys }, prefs: { follow } });
    PUSH.m.set("sub:" + String(i).padStart(6, "0"), rec); PUSH.meta.set("sub:" + String(i).padStart(6, "0"), { r: rec });
  }
}
// Network: RankedIn draws (fixture) and push services (status per endpoint, else 201). Every push is recorded.
function net(state) {
  const pushes = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("GetDrawsForStageAndStrengthAsync")) { state.rankedin++; return new Response(F(state.fixture)); }
    pushes.push(url);
    return new Response(null, { status: state.status[url] || 201 });
  };
  return pushes;
}
// SELF: the same worker, a fresh "invocation" per call (own count of pushes), same KV.
function self(env, calls, fail = () => false) {
  return { async fetch(req) {
    const body = JSON.parse(await req.clone().text());
    const c = { key: req.headers.get("X-Fanout-Key"), depth: body.depth, jobs: body.jobs.length, pushes: body.jobs.reduce((n, j) => n + j.m.length, 0) };
    calls.push(c);
    if (fail(c, calls)) return new Response("{}", { status: 500 });
    return worker.fetch(req, env);
  } };
}

test("1200 devices: every one gets exactly one push via SELF batches, over three ticks with the outbox; 410s removed", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv(), calls = [];
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-09-27T12:00:00+02:00", FANOUT_KEY: "s3cret" };
  env.SELF = self(env, calls);
  seed(PUSH, 1200);
  seed.gone = ["https://fcm.googleapis.com/fcm/send/d7", "https://fcm.googleapis.com/fcm/send/d1100"];
  const state = { fixture: "dc_1031.json", rankedin: 0, status: Object.fromEntries(seed.gone.map(u => [u, 410])) }, pushes = net(state);
  await tick(env, EV);   // baseline
  assert.equal(calls.length, 0, "no messages, empty outbox: no fan-out call");
  state.fixture = "dc_1112.json";
  let r = await tick(env, EV);
  const top = calls.filter(c => c.depth === 0), leaves = calls.filter(c => c.depth === 1);
  assert.equal(top.length, 1, "the tick makes one call (one subrequest)");
  assert.equal(leaves.length, 29, "the dispatcher: 29 batches (32 invocations per request)");
  assert.ok(calls.every(c => c.key === "s3cret"), "every call carries the secret");
  assert.ok(leaves.every(c => c.pushes <= 20), "batches of at most 20 pushes");
  assert.deepEqual([r.sent + r.removed, r.queued], [580, 620]);
  assert.equal(JSON.parse(PUSH.m.get("outbox")).jobs.length, 620);
  assert.ok(r.writes >= 2, "class state (+relay) and the outbox");
  const puts = PUSH.ops.put;
  r = await tick(env, EV);   // no new results: the outbox drains first
  assert.deepEqual([r.sent + r.removed, r.queued, r.drained], [580, 40, 620]);
  r = await tick(env, EV);
  assert.deepEqual([r.sent + r.removed, r.queued || 0], [40, 0]);
  assert.ok(!PUSH.m.has("outbox"), "outbox deleted when empty");
  assert.equal(PUSH.ops.put - puts, 1, "outbox written only when it changed (620 -> 40), then deleted");
  assert.equal(pushes.length, 1200);
  assert.equal(new Set(pushes).size, 1200, "every device exactly once");
  assert.ok(seed.gone.every(u => !PUSH.m.has("sub:" + String(+u.split("/d").pop()).padStart(6, "0"))), "410: subscriptions removed");
  assert.equal([...PUSH.m.keys()].filter(k => k.startsWith("sub:")).length, 1198);
  const before = calls.length;
  r = await tick(env, EV);
  assert.equal(calls.length, before, "nothing to send: no call");
  assert.equal(PUSH.ops.list > 0 && PUSH.ops.get < 200, true, "devices read with KV list (metadata), not a get each: " + PUSH.ops.get);
});

test("a batch that fails goes to the outbox and out on the next tick; the tick's own call failing keeps everything", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv(), calls = [];
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-09-27T12:00:00+02:00", FANOUT_KEY: "k" };
  let failNext = true;
  env.SELF = self(env, calls, c => { if (c.depth === 1 && failNext) { failNext = false; return true; } return false; });
  seed(PUSH, 100);
  const state = { fixture: "dc_1031.json", rankedin: 0, status: {} }, pushes = net(state);
  await tick(env, EV);
  state.fixture = "dc_1112.json";
  let r = await tick(env, EV);
  assert.deepEqual([r.sent, r.queued, r.childFailed], [80, 20, 1]);
  r = await tick(env, EV);
  assert.deepEqual([r.sent, r.queued || 0], [20, 0]);
  assert.equal(new Set(pushes).size, 100);
  assert.equal(pushes.length, 100);
  // Dispatcher down: nothing is lost, everything waits.
  _resetMemory();
  const P2 = kv(), c2 = [], env2 = { ...env, PUSH: P2, SELF: { fetch: async req => { c2.push(1); return new Response("x", { status: 503 }); } } };
  seed(P2, 30);
  state.fixture = "dc_1031.json";
  await tick(env2, EV);
  state.fixture = "dc_1112.json";
  r = await tick(env2, EV);
  assert.deepEqual([r.sent || 0, r.queued, r.fanoutFailed], [0, 30, 1]);
  assert.ok(P2.m.has("st:164681"), "state written: the messages are in the outbox");
});

test("POST /fanout: only with the secret; public calls are refused", async () => {
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st", FANOUT_KEY: "k" };
  const job = { n: "sub:x", s: ONE.sub, m: [{ title: "x", body: "y", tag: "t" }] };
  const post = (h, e = env) => worker.fetch(new Request("https://w/fanout", { method: "POST", headers: h, body: JSON.stringify({ jobs: [job] }) }), e);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ "X-Fanout-Key": "nope", Origin: "https://padel.holmberg.st" })).status, 403);
  assert.equal((await post({ "X-Fanout-Key": "k" }, { ...env, FANOUT_KEY: undefined })).status, 403, "off without the secret");
  assert.equal((await worker.fetch(new Request("https://w/fanout", { headers: { "X-Fanout-Key": "k" } }), env)).status, 403, "POST only");
  const sent = [];
  globalThis.fetch = async url => { sent.push(String(url)); return new Response(null, { status: 201 }); };
  const r = await post({ "X-Fanout-Key": "k" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sent: 1, removed: 0, gone: [], rest: [], used: 1 });
  // Never an open relay: a job for a host that is not a push service is not sent.
  const r2 = await worker.fetch(new Request("https://w/fanout", { method: "POST", headers: { "X-Fanout-Key": "k" },
    body: JSON.stringify({ jobs: [{ ...job, s: { ...ONE.sub, endpoint: "https://evil.example/x" } }] }) }), env);
  assert.equal((await r2.json()).sent, 0);
  assert.deepEqual(sent, [ONE.sub.endpoint]);
});

test("without SELF (legacy, in-process): what does not fit the subrequest budget waits in the outbox", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-09-27T12:00:00+02:00" };
  seed(PUSH, 60);
  const state = { fixture: "dc_1031.json", rankedin: 0, status: {} }, pushes = net(state);
  await tick(env, EV);
  state.fixture = "dc_1112.json";
  let r = await tick(env, EV);
  assert.deepEqual([r.sent, r.queued], [44, 16]);
  r = await tick(env, EV);
  assert.deepEqual([r.sent, r.queued || 0], [16, 0]);
  assert.equal(new Set(pushes).size, 60);
  // Outbox entries older than an hour (the push TTL) are dropped.
  PUSH.m.set("outbox", JSON.stringify({ at: "x", jobs: [{ n: "sub:000001", s: ONE.sub, m: [{ title: "old", tag: "t" }], q: Date.parse("2026-09-27T10:30:00+02:00") }] }));
  const n = pushes.length;
  r = await tick(env, EV);
  assert.equal(pushes.length, n);
  assert.ok(!PUSH.m.has("outbox"));
});

test("subscribe stores the record as KV metadata; an old record without it is rewritten once", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st" };
  const s = await makeSubscription("https://fcm.googleapis.com/fcm/send/meta");
  const sub = () => worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" }, body: JSON.stringify({ subscription: s.sub, prefs: { follow: [1675246] } }) }), env);
  assert.equal((await sub()).status, 200);
  const [k] = [...PUSH.m.keys()];
  assert.equal(PUSH.meta.get(k).r, PUSH.m.get(k));
  const p0 = PUSH.ops.put;
  await sub();
  assert.equal(PUSH.ops.put, p0, "unchanged: no write");
  PUSH.meta.delete(k);   // stored before the metadata existed
  await sub();
  assert.equal(PUSH.ops.put, p0 + 1);
  assert.equal(PUSH.meta.get(k).r, PUSH.m.get(k));
});

test("subscribe: lang \"es\" is kept in prefs; without it (or any other value) the record is exactly as before; a change is written", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st" };
  const s = await makeSubscription("https://fcm.googleapis.com/fcm/send/lang");
  const sub = prefs => worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" }, body: JSON.stringify({ subscription: s.sub, prefs }) }), env);
  const plain = JSON.stringify({ sub: s.sub, prefs: { follow: [1675246] } });
  assert.equal((await sub({ follow: [1675246] })).status, 200);
  const [k] = [...PUSH.m.keys()];
  assert.equal(PUSH.m.get(k), plain, "no lang: the record as before");
  let p0 = PUSH.ops.put;
  for (const lang of ["sv", "fr", 1, null]) await sub({ follow: [1675246], lang });
  assert.equal(PUSH.ops.put, p0, "sv or anything that is not es: Swedish, same record, no write");
  await sub({ follow: [1675246], lang: "es" });
  assert.equal(PUSH.ops.put, p0 + 1, "lang changed: one write");
  assert.deepEqual(JSON.parse(PUSH.m.get(k)).prefs, { follow: [1675246], lang: "es" });
  assert.equal(PUSH.meta.get(k).r, PUSH.m.get(k), "kept as metadata too");
  p0 = PUSH.ops.put;
  await sub({ follow: [1675246], lang: "es" });
  assert.equal(PUSH.ops.put, p0, "same again: no write");
  await sub({ follow: [1675246] });
  assert.equal(PUSH.m.get(k), plain, "back to Swedish: the plain record again");
});

test("subscribe: a record near 1000 chars (escaped quotes push the metadata past KV's 1024 bytes) is stored without metadata", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st" };
  const base = await makeSubscription("https://wns2-db5p.notify.windows.com/w/?token=x");
  const ns = [700]; for (let n = 740; n <= 800; n += 2) ns.push(n); ns.push(900);
  for (const n of ns) {
    const s = { ...base.sub, endpoint: "https://wns2-db5p.notify.windows.com/w/?token=" + "A".repeat(n) };
    const res = await worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" }, body: JSON.stringify({ subscription: s, prefs: { follow: [1675246] } }) }), env);
    assert.equal(res.status, 200, "endpoint " + n);
  }
  const recs = [...PUSH.m.entries()].filter(([k]) => k.startsWith("sub:"));
  assert.equal(recs.length, ns.length);
  assert.ok(recs.some(([k]) => !PUSH.meta.has(k)) && recs.some(([k]) => PUSH.meta.has(k)), "the biggest without metadata, the rest with");
  const l = await PUSH.list({ prefix: "sub:" });
  assert.equal(l.keys.length, ns.length);
});

test("POST /fanout: a negative depth from the caller cannot make a batch call on (no recursion)", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv(), calls = [];
  const env = { PUSH, ...v, ORIGIN: "https://padel.holmberg.st", FANOUT_KEY: "k", FANOUT_BATCH: "1" };
  env.SELF = self(env, calls);
  globalThis.fetch = async () => new Response(null, { status: 201 });
  const jobs = [0, 1, 2].map(i => ({ n: "sub:" + i, s: { ...ONE.sub, endpoint: ONE.sub.endpoint + i }, m: [{ title: "x", tag: "t" }], q: 1 }));
  const r = await worker.fetch(new Request("https://w/fanout", { method: "POST", headers: { "X-Fanout-Key": "k" }, body: JSON.stringify({ jobs, depth: -5 }) }), env);
  assert.equal((await r.json()).sent, 3);
  assert.deepEqual(calls.map(c => c.depth), [1, 1, 1], "one level of batches, each sends itself");
});

test("the tick's fan-out call refused (4xx, e.g. a secret mismatch): sent in-process instead of waiting in the outbox", async () => {
  _resetMemory();
  const v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-09-27T12:00:00+02:00", FANOUT_KEY: "k",
    SELF: { fetch: async () => new Response("{}", { status: 403 }) } };
  seed(PUSH, 10);
  const state = { fixture: "dc_1031.json", rankedin: 0, status: {} }, pushes = net(state);
  await tick(env, EV);
  state.fixture = "dc_1112.json";
  const r = await tick(env, EV);
  assert.deepEqual([r.sent, r.queued || 0, r.fanoutFailed], [10, 0, 1]);
  assert.equal(new Set(pushes).size, 10);
});
