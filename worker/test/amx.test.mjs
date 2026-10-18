import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { standings } from "../src/amx.js";
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; }
const ORIGIN = "https://padel.holmberg.st";
const call = (env, method, path, body) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
test("americano: create with club players and guests, score with the key, standings, notiser queued", async () => {
  _resetMemory();
  const env = { PUSH: kv(), NOW: "2026-10-18T10:00:00Z", ORIGIN };
  const round = [{ a: [0, 1], b: [2, 3] }, { a: [4, 5], b: [6, 7] }];
  const players = [{ pid: 1675246 }, { pid: 1680004 }, { n: "Gäst Ett" }, { n: "Gäst Två" }, { n: "A B" }, { n: "C D" }, { n: "E F" }, { n: "G H" }];
  let r = await call(env, "POST", "/amx", { name: "Söndagsamericano", fmt: "americano", pts: 24, courts: 2, players, round });
  assert.equal(r.status, 200);
  const { id, key, t } = await r.json();
  assert.match(id, /^[a-z2-9]{8}$/); assert.equal(t.players[0].n, "Thea Holmberg Löving"); assert.equal(t.kh, undefined);
  assert.equal(JSON.parse(env.PUSH.m.get("amx:pend")).length, 1);   // the start notis
  assert.equal((await call(env, "POST", "/amx/" + id, { key: "wrong", op: "score", r: 0, m: 0, s: [14, 10] })).status, 403);
  assert.equal((await call(env, "POST", "/amx/" + id, { key, op: "score", r: 0, m: 0, s: [14, 9] })).status, 400);   // must add up to 24
  r = await call(env, "POST", "/amx/" + id, { key, op: "score", r: 0, m: 0, s: [14, 10] });
  assert.equal(r.status, 200);
  const pend = JSON.parse(env.PUSH.m.get("amx:pend"));
  assert.equal(pend.length, 2);
  assert.match(pend[1].m.title, /^Söndagsamericano: Thea & Kian vann 14–10$/);
  assert.match(pend[1].m.body, /Mot Gäst & Gäst\. Runda 1\. Tabellen: Thea 1:a, Kian 1:a/);
  r = await call(env, "POST", "/amx/" + id, { key, op: "round", round: [{ a: [0, 2], b: [1, 1] }] });
  assert.equal(r.status, 400);   // a player twice
  r = await call(env, "POST", "/amx/" + id, { key, op: "round", round: [{ a: [0, 2], b: [1, 3] }] });
  assert.equal(r.status, 200);
  const got = await (await call(env, "GET", "/amx/" + id)).json();
  assert.equal(got.rounds.length, 2);
  const st = standings(got);
  assert.deepEqual(st.slice(0, 2).map(x => [x.n, x.p, x.pm]), [["Kian Borgström", 14, 4], ["Thea Holmberg Löving", 14, 4]]);
  assert.equal((await (await call(env, "GET", "/amx")).json()).list[0].id, id);
});
test("lagamericano: fixed pairs, games to 4, guests' pictures, won matches first", async () => {
  _resetMemory();
  const env = { PUSH: kv(), NOW: "2026-10-18T10:00:00Z", ORIGIN };
  const img = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  const players = [{ n: "A A", img }, { n: "B B", fig: 42 }, { n: "C C", img: "javascript:alert(1)" }, { n: "D D" }, { n: "E E" }, { n: "F F" }];
  const teams = [[0, 1], [2, 3], [4, 5]];
  let r = await call(env, "POST", "/amx", { name: "Lag", fmt: "lag", mode: "games", pts: 4, courts: 1, players, teams, round: [{ a: [0, 2], b: [1, 3] }] });
  assert.equal(r.status, 400);   // not the pairs
  r = await call(env, "POST", "/amx", { name: "Lag", fmt: "lag", mode: "games", pts: 4, courts: 1, players, teams, round: [{ a: [0, 1], b: [2, 3] }] });
  assert.equal(r.status, 200);
  const { id, key, t } = await r.json();
  assert.equal(t.players[0].img, img); assert.equal(t.players[1].fig, 42); assert.equal(t.players[2].img, undefined);
  for (const [s, code] of [[[4, 4], 400], [[3, 2], 400], [[6, 4], 400], [[5, 3], 200]]) assert.equal((await call(env, "POST", "/amx/" + id, { key, op: "score", r: 0, m: 0, s })).status, code, String(s));
  assert.equal((await call(env, "POST", "/amx/" + id, { key, op: "round", round: [{ a: [0, 1], b: [4, 5] }] })).status, 200);
  assert.equal((await call(env, "POST", "/amx/" + id, { key, op: "score", r: 1, m: 0, s: [0, 4] })).status, 200);
  const got = await (await call(env, "GET", "/amx/" + id)).json();
  assert.deepEqual(standings(got).slice(0, 2).map(x => x.n), ["E E", "F F"]);   // 1 win, +4 ahead of A/B (1 win, -2)
  assert.equal((await call(env, "POST", "/amx/" + id, { key, op: "look", i: 3, fig: 7 })).status, 200);
  assert.equal((await call(env, "POST", "/amx/" + id, { key, op: "look", i: 3, img })).status, 200);
});
test("arkiv: ended -> kept for good and on the club players' archive; reopened -> off it; deleted -> gone everywhere", async () => {
  _resetMemory();
  const env = { PUSH: kv(), NOW: "2026-10-18T10:00:00Z", ORIGIN };
  const puts = []; const put = env.PUSH.put; env.PUSH.put = async (k, v, o) => { puts.push([k, o]); return put(k, v, o); };
  const players = [{ pid: 1675246 }, { n: "B B" }, { n: "C C" }, { n: "D D" }];
  let r = await call(env, "POST", "/amx", { name: "Arkiv", fmt: "americano", pts: 16, courts: 1, players, round: [{ a: [0, 1], b: [2, 3] }] });
  const { id, key } = await r.json();
  assert.equal(puts.find(x => x[0] === "amx:" + id)[1].expirationTtl, 30 * 86400);
  await call(env, "POST", "/amx/" + id, { key, op: "score", r: 0, m: 0, s: [10, 6] });
  await call(env, "POST", "/amx/" + id, { key, op: "end" });
  assert.equal(puts.filter(x => x[0] === "amx:" + id).pop()[1], undefined);   // no expiry once ended
  let a = await (await call(env, "GET", "/amx/pl/1675246")).json();
  assert.deepEqual(a.list.map(x => [x.id, x.place, x.of, x.w, x.l, x.p]), [[id, 1, 4, 1, 0, 10]]);
  await call(env, "POST", "/amx/" + id, { key, op: "reopen" });
  assert.equal((await (await call(env, "GET", "/amx/pl/1675246")).json()).list.length, 0);
  await call(env, "POST", "/amx/" + id, { key, op: "end" });
  assert.equal((await call(env, "POST", "/amx/" + id, { key: "x", op: "delete" })).status, 403);
  r = await call(env, "POST", "/amx/" + id, { key, op: "delete" });
  assert.equal(r.status, 200);
  assert.equal((await call(env, "GET", "/amx/" + id)).status, 404);
  assert.equal((await (await call(env, "GET", "/amx/pl/1675246")).json()).list.length, 0);
  assert.equal((await (await call(env, "GET", "/amx")).json()).list.length, 0);
});
