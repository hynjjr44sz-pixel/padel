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
  assert.deepEqual({ ...r[1] }, { pos: 2, n: "Kian Borgström / Thea Löving", m: 4, w: 3, t: 0, l: 1, g: "61-42", d: 19, p: 18 });
});
test("table, singles (Americano): P is played, Points last", () => {
  const r = parseTable(fx("bhs-table-single.html"));
  assert.deepEqual({ ...r[0] }, { pos: 1, n: "Viktor Daneli", m: 6, w: 5, t: 0, l: 1, g: "102-64", d: 38, p: 30 });
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
