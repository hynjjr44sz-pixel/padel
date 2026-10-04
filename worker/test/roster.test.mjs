// The club roster (players.json): the worker's copy, follow prefs (old {thea, kian} included), push fan-out
// by follow, and notiser that name the right players when several club players share a class or a tie.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { tick, _resetMemory, followOf, rankingChecks, _internals } from "../src/index.js";
import ROSTER from "../src/players.js";
import { render } from "../sync-players.mjs";
import { parseTie, snapshotTie, tieNotes, tieSummary } from "../src/teamleague.js";
import { install, A, F } from "./fake-rankedin.mjs";
import { makeSubscription, makeVapid } from "./helpers.mjs";

const THEA = 1675246, KIAN = 1680004, CAS = 1849853, REB = 888094, LISA = 1702723, SANNA = 1055851;
const ORIGIN = "https://padel.holmberg.st";
function kv() {
  const m = new Map(), ops = { get: 0, put: 0, delete: 0, list: 0 };
  return { m, ops,
    async get(k) { ops.get++; return m.has(k) ? m.get(k) : null; },
    async put(k, v) { ops.put++; m.set(k, v); },
    async delete(k) { ops.delete++; m.delete(k); },
    async list({ prefix }) { ops.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
const post = (env, body) => worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify(body) }), env);
async function received(st, devs) {
  const out = {};
  for (const [k, d] of Object.entries(devs)) {
    out[k] = await Promise.all(st.pushes.filter(p => p.url === d.sub.endpoint).map(async p => JSON.parse(await d.decrypt(p.init.body))));
  }
  return out;
}
beforeEach(() => _resetMemory());

test("players.json: the worker's copy is in sync; keys and ids unique; Thea and Kian keep their keys", () => {
  const root = JSON.parse(readFileSync(new URL("../../players.json", import.meta.url), "utf8"));
  assert.equal(readFileSync(new URL("../src/players.js", import.meta.url), "utf8"), render(root), "run: node worker/sync-players.mjs");
  assert.equal(new Set(root.map(p => p.key)).size, root.length);
  assert.equal(new Set(root.map(p => p.pid)).size, root.length);
  assert.equal(ROSTER.find(p => p.key === "thea").pid, THEA);
  assert.equal(ROSTER.find(p => p.key === "kian").pid, KIAN);
  for (const p of root) {
    assert.match(p.key, /^[a-z0-9-]+$/, p.name);
    assert.ok(!p.img || (p.imgW > 0 && p.imgH > 0), p.name + ": image size");
    assert.ok([64, 65].includes(p.rid) && p.teamId && p.league, p.name);
  }
});

test("prefs: {follow} kept to roster ids; the old {thea, kian} maps to Thea 1675246 / Kian 1680004", () => {
  assert.deepEqual(followOf({ follow: [CAS, 999, String(THEA), CAS] }), [THEA, CAS].sort((a, b) => a - b));
  assert.deepEqual(followOf({ follow: [] }), []);
  assert.deepEqual(followOf({ thea: true, kian: true }), [THEA, KIAN]);
  assert.deepEqual(followOf({ thea: true, kian: false }), [THEA]);
  assert.deepEqual(followOf({ thea: false }), [KIAN]);
  assert.deepEqual(followOf({}), [THEA, KIAN], "no prefs at all: the old default");
  assert.deepEqual(followOf(null), [THEA, KIAN]);
});

test("POST /subscribe stores {follow}; old prefs are mapped; same follows again = no KV write", async () => {
  const v = await makeVapid(), PUSH = kv(), env = { PUSH, ...v, ORIGIN };
  const a = await makeSubscription("https://fcm.googleapis.com/fcm/send/a"), b = await makeSubscription("https://fcm.googleapis.com/fcm/send/b");
  assert.equal((await post(env, { subscription: a.sub, prefs: { follow: [CAS, THEA] } })).status, 200);
  assert.equal((await post(env, { subscription: b.sub, prefs: { thea: false, kian: true } })).status, 200);
  const recs = [...PUSH.m.values()].map(x => JSON.parse(x).prefs);
  assert.deepEqual(recs.map(p => p.follow), [[THEA, CAS].sort((x, y) => x - y), [KIAN]]);
  const puts = PUSH.ops.put;
  await post(env, { subscription: a.sub, prefs: { follow: [THEA, CAS] } });
  assert.equal(PUSH.ops.put, puts, "same follows (other order): nothing written");
  await post(env, { subscription: a.sub, prefs: { follow: [THEA] } });
  assert.equal(PUSH.ops.put, puts + 1, "follow changed: one write");
});

test("fan-out by follow: Thea and Cassandra in one class; each device gets its players' news once, nothing else", async () => {
  const st = install({}), v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: ORIGIN, ORIGIN, NOW: "2026-09-27T12:00:00+02:00" };
  const devs = {};
  for (const k of ["thea", "cas", "both", "kian", "none"]) devs[k] = await makeSubscription("https://fcm.googleapis.com/fcm/send/" + k);
  const legacyThea = await makeSubscription("https://fcm.googleapis.com/fcm/send/old"), legacyKian = await makeSubscription("https://fcm.googleapis.com/fcm/send/oldk");
  await post(env, { subscription: devs.thea.sub, prefs: { follow: [THEA] } });
  await post(env, { subscription: devs.cas.sub, prefs: { follow: [CAS] } });
  await post(env, { subscription: devs.both.sub, prefs: { follow: [THEA, CAS] } });
  await post(env, { subscription: devs.kian.sub, prefs: { follow: [KIAN] } });
  await post(env, { subscription: devs.none.sub, prefs: { follow: [] } });
  // Records written by the first version of the worker (before this change): {thea, kian} booleans
  PUSH.m.set("sub:old", JSON.stringify({ sub: legacyThea.sub, prefs: { thea: true, kian: false } }));
  PUSH.m.set("sub:oldk", JSON.stringify({ sub: legacyKian.sub, prefs: { thea: false, kian: true } }));
  devs.old = legacyThea; devs.oldk = legacyKian;
  const base = { cls: "Damer C", classId: 164681, tournamentId: 66374, name: "Järfälla Padel Open no 11", draws: [[0, 0]],
    windowFrom: "2026-09-27T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00", kind: "tournament", cover: ["164681"] };
  const evs = [{ ...base, key: "t164681-thea", who: "thea", me: "Thea Holmberg Löving", pid: THEA, partnerId: CAS },
    { ...base, key: "t164681-cassandra", who: "cassandra", me: "Cassandra Ersson", pid: CAS, partnerId: THEA }];
  st.over = { "/tournament/GetDrawsForStageAndStrengthAsync*": F("dc_1031.json") };
  let r = await tick(env, evs);
  assert.equal(st.pushes.length, 0, "baseline");
  assert.equal(r.polled, 1, "one class, one unit for both players");
  st.over = { "/tournament/GetDrawsForStageAndStrengthAsync*": F("dc_1112.json") };
  r = await tick(env, evs);
  const got = await received(st, devs);
  const titles = k => got[k].map(m => m.title);
  const want = ["Thea och Cassandra möter Pettersson Österberg / Ekeland"];
  assert.deepEqual(titles("thea"), want);
  assert.deepEqual(titles("cas"), want);
  assert.deepEqual(titles("both"), want, "one notis, not one per followed player");
  assert.deepEqual(titles("old"), want, "old {thea:true} record");
  assert.deepEqual([titles("kian"), titles("none"), titles("oldk")], [[], [], []]);
  assert.equal(r.sent, 4);
  assert.match(got.thea[0].url, /^\.\/#(thea|cassandra)\/m6872156$/);
});

test("fan-out by language: an es device gets the Spanish title/body, an sv device the Swedish one, in the same tick; es is never sent", async () => {
  const st = install({}), v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: ORIGIN, ORIGIN, NOW: "2026-09-27T12:00:00+02:00", ADMIN_KEY: "adm" };
  const devs = {};
  for (const k of ["sv", "es", "other"]) devs[k] = await makeSubscription("https://fcm.googleapis.com/fcm/send/lang-" + k);
  await post(env, { subscription: devs.sv.sub, prefs: { follow: [THEA] } });
  await post(env, { subscription: devs.es.sub, prefs: { follow: [THEA], lang: "es" } });
  await post(env, { subscription: devs.other.sub, prefs: { follow: [THEA], lang: "de" } });
  const ev = { cls: "Damer C", classId: 164681, tournamentId: 66374, name: "Järfälla Padel Open no 11", draws: [[0, 0]], key: "t164681-thea", who: "thea",
    me: "Thea Holmberg Löving", pid: THEA, windowFrom: "2026-09-27T07:00:00+02:00", windowTo: "2026-09-27T23:00:00+02:00", kind: "tournament", cover: ["164681"] };
  st.over = { "/tournament/GetDrawsForStageAndStrengthAsync*": F("dc_1031.json") };
  await tick(env, [ev]);
  st.over = { "/tournament/GetDrawsForStageAndStrengthAsync*": F("dc_1112.json") };
  const r = await tick(env, [ev]);
  assert.equal(r.sent, 3);
  const got = await received(st, devs);
  assert.deepEqual(got.sv.map(m => [m.title, m.body]), [["Thea och Cassandra möter Pettersson Österberg / Ekeland", "Vann omgång 1 7-6 7-6 mot Lundström / Callero. Kvartsfinal 12:45 · Bana 1"]]);
  assert.deepEqual(got.es.map(m => [m.title, m.body]), [["Thea y Cassandra contra Pettersson Österberg / Ekeland", "Ganaron la ronda 1 7-6 7-6 contra Lundström / Callero. Cuartos de final 12:45 · Pista 1"]]);
  assert.deepEqual(got.other, got.sv, "an unknown language: Swedish");
  assert.deepEqual([got.es[0].tag, got.es[0].url], [got.sv[0].tag, got.sv[0].url], "same tag and link");
  assert.deepEqual(Object.keys(got.es[0]).sort(), ["body", "tag", "title", "url"], "no es field in the payload");
  // Admin test push: each device in its language
  st.pushes.length = 0;
  const res = await worker.fetch(new Request("https://w/test", { method: "POST", headers: { "X-Admin-Key": "adm" } }), env);
  assert.equal(res.status, 200);
  const t = await received(st, devs);
  assert.deepEqual(t.sv.map(m => m.title), ["Testnotis från Nynäs Padel"]);
  assert.deepEqual(t.es.map(m => [m.title, m.body]), [["Notificación de prueba de Nynäs Padel", "Las notificaciones funcionan. Los próximos resultados llegarán aquí."]]);
  assert.ok(!("es" in t.es[0]));
});

test("many pushes folded into one notis per device: the summary in the device's language", async () => {
  const st = install({}), v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: ORIGIN, ORIGIN, NOW: "2026-11-08T12:00:00+01:00" };
  const devs = {};
  for (const k of ["a", "b", "c", "d", "es"]) {
    devs[k] = await makeSubscription("https://fcm.googleapis.com/fcm/send/fold-" + k);
    await post(env, { subscription: devs[k].sub, prefs: { follow: [REB, CAS], ...(k === "es" ? { lang: "es" } : {}) } });
  }
  const ev = { key: "l947-3355655-2026-11-08", kind: "teamleague", who: "thea", pid: THEA, pids: ROSTER.filter(p => p.teamId === 3355655).map(p => p.pid),
    me: "Thea Holmberg Löving", team: "Nynäs Damlag", name: "SPL Damer", round: 2, ties: [{ id: 127649, home: true, opp: "Padelverket Damlag", time: "10:00", venue: "Padelverket" }],
    windowFrom: "2026-11-08T07:00:00+01:00", windowTo: "2026-11-08T23:00:00+01:00", cover: ["tm127649"] };
  const partial = A("tm_127649_matches");
  partial[0].matches.matches.forEach(m => { m.matchResult = null; m.state = 2; });
  st.over = { "/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=127649&language=en": partial };
  await tick(env, [ev]);
  const two = A("tm_127649_matches");   // two matches decided, the tie still on
  two[0].matches.matches[2].matchResult = null; two[0].matches.matches[2].state = 2;
  st.over = { "/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=127649&language=en": two };
  await tick(env, [ev]);   // two notiser for each of 5 devices: more than 8, so folded
  const got = await received(st, devs);
  assert.deepEqual(got.a.map(m => [m.title, m.body, m.tag]), [["2 nya resultat",
    "Thea och Rebecca vann sin match 6-3 6-2\nCassandra och Cecilia förlorade sin match 5-7 1-6", "padel-sammanfattning"]]);
  assert.deepEqual(got.es.map(m => [m.title, m.body, m.tag]), [["2 resultados nuevos",
    "Thea y Rebecca ganaron su partido 6-3 6-2\nCassandra y Cecilia perdieron su partido 5-7 1-6", "padel-sammanfattning"]]);
});

test("SPL tie: each pair's own rubber to its followers, the tie result to the whole team (merged per device)", async () => {
  const roster = ROSTER.filter(p => p.teamId === 3355655).map(p => ({ who: p.key, pid: p.pid }));
  const ev = { who: "thea", pid: THEA, team: "Nynäs Damlag", name: "SPL Damer", round: 2, roster };
  const tie = { id: 127649, home: true, opp: "Padelverket Damlag", time: "10:00", venue: "Padelverket" };
  const all = parseTie(A("tm_127649_matches")), before = snapshotTie(all);
  delete before._done;
  Object.keys(before).forEach(k => { before[k] = before[k].replace(/,[ab]$/, ","); });
  delete before._done;
  // Two matches decided first: each pair's own notis to its followers
  const two = all.map(r => r.id === "5433850" ? { ...r, w: null, s: null } : r);
  const rub = tieNotes(ev, tie, two, before);
  assert.deepEqual(rub.map(x => [x.title.replace(/ [\d-]+( [\d-]+)*$/, ""), x.pids]), [
    ["Thea och Rebecca vann sin match", [THEA, REB]],
    ["Cassandra och Cecilia förlorade sin match", [CAS]]]);
  assert.equal(rub[1].url, "./#cassandra/m5433849");
  // Then the last one: the tie result only; Amanda and Sanna's match rides in it, the earlier two are not repeated
  const last = tieNotes(ev, tie, all, snapshotTie(two));
  assert.ok(last.every(x => x.tag === "padel-tm127649:klar"), last.map(x => x.tag).join(" "));
  assert.deepEqual(last.map(x => [x.pids.sort(), x.body.replace(/ [\d-]+ [\d-]+\.$/, "")]), [[[SANNA], "SPL Damer omgång 2. Amanda och Sanna förlorade sin match"],
    [[THEA, CAS, REB, LISA, 428692].sort(), "SPL Damer omgång 2."]]);
  // All in one look: one notis per device, the tie result with the device's pairs' matches
  const n = tieNotes(ev, tie, all, before);
  assert.equal(n.filter(x => /:r\d+$/.test(x.tag)).length, 0, "no separate match notiser when the tie ends with them");
  const klar = n.filter(x => x.tag === "padel-tm127649:klar");
  assert.ok(klar.every(x => x.title === "Nynäs Damlag förlorade mot Padelverket Damlag 1–2"));
  assert.deepEqual(klar.at(-1).pids.sort(), [LISA, 428692].sort(), "team players who did not play: the result without a match line");
  assert.equal(klar.at(-1).body, "SPL Damer omgång 2.");

  // Device view: merge per tag
  const { mergeForDevice } = _internals();
  const forPids = f => mergeForDevice(n.filter(x => x.pids.some(p => f.includes(p))));
  const tc = forPids([THEA, CAS]);
  assert.deepEqual(tc.map(x => x.title.split(" ").slice(0, 3).join(" ")), ["Nynäs Damlag förlorade"]);
  assert.match(tc[0].body, /^SPL Damer omgång 2\. Thea och Rebecca vann sin match 6-3 6-2\. Cassandra och Cecilia förlorade sin match [\d-]+ [\d-]+\.$/);
  assert.deepEqual(forPids([LISA]).map(x => x.body), ["SPL Damer omgång 2."]);
  assert.deepEqual(forPids([KIAN]), []);

  // Home view summary: finished rubbers of club pairs, tie score
  const sm = tieSummary(ev, tie, all);
  assert.equal(sm.sc, "1–2");
  assert.deepEqual(sm.res.map(r => r.mid), ["5433850", "5433849", "5433848"]);
  assert.deepEqual(sm.res.at(-1).won, [THEA, REB]);
});

test("tick: SPL team play day (roster in the event) pushes to the right followers", async () => {
  const st = install({}), v = await makeVapid(), PUSH = kv();
  const env = { PUSH, ...v, VAPID_SUBJECT: ORIGIN, ORIGIN, NOW: "2026-11-08T12:00:00+01:00" };
  const devs = { reb: await makeSubscription("https://fcm.googleapis.com/fcm/send/reb"), lisa: await makeSubscription("https://fcm.googleapis.com/fcm/send/lisa"),
    kian: await makeSubscription("https://fcm.googleapis.com/fcm/send/kian") };
  await post(env, { subscription: devs.reb.sub, prefs: { follow: [REB] } });
  await post(env, { subscription: devs.lisa.sub, prefs: { follow: [LISA] } });
  await post(env, { subscription: devs.kian.sub, prefs: { follow: [KIAN] } });
  const ev = { key: "l947-3355655-2026-11-08", kind: "teamleague", who: "thea", pid: THEA, pids: ROSTER.filter(p => p.teamId === 3355655).map(p => p.pid),
    me: "Thea Holmberg Löving", team: "Nynäs Damlag", name: "SPL Damer", round: 2, ties: [{ id: 127649, home: true, opp: "Padelverket Damlag", time: "10:00", venue: "Padelverket" }],
    windowFrom: "2026-11-08T07:00:00+01:00", windowTo: "2026-11-08T23:00:00+01:00", cover: ["tm127649"] };
  const partial = A("tm_127649_matches");
  partial[0].matches.matches.forEach(m => { m.matchResult = null; m.state = 2; });
  st.over = { "/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=127649&language=en": partial };
  await tick(env, [ev]);
  st.over = { "/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=127649&language=en": A("tm_127649_matches") };
  await tick(env, [ev]);
  const got = await received(st, devs);
  // every match decided in one look: the tie result only, with the pair's own match in it (no notis twice)
  assert.deepEqual(got.reb.map(m => [m.title, m.body]), [["Nynäs Damlag förlorade mot Padelverket Damlag 1–2", "SPL Damer omgång 2. Thea och Rebecca vann sin match 6-3 6-2."]]);
  assert.deepEqual(got.lisa.map(m => [m.title, m.body]), [["Nynäs Damlag förlorade mot Padelverket Damlag 1–2", "SPL Damer omgång 2."]]);
  assert.deepEqual(got.kian, []);
  // The tie's KV record carries the home view summary; GET /events serves it
  const sum = JSON.parse(PUSH.m.get("st:tm127649"))._sum;
  assert.equal(sum.sc, "1–2");
});

test("ranking: every roster player within the hourly budget (20), rotating when the roster is larger", async () => {
  const seen = [], env = { PUSH: { get: async () => null, put: async () => {} }, API_BASE: "http://x" };
  const orig = globalThis.fetch;
  globalThis.fetch = async u => { if (/SearchRankingPlayers/.test(u)) seen.push(decodeURIComponent(new URL(String(u)).searchParams.get("searchTerm"))); return new Response(JSON.stringify({ Payload: [] })); };
  try {
    const t = new Date("2026-09-28T01:52:00Z");
    await rankingChecks(env, t, { left: 45 }, {});
    assert.deepEqual(seen.slice().sort(), ROSTER.map(p => p.name).sort(), "full name as the search term");
    const many = Array.from({ length: 30 }, (_, i) => ({ who: "p" + i, pid: i + 1, name: "P" + i, q: "P" + i, rt: 3, ag: 82, list: "x" }));
    seen.length = 0;
    await rankingChecks(env, t, { left: 45 }, {}, many);
    assert.equal(seen.length, 20);
    const first = new Set(seen);
    seen.length = 0;
    await rankingChecks(env, new Date(+t + 3600e3), { left: 45 }, {}, many);
    assert.ok(seen.some(q => !first.has(q)), "the next hour reaches the others");
  } finally { globalThis.fetch = orig; }
});

test("GET /events: latest results and who plays now, from the units' records", async () => {
  install({});
  const PUSH = kv(), env = { PUSH, ORIGIN, NOW: "2026-11-08T13:00:00+01:00" };
  const ev = { key: "l947-3355655-2026-11-08", kind: "teamleague", who: "thea", pid: THEA, pids: [THEA, REB, CAS, LISA, SANNA, 428692], team: "Nynäs Damlag", name: "SPL Damer", round: 2,
    date: "2026-11-08", ties: [{ id: 127649, home: true, opp: "Padelverket Damlag", time: "10:00" }], windowFrom: "2026-11-08T07:00:00+01:00", windowTo: "2026-11-08T23:00:00+01:00", cover: ["tm127649"] };
  const roster = ev.pids.map(pid => ({ pid, who: ROSTER.find(p => p.pid === pid).key }));
  const rub = parseTie(A("tm_127649_matches"));
  rub[2].w = null;   // Sanna's match still on
  PUSH.m.set("disc", JSON.stringify({ at: "2026-11-08T11:07:00Z", events: [ev], ended: [], past: [] }));
  PUSH.m.set("st:tm127649", JSON.stringify({ _sum: tieSummary({ ...ev, roster }, ev.ties[0], rub) }));
  const body = await (await worker.fetch(new Request("https://w/events"), env)).json();
  assert.deepEqual(body.latest.map(x => x.mid).sort(), ["5433848", "5433849"]);
  assert.equal(body.latest[0].team, "Nynäs Damlag");
  assert.equal(body.live[String(SANNA)].st, "next");
  assert.equal(body.live[String(SANNA)].vs, "Padelverket Damlag");
});

test("GET /stats: only with STATS_KEY; devices by language, service and followed player; pushes per day", async () => {
  const PUSH = kv(), v = await makeVapid();
  const env = { PUSH, ...v, VAPID_SUBJECT: ORIGIN, ORIGIN, NOW: "2026-09-29T12:00:00+02:00", STATS_KEY: "st" };
  const a = await makeSubscription("https://web.push.apple.com/a1"), b = await makeSubscription("https://fcm.googleapis.com/fcm/send/b1");
  await post(env, { subscription: a.sub, prefs: { follow: [THEA, KIAN] } });
  await post(env, { subscription: b.sub, prefs: { follow: [THEA], lang: "es" } });
  PUSH.m.set("stats:2026-09-27", JSON.stringify({ sent: 5, removed: 1, ticks: 2 }));
  assert.equal((await worker.fetch(new Request("https://w/stats"), env)).status, 403);
  assert.equal((await worker.fetch(new Request("https://w/stats", { headers: { "X-Stats-Key": "no" } }), env)).status, 403);
  const s = await (await worker.fetch(new Request("https://w/stats", { headers: { "X-Stats-Key": "st" } }), env)).json();
  assert.equal(s.devices.n, 2);
  assert.deepEqual(s.devices.lang, { sv: 1, es: 1 });
  assert.deepEqual(s.devices.services, { Apple: 1, Google: 1 });
  assert.deepEqual(s.devices.following.slice(0, 2), [{ pid: THEA, n: 2 }, { pid: KIAN, n: 1 }]);
  assert.equal(s.devices.followAvg, 1.5);
  assert.equal(s.pushes.total, 5);
  assert.deepEqual(s.pushes.days[2], { d: "2026-09-27", sent: 5, removed: 1 });
});
