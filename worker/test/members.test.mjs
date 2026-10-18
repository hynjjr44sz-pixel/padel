import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { membersRun, loadMembers, setVisibility, membersOut, _resetMembers, applyMembers } from "../src/members.js";
import { PLAYERS, BY_PID } from "../src/discover.js";
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; }
const ORIGIN = "https://padel.holmberg.st";
const MEMBERS = [{ firstLetter: "A", participants: [
  { playerId: 900001, playerRankedinId: "R1", playerFirstName: "anna", playerLastName: "andersson" },      // 34, on the women's list
  { playerId: 900002, playerRankedinId: "R2", playerFirstName: "Bo", playerLastName: "Berg" },             // 52, not ranked
  { playerId: 900003, playerRankedinId: "R3", playerFirstName: "Cia", playerLastName: "Ung" },             // 15: a junior
  { playerId: 1675246, playerRankedinId: "R000266565", playerFirstName: "Thea", playerLastName: "Holmberg Löving" } ] }];   // in players.json
const AGE = { R1: 34, R2: 52, R3: 15, R000266565: 17 };
function net(calls) {
  return async u => {
    u = String(u); calls.push(u);
    if (/GetMembersAsync\?id=9136/.test(u)) return new Response(JSON.stringify(MEMBERS));
    const pr = /rankedinId=([^&]+)/.exec(u);
    if (pr) return new Response(JSON.stringify({ Header: { Age: String(AGE[decodeURIComponent(pr[1])]) } }));
    if (/SearchRankingPlayersAsync/.test(u)) {
      const women = /rankingType=4/.test(u), who = decodeURIComponent(/searchTerm=([^&]+)/.exec(u)[1]);
      const hit = women && who === "Anna Andersson" ? [{ Participant: { NewParticipantId: 900001 } }] : [];
      return new Response(JSON.stringify({ Payload: hit, TotalCount: hit.length }));
    }
    return new Response("{}", { status: 404 });
  };
}
const getter = f => async p => { const r = await f("https://api.rankedin.com/v1" + p); if (!r.ok) throw new Error("HTTP"); return r.json(); };

test("medlemmar: the club's list once a day; 18+ shown unless they said no, juniors only after a yes; they join PLAYERS", async () => {
  _resetMemory(); _resetMembers();
  const env = { PUSH: kv(), ORIGIN }, calls = [], t = new Date("2026-10-19T02:03:00Z"), n0 = PLAYERS.length;
  const r = await membersRun(env, getter(net(calls)), t, { left: 45 });
  assert.deepEqual(r, { members: 4, shown: 2, checked: 4 });
  const rec = JSON.parse(env.PUSH.m.get("members"));
  assert.deepEqual(rec.list.map(m => [m.name, m.age, m.gender]), [["Anna Andersson", 34, "F"], ["Bo Berg", 52, null], ["Cia Ung", 15, null], ["Thea Holmberg Löving", undefined, undefined]]);
  // shown: Anna (women's list: ranking and skill rating) and Bo; not Cia (15); Thea stays the roster's own entry
  assert.equal(PLAYERS.length, n0 + 2);
  assert.deepEqual([BY_PID.get(900001).who, BY_PID.get(900001).rt, BY_PID.get(900001).rid, BY_PID.get(900002).gender], ["anna-andersson", 4, 65, null]);
  assert.ok(!BY_PID.has(900003));
  assert.equal(BY_PID.get(1675246).who, "thea");
  assert.deepEqual(membersOut().map(m => m.key), ["anna-andersson", "bo-berg"]);
  // the next run the same day: nothing fetched again
  calls.length = 0;
  await membersRun(env, getter(net(calls)), new Date("2026-10-19T02:13:00Z"), { left: 45 });
  assert.equal(calls.length, 0);
  // Cia's parent says yes; Bo says no
  await setVisibility(env, 900003, "in");
  await setVisibility(env, 900002, "out");
  assert.deepEqual(membersOut().map(m => m.key), ["anna-andersson", "cia-ung"]);
  assert.ok(!BY_PID.has(900002) && BY_PID.has(900003));
  // the page gets the members shown with /events
  const ev = await (await worker.fetch(new Request("https://w/events", { headers: { Origin: ORIGIN } }), env)).json();
  assert.deepEqual(ev.members.map(m => [m.key, m.name, m.gender, m.member]), [["anna-andersson", "Anna Andersson", "F", 1], ["cia-ung", "Cia Ung", null, 1]]);
  // back to by-age: Cia hidden again
  await setVisibility(env, 900003, null);
  assert.ok(!BY_PID.has(900003));
  applyMembers({ list: [] });   // leave PLAYERS as the other tests expect it
  assert.equal(PLAYERS.length, n0);
});
