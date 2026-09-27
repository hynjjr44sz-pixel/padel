import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { tick, _resetMemory, discoveryDue, discoveryBatch, runDiscovery } from "../src/index.js";
import { discover, cleanName, ratingFor, photoOf, PLAYERS } from "../src/discover.js";
import { localToDate, isoLocal, dayOf } from "../src/tz.js";
import { merge } from "../src/events.js";
import { install, A, CDN } from "./fake-rankedin.mjs";
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

  // Cassandra plays Damer C with Thea: her own entry, same class (the live unit is shared).
  const cas = by("t164681-cassandra");
  assert.deepEqual([cas.partner, cas.partnerId, cas.pid], ["Thea Holmberg Löving", 1675246, 1849853]);
  assert.equal(by("t164677-andreas").partner, "Kian Borgström");

  // SPL: one entry per team and play day (not one per player), with every roster player of the team.
  const spl = res.events.filter(e => e.kind === "teamleague" && e.teamId === 3355655);
  assert.equal(spl.length, 5, "five play days left");
  assert.deepEqual([spl[0].date, spl[0].name, spl[0].team, spl[0].division, spl[0].round], ["2026-10-04", "SPL Damer", "Nynäs Damlag", "Div 3 Öst - Södra", 1]);
  assert.deepEqual(spl[0].ties.map(t => [t.id, t.home, t.opp, t.time]), [[166800, false, "Team TK x Rejoice", ""], [166802, true, "CC Academy UNO Nacka 2", ""]]);
  assert.deepEqual(spl[0].cover, ["tm166800", "tm166802"]);
  assert.equal(spl[0].who, "thea", "Thea first (old links and pages)");
  assert.deepEqual(spl[0].pids.slice().sort(), PLAYERS.filter(p => p.teamId === 3355655).map(p => p.pid).sort());
  assert.ok(spl[0].players.includes("Thea Holmberg Löving") && spl[0].players.includes("Lisa Brinklöv"));
  const kspl = res.events.find(e => e.kind === "teamleague" && e.teamId === 3383536);
  assert.deepEqual([kspl.who, kspl.date, kspl.windowFrom, kspl.ties[0].id, kspl.ties[0].venue], ["kian", "2026-10-03", "2026-10-03T07:00:00+02:00", 167486, "Vista"]);
  assert.equal(new Set(res.events.map(e => e.key)).size, res.events.length, "no duplicate keys");
  assert.ok(res.ended.includes("l894"), "Klubbligan VT 26 has ended");
  assert.ok(!st.calls.some(c => c.includes("GetHeaderAsync?id=829")), "a league that started 364 days ago is not even looked up");
  assert.ok(!st.calls.some(c => /GetTeamLeagueTeamDetailsAsync|Homepage/.test(c)), "the roster knows its own teams");
  assert.equal(st.calls.filter(c => c.startsWith("/teamleague/GetTeamMatchesAsync?teamid=3355655")).length, 1, "shared lookups once per run");

  // Second run with the first as prev: no player scans, the ended league is skipped, same list.
  st.calls.length = 0;
  const again = await discover(getter(st), NOW, { events: res.events, ended: res.ended, none: res.none });
  assert.deepEqual(again.events, res.events);
  assert.ok(!st.calls.some(c => /GetPlayersForClassAsync|GetHeaderAsync\?id=894|Homepage/.test(c)), st.calls.join("\n"));
  const prof = st.calls.filter(c => c.startsWith("/player/playerprofileinfoasync"));
  assert.equal(prof.length, PLAYERS.length, "one profile call per player");
  assert.ok(st.calls.length - prof.length <= PLAYERS.length + 8, "fetches: " + st.calls.length);
});

test("discover: a batch replaces only its own players' entries and its teams' play days", async () => {
  const st = install({});
  const full = await discover(getter(st), NOW, null);
  const prev = { events: full.events, ended: full.ended, none: full.none };
  // Kian withdraws from Järfälla; only Kian and Andreas are looked up.
  st.over = { "/tournament/GetPlayersForClassAsync?tournamentId=66374&tournamentClassId=164677&language=en": { Participants: [] } };
  const kian = PLAYERS.filter(p => p.who === "kian");
  const res = await discover(getter(st), new Date(+NOW + 2 * 864e5), { ...prev, events: prev.events.map(e => ({ ...e, scanned: "2026-09-01T00:00:00Z" })) }, kian);
  assert.deepEqual(res.refreshed, ["kian"]);
  assert.ok(!res.events.some(e => e.key === "t164677-kian"), "Kian's entry is gone");
  assert.ok(res.events.some(e => e.key === "t164677-andreas"), "Andreas was not looked up: kept");
  assert.ok(res.events.some(e => e.key === "t173729-thea"), "Thea kept");
  assert.equal(res.events.filter(e => e.kind === "teamleague" && e.teamId === 3383536).length, full.events.filter(e => e.kind === "teamleague" && e.teamId === 3383536).length);
});

test("rotation: 4 players per 10 minutes, the whole roster within 40-50 minutes; at most 35 RankedIn calls per run", async () => {
  const seen = new Set(), t0 = Date.parse("2026-09-27T11:07:00Z");
  for (let k = 0; k < Math.ceil(PLAYERS.length / 4); k++) discoveryBatch(new Date(t0 + k * 600e3)).forEach(p => seen.add(p.who));
  assert.equal(seen.size, PLAYERS.length);
  assert.equal(discoveryBatch(new Date(t0)).length, 4);

  const st = install({}), PUSH = kv(), log = {};
  const budget = { left: 45 };
  let rec = await runDiscovery({ PUSH }, new Date(t0), budget, null, log);
  assert.ok(45 - budget.left <= 35, "first run (everyone): " + (45 - budget.left));
  // Keep running the batches until the whole roster has been looked up; each run stays inside 35 calls.
  for (let k = 1; k <= 8; k++) {
    _resetMemory();
    const b = { left: 45 };
    st.calls.length = 0;
    rec = await runDiscovery({ PUSH }, new Date(t0 + k * 600e3), b, rec, {});
    assert.ok(st.calls.length <= 35, "run " + k + ": " + st.calls.length);
  }
  assert.ok(rec.events.some(e => e.key === "t164677-andreas") && rec.events.some(e => e.key === "t164681-cassandra") && rec.events.some(e => e.key === "t173729-thea"));
  // Nothing changes any more: no KV write for the next rounds.
  const puts = PUSH.ops.put;
  for (let k = 9; k <= 12; k++) { _resetMemory(); await runDiscovery({ PUSH }, new Date(t0 + k * 600e3), { left: 45 }, rec, {}); }
  assert.equal(PUSH.ops.put, puts, "no write when nothing changed");
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
  // The class record carries the home view's summary (no extra write)
  const sum = JSON.parse(PUSH.m.get("st:164681"))._sum;
  assert.ok(sum && sum.nx["1675246"] && sum.nx["1849853"], JSON.stringify(sum));
  assert.equal(sum.nx["1675246"].st, "next");

  // Later discovery rounds with nothing new: no KV write for "disc"
  for (const m of ["11:17", "11:27", "11:37", "11:47", "11:57", "12:07"]) { _resetMemory(); env.NOW = "2026-09-27T" + m + ":00Z"; await tick(env); }
  const puts = PUSH.ops.put;
  _resetMemory();
  env.NOW = "2026-09-27T12:17:00Z";
  r = await tick(env);
  assert.equal(r.refreshed, 4);
  assert.equal(PUSH.ops.put, puts, "nothing changed, nothing written");
  // Minute 8: not due
  _resetMemory();
  st.calls.length = 0;
  env.NOW = "2026-09-27T12:08:00Z";
  await tick(env);
  assert.ok(!st.calls.some(c => c.includes("ParticipatedEvents")));

  const res = await worker.fetch(new Request("https://w/events", { headers: { Origin: "https://padel.holmberg.st" } }), env);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://padel.holmberg.st");
  assert.match(res.headers.get("Cache-Control"), /max-age=120/);
  const body = await res.json();
  assert.equal(body.src, "worker");
  assert.ok(body.events.some(e => e.key === "t173729-thea") && body.events.some(e => e.kind === "teamleague"));
  // Home view: who is playing now (from the live monitoring) and the latest results
  assert.equal(body.live["1675246"].st, "next");
  assert.equal(body.live["1675246"].cls, "Damer C");
  assert.ok(Array.isArray(body.latest));
  const v = await (await worker.fetch(new Request("https://w/vapid"), env)).json();
  assert.ok(v.classes.includes(164681) && v.classes.includes("tm166800") && v.classes.includes(173729));
});

test("discoveryDue: every 10 minutes at :x7, or when nothing is stored", () => {
  const rec = { at: "2026-09-27T10:07:00Z", events: [] };
  assert.equal(discoveryDue(null, new Date("2026-09-27T10:30:00Z")), true);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T10:30:00Z")), false);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T11:07:00Z")), true);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T11:17:00Z")), true);
  assert.equal(discoveryDue(rec, new Date("2026-09-27T16:08:00Z")), false);
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

test("photos: RankedIn profile photos recorded per pid in disc and served in /events; unchanged -> no KV write; a new photo within the rotation", async () => {
  const st = install({}), PUSH = kv(), t0 = Date.parse("2026-09-27T11:07:00Z"), env = { PUSH, ORIGIN: "https://padel.holmberg.st" };
  let rec = null;
  for (let k = 0; k <= 5; k++) { _resetMemory(); rec = await runDiscovery(env, new Date(t0 + k * 600e3), { left: 45 }, rec, {}); }
  const stored = JSON.parse(PUSH.m.get("disc")).photos;
  assert.deepEqual(stored["1055851"], { url: CDN + "900001.png", thumb: CDN + "900001thumb.png", placeholder: false }, "Sanna");
  assert.equal(stored["1702723"].placeholder, true, "Lisa: RankedIn's default logo");
  assert.equal(stored["1680004"].placeholder, false, "Kian (the page keeps his own photo)");
  assert.ok(!stored["1675246"], "no profile answer: nothing recorded");
  assert.ok(Object.keys(stored).every(pid => PLAYERS.some(p => String(p.pid) === pid)), "roster players only");
  env.NOW = new Date(t0 + 5 * 600e3).toISOString();
  const body = await (await worker.fetch(new Request("https://w/events"), env)).json();
  assert.deepEqual(body.photos, stored);

  // A full rotation more with nothing new: profile calls made, no KV write.
  const puts = PUSH.ops.put;
  st.calls.length = 0;
  for (let k = 6; k <= 11; k++) { _resetMemory(); rec = await runDiscovery(env, new Date(t0 + k * 600e3), { left: 45 }, rec, {}); }
  assert.ok(st.calls.filter(c => c.startsWith("/player/playerprofileinfoasync")).length >= PLAYERS.length, "every player's profile looked at");
  assert.equal(PUSH.ops.put, puts, "unchanged photos: no write");

  // Lisa uploads a photo: seen at her next turn in the rotation (under an hour), one write.
  st.over = { "/player/playerprofileinfoasync?rankedinId=R000267664&language=en": { Header: { PlayerId: 1702723, ImageId: 5, ImageOriginalUrl: CDN + "5.png", ImageThumbnailUrl: CDN + "5thumb.png" } } };
  let when = null;
  for (let k = 12; k <= 17 && !when; k++) {
    _resetMemory();
    rec = await runDiscovery(env, new Date(t0 + k * 600e3), { left: 45 }, rec, {});
    if (!rec.photos["1702723"].placeholder) when = k - 12;
  }
  assert.ok(when !== null && when * 10 < 60, "seen within the hour");
  assert.equal(PUSH.ops.put, puts + 1, "one write for the change");
  assert.deepEqual(JSON.parse(PUSH.m.get("disc")).photos["1702723"], { url: CDN + "5.png", thumb: CDN + "5thumb.png", placeholder: false });

  // Profile calls come after the batch's events: out of budget, the events are done and old photos kept.
  _resetMemory();
  const mine = await discover(async path => { if (path.startsWith("/player/playerprofile")) { const e = new Error("budget"); e.budget = true; throw e; } return (await fetch("https://api.rankedin.com/v1" + path)).json(); },
    new Date(t0 + 20 * 600e3), rec, PLAYERS.slice(0, 2));
  assert.equal(mine.partial, false);
  assert.deepEqual(mine.photos, rec.photos);
});

test("photoOf: placeholder, wrong player, bad urls", () => {
  assert.equal(photoOf({ Header: { PlayerId: 1, ImageId: 0, ImageOriginalUrl: "https://cdn.rankedin.com/images/rin_logo_sm.png", ImageThumbnailUrl: "https://cdn.rankedin.com/images/rin_logo_sm.png" } }, 1).placeholder, true);
  assert.equal(photoOf({ Header: { PlayerId: 2, ImageId: 7, ImageOriginalUrl: CDN + "7.png" } }, 1), null, "someone else's profile");
  assert.equal(photoOf({ Header: { PlayerId: 1, ImageId: 7, ImageOriginalUrl: "javascript:alert(1)" } }, 1), null);
  assert.deepEqual(photoOf({ Header: { PlayerId: 1, ImageId: 7, ImageOriginalUrl: CDN + "7.png" } }, 1), { url: CDN + "7.png", thumb: CDN + "7.png", placeholder: false });
  assert.equal(photoOf(null, 1), null);
});
