// Backhandsmash parsing (saved fragments from backhandsmash.com, Nynäshamn Padelcenter, September 2026)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLeague, parseTable, parseResults } from "../src/bhs.js";

const fx = f => readFileSync(new URL("./fixtures/" + f, import.meta.url), "utf8");

test("league page: the group ids and names", () => {
  const L = parseLeague(fx("bhs-league.html"));
  assert.deepEqual(L.groups[0], ["92355", "Division 3A"]);
  assert.equal(L.groups.length, 4);
});
test("table, pairs: played (M), W/T/L, games, +/-, points (last column)", () => {
  const r = parseTable(fx("bhs-table-pair.html"));
  assert.equal(r.length, 6);
  assert.deepEqual({ ...r[1] }, { id: 118687, pos: 2, n: "Kian Borgström / Thea Löving", m: 4, w: 3, t: 0, l: 1, g: "61-42", d: 19, p: 18 });
});
test("table, singles (Americano): P is played, Points last", () => {
  const r = parseTable(fx("bhs-table-single.html"));
  assert.deepEqual({ ...r[0], id: 0 }, { id: 0, pos: 1, n: "Viktor Daneli", m: 6, w: 5, t: 0, l: 1, g: "102-64", d: 38, p: 30 });
});
test("results: both sides, score from the first, date", () => {
  const r = parseResults(fx("bhs-results.html"));
  const k = r.find(x => /Kian/.test(x.b) && /Lindgren/.test(x.a));
  assert.deepEqual(k, { a: "Andreas Lindgren / Rebecca Levander", b: "Kian Borgström / Thea Löving", s: "6-3 4-6 6-2", d: "2026-09-25" });
});
test("schedule (logged in): coming matches with time, length, court, group, both sides", async () => {
  const { parseSchedule } = await import("../src/bhs.js");
  const r = parseSchedule(fx("bhs-schedule.html"));
  assert.ok(r.length >= 1);
  assert.deepEqual(r[0], { d: "2026-09-30 20:00", min: 90, c: "1", g: "Herrar div 2", a: "Daniel Strömvall / Andreas Mickos", b: "Javier Castilla / Kian Borgström" });
});
test("league page: the schedule's site id", () => {
  assert.equal(parseLeague(fx("bhs-league.html")).site, 390);
});

test("round history and league ranking", async () => {
  const { parseHistory, parseRanking } = await import("../src/bhs.js");
  const h = parseHistory('{"cols":[],"rows":[{"c":[{"v":1,"f":"2024:2"},{"v":4,"f":"4"},{"v":6,"f":"6"}]},{"c":[{"v":2,"f":"2026:4"},{"v":1,"f":"1"},{"v":2,"f":"2"}]}]}');
  assert.deepEqual(h, [["2024:2", 4, 6], ["2026:4", 1, 2]]);
  const r = parseRanking({ Compiled: "Updated  2026-06-20 00:00", TableData: { Rows: [{ Cells: [{ Value: 1 }, { Value: "Cecilia  Hildemyhr" }, { Value: 2.2 }] }, { Cells: [{ Value: 4 }, { Value: "Sanna  Årsjö" }, { Value: 4.4 }] }] } }, n => /Sanna/.test(n) ? [1055851] : []);
  assert.deepEqual(r, { n: 2, at: "2026-06-20", rows: [{ rank: 4, name: "Sanna Årsjö", avg: 4.4, pids: [1055851] }] });
});
test("series winners: when the league's round moves on, the 1st of the round that ended", async () => {
  const { seriesWinners } = await import("../src/bhs.js");
  const groups = [{ lg: "mix", series: "Mixedserie", name: "Mix 1", rows: [{ id: 7, n: "Kian Borgström / Thea Löving", pids: [1, 2] }, { id: 8, n: "Magnus Olsson / Sigrid Olsson", pids: [3] }] }];
  const t1 = new Date("2026-09-29T01:43:00Z"), t2 = new Date("2026-10-27T01:43:00Z");
  const a = seriesWinners(null, { 7: [["2026:4", 1, 2], ["2026:8", 1, 1]], 8: [["2026:8", 1, 3]] }, groups, t1);
  assert.deepEqual(a.cur, { mix: "2026:8" });
  assert.deepEqual(a.sw, []);
  const b = seriesWinners(a, { 7: [["2026:8", 1, 1], ["2026 : 9", 1, 2]], 8: [["2026:8", 1, 3], ["2026 : 9", 1, 1]] }, groups, t2);
  assert.deepEqual(b.sw, [{ id: 7, lg: "mix", series: "Mixedserie", group: "Mix 1", round: "2026:8", n: "Kian Borgström / Thea Löving", pids: [1, 2], at: t2.toISOString() }]);
  assert.deepEqual(seriesWinners(b, { 7: [["2026 : 9", 1, 2]], 8: [["2026 : 9", 1, 1]] }, groups, t2).sw.length, 1);   // not twice
});

// Results as notiser (Kian's Americano match 30 Sep 2026)
const G = { id: 92350, lg: "noteam", series: "Americanoserie", name: "Herrar div 2", res: [], next: [] };
const T = new Date("2026-09-30T21:43:00+02:00");
const R = { a: "Javier Castilla / Kian Borgström", b: "Daniel Strömvall / Andreas Mickos", s: "6-4 6-2 2-6", d: "2026-09-30", pids: [1680004] };
test("match key: same match whatever the order of sides and partners", async () => {
  const { matchKey } = await import("../src/bhs.js");
  assert.equal(matchKey(R.a, R.b, R.d), matchKey("Andreas Mickos / Daniel Strömvall", "Kian Borgström / Javier Castilla", "2026-09-30 20:00"));
  assert.notEqual(matchKey(R.a, R.b, R.d), matchKey(R.a, R.b, "2026-10-07"));
});
test("new result -> notis to the club players' devices (Swedish and Spanish), only for groups seen before", async () => {
  const { newResults, matchKey } = await import("../src/bhs.js");
  const PL = [{ pid: 1680004, me: "Kian Borgström", name: "Kian" }];
  assert.deepEqual(newResults([], [{ ...G, res: [R] }], T, PL), []);
  const [n] = newResults([G], [{ ...G, res: [R] }], T, PL);
  assert.deepEqual(n.pids, [1680004]);
  assert.equal(n.m.title, "Kian vann i americanoserien");
  assert.equal(n.m.body, "Javier Castilla / Kian Borgström – Daniel Strömvall / Andreas Mickos  6-4 6-2 2-6 · Herrar div 2");
  assert.equal(n.m.url, "./#serie/92350/" + matchKey(R.a, R.b, R.d));
  assert.equal(n.m.es.title, "Kian ganó en la liga americano");
  assert.deepEqual(newResults([{ ...G, res: [R] }], [{ ...G, res: [R] }], T, PL), []);
  assert.deepEqual(newResults([G], [{ ...G, res: [R] }], new Date("2026-10-05T12:00:00+02:00"), PL), [], "old results never notify");
  const lost = newResults([G], [{ ...G, res: [{ ...R, s: "4-6 2-6 6-2" }] }], T, PL)[0];
  assert.equal(lost.m.title, "Kian förlorade i americanoserien");
  assert.match(lost.m.body, /^Daniel Strömvall \/ Andreas Mickos – Javier Castilla \/ Kian Borgström  6-4 6-2 2-6/);
});
test("results due: from 10 min before a scheduled match ends until 5 h after, until its result is in", async () => {
  const { resultsDue } = await import("../src/bhs.js");
  const g = { ...G, next: [{ d: "2026-09-30 20:00", min: 90, a: R.a, b: R.b }] };
  assert.equal(resultsDue([g], new Date("2026-09-30T19:00:00+02:00")).length, 0);
  assert.equal(resultsDue([g], new Date("2026-09-30T21:25:00+02:00")).length, 1);
  assert.equal(resultsDue([g], new Date("2026-10-01T02:00:00+02:00")).length, 1);
  assert.equal(resultsDue([g], new Date("2026-10-01T03:00:00+02:00")).length, 0);
  assert.equal(resultsDue([{ ...g, res: [R] }], new Date("2026-09-30T22:00:00+02:00")).length, 0);
});
test("series notiser wait over the night (23-07) and go out with the first look after", async () => {
  const { bhsSendable } = await import("../src/index.js");
  const v = {}, n = { pids: [1], m: { title: "x" } };
  assert.deepEqual(bhsSendable(v, [n], new Date("2026-09-30T23:40:00+02:00")), []);
  assert.equal(v.held.length, 1);
  assert.deepEqual(bhsSendable(v, [], new Date("2026-10-01T07:03:00+02:00")), [n]);
  assert.equal(v.held, undefined);
});
test("after a scheduled match: its group's results are looked at again and the new one is a notis (once)", async () => {
  const { runBhsResults, _resetMemory } = await import("../src/index.js");
  _resetMemory();
  const m = new Map(), PUSH = { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
  const g = { id: 92917, lg: "mix", series: "Mixedserie", name: "Mix 1", pids: [1675246, 1680004], rows: [], res: [],
    next: [{ d: "2026-09-25 19:00", min: 90, c: "2", a: "Kian Borgström / Thea Löving", b: "Andreas Lindgren / Rebecca Levander", pids: [1680004, 1675246] }] };
  m.set("bhs", JSON.stringify({ at: "2026-09-25T01:33:00Z", groups: [g] }));
  const orig = globalThis.fetch, seen = [];
  globalThis.fetch = async url => { seen.push(String(url)); return new Response(fx("bhs-results.html")); };
  try {
    const env = { PUSH }, budget = { left: 10 };
    assert.deepEqual(await runBhsResults(env, new Date("2026-09-25T18:03:00+02:00"), budget), [], "not yet over");
    assert.equal(seen.length, 0);
    const out = await runBhsResults(env, new Date("2026-09-25T20:33:00+02:00"), budget);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /results\/bygroup\?id=92917/);
    assert.deepEqual(out.map(n => n.m.title), ["Rebecca vann mot Kian och Thea i mixedserien"], "only the fresh one");
    assert.equal(out[0].m.body, "Andreas Lindgren / Rebecca Levander – Kian Borgström / Thea Löving  6-3 4-6 6-2 · Mix 1");
    assert.ok(JSON.parse(m.get("bhs")).groups[0].res.length > 0);
    assert.deepEqual(await runBhsResults(env, new Date("2026-09-25T20:43:00+02:00"), budget), [], "result in: no more looks, no repeat");
    assert.equal(seen.length, 1);
  } finally { globalThis.fetch = orig; _resetMemory(); }
});
