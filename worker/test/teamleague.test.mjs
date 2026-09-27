import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseTie, snapshotTie, tieNotes } from "../src/teamleague.js";
import { parse, snapshot, notes } from "../src/rankedin.js";
import worker, { tick, _resetMemory } from "../src/index.js";
import { install, A } from "./fake-rankedin.mjs";
import { makeSubscription, makeVapid } from "./helpers.mjs";

const THEA = { who: "thea", pid: 1675246, me: "Thea Holmberg Löving", team: "Nynäs Damlag", name: "SPL Damer", round: 3 };
const TIE = { id: 127649, home: true, opp: "Padelverket Damlag", time: "10:00", venue: "Padelverket" };
const clone = x => JSON.parse(JSON.stringify(x));
beforeEach(() => _resetMemory());

test("parseTie: camelCase rubbers, challenger-side scores, pending sides", () => {
  const r = parseTie(A("tm_127649_matches"));
  assert.equal(r.length, 3);
  assert.deepEqual(r.map(x => [x.id, x.kind, x.w, x.s]), [["5433848", "Dam", "a", "6-3 6-2"], ["5433849", "Dam", "b", "5-7 1-6"], ["5433850", "Dam", "b", "2-6 2-6"]]);
  assert.deepEqual(r[0].a.n, ["Thea Holmberg Löving", "Rebecca Levander"]);
  const p = parseTie(A("tm_142161_matches"));
  assert.ok(p.every(x => x.a === null && x.b && !x.w), "lineup only on one side");
  assert.deepEqual(parseTie(A("tm_166800_matches")), []);
});

test("tie notiser: own rubber highlighted, team rubbers, tie result; nothing twice", () => {
  const all = parseTie(A("tm_127649_matches")), full = snapshotTie(all);
  assert.equal(full._done, 1);
  const before = clone(full);
  before["5433848"] = before["5433848"].replace(/,a$/, ",");
  delete before._done;
  const n = tieNotes(THEA, TIE, all, before);
  assert.deepEqual(n.map(x => x.title), ["Thea och Rebecca vann sin match 6-3 6-2", "Nynäs Damlag förlorade mot Padelverket Damlag 1–2"]);
  assert.equal(n[0].body, "Mot Frohlund / Spong. Ställning: Nynäs Damlag 1–2 Padelverket Damlag.");
  assert.equal(n[0].tag, "padel-tm127649:r5433848");
  assert.equal(n[1].body, "SPL Damer omgång 3. Thea och Rebecca vann sin match 6-3 6-2.");
  assert.equal(n[1].url, "./#thea");
  assert.deepEqual(tieNotes(THEA, TIE, all, full), []);

  // A teammate's rubber finishing is not pushed on its own; only the tie result (now complete) is.
  const b2 = clone(full);
  b2["5433849"] = b2["5433849"].replace(/,b$/, ",");
  delete b2._done;
  const n2 = tieNotes(THEA, TIE, all, b2);
  assert.deepEqual(n2.map(x => x.title), ["Nynäs Damlag förlorade mot Padelverket Damlag 1–2"]);
});

test("tie notiser: away team scores are flipped to our side", () => {
  const data = A("tm_127649_matches");
  // Swap sides: Nynäs is now the challenged (away) team
  data[0].matches.matches.forEach(m => {
    [m.challenger, m.challenged] = [m.challenged, m.challenger];
    m.matchResult.isFirstParticipantWinner = !m.matchResult.isFirstParticipantWinner;
    m.matchResult.score.detailedScoring.forEach(s => { [s.firstParticipantScore, s.secondParticipantScore] = [s.secondParticipantScore, s.firstParticipantScore]; });
  });
  const all = parseTie(data), before = snapshotTie(all);
  before["5433848"] = before["5433848"].replace(/,b$/, ",");
  const n = tieNotes(THEA, { ...TIE, home: false }, all, before);
  assert.equal(n[0].title, "Thea och Rebecca vann sin match 6-3 6-2");
});

test("lineup published: 'möter' once, with the tie in the body", () => {
  const one = A("tm_142161_matches");   // only Nynäs' side published
  const both = clone(one);
  both[0].matches.matches[0].challenger = { name: "Anna Andersson", player2Name: "Olle Olsson", player1Id: 11, player2Id: 12 };
  const ev = { ...THEA, name: "Klubbligan", team: "Nynäs PK", round: 1 }, tie = { id: 142161, home: false, opp: "Vista", time: "12:00", venue: "Vista Padel" };
  const n = tieNotes(ev, tie, parseTie(both), snapshotTie(parseTie(one)));
  assert.deepEqual(n.map(x => [x.title, x.body]), [["Thea och Andreas möter Andersson / Olsson", "Klubbligan · Nynäs PK mot Vista · 12:00 · Vista Padel"]]);
  assert.deepEqual(tieNotes(ev, tie, parseTie(both), snapshotTie(parseTie(both))), []);
});

test("groups + playoffs (Vista Spring 65183 Herr D): two groups parsed, playoff knockout, group placing notis", () => {
  const m = parse([A("t65183_draw_153640_0_0"), A("t65183_draw_153640_1_0")]);
  assert.deepEqual(m.pools.map(p => p.label), ["Grupp A", "Grupp B"]);
  assert.ok(m.some(x => x.kind === "ko") && m.some(x => x.kind === "rr"));
  const kian = { who: "kian", me: "Kian Borgström", cls: "Herr D", classId: 153640 };
  const before = snapshot(m);
  const mine = m.filter(x => x.kind === "rr" && x.a && x.b && [x.a, x.b].some(p => p.n.includes("Kian Borgström")));
  assert.ok(mine.length >= 2);
  const last = mine.sort((x, y) => (x.date > y.date ? 1 : -1)).at(-1);
  before[last.id] = before[last.id].replace(/,[^,]*$/, ",");
  const n = notes(kian, m, before);
  assert.match(n[0].title, /^Kian och Andreas (vann|förlorade) gruppmatchen /);
  assert.match(n.at(-1).title, /^Kian och Andreas slutade \S+ i Grupp [AB]$/);
  assert.match(n.at(-1).body, /^1\. /);
});

test("tick: SPL play day end to end: baseline, a finished rubber is pushed, KV only on change", async () => {
  const st = install({}), v = await makeVapid();
  const m = new Map(), PUSH = { async get(k) { return m.get(k) ?? null; }, async put(k, val) { m.set(k, val); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
  const env = { PUSH, ...v, VAPID_SUBJECT: "https://padel.holmberg.st", ORIGIN: "https://padel.holmberg.st", NOW: "2026-11-08T12:00:00+01:00" };
  const a = await makeSubscription("https://fcm.googleapis.com/fcm/send/a");
  await worker.fetch(new Request("https://w/subscribe", { method: "POST", headers: { Origin: "https://padel.holmberg.st" }, body: JSON.stringify({ subscription: a.sub, prefs: { thea: true, kian: false } }) }), env);
  const ev = { key: "l947-3355655-2026-11-08", kind: "teamleague", who: "thea", pid: 1675246, me: "Thea Holmberg Löving", team: "Nynäs Damlag", name: "SPL Damer", round: 2,
    ties: [{ id: 127649, home: true, opp: "Padelverket Damlag", time: "10:00", venue: "Padelverket" }],
    windowFrom: "2026-11-08T07:00:00+01:00", windowTo: "2026-11-08T23:00:00+01:00", cover: ["tm127649"] };
  const partial = A("tm_127649_matches");
  partial[0].matches.matches[0].matchResult = null; partial[0].matches.matches[0].state = 2;
  st.over = { "/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=127649&language=en": partial };
  let r = await tick(env, [ev]);
  assert.deepEqual([r.writes, r.sent], [1, 0]);
  r = await tick(env, [ev]);
  assert.deepEqual([r.writes, r.sent], [0, 0]);
  st.over = {};
  st.over["/teamleague/GetTeamLeagueTeamsMatchesAsync?teamMatchId=127649&language=en"] = A("tm_127649_matches");
  r = await tick(env, [ev]);
  assert.deepEqual([r.writes, r.sent], [1, 2]);
  const msgs = await Promise.all(st.pushes.map(async p => JSON.parse(await a.decrypt(p.init.body))));
  assert.deepEqual(msgs.map(x => x.title), ["Thea och Rebecca vann sin match 6-3 6-2", "Nynäs Damlag förlorade mot Padelverket Damlag 1–2"]);
  assert.ok(JSON.parse(m.get("st:tm127649"))._done);
});
