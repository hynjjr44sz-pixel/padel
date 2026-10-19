import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";
import { ytId } from "../src/coach.js";

const ORIGIN = "https://padel.holmberg.st";
const kv = () => { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; };
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
const B = t => ({ Authorization: "Bearer " + t });

test("youtube links -> id", () => {
  for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?t=3", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ", "https://m.youtube.com/watch?feature=x&v=dQw4w9WgXcQ"]) assert.equal(ytId(u), "dQw4w9WgXcQ", u);
  assert.equal(ytId("https://evil.example/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(ytId("nope"), null);
});

test("träning fas 2: groups, assistants, the library, plans; a player marks a plan done, the coach sees the feedback", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const acct = async body => { const a = await (await call(env, "POST", "/admin", { op: "add", ...body }, ak)).json(); return { id: a.id, tok: (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token }; };
  const javier = await acct({ name: "Javier Castilla", roles: ["tranare"] }), thea = await acct({ pid: 1675246 }), kian = await acct({ pid: 1680004 }), cass = await acct({ pid: 1849853 }), pt = await acct({ name: "PT", roles: ["pt"] });
  // only a head coach makes groups
  assert.equal((await call(env, "POST", "/coach", { op: "group", name: "Damlaget", pids: [1675246] }, B(thea.tok))).status, 403);
  assert.equal((await call(env, "POST", "/coach", { op: "group", name: "X", pids: [999] }, B(javier.tok))).status, 400);
  const g = await (await call(env, "POST", "/coach", { op: "group", name: "Damlaget onsdagar", pids: [1675246, 1849853] }, B(javier.tok))).json();
  // the group's members are Javier's players now: their training
  assert.equal((await call(env, "GET", "/train?pid=1849853", null, B(javier.tok))).status, 200);
  assert.equal((await call(env, "GET", "/train?pid=1680004", null, B(javier.tok))).status, 403);
  // Thea becomes an assistant: the library, the group's plans; not Cassandra's own training
  assert.equal((await call(env, "GET", "/lib", null, B(thea.tok))).status, 403);
  assert.equal((await call(env, "POST", "/coach", { op: "assist", users: [thea.id, "nobody"] }, B(javier.tok))).status, 400);
  assert.equal((await call(env, "POST", "/coach", { op: "assist", users: [thea.id] }, B(javier.tok))).status, 200);
  const cg = await (await call(env, "GET", "/coach", null, B(javier.tok))).json();
  assert.deepEqual([cg.head, cg.groups.map(x => [x.name, x.pids.sort()]), cg.assistants.map(a => a.id)], [true, [["Damlaget onsdagar", [1675246, 1849853]]], [thea.id]]);
  assert.ok(cg.accounts.some(a => a.id === kian.id) && !cg.accounts.some(a => a.id === javier.id));
  const tg = await (await call(env, "GET", "/coach", null, B(thea.tok))).json();
  assert.deepEqual([tg.head, tg.groups.map(x => x.name), tg.assistants], [false, ["Damlaget onsdagar"], undefined]);
  assert.equal((await call(env, "GET", "/train?pid=1849853", null, B(thea.tok))).status, 403);
  // the library: Thea adds one (a YouTube link), Javier one; Thea may not change Javier's, Javier may change hers
  const e1 = await (await call(env, "POST", "/lib", { cat: "slag", topic: "Bandeja", title: "Bandeja grunder", body: "Sidled, armbågen högt.", yt: "https://youtu.be/dQw4w9WgXcQ", level: "medel", min: 15 }, B(thea.tok))).json();
  const e2 = await (await call(env, "POST", "/lib", { cat: "ovningar", title: "Volleydrill 2 mot 2", min: 20 }, B(javier.tok))).json();
  assert.equal((await call(env, "POST", "/lib", { cat: "bad", title: "x" }, B(javier.tok))).status, 400);
  assert.equal((await call(env, "POST", "/lib", { cat: "slag", title: "x", yt: "https://evil.example/v" }, B(javier.tok))).status, 400);
  assert.equal((await call(env, "POST", "/lib", { id: e2.id, cat: "ovningar", title: "Ändrad" }, B(thea.tok))).status, 403);
  assert.equal((await call(env, "POST", "/lib", { id: e1.id, cat: "slag", topic: "Bandeja", title: "Bandeja, grunder", yt: "dQw4w9WgXcQ" }, B(javier.tok))).status, 200);
  const lib = await (await call(env, "GET", "/lib", null, B(pt.tok))).json();
  assert.deepEqual(lib.ex.map(x => [x.cat, x.title, x.yt]), [["ovningar", "Volleydrill 2 mot 2", null], ["slag", "Bandeja, grunder", "dQw4w9WgXcQ"]]);
  // plans: Javier for the group, Thea (assistant) too; the PT not for someone not linked; Kian sees nothing of the group
  assert.equal((await call(env, "POST", "/plans", { gid: g.id, day: "2026-10-21", time: "19:00", kind: "padel", min: 90, title: "Volley och bandeja", ex: ["nope"] }, B(javier.tok))).status, 400);
  const p1 = await (await call(env, "POST", "/plans", { gid: g.id, day: "2026-10-21", time: "19:00", kind: "padel", min: 90, title: "Volley och bandeja", note: "Värm upp ordentligt", ex: [e2.id, e1.id] }, B(javier.tok))).json();
  assert.equal((await call(env, "POST", "/plans", { gid: g.id, day: "2026-10-28", kind: "padel", min: 90, title: "Strategi" }, B(thea.tok))).status, 200);
  assert.equal((await call(env, "POST", "/plans", { pid: 1680004, day: "2026-10-22", kind: "gym", min: 45, title: "Ben" }, B(pt.tok))).status, 403);
  assert.equal((await call(env, "POST", "/plans", { pid: 1849853, day: "2026-10-22", kind: "gym", min: 45, title: "Ben, Cassandra" }, B(javier.tok))).status, 200);
  const cp = await (await call(env, "GET", "/plans?pid=1849853", null, B(cass.tok))).json();
  assert.deepEqual(cp.plans.map(p => [p.day, p.title, p.gname || null, p.ex.map(x => x.title), p.done]), [
    ["2026-10-21", "Volley och bandeja", "Damlaget onsdagar", ["Volleydrill 2 mot 2", "Bandeja, grunder"], null],
    ["2026-10-22", "Ben, Cassandra", null, [], null],
    ["2026-10-28", "Strategi", "Damlaget onsdagar", [], null]]);
  assert.deepEqual((await (await call(env, "GET", "/plans?pid=1680004", null, B(kian.tok))).json()).plans, []);
  assert.equal((await call(env, "GET", "/plans?gid=" + g.id, null, B(kian.tok))).status, 403);
  // Cassandra marks the group's session done (logs it); Kian may not use the group's plan
  env.NOW = "2026-10-21T20:30:00Z";
  assert.equal((await call(env, "POST", "/train", { pid: 1680004, day: "2026-10-21", kind: "padel", min: 90, rpe: 6, plan: p1.id }, B(kian.tok))).status, 400);
  const s = await (await call(env, "POST", "/train", { pid: 1849853, day: "2026-10-21", kind: "padel", min: 85, rpe: 8, note: "Tungt men kul", plan: p1.id, stars: 4 }, B(cass.tok))).json();
  assert.equal((await (await call(env, "GET", "/plans?pid=1849853", null, B(cass.tok))).json()).plans[0].done, s.id);
  let gp = await (await call(env, "GET", "/plans?gid=" + g.id, null, B(thea.tok))).json();
  assert.deepEqual(gp.plans[0].done, [{ pid: 1849853, session: s.id, min: 85, rpe: 8, note: "Tungt men kul", stars: 4, c: 0 }]);
  // the thread: Javier answers (a notis to Cassandra's phone), Cassandra answers back (a notis to Javier's); Thea (assistant) may not
  const cassEp = "https://push.example/cass", javEp = "https://push.example/jav";
  const sk = async ep => { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ep))); return "sub:" + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join(""); };
  for (const [ep, tok] of [[cassEp, cass.tok], [javEp, javier.tok]]) { await env.PUSH.put(await sk(ep), JSON.stringify({ sub: { endpoint: ep } })); assert.equal((await call(env, "POST", "/me/push", { endpoint: ep }, B(tok))).status, 200); }
  assert.equal((await call(env, "POST", "/train/comment", { id: s.id, text: "Bra!" }, B(thea.tok))).status, 403);
  assert.equal((await call(env, "POST", "/train/comment", { id: s.id, text: "Bra jobbat! Vila axeln till onsdag." }, B(javier.tok))).status, 200);
  env.NOW = "2026-10-21T21:00:00Z";
  assert.equal((await call(env, "POST", "/train/comment", { id: s.id, text: "Tack, ska göra det" }, B(cass.tok))).status, 200);
  const th = await (await call(env, "GET", "/train/thread?id=" + s.id, null, B(cass.tok))).json();
  assert.deepEqual([th.session.stars, th.comments.map(c => [c.name, c.text, c.mine])], [4, [["Javier Castilla", "Bra jobbat! Vila axeln till onsdag.", false], ["Cassandra Ersson", "Tack, ska göra det", true]]]);
  const q = JSON.parse(env.PUSH.m.get("amx:pend"));
  assert.deepEqual(q.slice(-2).map(x => [x.subs, x.m.title]), [[[await sk(cassEp)], "Javier om passet"], [[await sk(javEp)], "Cassandra om passet"]]);
  gp = await (await call(env, "GET", "/plans?gid=" + g.id, null, B(javier.tok))).json();
  assert.equal(gp.plans[0].done[0].c, 2);
  assert.equal((await (await call(env, "GET", "/train?pid=1849853", null, B(cass.tok))).json()).sessions[0].c, 2);
  // a new plan for the group: a notis to its players' phones
  await call(env, "POST", "/plans", { gid: g.id, day: "2026-10-30", time: "18:00", kind: "padel", min: 60, title: "Serve och retur" }, B(javier.tok));
  const q2 = JSON.parse(env.PUSH.m.get("amx:pend")).pop();
  assert.deepEqual([q2.subs, q2.m.title, q2.m.body], [[await sk(cassEp)], "Nytt pass: Serve och retur", "fre 30/10 18:00 · 60 min · Damlaget onsdagar"]);
  // the session removed: no longer done
  await call(env, "POST", "/train", { op: "del", id: s.id }, B(cass.tok));
  assert.deepEqual((await (await call(env, "GET", "/plans?gid=" + g.id, null, B(javier.tok))).json()).plans[0].done, []);
  // a plan removed by an assistant; the group removed by Javier with its plans
  assert.equal((await call(env, "POST", "/plans", { op: "del", id: p1.id }, B(thea.tok))).status, 200);
  assert.equal((await call(env, "POST", "/coach", { op: "group-del", id: g.id }, B(javier.tok))).status, 200);
  assert.deepEqual((await (await call(env, "GET", "/plans?pid=1849853", null, B(cass.tok))).json()).plans.map(p => p.title), ["Ben, Cassandra"]);   // the group's plans went with it
  assert.equal((await call(env, "GET", "/train?pid=1849853", null, B(javier.tok))).status, 403);   // no longer his player
});
