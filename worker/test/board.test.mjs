// Club leaderboard ("board" in KV "disc", served by GET /events; home view: Topplistan): this year's W–L from the
// profiles discovery reads anyway, SPF standing and skill from the hourly ranking check. KV is written only on change.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { tick, _resetMemory, rankingChecks, runDiscovery } from "../src/index.js";
import { discover, wlOf, skillOf, PLAYERS } from "../src/discover.js";
import { install, wlFor, climbOf } from "./fake-rankedin.mjs";
import { readFileSync } from "node:fs";

const ROSTER = PLAYERS, RJ = JSON.parse(readFileSync(new URL("../../players.json", import.meta.url), "utf8"));
function kv() {
  const m = new Map(), ops = { get: 0, put: 0 }, puts = [];
  return { m, ops, puts,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; puts.push(k); m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
const getter = () => async path => {
  const r = await fetch("https://api.rankedin.com/v1" + path);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
};
beforeEach(() => _resetMemory());

test("board helpers: W–L from the profile statistics, skill of the player's own list", () => {
  assert.deepEqual(wlOf({ Statistics: { WinLossDoublesCurrentYear: "32-4" } }), { w: 32, l: 4 });
  assert.equal(wlOf({ Statistics: { WinLossDoublesCurrentYear: "" } }), null);
  assert.equal(wlOf(null), null);
  assert.equal(skillOf([{ RatingId: 66, RatingValue: 13.08 }, { RatingId: 65, RatingValue: 16.1 }], 65), 16.1);
  assert.equal(skillOf([{ RatingId: 66, RatingValue: 13.08 }], 65), null);
});

test("discover: this year's W–L per player from the profile (no extra call), the others kept, the year noted", async () => {
  const st = install({});
  const batch = ROSTER.slice(0, 4), NOW = new Date("2026-09-30T10:07:00Z");
  const prev = { events: [], board: { [ROSTER[5].pid]: { w: 1, l: 1, y: 2026, sk: 12.3, rk: 99 } } };
  const res = await discover(getter(), NOW, prev, batch);
  batch.forEach(p => { const [w, l] = wlFor(p.pid).split("-").map(Number); assert.deepEqual([res.board[p.pid].w, res.board[p.pid].l, res.board[p.pid].y], [w, l, 2026], p.who); });
  assert.deepEqual(res.board[ROSTER[5].pid], prev.board[ROSTER[5].pid], "not in the batch: kept as it was");
  assert.equal(st.calls.filter(c => /GetPlayerRatingAsync/.test(c)).length, 0, "no skill calls in discovery");
  assert.equal(st.calls.filter(c => /playerprofileinfoasync/.test(c)).length, 4, "one profile call per player, as before");
  // A profile for someone else (wrong PlayerId) is ignored
  st.over = { ["/player/playerprofileinfoasync?rankedinId=" + batch[0].rin + "&language=en"]: { Header: { PlayerId: 1 }, Statistics: { WinLossDoublesCurrentYear: "99-0" } } };
  const res2 = await discover(getter(), NOW, { events: [], board: {} }, batch.slice(0, 1));
  assert.equal(res2.board[batch[0].pid], undefined);
});

test("discovery: the board goes into disc; unchanged W–L -> no write; a new result -> one write", async () => {
  install({});
  const PUSH = kv(), t0 = new Date("2026-09-30T10:07:00Z");
  let rec = await runDiscovery({ PUSH }, t0, { left: 500 }, null, {}, 500);   // everyone at once (the real first run is budgeted)
  assert.equal(Object.keys(rec.board).length, ROSTER.filter(p => p.rin).length, "first run: everyone");
  const puts = PUSH.ops.put;
  for (let k = 1; k <= 5; k++) { _resetMemory(); rec = await runDiscovery({ PUSH }, new Date(+t0 + k * 600e3), { left: 45 }, rec, {}); }
  assert.equal(PUSH.ops.put, puts, "no write when nothing changed");
  const st = install({});
  const who = ROSTER.find(p => p.who === "thea");
  st.over = { ["/player/playerprofileinfoasync?rankedinId=" + who.rin + "&language=en"]: { Statistics: { WinLossDoublesCurrentYear: "33-4" } } };
  for (let k = 6; k <= 12; k++) { _resetMemory(); rec = await runDiscovery({ PUSH }, new Date(+t0 + k * 600e3), { left: 45 }, rec, {}); }
  assert.equal(PUSH.ops.put, puts + 1, "one write for Thea's new win");
  assert.equal(JSON.parse(PUSH.m.get("disc")).board[who.pid].w, 33);
});

test("ranking check: standing, climb and skill into the board; backfill from rank:<pid> once; no write when unchanged", async () => {
  const st = install({});
  const PUSH = kv(), env = { PUSH, ORIGIN: "x" };
  PUSH.m.set("disc", JSON.stringify({ at: "2026-09-28T01:07:00Z", events: [], board: {} }));
  // Known before the deploy: Thea's standing (the board has no ranking yet)
  PUSH.m.set("rank:1675246", JSON.stringify({ d: "2026-09-14", s: 168, p: 60.1 }));
  PUSH.m.set("rankdate:4:83", "2026-09-21"); PUSH.m.set("rankdate:3:82", "2026-09-21");
  const t = new Date("2026-09-28T03:52:00Z"), log = {};
  await rankingChecks(env, t, { left: 45 }, log);
  let b = JSON.parse(PUSH.m.get("disc")).board;
  assert.deepEqual(b["1675246"], { rk: 168, rp: 60.1, rd: "2026-09-14", up: null }, "canary list unchanged: backfilled from rank:<pid>");
  assert.deepEqual(b["1849853"], { rk: 281, rp: 37.965, rd: "2026-09-21", up: -3 }, "the list's canary (first player) looked up");
  assert.deepEqual(b["1702723"], { rd: null }, "nothing known yet: noted once, not read again");
  const skilled = Object.keys(b).filter(pid => "sk" in b[pid]);
  assert.equal(skilled.length, 6, "6 skills an hour");
  skilled.forEach(pid => assert.equal(b[pid].sk, RJ.find(p => String(p.pid) === pid).skill ?? null, pid));
  assert.equal(st.calls.filter(c => /GetPlayerRatingAsync/.test(c)).length, 6);
  // Same hour again: nothing new -> no write, and the rank keys are not read again
  const puts = PUSH.ops.put, gets = PUSH.ops.get;
  _resetMemory();
  await rankingChecks(env, t, { left: 45 }, {});
  assert.equal(PUSH.ops.put, puts, "unchanged: no KV write");
  assert.ok(PUSH.ops.get - gets <= 5, "no backfill reads the second time: " + (PUSH.ops.get - gets));
  // Three hours: the whole roster has a skill
  for (let h = 1; h <= 2; h++) await rankingChecks(env, new Date(+t + h * 3600e3), { left: 45 }, {});
  b = JSON.parse(PUSH.m.get("disc")).board;
  ROSTER.forEach(p => assert.ok("sk" in b[p.pid], p.who + " has a skill entry"));
  assert.equal(b["1675246"].sk, 15.94);
  // New list (Monday): every player looked up, standings and climbs (RankedIn's StandingDiff) in one disc write
  PUSH.m.set("rankdate:4:83", "2026-09-14"); PUSH.m.set("rankdate:3:82", "2026-09-14");
  const before = PUSH.puts.length;
  await rankingChecks(env, new Date(+t + 7 * 3600e3), { left: 45 }, {});
  b = JSON.parse(PUSH.m.get("disc")).board;
  assert.equal(PUSH.puts.slice(before).filter(k => k === "disc").length, 1, "one disc write for the new list");
  assert.deepEqual([b["1680004"].rk, b["1680004"].up, b["1680004"].rd], [789, climbOf(1680004), "2026-09-21"]);
  assert.equal(b["1675246"].up, 18);
  assert.equal(b["1849853"].rk, 281);
  // No disc yet (first minutes after a deploy): the ranking check never creates it
  const P2 = kv();
  await rankingChecks({ PUSH: P2 }, t, { left: 45 }, {});
  assert.ok(!P2.m.has("disc"));
});

test("GET /events serves the board; the tick at :52 fills it next to the notiser", async () => {
  install({});
  const PUSH = kv(), env = { PUSH, ORIGIN: "x", NOW: "2026-09-30T10:07:00Z" };
  for (const m of ["07", "17", "27", "37", "47"]) { _resetMemory(); env.NOW = "2026-09-30T10:" + m + ":00Z"; await tick(env); }
  _resetMemory();
  env.NOW = "2026-09-30T10:52:00Z";
  await tick(env);
  _resetMemory();
  const body = await (await worker.fetch(new Request("https://w/events"), env)).json();
  const thea = body.board["1675246"];
  assert.deepEqual([thea.w, thea.l, thea.y, thea.rk, thea.rp, thea.up], [32, 4, 2026, 150, 68.695, 18]);
  assert.equal(Object.values(body.board).filter(x => typeof x.sk === "number").length, 6);
});

test("discovery from a stale isolate copy keeps the standings and skills the ranking check wrote meanwhile", async () => {
  install({});
  const PUSH = kv(), env = { PUSH, ORIGIN: "x" }, t0 = new Date("2026-09-28T03:47:00Z");
  let rec = await runDiscovery(env, t0, { left: 500 }, null, {}, 500);
  const stale = JSON.parse(JSON.stringify(rec));   // another isolate's copy, read before the ranking check
  PUSH.m.set("rankdate:4:83", "2026-09-21"); PUSH.m.set("rankdate:3:82", "2026-09-21");
  _resetMemory();
  await rankingChecks(env, new Date("2026-09-28T03:52:00Z"), { left: 45 }, {});
  const after = JSON.parse(PUSH.m.get("disc"));
  assert.ok(after.bat && Object.values(after.board).some(b => "sk" in b), "the ranking check wrote skills");
  // That isolate's discovery: something changed (a new W–L) so it writes, from its old copy
  const st = install({}), thea = ROSTER.find(p => p.who === "thea");
  st.over = { ["/player/playerprofileinfoasync?rankedinId=" + thea.rin + "&language=en"]: { Statistics: { WinLossDoublesCurrentYear: "40-4" } } };
  _resetMemory();
  for (let k = 1; k <= 5; k++) rec = await runDiscovery(env, new Date(+t0 + k * 600e3), { left: 45 }, k === 1 ? stale : rec, {});
  const disc = JSON.parse(PUSH.m.get("disc"));
  assert.equal(disc.board[thea.pid].w, 40, "the new W–L");
  for (const pid of Object.keys(after.board)) for (const k of ["sk", "rk", "rp", "rd", "up"]) if (k in after.board[pid]) assert.equal(disc.board[pid][k], after.board[pid][k], pid + " " + k);
  assert.equal(disc.bat, after.bat);
});
