import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";

const ORIGIN = "https://padel.holmberg.st";
const kv = () => { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; };
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
const B = t => ({ Authorization: "Bearer " + t });

test("akademin: the coach's page and shown groups (no names), interest from anyone to the coach only", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const acct = async body => { const a = await (await call(env, "POST", "/admin", { op: "add", ...body }, ak)).json(); return { id: a.id, tok: (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token }; };
  const javier = await acct({ name: "Javier Castilla", roles: ["tranare"] }), adm = await acct({ name: "Admin", roles: ["admin"] });
  const g1 = await (await call(env, "POST", "/coach", { op: "group", name: "Damlaget onsdagar", pids: [1675246, 1849853] }, B(javier.tok))).json();
  const g2 = await (await call(env, "POST", "/coach", { op: "group", name: "Privat grupp", pids: [1680004] }, B(javier.tok))).json();
  assert.deepEqual(await (await call(env, "GET", "/academy")).json(), { intro: null, ptext: null, pprice: null, groups: [] });
  assert.equal((await call(env, "POST", "/academy", { op: "page", intro: "x" }, B(adm.tok))).status, 403);
  await call(env, "POST", "/academy", { op: "page", intro: "Nynäs padelakademi", ptext: "Privatlektion 60 min", pprice: "650 kr" }, B(javier.tok));
  assert.equal((await call(env, "POST", "/academy", { op: "group", gid: g1.id, shown: true, max: 200 }, B(javier.tok))).status, 400);
  await call(env, "POST", "/academy", { op: "group", gid: g1.id, shown: true, level: "C-nivå", sched: "Onsdagar 19:00", max: 8, price: "1 200 kr/termin", info: "Teknik och spel" }, B(javier.tok));
  const pub = await (await call(env, "GET", "/academy")).json();
  assert.deepEqual(pub, { intro: "Nynäs padelakademi", ptext: "Privatlektion 60 min", pprice: "650 kr",
    groups: [{ id: g1.id, name: "Damlaget onsdagar", shown: true, level: "C-nivå", sched: "Onsdagar 19:00", max: 8, price: "1 200 kr/termin", info: "Teknik och spel", n: 2, dow: null, time: null, min: null, open: false }] });
  assert.ok(!JSON.stringify(pub).includes("1675246"));   // no players
  // the coach sees the group not shown too
  assert.deepEqual((await (await call(env, "GET", "/academy", null, B(javier.tok))).json()).groups.map(g => [g.name, g.shown, g.mine]), [["Damlaget onsdagar", true, true], ["Privat grupp", false, true]]);
  // interest: a group shown, private lessons; not a hidden group; the coach gets a notis (not the admin)
  const ep = "https://push.example/jav", h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ep))), key = "sub:" + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.PUSH.put(key, JSON.stringify({ sub: { endpoint: ep } }));
  await call(env, "POST", "/me/push", { endpoint: ep }, B(javier.tok));
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "grupp", gid: g2.id, name: "Lisa", contact: "070-1234567" })).status, 400);
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "grupp", gid: g1.id, name: "Lisa", contact: "x" })).status, 400);
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "grupp", gid: g1.id, name: "Lisa Berg", contact: "070-1234567", age: "34, C-nivå", msg: "Kan börja direkt" })).status, 200);
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "privat", name: "Per", contact: "per@example.se" })).status, 200);
  const q = JSON.parse(env.PUSH.m.get("amx:pend"));
  assert.deepEqual(q.map(x => [x.subs, x.m.title]), [[[key], "Intresse: Damlaget onsdagar"], [[key], "Intresse: privatlektion"]]);
  assert.equal((await call(env, "GET", "/academy/interest", null, B(adm.tok))).status, 403);
  let l = (await (await call(env, "GET", "/academy/interest", null, B(javier.tok))).json()).list;
  assert.deepEqual(l.map(x => [x.kind, x.gname, x.name, x.status]).sort(), [["grupp", "Damlaget onsdagar", "Lisa Berg", "ny"], ["privat", null, "Per", "ny"]]);
  await call(env, "POST", "/academy/interest/mark", { id: l.find(x => x.name === "Per").id, status: "kontaktad" }, B(javier.tok));
  l = (await (await call(env, "GET", "/academy/interest", null, B(javier.tok))).json()).list;
  assert.equal(l.find(x => x.name === "Per").status, "kontaktad");
  // spam: at most 5 a day from one network
  for (let i = 0; i < 3; i++) await call(env, "POST", "/academy/interest", { kind: "privat", name: "S" + i, contact: "070-000000" + i });
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "privat", name: "S9", contact: "070-0000009" })).status, 429);
  // hidden again: off the public page
  await call(env, "POST", "/academy", { op: "group", gid: g1.id, shown: false }, B(javier.tok));
  assert.deepEqual((await (await call(env, "GET", "/academy")).json()).groups, []);
});

test("akademin, avgifter: the player says swishat or MATCHi, the coach marks betald or gratis; a new term", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const acct = async body => { const a = await (await call(env, "POST", "/admin", { op: "add", ...body }, ak)).json(); return { id: a.id, tok: (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token }; };
  const javier = await acct({ name: "Javier Castilla", roles: ["tranare"] }), thea = await acct({ pid: 1675246 }), kian = await acct({ pid: 1680004 });
  const g = await (await call(env, "POST", "/coach", { op: "group", name: "Damlaget", pids: [1675246, 1849853] }, B(javier.tok))).json();
  assert.deepEqual((await (await call(env, "GET", "/pay?pid=1675246", null, B(thea.tok))).json()).fees, []);   // no price yet
  await call(env, "POST", "/academy", { op: "group", gid: g.id, shown: true, price: "1 200 kr/termin" }, B(javier.tok));
  assert.equal((await call(env, "POST", "/pay", { op: "swish", swish: "123 456 78 90" }, B(thea.tok))).status, 403);
  assert.equal((await call(env, "POST", "/pay", { op: "swish", swish: "123 456 78 90" }, B(javier.tok))).status, 200);
  let f = await (await call(env, "GET", "/pay?pid=1675246", null, B(thea.tok))).json();
  assert.deepEqual([f.swish, f.fees], ["1234567890", [{ gid: g.id, gname: "Damlaget", price: "1 200 kr/termin", amount: 1200, status: "obetald" }]]);
  assert.equal((await call(env, "GET", "/pay?pid=1675246", null, B(kian.tok))).status, 403);
  // Thea: swishat; she may not mark it paid herself; Kian may not touch hers
  assert.equal((await call(env, "POST", "/pay", { gid: g.id, pid: 1675246, status: "betald" }, B(thea.tok))).status, 400);
  assert.equal((await call(env, "POST", "/pay", { gid: g.id, pid: 1675246, status: "swishad" }, B(kian.tok))).status, 403);
  assert.equal((await call(env, "POST", "/pay", { gid: g.id, pid: 1675246, status: "swishad" }, B(thea.tok))).status, 200);
  assert.equal(JSON.parse(env.PUSH.m.get("amx:pend") || "[]").length, 0);   // Javier has no phone linked: nothing queued
  // the coach: the group's list, Thea paid, Cassandra free (a school pupil)
  let c = await (await call(env, "GET", "/pay?gid=" + g.id, null, B(javier.tok))).json();
  assert.deepEqual(c.fees.map(x => [x.pid, x.status]).sort(), [[1675246, "swishad"], [1849853, "obetald"]]);
  assert.equal((await call(env, "GET", "/pay?gid=" + g.id, null, B(thea.tok))).status, 403);
  await call(env, "POST", "/pay", { gid: g.id, pid: 1675246, status: "betald" }, B(javier.tok));
  await call(env, "POST", "/pay", { gid: g.id, pid: 1849853, status: "gratis" }, B(javier.tok));
  assert.equal((await call(env, "POST", "/pay", { gid: g.id, pid: 1675246, status: "matchi" }, B(thea.tok))).status, 400);   // settled
  // a new term: paid ones back to not paid, free ones stay
  await call(env, "POST", "/pay", { gid: g.id, op: "reset" }, B(javier.tok));
  c = await (await call(env, "GET", "/pay?gid=" + g.id, null, B(javier.tok))).json();
  assert.deepEqual(c.fees.map(x => [x.pid, x.status]).sort(), [[1675246, "obetald"], [1849853, "gratis"]]);
});

test("akademin: a group's fixed slot, open for sign-ups; a logged-in player signs up, the coach adds them with one tap", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const acct = async body => { const a = await (await call(env, "POST", "/admin", { op: "add", ...body }, ak)).json(); return { id: a.id, tok: (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token }; };
  const javier = await acct({ name: "Javier Castilla", roles: ["tranare"] }), kian = await acct({ pid: 1680004 });
  const g = await (await call(env, "POST", "/coach", { op: "group", name: "Juniorer", pids: [1675246] }, B(javier.tok))).json();
  assert.equal((await call(env, "POST", "/academy", { op: "group", gid: g.id, shown: true, dow: 9 }, B(javier.tok))).status, 400);
  await call(env, "POST", "/academy", { op: "group", gid: g.id, shown: true, dow: 6, time: "10:00", min: 90, max: 8, price: "900 kr" }, B(javier.tok));
  let a = (await (await call(env, "GET", "/academy")).json()).groups[0];
  assert.deepEqual([a.sched, a.dow, a.time, a.min, a.open], ["Lördagar 10:00–11:30", 6, "10:00", 90, false]);
  // not open: no sign-up
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "anmalan", gid: g.id, pid: 1680004 }, B(kian.tok))).status, 400);
  await call(env, "POST", "/academy", { op: "group", gid: g.id, shown: true, dow: 6, time: "10:00", min: 90, max: 8, open: true }, B(javier.tok));
  assert.equal((await (await call(env, "GET", "/academy")).json()).groups[0].open, true);
  // Kian, logged in, signs up himself (no name or contact needed); someone not logged in with name and phone
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "anmalan", gid: g.id, pid: 1680004 }, B(kian.tok))).status, 200);
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "anmalan", gid: g.id, name: "Ny Spelare", contact: "070-1112233" })).status, 200);
  // Thea is already in it: no sign-up for her by a coach-less account; a pid one may not speak for is ignored (needs a name)
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "anmalan", gid: g.id, pid: 1675246 }, B(kian.tok))).status, 400);
  let l = (await (await call(env, "GET", "/academy/interest", null, B(javier.tok))).json()).list;
  const k = l.find(x => x.pid === 1680004);
  assert.deepEqual([k.kind, k.name, k.member], ["anmalan", "Kian Borgström", 0]);
  assert.equal((await call(env, "POST", "/academy/interest/mark", { id: l.find(x => !x.pid).id, op: "add" }, B(javier.tok))).status, 404);   // no player to add
  assert.equal((await call(env, "POST", "/academy/interest/mark", { id: k.id, op: "add" }, B(javier.tok))).status, 200);
  a = (await (await call(env, "GET", "/academy")).json()).groups[0];
  assert.equal(a.n, 2);
  l = (await (await call(env, "GET", "/academy/interest", null, B(javier.tok))).json()).list;
  assert.deepEqual([l.find(x => x.pid === 1680004).member, l.find(x => x.pid === 1680004).status], [1, "kontaktad"]);
  assert.equal((await call(env, "POST", "/academy/interest", { kind: "anmalan", gid: g.id, pid: 1680004 }, B(kian.tok))).status, 400);   // already in it
});
