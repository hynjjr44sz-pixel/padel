import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1, arrHeader } from "./d1.mjs";
import { vinMove, vinStand, vinPlaces } from "../src/amx.js";

const ORIGIN = "https://padel.holmberg.st";
const kv = () => { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; };
const call = async (env, path, body) => worker.fetch(new Request("https://w" + path, { method: body ? "POST" : "GET", headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(path === "/amx" ? await arrHeader(env.DB) : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
const players = "Daneli Lindberg Mickos Tobbe Oliver Kian Sara Magnus Milos Jones Johan Agnes".split(" ").map(n => ({ n }));
const round = [{ c: 1, a: [0, 1], b: [2, 3] }, { c: 2, a: [4, 5], b: [6, 7] }, { c: 3, a: [8, 9], b: [10, 11] }];

test("vinnarbana: 12 on 3 courts; winners up, losers down; points 2, 2, then 3/2/1; ties by wins, then the klunsning; the final", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-21T18:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) };
  // exactly 4 a court
  assert.equal((await call(env, "/amx", { fmt: "vinnar", courts: 3, players: players.slice(0, 10), round, vin: { n: 7, min: 12 } })).status, 400);
  const r = await (await call(env, "/amx", { name: "Deluxe", fmt: "vinnar", courts: 3, players, round, vin: { n: 3, min: 12 } })).json();
  const id = r.id, key = r.key, op = async b => (await call(env, "/amx/" + id, { key, ...b })).json();
  assert.deepEqual(r.t.rounds[0][0], { c: 1, p: [0, 1, 2, 3], a: [0, 1], b: [2, 3], w: null });
  // a drawn pair wins as a pair; not two from different sides
  assert.equal((await op({ op: "vwin", c: 1, w: [0, 2] })).error, "bad winners");
  assert.equal((await op({ op: "score", r: 0, m: 0, s: [1, 0] })).error, "bad op");
  assert.equal((await op({ op: "vnext" })).error, "not done");
  let t = (await op({ op: "timer", run: true })).t;
  assert.equal(t.timer.dur, 12 * 60e3);
  await op({ op: "vwin", c: 1, w: [0, 1] }); await op({ op: "vwin", c: 2, w: [6, 7] }); t = (await op({ op: "vwin", c: 3, w: [8, 9] })).t;
  t = (await op({ op: "vnext" })).t;
  assert.equal(t.timer, null);
  assert.deepEqual(t.rounds[1].map(x => x.p.slice().sort((a, b) => a - b)), [[0, 1, 6, 7], [2, 3, 8, 9], [4, 5, 10, 11]]);
  // match 2 (pairs settled on court: any two of the four)
  await op({ op: "vwin", c: 1, w: [0, 6] }); await op({ op: "vwin", c: 2, w: [2, 9] }); await op({ op: "vwin", c: 3, w: [5, 11] });
  t = (await op({ op: "vnext" })).t;
  assert.deepEqual(t.rounds[2].map(x => x.p.slice().sort((a, b) => a - b)), [[0, 2, 6, 9], [1, 5, 7, 11], [3, 4, 8, 10]]);
  await op({ op: "vwin", c: 1, w: [0, 2] }); await op({ op: "vwin", c: 2, w: [1, 7] }); t = (await op({ op: "vwin", c: 3, w: [3, 4] })).t;
  // Daneli 2+2+3 = 7, Mickos 0+2+3 = 5, then four on 4 points and 2 wins (Sara, Lindberg, Jones, Magnus)
  const st = vinStand(t);
  assert.deepEqual(st.slice(0, 2).map(o => [o.n, o.p, o.w]), [["Daneli", 7, 3], ["Mickos", 5, 2]]);
  assert.deepEqual(st.slice(2, 6).map(o => o.p + "/" + o.w), ["4/2", "4/2", "4/2", "4/2"]);
  // level on points and wins: the organiser's klunsning order
  const lev = st.filter(o => o.p === st[2].p && o.w === st[2].w).map(o => o.i);
  assert.ok(lev.length >= 2);
  t = (await op({ op: "vtie", order: lev.slice().reverse() })).t;
  assert.equal(vinStand(t)[2].i, lev[lev.length - 1]);
  // the final: picks only 3 or 4 (5 or 6 is wrong)
  const s = vinStand(t).map(o => o.i);
  assert.equal((await op({ op: "vnext", picks: [s[4], s[6], s[10]] })).error, "bad picks");
  t = (await op({ op: "vnext", picks: [s[3], s[6], s[11]] })).t;
  assert.deepEqual(t.rounds[3].map(x => [x.a, x.b]), [[[s[0], s[3]], [s[1], s[2]]], [[s[4], s[6]], [s[5], s[7]]], [[s[8], s[11]], [s[9], s[10]]]]);
  await op({ op: "vwin", c: 1, w: [s[1], s[2]] }); await op({ op: "vwin", c: 2, w: [s[4], s[6]] }); t = (await op({ op: "vwin", c: 3, w: [s[9], s[10]] })).t;
  const pl = vinPlaces(t);
  assert.deepEqual([pl[s[1]], pl[s[2]], pl[s[0]], pl[s[4]], pl[s[5]], pl[s[10]], pl[s[11]]], [1, 1, 3, 5, 7, 9, 11]);
  assert.equal((await op({ op: "vnext" })).error, "not done");   // nothing after the final
  t = (await op({ op: "end" })).t;
  const all = await (await call(env, "/amx/all")).json();
  assert.deepEqual(all.list ? all.list[0].win : all[0].win, [[players[s[1]].n, players[s[2]].n]]);
});
test("vinnarbana on two courts: court 1's losers and court 2's winners swap", () => {
  const t = { courts: 2, vin: { n: 7 }, players: players.slice(0, 8), rounds: [[{ c: 1, p: [0, 1, 2, 3], w: [2, 3] }, { c: 2, p: [4, 5, 6, 7], w: [4, 6] }]] };
  assert.deepEqual(vinMove(t).map(x => x.p), [[2, 3, 4, 6], [0, 1, 5, 7]]);
  assert.deepEqual(vinStand(t).slice(0, 4).map(o => o.p), [2, 2, 2, 2]);
});
