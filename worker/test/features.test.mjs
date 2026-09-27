// New notiser: draw published, time/court change of the next match, deep links; past events in GET /events;
// the service worker's notificationclick (postMessage to an open page instead of a reload).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import worker, { tick, _resetMemory, pastOf, drawChecks } from "../src/index.js";
import { parse, snapshot, notes, drawNote, unpack, tcOf, dowOf } from "../src/rankedin.js";
import { install, A } from "./fake-rankedin.mjs";
import { makeSubscription, makeVapid } from "./helpers.mjs";

const F = n => JSON.parse(readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const clone = x => JSON.parse(JSON.stringify(x));
const DC = { who: "thea", me: "Thea Holmberg Löving", cls: "Damer C", classId: 164681 };
function kv() {
  const m = new Map(), ops = { get: 0, put: 0, delete: 0, list: 0 };
  return { m, ops,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; m.set(k, v); },
    async delete(k) { ops.delete++; m.delete(k); },
    async list({ prefix }) { ops.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
// Change date/court of one match in a knockout fixture
function move(data, mid, date, court) {
  const d = clone(data);
  d.forEach(dr => dr.Elimination && dr.Elimination.DrawData.forEach(col => (col || []).forEach(c => {
    if (c && c.MatchId === mid) { if (date) c.Date = date; if (court) c.CourtName = court; }
  })));
  return d;
}
beforeEach(() => _resetMemory());

test("snapshot keeps time@court; unpack reads old records (no schedule) as unknown", () => {
  const m = parse([F("dc_1112.json")]), s = snapshot(m);
  assert.equal(s["6872156"], "6440356,6440363,,2026-09-27T12:45@Bana 1");
  assert.deepEqual(unpack(s["6872156"]), { a: "6440356", b: "6440363", w: "", tc: "2026-09-27T12:45@Bana 1" });
  assert.deepEqual(unpack("6440356,6440360,"), { a: "6440356", b: "6440360", w: "", tc: null });
  assert.equal(tcOf({ date: "2026-10-09T18:00:00", c: "Bana 3, inne" }), "2026-10-09T18:00@Bana 3  inne");
  assert.equal(dowOf("2026-10-09T18:00:00"), "fre");
});

test("time/court change of Thea's next match: one notis, deep link, same tag for later changes", () => {
  const base = F("dc_1112.json"), before = snapshot(parse([base]));
  const later = move(base, 6872156, "2026-09-27T13:15:00", "Bana 2");
  let n = notes(DC, parse([later]), before);
  assert.deepEqual(n.map(x => x.title), ["Ny tid: Thea och Cassandra spelar kvartsfinalen 13:15, Bana 2"]);
  assert.equal(n[0].body, "Förut 12:45, Bana 1. Mot Pettersson Österberg / Ekeland.");
  assert.equal(n[0].tag, "padel-164681:tid:m6872156");
  assert.equal(n[0].url, "./#thea/m6872156");
  // Court only
  n = notes(DC, parse([move(base, 6872156, null, "Bana 4")]), before);
  assert.deepEqual(n.map(x => x.title), ["Ny bana: Thea och Cassandra spelar kvartsfinalen 12:45, Bana 4"]);
  // Another day: weekday in both times
  n = notes(DC, parse([move(base, 6872156, "2026-09-28T09:00:00", null)]), before);
  assert.equal(n[0].title, "Ny tid: Thea och Cassandra spelar kvartsfinalen mån 09:00, Bana 1");
  assert.equal(n[0].body, "Förut sön 12:45, Bana 1. Mot Pettersson Österberg / Ekeland.");
  // Nothing changed / a match that is not Thea's changed -> nothing
  assert.deepEqual(notes(DC, parse([base]), before), []);
  assert.deepEqual(notes(DC, parse([move(base, 6872151, "2026-09-27T16:00:00", "Bana 6")]), before), []);
});

test("time change: silent after a deploy (old KV record without schedule) and when another notis already has the time", () => {
  const base = F("dc_1112.json"), old = {};
  Object.entries(snapshot(parse([base]))).forEach(([k, v]) => { old[k] = v.split(",").slice(0, 3).join(","); });
  assert.deepEqual(notes(DC, parse([move(base, 6872156, "2026-09-27T13:15:00", "Bana 2")]), old), []);
  // The QF win names the semifinal with its (new) time; no extra "Ny tid"
  const won = F("dc_wins_qf.json"), b2 = snapshot(parse([base]));
  const n = notes(DC, parse([won]), b2);
  assert.ok(n.every(x => !/^Ny (tid|bana)/.test(x.title)), JSON.stringify(n));
  // Opponent became known and the time moved in the same update: one "möter" notis, with the new time
  const n2 = notes(DC, parse([move(base, 6872156, "2026-09-27T13:15:00", null)]), snapshot(parse([F("dc_1031.json")])));
  assert.deepEqual(n2.map(x => x.title), ["Thea och Cassandra möter Pettersson Österberg / Ekeland"]);
  assert.match(n2[0].body, /Kvartsfinal 13:15 · Bana 1$/);
  // First schedule (no time/court before) is not a change: no "Förut ." notis
  const unsched = snapshot(parse([move(base, 6872156, "0001-01-01T00:00:00", " ")]));
  assert.deepEqual(notes(DC, parse([base]), unsched), []);
  const noCourt = snapshot(parse([move(base, 6872156, null, " ")]));
  assert.deepEqual(notes(DC, parse([base]), noCourt), []);
});

test("drawNote: knockout (first opponent, weekday, court) and groups (group mates, first match)", () => {
  const ko = drawNote({ ...DC, name: "Järfälla Padel Open no 11" }, parse([F("dc_1112.json")]));
  assert.deepEqual(ko, { title: "Lottningen klar: Thea och Cassandra möter Pettersson Österberg / Ekeland", body: "Sön 12:45, Bana 1. Järfälla Padel Open no 11, Damer C.",
    tag: "padel-164681:lottning", url: "./#thea/m6872156" });
  // Published late (first round already played): the first match still to play; opponent not known yet
  const late = drawNote({ ...DC, name: "Järfälla Padel Open no 11" }, parse([F("dc_1031.json")]));
  assert.deepEqual([late.title, late.url], ["Lottningen klar: Thea och Cassandra börjar i kvartsfinalen", "./#thea/m6872156"]);
  const vista = { who: "thea", me: "Thea Holmberg Löving", cls: "Dam B", classId: 173729, name: "Vista Padel Autumn Smash Open" };
  const rr = drawNote(vista, parse([F("vista_rr_new.json")]));
  assert.equal(rr.title, "Lottningen klar: Thea och Nathalie i gruppen");
  assert.equal(rr.body, "Med P A / Lindgren, Dolfie / Öberg, Ahlin / Ivarsson. Första match lör 09:00, Bana 2. Vista Padel Autumn Smash Open, Dam B.");
  assert.equal(rr.url, "./#thea/m6773468");
  assert.equal(rr.tag, "padel-173729:lottning");
  const none = drawNote({ ...vista, me: "Någon Annan" }, parse([F("vista_rr_new.json")]));
  assert.deepEqual([none.title, none.url], ["Lottningen klar i Dam B", "./#thea"]);
});

const VISTA = { key: "t173729-thea", kind: "tournament", who: "thea", me: "Thea Holmberg Löving", pid: 1675246, tournamentId: 73554, classId: 173729,
  cls: "Dam B", name: "Vista Padel Autumn Smash Open", windowFrom: "2026-10-09T07:00:00+02:00", windowTo: "2026-10-11T23:00:00+02:00", cover: ["173729"] };
const published = () => A("t73554_classnames_draws").map(x => x.Id === 173729 ? { ...x, TournamentDraws: [{ Id: 1, Name: "Dam B", Stage: 0, Strength: 0 }] } : x);

test("draw published (worker): baseline at minute 37, one push when it appears, then quiet; other minutes do nothing", async () => {
  const st = install({}), v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-10-05T16:37:00Z" };
  const a = await makeSubscription("https://fcm.googleapis.com/fcm/send/a");
  await worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" }, body: JSON.stringify({ subscription: a.sub }) }), env);
  st.over = { "/tournament/GetDrawsForStageAndStrengthAsync*": F("vista_rr_new.json") };
  let r = await tick(env, [VISTA]);
  assert.equal(PUSH.m.get("pub:173729"), "0", "first look: not published, remembered");
  assert.equal(st.pushes.length, 0);
  const puts = PUSH.ops.put;
  r = await tick({ ...env, NOW: "2026-10-05T17:37:00Z" }, [VISTA]);
  assert.equal(PUSH.ops.put, puts, "no change, no write");
  st.calls.length = 0;
  st.over["/tournament/GetClassesAndDrawNamesAsync/?tournamentId=73554"] = published();
  await tick({ ...env, NOW: "2026-10-05T17:38:00Z" }, [VISTA]);
  assert.equal(st.calls.length, 0, "only at minute 37");
  r = await tick({ ...env, NOW: "2026-10-05T18:37:00Z" }, [VISTA]);
  assert.equal(r.drawn, 1);
  assert.equal(PUSH.m.get("pub:173729"), "1");
  assert.equal(st.pushes.length, 1);
  const msg = JSON.parse(await a.decrypt(st.pushes[0].init.body));
  assert.equal(msg.title, "Lottningen klar: Thea och Nathalie i gruppen");
  assert.equal(msg.url, "./#thea/m6773468");
  assert.equal(msg.tag, "padel-173729:lottning");
  r = await tick({ ...env, NOW: "2026-10-05T19:37:00Z" }, [VISTA]);
  assert.equal(st.pushes.length, 1, "told once");
  // More than 7 days ahead: not checked at all
  st.calls.length = 0;
  await tick({ ...env, NOW: "2026-09-30T16:37:00Z" }, [{ ...VISTA, classId: 999, key: "x" }]);
  assert.equal(st.calls.length, 0);
});

test("draw published: already there at the first look = baseline (no push); Kian's prefs respected", async () => {
  const st = install({}), PUSH = kv(), log = {};
  st.over = { "/tournament/GetClassesAndDrawNamesAsync/?tournamentId=73554": published(), "/tournament/GetDrawsForStageAndStrengthAsync*": F("vista_rr_new.json") };
  const budget = { left: 45 };
  const msgs = await drawChecks({ PUSH }, new Date("2026-10-05T16:37:00Z"), [VISTA], budget, log);
  assert.deepEqual(msgs, []);
  assert.equal(PUSH.m.get("pub:173729"), "1");
  assert.equal(45 - budget.left, 1, "one RankedIn call: the class list");
});

test("draw checks stay inside the subrequest budget together with discovery (first run at minute 37)", async () => {
  const st = install({}), PUSH = kv();
  st.over = { "/tournament/GetClassesAndDrawNamesAsync/?tournamentId=73554": A("t73554_classnames_draws") };
  const r = await tick({ PUSH, NOW: "2026-10-05T16:37:00Z", ORIGIN: "https://padel.holmberg.st" });
  assert.ok(r.discovered > 0);
  assert.ok(st.calls.length <= 45, "calls " + st.calls.length);
  assert.equal(PUSH.m.get("pub:173729"), "0");
});

test("past events: an event that leaves the list after its last day is kept (60 days) and served by GET /events", async () => {
  const t = new Date("2026-09-28T09:07:00Z");
  const e1 = { key: "t164681-thea", kind: "tournament", windowTo: "2026-09-27T23:00:00+02:00" }, e2 = { key: "t1-thea", kind: "tournament", windowTo: "2026-10-11T23:00:00+02:00" };
  const past = pastOf({ events: [e1, e2], past: [{ key: "old", windowTo: "2026-06-01T23:00:00+02:00" }, { key: "t9", windowTo: "2026-09-13T23:00:00+02:00" }] }, [e2], t);
  assert.deepEqual(past.map(p => p.key), ["t164681-thea", "t9"], "newest first, older than 60 days dropped");
  assert.deepEqual(pastOf({ events: [e2] }, [], t), [], "an upcoming event that disappears (withdrawn) is not past");

  install({});
  const PUSH = kv(), env = { PUSH, ORIGIN: "https://padel.holmberg.st" };
  PUSH.m.set("disc", JSON.stringify({ at: "2026-09-28T09:07:00Z", events: [e2], ended: [], past }));
  const body = await (await worker.fetch(new Request("https://w/events"), env)).json();
  assert.deepEqual(body.past.map(p => p.key), ["t164681-thea", "t9"]);
});

test("discovery run the day after Järfälla: the finished classes move to past (one KV write)", async () => {
  const st = install({}), PUSH = kv();
  let r = await tick({ PUSH, NOW: "2026-09-27T11:07:00Z", ORIGIN: "x" });
  assert.ok(JSON.parse(PUSH.m.get("disc")).events.some(e => e.key === "t164681-thea"));
  _resetMemory();
  st.over = { "/tournament/GetInfoAsync?id=66374&language=en": { TournamentSidebarModel: { EventState: 4, StartDate: "2026-09-25T17:00:00", EndDate: "2026-09-27T23:00:00" } } };
  r = await tick({ PUSH, NOW: "2026-09-28T09:07:00Z", ORIGIN: "x" });
  const rec = JSON.parse(PUSH.m.get("disc"));
  assert.ok(!rec.events.some(e => e.key === "t164681-thea"));
  assert.deepEqual(rec.past.map(p => p.key).sort(), ["t164677-kian", "t164681-thea"]);
  assert.equal(rec.past.find(p => p.key === "t164681-thea").name, "Järfälla Padel Open no 11");
});

// sw.js runs in a service worker global; load it into a sandbox with fake clients.
function loadSW(clients) {
  const handlers = {}, calls = [];
  const self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    registration: { scope: "https://padel.holmberg.st/", showNotification: (t, o) => { calls.push(["show", t, o]); return Promise.resolve(); } },
    clients: { matchAll: async () => clients, openWindow: async u => { calls.push(["open", u]); return null; }, claim: async () => {} },
    skipWaiting() {}, location: { origin: "https://padel.holmberg.st" }
  };
  vm.runInNewContext(readFileSync(new URL("../../sw.js", import.meta.url), "utf8"), { self, caches: {}, fetch: () => {}, URL, Promise, Response: {} });
  return { handlers, calls };
}
function click(h, url) {
  let p;
  h.notificationclick({ notification: { data: { url }, close() {} }, waitUntil: x => { p = x; } });
  return p;
}
test("sw.js: notificationclick focuses an open page and posts the deep link (no reload); otherwise opens it", async () => {
  const msgs = [], nav = [];
  const client = { url: "https://padel.holmberg.st/#kian", focus: async () => client, postMessage: m => msgs.push(m), navigate: async u => { nav.push(u); return client; } };
  let { handlers, calls } = loadSW([client]);
  await click(handlers, "./#thea/m6872156");
  assert.deepEqual(JSON.parse(JSON.stringify(msgs)), [{ type: "padel-open", url: "https://padel.holmberg.st/#thea/m6872156", hash: "#thea/m6872156" }]);
  assert.deepEqual(nav, []);
  ({ handlers, calls } = loadSW([]));
  await click(handlers, "./#thea/m6872156");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["open", "https://padel.holmberg.st/#thea/m6872156"]]);
  // push payload url is kept on the notification
  ({ handlers, calls } = loadSW([]));
  let p;
  handlers.push({ data: { json: () => ({ title: "T", body: "B", tag: "padel-x", url: "./#kian/m1" }) }, waitUntil: x => { p = x; } });
  await p;
  assert.equal(calls[0][2].data.url, "./#kian/m1");
});

test("module exports are functions or the handler object (workerd refuses anything else)", async () => {
  const mod = await import("../src/index.js");
  for (const [k, v] of Object.entries(mod)) assert.ok(typeof v === "function" || (k === "default" && typeof v.fetch === "function" && typeof v.scheduled === "function"), k);
});

test("draw check: every 15 min within 48 h of the start, hourly up to 7 days", async () => {
  const { drawChecks } = await import("../src/index.js");
  const seen = [];
  const env = { PUSH: { get: async () => "0", put: async () => {} }, API_BASE: "http://x" };
  const t = new Date("2026-10-08T10:22:00+02:00");
  const near = { kind: "tournament", who: "thea", tournamentId: 1, classId: 11, windowFrom: "2026-10-09T07:00:00+02:00", windowTo: "2026-10-11T23:00:00+02:00" };
  const far = { ...near, tournamentId: 2, classId: 22, windowFrom: "2026-10-13T07:00:00+02:00", windowTo: "2026-10-13T23:00:00+02:00" };
  const orig = globalThis.fetch;
  globalThis.fetch = async u => { seen.push(String(u)); return new Response("[]", { status: 200 }); };
  try {
    await drawChecks(env, t, [near, far], { left: 45 }, {}, 2 * 24 * 3600e3);
    assert.equal(seen.length, 1, seen.join(" "));
    seen.length = 0;
    await drawChecks(env, t, [near, far], { left: 45 }, {});
    assert.equal(seen.length, 2, seen.join(" "));
  } finally { globalThis.fetch = orig; }
});

test("ranking: baseline silent, new Monday list -> one notis per player, unchanged -> no write", async () => {
  const { rankingChecks } = await import("../src/index.js");
  const store = new Map(), puts = [];
  const env = { PUSH: { get: async k => store.get(k) ?? null, put: async (k, v) => { puts.push(k); store.set(k, v); } }, API_BASE: "http://x" };
  let list = { d: "2026-09-21T00:00:00", s: 150, p: 68.695 };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Payload: [{ Participant: { NewParticipantId: 1675246 }, ParticipantPoints: { RankingDate: list.d, Standing: list.s, Points: list.p } }] }));
  const P = [{ who: "thea", pid: 1675246, name: "Thea", q: "Holmberg", rt: 4, ag: 83, list: "Dam huvudlista" }];
  try {
    const t = new Date("2026-09-27T20:52:00+02:00");
    assert.deepEqual(await rankingChecks(env, t, { left: 45 }, {}, P), []);
    assert.equal(puts.length, 1);
    assert.deepEqual(await rankingChecks(env, t, { left: 45 }, {}, P), []);
    assert.equal(puts.length, 1, "unchanged: no KV write");
    list = { d: "2026-09-28T00:00:00", s: 142, p: 78.695 };
    const n = await rankingChecks(env, new Date("2026-09-28T03:52:00+02:00"), { left: 45 }, {}, P);
    assert.equal(n.length, 1);
    assert.equal(n[0].m.title, "Ny ranking: Thea #142 ▲︎ 8 platser");
    assert.equal(n[0].m.body, "78.7 p (+10.0) · Dam huvudlista");
    assert.equal(n[0].m.url, "./#thea");
  } finally { globalThis.fetch = orig; }
});
