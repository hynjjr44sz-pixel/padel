// "Förslag på tävlingar": the nightly calendar (src/calendar.js) on the real RankedIn responses saved 2026-09-28
// (fixtures/cal), the distance filter, SPF eligibility, KV writes only on change, and the subrequest budget per tick.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { tick, _resetMemory } from "../src/index.js";
import { classLevel, classGender, parseInfo, parseClasses, haversine, calendarDue, eligibility, baseLevel, suggestFor, signupOpen, calendarStep } from "../src/calendar.js";
import { install, kmFromHome, route } from "./fake-rankedin.mjs";
import { readFileSync } from "node:fs";

const CF = n => JSON.parse(readFileSync(new URL("./fixtures/cal/" + n + ".json", import.meta.url)));
function kv() {
  const m = new Map(), ops = { get: 0, put: 0, delete: 0, list: 0 }, puts = [];
  return { m, ops, puts,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; puts.push(k); m.set(k, v); },
    async delete(k) { ops.delete++; m.delete(k); },
    async list({ prefix }) { ops.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
// A discovery record with Thea (and Cassandra as her partner) in Vista's Dam B: registrations come from here.
const DISC = { at: "2026-09-28T00:00:00Z", events: [{ key: "t173729-thea", kind: "tournament", who: "thea", pid: 1675246, partnerId: 1849853, tournamentId: 73554, classId: 173729,
  windowFrom: "2026-10-09T07:00:00+02:00", windowTo: "2026-10-11T23:00:00+02:00" }], ended: [], none: [], past: [], photos: {}, board: {} };
const NIGHT = "2026-09-28T01:23:00Z";   // 03:23 in Stockholm (CEST)
const at = (iso, min) => new Date(Date.parse(iso) + min * 60e3).toISOString();
beforeEach(() => _resetMemory());

test("class names: level from the name (not LevelName), gender from the name, else the description", () => {
  const L = ["Herr B", "DAMER C", "C - Klass", "B-Klass herr", "Dam C-klass", "Herr D-klass", "Damer A ", "Mixed", "MIX", "SPT Damer", "Flickor 14 Step In",
    "P12 Step in", "Herrar 45+", "Rise Energy’s motionsklass"].map(classLevel);
  assert.deepEqual(L, ["B", "C", "C", "B", "C", "D", "A", "other", "other", "other", "other", "other", "other", "other"]);
  assert.deepEqual([["Herr B", "Men-Doubles / Men-Main"], ["DAMER B", "Women-Doubles / Women-Main"], ["C - Klass", "Women-Doubles / Women-Main"],
    ["Herrar C", "Women-Doubles / Women-Main"], ["Mix", "Mixed-Doubles / Mixed-Main"], ["Pojkar 16", "Men-Doubles / Boys Under 16"],
    ["Herr D ", "Men-Doubles / Men Over 40"], ["Herrar D", "Men-Singles / Men-Main"], ["Damer 50+", "Women-Doubles / Women Over 50"]].map(x => classGender(...x)),
    ["M", "F", "F", "M", "mixed", "other", "other", "other", "other"]);
  // SPF-ranked classes only: the race rankings' copies and "osanktionerad" classes are left out
  const c = parseClasses(CF("classes_73351"));
  assert.ok(c.length && c.every(x => x.id && x.name && x.level && x.gender));
  const all = CF("classes_73351").Classes;
  assert.ok(all.length > c.length, "race duplicates dropped");
  assert.deepEqual(parseClasses({ Classes: [{ ClassId: 1, ClassName: "Dam D (osanktionerad)", OrganizationName: "SPF Padel Ranking" }] }), []);
  assert.deepEqual(parseClasses(CF("classes_73468")).map(x => [x.name, x.level, x.gender, x.players, x.limit]), [["Herr B", "B", "M", 4, 24], ["Dam B", "B", "F", 1, 24],
    ["Herr C", "C", "M", 5, 24], ["Dam C", "C", "F", 4, 24], ["Herr D", "D", "M", 1, 24], ["Dam D", "D", "F", 3, 24], ["Mix", "other", "mixed", 0, 24]]);
});

test("info: coordinates (0.0 = unknown), closing date, club, town from the address", () => {
  const j = parseInfo(CF("info_73468")), h = parseInfo(CF("info_73554")), g = parseInfo(CF("info_73409"));
  assert.deepEqual([j.lat, j.lon, j.closes, j.state, j.club, j.city, j.spf], [0, 0, "2026-10-13T23:55:00", 1, "Padelverket Haninge Sportklubb", "Jordbro", true]);
  assert.equal(Math.round(haversine({ lat: 58.903, lon: 17.947 }, h)), 36, "Huddinge 3,6 mil");
  assert.equal(g.club, null); assert.equal(g.venue, "PDL Center Värmdö"); assert.equal(g.city, "Gustavsberg");
  assert.equal(signupOpen({ state: 1, closes: "2026-09-28T23:55:00" }, new Date("2026-09-28T21:00:00Z")), true, "69142: open until 23:55 local");
  assert.equal(signupOpen({ state: 1, closes: "2026-09-28T23:55:00" }, new Date("2026-09-28T22:00:00Z")), false);
  assert.equal(signupOpen({ state: 5, closes: "2026-10-28T23:55:00" }, new Date("2026-09-28T12:00:00Z")), false, "sign-up closed");
});

test("due only 03:23-03:38 local, never on a discovery minute", () => {
  assert.equal(calendarDue(new Date("2026-09-28T01:23:00Z")), true);
  assert.equal(calendarDue(new Date("2026-09-28T01:27:00Z")), false);
  assert.equal(calendarDue(new Date("2026-09-28T01:39:00Z")), false);
  assert.equal(calendarDue(new Date("2026-09-28T03:23:00Z")), false);
  assert.equal(calendarDue(new Date("2026-11-02T02:23:00Z")), true, "winter time: 03:23 CET");
});

test("nightly build: 22 events within 200 km, over two ticks of at most 45 calls; KV written only on change", async () => {
  const state = install({}), PUSH = kv();
  PUSH.m.set("disc", JSON.stringify(DISC));
  const env = { PUSH, ORIGIN: "x", RANK_OFF: "1" };
  const perTick = [];
  let r;
  for (let i = 0; i < 6; i++) {
    const n0 = state.calls.length;
    _resetMemory();
    r = await tick({ ...env, NOW: at(NIGHT, i) });
    perTick.push(state.calls.length - n0);
    if (PUSH.m.has("cal")) break;
  }
  assert.deepEqual(perTick, [40, 20], "list 1 + 22 x (info + classes) + 9 radius bands + 6 caps = 60 calls, 40 + 20");
  assert.ok(perTick.every(n => n <= 45));
  assert.equal(state.calls.filter(c => /GetOrganisationEventsAsync/.test(c) && !/radiusKm=200/.test(c)).length, 9, "radius bands");
  assert.ok(state.calls.every(c => !/GetPlayersForClassAsync|ParticipatedEventsAsync/.test(c)), "no per-player calls");
  const cal = JSON.parse(PUSH.m.get("cal"));
  assert.equal(cal.events.length, 22);
  assert.ok(cal.events.every(e => e.km <= 200 && kmFromHome(e.id) <= 200));
  assert.ok(!cal.events.some(e => [73041, 74476, 73759].includes(e.id)), "Karlstad, Göteborg, Växjö: too far");
  assert.deepEqual(cal.events.map(e => e.start), cal.events.map(e => e.start).slice().sort(), "sorted by start");
  const by = id => cal.events.find(e => e.id === id);
  assert.deepEqual([by(73554).km, by(73554).approx, by(73468).km, by(73468).approx, by(73829).km, by(71858).km, by(71858).approx], [36, undefined, 30, 1, 40, 200, 1],
    "own coordinates: haversine; none: the smallest radius that lists it (Jordbro 30, Södertälje 40), else 200");
  assert.deepEqual(by(73468).classes.map(c => c.name), ["Herr B", "Dam B", "Herr C", "Dam C", "Herr D", "Dam D", "Mix"]);
  assert.deepEqual([by(73468).name, by(73468).club, by(73468).city, by(73468).closes, by(73468).state, by(73468).url],
    ["Padelverket Fall Open", "Padelverket Haninge Sportklubb", "Jordbro", "2026-10-13T23:55:00", 1, "https://www.rankedin.com/sv/tournament/73468/padelverket-fall-open-sanktionerade-b-c-d-och-mix-klasser"]);
  assert.deepEqual(by(73554).regs, [{ pid: 1675246, classId: 173729 }, { pid: 1849853, classId: 173729 }], "Thea and Cassandra entered (from the discovery)");
  assert.deepEqual(cal.caps, { d: "2026-09-28", M: { B: 386.84, C: 126.85, D: 12.3 }, F: { B: 420.27, C: 132.13, D: 21 } });
  assert.ok(JSON.stringify(cal).length < 25000, "compact: " + JSON.stringify(cal).length);
  assert.ok(PUSH.puts.filter(k => k === "cal").length === 1 && PUSH.puts.filter(k => k === "calw").length === 2);

  // Done for the night: the later minutes do nothing (one KV read)
  const c0 = state.calls.length, p0 = PUSH.ops.put;
  r = await tick({ ...env, NOW: at(NIGHT, 5) });
  assert.equal(state.calls.length, c0); assert.equal(PUSH.ops.put, p0);

  // Next night, nothing changed: coordinates and caps are kept (no bands, no ranking calls), "cal" is not written
  _resetMemory();
  const n1 = state.calls.length, puts1 = PUSH.puts.length;
  for (let i = 0; i < 3; i++) { _resetMemory(); await tick({ ...env, NOW: at("2026-09-29T01:23:00Z", i) }); }
  const night2 = state.calls.slice(n1);
  assert.equal(night2.length, 45, "1 list + 44");
  assert.ok(!night2.some(c => /radiusKm=(?!200)/.test(c) || /SearchRankingPlayersAsync/.test(c)));
  assert.deepEqual(PUSH.puts.slice(puts1), ["calw", "calw"], "no cal write");

  // A new entry in a class: written
  state.over = { "/tournament/GetClassesSectionAsync?tournamentId=73468": { Classes: CF("classes_73468").Classes.map(c => c.ClassId === 173514 ? { ...c, PlayersCount: 2 } : c) } };
  const puts2 = PUSH.puts.length;
  for (let i = 0; i < 3; i++) { _resetMemory(); await tick({ ...env, NOW: at("2026-09-30T01:23:00Z", i) }); }
  assert.ok(PUSH.puts.slice(puts2).includes("cal"));
  assert.equal(JSON.parse(PUSH.m.get("cal")).events.find(e => e.id === 73468).classes[1].players, 2);

  // GET /cal: registrations as the discovery has them now, cached an hour
  const d2 = { ...DISC, events: DISC.events.concat([{ key: "t173515-kian", kind: "tournament", who: "kian", pid: 1680004, partnerId: 99, tournamentId: 73468, classId: 173515 }]) };
  PUSH.m.set("disc", JSON.stringify(d2));
  _resetMemory();
  const res = await worker.fetch(new Request("https://w/cal"), { PUSH, ORIGIN: "x", NOW: "2026-09-30T08:00:00Z" });
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  const body = await res.json();
  assert.deepEqual(body.events.find(e => e.id === 73468).regs, [{ pid: 1680004, classId: 173515 }]);
  const ev = await (await worker.fetch(new Request("https://w/events"), { PUSH, ORIGIN: "x", NOW: "2026-09-30T08:00:00Z" })).json();
  assert.equal(ev.cal, undefined, "/events stays small");
});

test("the day's other work keeps its share: a step never takes the last 5 subrequests", async () => {
  install({});
  const PUSH = kv();
  let n = 0;
  const budgeted = async path => { if (n >= 7) { const e = new Error("subrequest budget"); e.budget = true; throw e; } n++; return route(path); };
  const r1 = await calendarStep(budgeted, new Date(NIGHT), null, null, DISC);
  assert.equal(r1.cal, null); assert.equal(n, 7);
  assert.equal(r1.w.list.length, 22); assert.equal(Object.keys(r1.w.info).length, 3, "resumes where it stopped");
  // index.js: budget.left 12 -> the calendar gets 7
  const { runCalendar } = await import("../src/index.js");
  const budget = { left: 12 }, log = {};
  await runCalendar({ PUSH }, new Date(NIGHT), budget, null, log);
  assert.deepEqual([log.cal, budget.left], [7, 5]);
});

test("a failing event keeps last night's data; not due: no calls at all", async () => {
  const state = install({}), PUSH = kv();
  await tick({ PUSH, ORIGIN: "x", RANK_OFF: "1", NOW: "2026-09-28T10:23:00Z" });
  assert.ok(!state.calls.some(c => /GetOrganisationEventsAsync|GetClassesSectionAsync/.test(c)));
  const prev = { caps: { d: "2026-09-28", M: { B: 1, C: 1, D: 1 }, F: { B: 1, C: 1, D: 1 } }, events: [{ id: 73468, name: "Old", club: "X", city: "Jordbro", lat: 0, lon: 0, km: 30, approx: 1, start: "2026-10-16T09:00:00", closes: "2026-10-13T23:55:00", state: 1, classes: [{ id: 1 }] }] };
  const get = async p => { if (/73468/.test(p)) throw new Error("RankedIn HTTP 500"); return route(p); };
  let w = null, cal = null;
  for (let i = 0; i < 3 && !cal; i++) ({ w, cal } = await calendarStep(get, new Date(NIGHT), w, prev, DISC));
  const j = cal.events.find(e => e.id === 73468);
  assert.deepEqual([j.km, j.approx, j.classes, j.closes], [30, 1, [{ id: 1 }], "2026-10-13T23:55:00"]);
});

test("SPF eligibility: the pair cap decides; own class and one above; the class below with a weaker partner", () => {
  const caps = { M: { B: 386.84, C: 126.85, D: 12.3 }, F: { B: 420.27, C: 132.13, D: 21 } };
  assert.deepEqual(eligibility(caps, "F", 68.695, 150), { base: "B", levels: ["B", "A"], cap: 420.27, lower: { level: "C", partnerMax: 63.44 } }, "Thea: B, C with a partner up to 63.44");
  assert.deepEqual(eligibility(caps, "M", 11.99, 789).levels, ["C", "B"], "Kian: C and B");
  assert.equal(baseLevel(caps, "M", 6.15), "D", "exactly the cap: D (2 x 6.15 = 12.3)");
  assert.equal(baseLevel(caps, "M", 6.16), "C");
  assert.equal(baseLevel(caps, "M", 250), "A");
  assert.equal(baseLevel(caps, "F", null, null), "D", "not ranked: D");
  assert.equal(baseLevel(null, "F", null, 51), "B", "no caps: by standing (women 51-160 B)");
  assert.equal(baseLevel(null, "M", null, 60), "A");
  assert.equal(eligibility(caps, "M", 250).lower.level, "B");
  assert.equal(eligibility(caps, "M", 0).lower, null, "D: nothing below");
  const cal = { caps, events: [
    { id: 1, start: "2026-10-01", closes: "2026-09-30T23:00:00", state: 1, regs: [], classes: [{ id: 11, level: "B", gender: "F" }, { id: 12, level: "C", gender: "F" }, { id: 13, level: "A", gender: "F" }] },
    { id: 2, start: "2026-10-02", closes: "2026-09-30T23:00:00", state: 1, regs: [{ pid: 7, classId: 21 }], classes: [{ id: 21, level: "B", gender: "F" }] },
    { id: 3, start: "2026-10-03", closes: "2026-09-27T23:00:00", state: 1, regs: [], classes: [{ id: 31, level: "B", gender: "F" }] },
    { id: 4, start: "2026-10-04", closes: "2026-09-30T23:00:00", state: 1, regs: [], classes: [{ id: 41, level: "B", gender: "M" }, { id: 42, level: "C", gender: "F" }, { id: 43, level: "other", gender: "mixed" }] },
    { id: 5, start: "2026-10-05", closes: "2026-09-30T23:00:00", state: 5, regs: [], classes: [{ id: 51, level: "B", gender: "F" }] },
    { id: 6, start: "2026-10-06", closes: "2026-09-30T23:00:00", state: 1, regs: [{ pid: 5, classId: 61 }], classes: [{ id: 61, level: "A", gender: "F" }] }] };
  const t = new Date("2026-09-28T12:00:00Z"), P = { pid: 5, gender: "F", pts: 68.695, rank: 150 };
  assert.deepEqual(suggestFor(cal, P, t), [{ id: 1, classes: [11, 13], mates: [] }, { id: 2, classes: [21], mates: [7] }],
    "3: closed, 4: no class at her level (men's B, C is below), 5: sign-up closed, 6: already entered");
  assert.deepEqual(suggestFor(cal, P, t, [1]).map(x => x.id), [2], "entered per the page's own list");
  assert.equal(suggestFor(cal, P, t, [], 1).length, 1);
});

test("calendar runs every 6 hours: 03:23, 09:23, 15:23, 21:23 local, each a new run", async () => {
  const { calendarDue, runOf } = await import("../src/calendar.js");
  const at = s => new Date(s);
  assert.equal(calendarDue(at("2026-09-28T09:25:00+02:00")), true);
  assert.equal(calendarDue(at("2026-09-28T15:30:00+02:00")), true);
  assert.equal(calendarDue(at("2026-09-28T21:24:00+02:00")), true);
  assert.equal(calendarDue(at("2026-09-28T12:25:00+02:00")), false);
  assert.equal(calendarDue(at("2026-09-28T09:27:00+02:00")), false, "never a discovery minute");
  assert.notEqual(runOf(at("2026-09-28T03:30:00+02:00")), runOf(at("2026-09-28T09:30:00+02:00")));
  assert.equal(runOf(at("2026-09-28T09:23:00+02:00")), runOf(at("2026-09-28T09:38:00+02:00")));
});
