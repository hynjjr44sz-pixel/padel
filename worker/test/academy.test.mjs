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
    groups: [{ id: g1.id, name: "Damlaget onsdagar", shown: true, level: "C-nivå", sched: "Onsdagar 19:00", max: 8, price: "1 200 kr/termin", info: "Teknik och spel", n: 2 }] });
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
