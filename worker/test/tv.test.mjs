// MATCHi TV (PadelGo): halls with cameras, the hall of an event, its streams
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchClub, eventClub, parseMedia } from "../src/tv.js";
import { tvTargets, tvDue, runTv, _resetMemory } from "../src/index.js";

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
  assert.equal(b1.a, "2026-09-27T13:55:55");
  assert.equal(b1.t, "Järfälla Open söndag 27 sep");
});
test("when: hourly around the event, every 10 min while it is on, never at night", () => {
  const ev = { kind: "tournament", key: "t1-x", venue: "Järfälla Padel Club", windowFrom: "2026-09-25T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00" };
  assert.deepEqual(tvTargets([ev], new Date("2026-09-20T12:00:00+02:00")), [], "a week before: nothing");
  const on = tvTargets([ev], new Date("2026-09-27T12:08:00+02:00"));
  assert.deepEqual(on.map(x => [x.id, x.live]), [[595, true]]);
  assert.equal(tvDue(on, new Date("2026-09-27T12:08:00+02:00")), true);
  assert.equal(tvDue(on, new Date("2026-09-27T12:09:00+02:00")), false);
  const after = tvTargets([ev], new Date("2026-09-28T10:28:00+02:00"));
  assert.deepEqual(after.map(x => x.live), [false]);
  assert.equal(tvDue(after, new Date("2026-09-28T10:28:00+02:00")), true);
  assert.equal(tvDue(after, new Date("2026-09-28T10:08:00+02:00")), false);
  assert.equal(tvDue(after, new Date("2026-09-29T03:28:00+02:00")), false, "night");
  assert.deepEqual(tvTargets([ev], new Date("2026-09-30T10:28:00+02:00")), [], "two days after: done");
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
