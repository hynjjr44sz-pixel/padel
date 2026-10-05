// MATCHi TV (PadelGo): halls with cameras, the hall of an event, its streams
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchClub, eventClub, parseMedia } from "../src/tv.js";
import worker, { tvTargets, tvDue, runTv, _resetMemory } from "../src/index.js";

const MEDIA = JSON.parse(readFileSync(new URL("./fixtures/tv-jarfalla.json", import.meta.url), "utf8"));

test("hall: a venue or an away team -> the camera hall; nothing for halls without cameras or loose words", () => {
  assert.deepEqual(matchClub("Padelverket Haninge Sportklubb"), { id: 255, n: "Padelverket Haninge" });
  assert.equal(matchClub("Järfälla Padel Club").id, 595);
  assert.equal(matchClub("Golden Padel A").id, 365, "away team named after its hall");
  assert.equal(matchClub("Järfälla Padel").id, 595, "RankedIn's name for it");
  assert.equal(matchClub("Nord Sverige Tennis"), null, "a one-word hall (Padel Nord) needs more than its word");
  for (const v of ["Vista Padel & Vista Bistro", "Svenska Padelförbundet", "Nynäs", "Padelverket Damlag", "", null]) assert.equal(matchClub(v), null, String(v));
  assert.equal(eventClub({ kind: "tournament", venue: "Djursholms Tennisklubb" }).id, 252);
  assert.equal(eventClub({ kind: "tournament", venue: "Svenska Padelförbundet", address: "Kiselgatan 33 602 23 Norrköping, Sweden" }), null, "the city in the address is not a hall");
  assert.equal(eventClub({ kind: "teamleague", ties: [{ home: true, opp: "Golden Padel A", venue: "" }] }), null, "home tie: not their hall");
  assert.equal(eventClub({ kind: "teamleague", ties: [{ home: false, opp: "Golden Padel A", venue: "" }] }).id, 365);
});
test("streams: court, start/end (local), ended, title", () => {
  const s = parseMedia(MEDIA);
  const b1 = s.find(x => /27 sep/.test(x.t) && x.c === "Bana 1");
  assert.ok(b1, JSON.stringify(s));
  assert.match(b1.x, /^\w{11}$/);
  assert.equal(b1.a, "2026-09-27T13:55:55Z", "PadelGo times are UTC");
  assert.equal(b1.t, "Järfälla Open söndag 27 sep");
});
test("when: hourly around the event, every 10 min while it is on, never at night", () => {
  const ev = { kind: "tournament", key: "t1-x", venue: "Järfälla Padel Club", windowFrom: "2026-09-25T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00" };
  assert.deepEqual(tvTargets([ev], new Date("2026-09-20T12:00:00+02:00")), [], "a week before: nothing");
  const on = tvTargets([ev], new Date("2026-09-27T12:08:00+02:00"));
  assert.deepEqual(on.map(x => [x.id, x.live]), [[595, true]]);
  assert.equal(tvDue(on, new Date("2026-09-27T12:08:00+02:00")), true, "every 5 min while on (minute 3, 8, ...)");
  assert.equal(tvDue(on, new Date("2026-09-27T12:09:00+02:00")), false);
  const after = tvTargets([ev], new Date("2026-09-28T10:28:00+02:00"));
  assert.deepEqual(after.map(x => x.live), [false]);
  assert.equal(tvDue(after, new Date("2026-09-28T10:28:00+02:00")), true);
  assert.equal(tvDue(after, new Date("2026-09-28T10:08:00+02:00")), false);
  assert.equal(tvDue(after, new Date("2026-09-29T03:28:00+02:00")), false, "night");
  const old = tvTargets([ev], new Date("2026-10-05T10:28:00+02:00"));
  assert.deepEqual(old.map(x => [x.live, x.recent]), [[false, false]], "a week after: still a target (recordings)");
  assert.equal(tvDue(old, new Date("2026-10-05T10:28:00+02:00")), false, "but only once a day");
  assert.equal(tvDue(old, new Date("2026-10-05T07:28:00+02:00")), true);
  assert.deepEqual(tvTargets([ev], new Date("2026-10-28T10:28:00+02:00")), [], "a month after: done");
});
test("run: the hall's streams of the event days into KV, written only on a change", async () => {
  _resetMemory();
  const m = new Map(), puts = [], PUSH = { async get(k) { return m.get(k) ?? null; }, async put(k, v) { puts.push(k); m.set(k, v); } };
  const orig = globalThis.fetch, seen = [];
  globalThis.fetch = async (u, init) => { seen.push([String(u), JSON.parse(init.body).clubId]); return new Response(JSON.stringify(MEDIA)); };
  try {
    const t = new Date("2026-09-28T10:28:00+02:00"), tg = [{ id: 595, n: "Järfälla Padel Club", live: false, from: Date.parse("2026-09-25T07:00:00+02:00"), to: Date.parse("2026-09-27T23:00:00+02:00") }];
    const v = await runTv({ PUSH }, t, { left: 10 }, tg);
    assert.deepEqual(seen, [["https://streams.padelgo.tv/Media/channel", 595]]);
    assert.ok(v.clubs[595].s.length >= 2 && v.clubs[595].s.every(x => x.a >= "2026-09-24" && x.a < "2026-09-29"), JSON.stringify(v.clubs[595].s.map(x => x.a)));
    assert.deepEqual(puts, ["tv"]);
    await runTv({ PUSH }, t, { left: 10 }, tg);
    assert.deepEqual(puts, ["tv"], "unchanged: no write");
  } finally { globalThis.fetch = orig; _resetMemory(); }
});
test("the weekly list: fetched once a day into KV (only when changed), replaces the bundled one; a bad list is refused", async () => {
  const { tvRefresh } = await import("../src/index.js"), { useClubs, TV_LIST_URL } = await import("../src/tv.js");
  const CLUBS = (await import("../src/tvclubs.js")).default;
  const list = CLUBS.concat([[99999, "Nynäshamns Padelcenter", ["Bana 1"]]]), m = new Map(), puts = [];
  const PUSH = { async get(k) { return m.get(k) ?? null; }, async put(k, v) { puts.push(k); m.set(k, v); } };
  const orig = globalThis.fetch, seen = [];
  let body = JSON.stringify(list);
  globalThis.fetch = async u => { seen.push(String(u)); return new Response(body); };
  try {
    assert.equal(matchClub("Nynäshamns Padelcenter"), null, "not in the bundled list");
    await tvRefresh({ PUSH }, { left: 5 });
    assert.deepEqual([seen, puts], [[TV_LIST_URL], ["tvclubs"]]);
    assert.equal(matchClub("Nynäshamns Padelcenter").id, 99999, "a new hall with cameras");
    await tvRefresh({ PUSH }, { left: 5 });
    assert.deepEqual(puts, ["tvclubs"], "unchanged: no write");
    body = JSON.stringify(list.slice(0, 5));
    await assert.rejects(tvRefresh({ PUSH }, { left: 5 }), /invalid/);
    assert.equal(matchClub("Nynäshamns Padelcenter").id, 99999, "the last good list stays");
  } finally { globalThis.fetch = orig; useClubs(CLUBS); }
});

test("notis: the court's stream is live as a club pair's match starts; once per stream and match; not too early", async () => {
  const { tvNotes } = await import("../src/tv.js");
  const ev = { key: "t164681-thea", kind: "tournament", venue: "Järfälla Padel", classId: 164681, windowFrom: "2026-09-25T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00" };
  const clubs = { 595: { n: "Järfälla Padel Club", s: [{ x: "CaGtlcm3xJI", c: "Bana 1", a: "2026-09-27T13:55:55Z", b: "2026-09-27T18:00:00Z", e: 0 }, { x: "zzzzzzzzzzz", c: "Bana 2", a: "2026-09-27T13:55:55Z", b: "", e: 0 }] } };
  const nx = { st: "next", mid: "6872156", lab: "Final", d: "2026-09-27T17:45:00", t: "17:45", c: "Bana 1", opp: "Persson / Bradbury", key: "t164681-thea" };
  const live = { 1675246: nx, 1849853: nx };
  assert.deepEqual(tvNotes(clubs, live, [ev], new Date("2026-09-27T17:00:00+02:00")), [], "45 min before: not yet");
  const n = tvNotes(clubs, live, [ev], new Date("2026-09-27T17:35:00+02:00"));
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].pids.sort(), [1675246, 1849853]);
  assert.equal(n[0].k, "CaGtlcm3xJI:6872156");
  assert.match(n[0].m.title, /^(Thea och Cassandra|Cassandra och Thea) sänds live på MATCHi TV$/);
  assert.equal(n[0].m.body, "Final · Bana 1 · Järfälla Padel Club · mot Persson / Bradbury");
  assert.equal(n[0].m.url, "https://matchi.tv/watch?s=CaGtlcm3xJI");
  assert.match(n[0].m.es.title, /en directo en MATCHi TV$/);
  assert.deepEqual(tvNotes(clubs, live, [ev], new Date("2026-09-27T17:40:00+02:00"), [n[0].k]), [], "sent once");
  assert.deepEqual(tvNotes(clubs, { 1675246: { ...nx, c: "Bana 3" } }, [ev], new Date("2026-09-27T17:35:00+02:00")), [], "a court without a stream");
  const ended = { 595: { n: "x", s: [{ ...clubs[595].s[0], e: 1 }] } };
  assert.deepEqual(tvNotes(ended, live, [ev], new Date("2026-09-27T17:35:00+02:00")), [], "the stream has ended");
});
test("match start in the recording (tvstarts.py): the empty court turning into play nearest the scheduled time", async t => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("python3", ["-c", "import cv2"]).status !== 0) return t.skip("python3 with cv2 not here");
  // Järfälla 27 sep, Bana 1, the final (scheduled 107 min in): motion per minute measured from the recording
  const scores = { 40: 1.21, 43: 2.3, 46: 2.91, 49: 0.68, 52: 1.85, 55: 0.11, 58: 0.55, 61: 0.33, 64: 0.11, 67: 0.06, 70: 0.04, 73: 0.18, 76: 0.08, 79: 0.51, 82: 0.21,
    85: 2.11, 88: 2.33, 91: 1.31, 94: 0.43, 97: 1.67, 100: 3.1, 103: 4.67, 106: 4.47, 109: 4.57, 112: 3.96, 115: 5.5, 118: 5.06, 121: 2.38 };
  const py = "import json,sys; sys.path.insert(0,'.'); from tvstarts import start_of; s={int(k):v for k,v in json.loads(sys.argv[1]).items()}; print(json.dumps([start_of(s,107), start_of({k:v for k,v in s.items() if k>=85},107)]))";
  const r = spawnSync("python3", ["-c", py, JSON.stringify(scores)], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [85, null], "starts at 85; without an empty court before it: none");
});
test("match starts: read into KV only when changed, a 404 (none yet) is fine", async () => {
  const { tvStartsRefresh } = await import("../src/index.js");
  const m = new Map(), puts = [], PUSH = { async get(k) { return m.get(k) ?? null; }, async put(k, v) { puts.push(k); m.set(k, v); } };
  const orig = globalThis.fetch;
  let res = () => new Response("", { status: 404 });
  globalThis.fetch = async () => res();
  try {
    await tvStartsRefresh({ PUSH }, { left: 5 });
    assert.deepEqual(puts, []);
    const body = JSON.stringify({ 6872153: { x: "CaGtlcm3xJI", o: 4980 } });
    res = () => new Response(body);
    await tvStartsRefresh({ PUSH }, { left: 5 });
    await tvStartsRefresh({ PUSH }, { left: 5 });
    assert.deepEqual(puts, ["tvstarts"]);
    const r = await worker.fetch(new Request("https://w/events"), { PUSH });
    assert.deepEqual((await r.json()).tvs, { 6872153: { x: "CaGtlcm3xJI", o: 4980 } });
  } finally { globalThis.fetch = orig; _resetMemory(); }
});
