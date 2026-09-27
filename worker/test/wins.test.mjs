// "Veckans vinnare": class winners kept in KV "wins" (from the class records), served in GET /events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { tick, _resetMemory, winsBackfill, recentWins } from "../src/index.js";
import { parse, summary, classResult } from "../src/rankedin.js";
import ROSTER from "../src/players.js";

const F = n => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const slug = n => String(n).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const BY_NAME = new Map(ROSTER.map(p => [slug(p.name), { pid: p.pid, who: p.key }]));
const THEA = 1675246, CASSANDRA = 1849853;
// Järfälla Padel Open no 11, Damer C (as discovered): Thea with Cassandra
const JC = { key: "t164681-thea", kind: "tournament", who: "thea", me: "Thea Holmberg Löving", pid: THEA, tournamentId: 66374, classId: 164681,
  cls: "Damer C", name: "Järfälla Padel Open no 11", url: "https://www.rankedin.com/en/tournament/66374/jarfalla-padel-open-no-11-sanktionerad-b-c-d",
  partner: "Cassandra Ersson", partnerId: CASSANDRA, draws: [[0, 0]], format: "knockout",
  windowFrom: "2026-09-25T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00", cover: ["164681"] };

function kv(init = {}) {
  const m = new Map(Object.entries(init)), ops = { get: 0, put: 0 }, puts = [];
  return { m, ops, puts,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; puts.push(k); m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
function net(fixture) {
  const st = { calls: 0 };
  globalThis.fetch = async url => {
    url = String(url);
    if (url.includes("GetDrawsForStageAndStrengthAsync")) { st.calls++; return new Response(F(fixture)); }
    return new Response(null, { status: 201 });
  };
  return st;
}
const events = async (PUSH, NOW) => (await worker.fetch(new Request("https://w/events"), { PUSH, NOW, ORIGIN: "x" })).json();

test("classResult: the real Damer C final (Thea and Cassandra 6-1 6-4) and undecided draws", () => {
  const r = classResult(parse([JSON.parse(F("dc_final.json"))]), BY_NAME, "knockout");
  assert.deepEqual([r.d, r.s, r.w, r.l, r.opp], ["2026-09-27T17:45", "6-1 6-4", [THEA, CASSANDRA], [], "Persson / Bradbury"]);
  assert.deepEqual(r.win, ["Thea Holmberg Löving", "Cassandra Ersson"]);
  assert.equal(classResult(parse([JSON.parse(F("dc_in_final.json"))]), BY_NAME, "knockout"), null, "final not played yet");
  assert.equal(classResult(parse([JSON.parse(F("dc_1112.json"))]), BY_NAME, "knockout"), null);
});

test("classResult: groups-only class -> the group winner; not for a mixed class without its playoff", () => {
  const m = parse([JSON.parse(F("rr_uno.json"))]);
  const roster = new Map([[slug("Joakim Ahlin"), { pid: 7, who: "x" }]]);
  const r = classResult(m, roster, "groups");
  assert.deepEqual([r.w, r.s, r.rr, r.d], [[7], "3–0", 1, "2026-08-29T13:00"]);
  assert.equal(classResult(m, roster, "mixed"), null);
  assert.equal(classResult(parse([JSON.parse(F("vista_rr_new.json"))]), roster, "groups"), null, "group not finished");
});

test("tick: the final decided -> one 'wins' entry (one KV write), served by GET /events; no write on later looks", async () => {
  _resetMemory();
  const PUSH = kv(), env = { PUSH, NOW: "2026-09-27T20:00:00+02:00", ORIGIN: "x" };
  net("dc_in_final.json");
  await tick(env, [JC]);
  assert.equal(PUSH.m.get("wins"), undefined, "no winner yet");
  net("dc_final.json");
  let r = await tick(env, [JC]);
  assert.equal(r.wins, 1);
  assert.deepEqual(PUSH.puts.filter(k => k === "wins").length, 1);
  const w = JSON.parse(PUSH.m.get("wins")).list;
  assert.equal(w.length, 1);
  assert.deepEqual({ ...w[0] }, { id: "164681:1", place: 1, classId: 164681, tournamentId: 66374, name: "Järfälla Padel Open no 11", cls: "Damer C", url: JC.url,
    date: "2026-09-27", d: "2026-09-27T17:45", pids: [THEA, CASSANDRA], pair: ["Thea Holmberg Löving", "Cassandra Ersson"], opp: "Persson / Bradbury", s: "6-1 6-4" });
  assert.ok(JSON.parse(PUSH.m.get("st:164681"))._sum.fin, "kept in the class record");
  const puts = PUSH.ops.put;
  r = await tick({ ...env, NOW: "2026-09-27T20:10:00+02:00" }, [JC]);
  assert.equal(PUSH.ops.put, puts, "same result: no KV write");
  _resetMemory();
  const ev = await events(PUSH, "2026-09-29T12:00:00+02:00");
  assert.deepEqual(ev.wins.map(x => x.id), ["164681:1"]);
  assert.deepEqual((await events(PUSH, "2026-10-28T12:00:00+01:00")).wins, [], "gone after 30 days");
});

test("backfill: a class record from before 'wins' existed (no fin) -> the win at minute 44, once", async () => {
  _resetMemory();
  const matches = parse([JSON.parse(F("dc_final.json"))]), st = { x: 1, _done: 1, _sum: summary(matches, BY_NAME) };
  const past = [JC, { ...JC, key: "t164681-cassandra", who: "cassandra", me: "Cassandra Ersson", pid: CASSANDRA, partner: "Thea Holmberg Löving", partnerId: THEA }];
  const PUSH = kv({ "st:164681": JSON.stringify(st), disc: JSON.stringify({ at: "2026-09-29T08:07:00Z", events: [], ended: [], none: [], past }) });
  net("dc_final.json");
  let r = await tick({ PUSH, NOW: "2026-09-29T08:43:00Z", ORIGIN: "x", RANK_OFF: "1" });
  assert.equal(PUSH.m.get("wins"), undefined, "only at minute 44");
  r = await tick({ PUSH, NOW: "2026-09-29T08:44:00Z", ORIGIN: "x", RANK_OFF: "1" });
  assert.equal(r.writes, 1);
  const w = JSON.parse(PUSH.m.get("wins")).list;
  assert.deepEqual(w.map(x => [x.id, x.date, x.s, x.opp, x.pids.join()]), [["164681:1", "2026-09-27", "6-1 6-4", "Persson / Bradbury", THEA + "," + CASSANDRA]]);
  assert.deepEqual(w[0].pair, ["Thea Holmberg Löving", "Cassandra Ersson"]);
  const puts = PUSH.ops.put;
  await tick({ PUSH, NOW: "2026-09-29T09:44:00Z", ORIGIN: "x", RANK_OFF: "1" });
  assert.equal(PUSH.ops.put, puts, "already there: no write");
  assert.equal(await winsBackfill({ PUSH }, new Date("2026-10-07T10:00:00Z"), past, {}), 0, "older than 9 days: not looked at");
});

test("lost final: a place-2 entry with the score from the club pair's side", async () => {
  _resetMemory();
  // Rebecka Persson / Marina Bradbury as the club pair (a made-up roster), Thea's pair the opponents
  const matches = parse([JSON.parse(F("dc_final.json"))]), roster = new Map([[slug("Marina Bradbury"), { pid: 99, who: "marina" }]]);
  const fin = classResult(matches, roster, "knockout");
  const { winEntries } = await import("../src/index.js");
  const e = winEntries({ ...JC, pid: 99 }, fin, new Date("2026-09-27T20:00:00+02:00"));
  assert.deepEqual(e.map(x => [x.id, x.place, x.pids.join(), x.s, x.opp]), [["164681:2", 2, "99", "1-6 4-6", "Holmberg Löving / Ersson"]]);
  assert.deepEqual(recentWins(e, new Date("2026-11-01T10:00:00Z")), []);
});
