import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { tick, _resetMemory, discoveryDue } from "../src/index.js";
import { discover, cleanName, ratingFor } from "../src/discover.js";
import { localToDate, isoLocal, dayOf } from "../src/tz.js";
import { merge } from "../src/events.js";
import { install, A } from "./fake-rankedin.mjs";
import { makeSubscription, makeVapid } from "./helpers.mjs";

const NOW = new Date("2026-09-27T11:52:00Z");   // 13:52 in Stockholm, the day of Järfälla no 11
function kv() {
  const m = new Map(), ops = { get: 0, put: 0, delete: 0, list: 0 };
  return { m, ops,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; m.set(k, v); },
    async delete(k) { ops.delete++; m.delete(k); },
    async list({ prefix }) { ops.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
const getter = state => async path => {
  const r = await fetch("https://api.rankedin.com/v1" + path);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
};
beforeEach(() => _resetMemory());

test("tz: Europe/Stockholm offsets across the October switch; both RankedIn date formats", () => {
  assert.equal(localToDate("2026-09-27T12:45:00").toISOString(), "2026-09-27T10:45:00.000Z");
  assert.equal(localToDate("27/09/2026 12:45").toISOString(), "2026-09-27T10:45:00.000Z");
  assert.equal(localToDate("2026-10-25T12:00:00").toISOString(), "2026-10-25T11:00:00.000Z");   // CET from 25 Oct 2026
  assert.equal(isoLocal("2026-10-24", "23:00"), "2026-10-24T23:00:00+02:00");
  assert.equal(isoLocal("2026-10-25", "07:00"), "2026-10-25T07:00:00+01:00");
  assert.equal(isoLocal("2027-03-28", "07:00"), "2027-03-28T07:00:00+02:00");
  assert.equal(dayOf(new Date("2026-09-27T22:30:00Z")), "2026-09-28");
  assert.equal(localToDate("0001-01-01T00:00:00"), null);
});

test("names and rating ids", () => {
  assert.equal(cleanName("Vista Padel Autumn Smash Open (Sanktionerad Dam&Herr B/C/D) Powered by HEAD"), "Vista Padel Autumn Smash Open");
  assert.equal(cleanName("Järfälla Padel Open no 11 - Sanktionerad B,C,D"), "Järfälla Padel Open no 11");
  assert.equal(cleanName("Good to Great - Volvo Open (B,C,D & Mixed) "), "Good to Great - Volvo Open");
  assert.equal(cleanName("SPL Swedish Padel League Damer 2026-27 "), "SPL Damer");
  assert.deepEqual(["Dam B", "Herr C", "Mix", "Damer C", "Herrar D"].map(ratingFor), [65, 64, 66, 65, 64]);
});

test("discover: tournaments with class, partner and draws; team league play days; old leagues remembered as ended", async () => {
  const st = install({});
  const res = await discover(getter(st), NOW, null);
  assert.equal(res.partial, false);
  const by = k => res.events.find(e => e.key === k);
  const dc = by("t164681-thea");
  assert.deepEqual([dc.cls, dc.partner, dc.tournamentId, dc.format, dc.windowFrom, dc.windowTo, dc.name],
    ["Damer C", "Cassandra Ersson", 66374, "knockout", "2026-09-25T07:00:00+02:00", "2026-09-27T23:00:00+02:00", "Järfälla Padel Open no 11"]);
  assert.deepEqual(dc.draws, [[0, 0]]);
  assert.deepEqual(dc.cover, ["164681"]);
  const vista = by("t173729-thea");
  assert.deepEqual([vista.cls, vista.partner, vista.pairs, vista.draws, vista.rating, vista.venue, vista.address],
    ["Dam B", "Nathalie Hällegard", 5, null, 65, "Vista Padel & Vista Bistro", "Novavägen 36, Huddinge"]);
  assert.equal(vista.windowFrom, "2026-10-09T07:00:00+02:00");
  assert.equal(vista.windowTo, "2026-10-11T23:00:00+02:00");
  assert.equal(by("t164677-kian").cls, "Herrar C");
  assert.equal(res.events.filter(e => e.who === "kian" && e.kind === "tournament").length, 1, "Kian is not entered in Vista");

  const spl = res.events.filter(e => e.kind === "teamleague" && e.who === "thea");
  assert.equal(spl.length, 5, "five play days left");
  assert.deepEqual([spl[0].date, spl[0].name, spl[0].team, spl[0].division, spl[0].round], ["2026-10-04", "SPL Damer", "Nynäs Damlag", "Div 3 Öst - Södra", 1]);
  assert.deepEqual(spl[0].ties.map(t => [t.id, t.home, t.opp, t.time]), [[166800, false, "Team TK x Rejoice", ""], [166802, true, "CC Academy UNO Nacka 2", ""]]);
  assert.deepEqual(spl[0].cover, ["tm166800", "tm166802"]);
  assert.ok(spl[0].players.includes("Thea Holmberg Löving"));
  const kspl = res.events.find(e => e.kind === "teamleague" && e.who === "kian");
  assert.deepEqual([kspl.date, kspl.windowFrom, kspl.ties[0].id, kspl.ties[0].venue], ["2026-10-03", "2026-10-03T07:00:00+02:00", 167486, "Vista"]);
  assert.ok(res.ended.includes("l894"), "Klubbligan VT 26 has ended");
  assert.ok(!st.calls.some(c => c.includes("GetHeaderAsync?id=829")), "a league that started 364 days ago is not even looked up");

  // Second run with the first as prev: no player scans, the ended league is skipped, same list.
  st.calls.length = 0;
  const again = await discover(getter(st), NOW, { events: res.events, ended: res.ended });
  assert.deepEqual(again.events, res.events);
  assert.ok(!st.calls.some(c => /GetPlayersForClassAsync|GetHeaderAsync\?id=894|Homepage/.test(c)), st.calls.join("\n"));
  assert.ok(st.calls.length <= 14, "fetches: " + st.calls.length);
});

test("discover: budget errors keep the previous entries and mark the run partial", async () => {
  const st = install({});
  const full = await discover(getter(st), NOW, null);
  let n = 0;
  const limited = async path => { if (++n > 3) { const e = new Error("budget"); e.budget = true; throw e; } return getter(st)(path); };
  const res = await discover(limited, NOW, { events: full.events, ended: full.ended });
  assert.equal(res.partial, true);
  assert.deepEqual(res.events.map(e => e.key).sort(), full.events.map(e => e.key).sort());
});

test("tick: discovery at minute 7 writes KV once; no rewrite when nothing changed; GET /events and /vapid serve it", async () => {
  const st = install({}), PUSH = kv(), env = { PUSH, NOW: "2026-09-27T11:07:00Z", ORIGIN: "https://padel.holmberg.st", VAPID_PUBLIC_KEY: "x" };
  let r = await tick(env);
  assert.ok(r.discovered > 5);
  assert.ok(PUSH.m.has("disc"));
  const rec = JSON.parse(PUSH.m.get("disc"));
  assert.equal(rec.at, "2026-09-27T11:07:00.000Z");
  assert.ok(st.calls.length <= 45, "subrequests " + st.calls.length);
  // Järfälla is live (window 25-27 sep): Damer C and Herrar C polled; first look = baseline
  assert.ok(PUSH.m.has("st:164681") && PUSH.m.has("st:164677"));

  // An hour later (fresh isolate): discovery again, same list -> no KV write for "disc"
  _resetMemory();
  const puts = PUSH.ops.put;
  env.NOW = "2026-09-27T12:07:00Z";
  r = await tick(env);
  assert.equal(PUSH.ops.put, puts, "nothing changed, nothing written");
  assert.equal(JSON.parse(PUSH.m.get("disc")).at, "2026-09-27T11:07:00.000Z");
  // Minute 8: not due
  _resetMemory();
  st.calls.length = 0;
  env.NOW = "2026-09-27T12:08:00Z";
  await tick(env);
  assert.ok(!st.calls.some(c => c.includes("ParticipatedEvents")));

  const res = await worker.fetch(new Request("https://w/events", { headers: { Origin: "https://padel.holmberg.st" } }), env);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://padel.holmberg.st");
  assert.match(res.headers.get("Cache-Control"), /max-age=300/);
  const body = await res.json();
  assert.equal(body.src, "worker");
  assert.ok(body.events.some(e => e.key === "t173729-thea") && body.events.some(e => e.kind === "teamleague"));
  const v = await (await worker.fetch(new Request("https://w/vapid"), env)).json();
  assert.ok(v.classes.includes(164681) && v.classes.includes("tm166800") && v.classes.includes(173729));
});

test("discoveryDue: every hour at :07, after 6 h, when missing or partial", () => {
  const rec = { at: "2026-09-27T10:07:00Z", events: [] };
  assert.equal(discoveryDue(null, new Date("2026-09-27T10:30:00Z")), true);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T10:30:00Z")), false);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T11:07:00Z")), true);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T16:08:00Z")), true);
  assert.equal(discoveryDue({ ...rec, partial: true }, new Date("2026-09-27T10:30:00Z")), true);
});

test("merge: static events fill in, discovered wins (same classId + who)", () => {
  const d = [{ key: "t164681-thea", kind: "tournament", who: "thea", classId: 164681, cls: "Damer C", windowFrom: "2026-09-25T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00", draws: [[0, 0]] }];
  const m = merge(d);
  assert.equal(m.filter(e => e.classId === 164681).length, 1);
  assert.equal(m.find(e => e.classId === 164681).windowFrom, "2026-09-25T07:00:00+02:00");
  assert.deepEqual(m.find(e => e.classId === 173729).draws, [[0, 0], [1, 0]]);
  const vista = [{ key: "t173729-thea", kind: "tournament", who: "thea", classId: 173729, draws: null, windowFrom: "2026-10-09T07:00:00+02:00", windowTo: "2026-10-11T23:00:00+02:00" }];
  assert.deepEqual(merge(vista).find(e => e.classId === 173729).draws, [[0, 0], [1, 0]]);
  assert.equal(vista[0].draws, null, "the stored record is never changed (it would look like a new list every hour)");
});

test("rotation: more active classes than the budget -> at most 30 RankedIn fetches per tick, others next minute", async () => {
  const st = install({}), PUSH = kv();
  const evs = [];
  for (let i = 0; i < 20; i++) evs.push({ who: "thea", me: "Thea Holmberg Löving", cls: "K" + i, classId: 164681 + i * 1000, stages: [0, 1],
    activeFrom: "2026-09-27T08:00:00+02:00", activeTo: "2026-09-27T22:00:00+02:00" });
  st.over = { "/tournament/GetDrawsForStageAndStrengthAsync*": A("t65183_draw_153640_0_0") };
  const r1 = await tick({ PUSH, NOW: "2026-09-27T12:00:00+02:00" }, evs);
  assert.equal(r1.polled, 15);
  assert.equal(st.calls.length, 30);
  const first = new Set([...PUSH.m.keys()]);
  await tick({ PUSH, NOW: "2026-09-27T12:01:00+02:00" }, evs);
  assert.ok([...PUSH.m.keys()].length > first.size, "the next minute reaches classes the first one skipped");
});
