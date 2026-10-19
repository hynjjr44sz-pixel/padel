import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { membersRun, loadMembers, setVisibility, membersOut, _resetMembers, applyMembers } from "../src/members.js";
import { PLAYERS, BY_PID } from "../src/discover.js";
import { fakeD1 } from "./d1.mjs";
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
    // Bo is on no ranking list: the class he played in before (Herr C) says men's
    if (/ParticipatedEventsAsync\?playerId=900002/.test(u)) return new Response(JSON.stringify({ Payload: [{ Id: 77, Type: 4, State: 4 }] }));
    if (/ParticipatedEventsAsync/.test(u)) return new Response(JSON.stringify({ Payload: [] }));
    if (/GetInfoAsync\?id=77/.test(u)) return new Response(JSON.stringify({ TournamentSidebarModel: { Classes: [{ Id: 1, Name: "Dam C" }, { Id: 2, Name: "Mix" }, { Id: 3, Name: "Herr C" }] } }));
    if (/GetPlayersForClassAsync\?tournamentId=77&tournamentClassId=1&/.test(u)) return new Response(JSON.stringify({ Participants: [{ Participant: { FirstPlayer: { Id: 5 }, SecondPlayer: { Id: 6 } } }] }));
    if (/GetPlayersForClassAsync\?tournamentId=77&tournamentClassId=3&/.test(u)) return new Response(JSON.stringify({ Participants: [{ Participant: { FirstPlayer: { Id: 7 }, SecondPlayer: { Id: 900002 } } }] }));
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
  assert.deepEqual(rec.list.map(m => [m.name, m.age, m.gender]), [["Anna Andersson", 34, "F"], ["Bo Berg", 52, "M"], ["Cia Ung", 15, null], ["Thea Holmberg Löving", undefined, undefined]]);
  // shown: Anna (women's list: ranking and skill rating) and Bo; not Cia (15); Thea stays the roster's own entry
  assert.equal(PLAYERS.length, n0 + 2);
  assert.deepEqual([BY_PID.get(900001).who, BY_PID.get(900001).rt, BY_PID.get(900001).rid, BY_PID.get(900002).gender], ["anna-andersson", 4, 65, "M"]);
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

test("begär konto för en dold junior: the parent types the name, matched against the members; approved -> shown", async () => {
  _resetMemory(); _resetMembers();
  const env = { PUSH: kv(), DB: fakeD1(), ORIGIN, NOW: "2026-10-19T10:00:00Z", ADMIN_KEY: "k".repeat(32) }, n0 = PLAYERS.length;
  await membersRun(env, getter(net([])), new Date("2026-10-19T02:03:00Z"), { left: 45 });
  assert.ok(!BY_PID.has(900003));   // Cia, 15: not shown
  const call = (m, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method: m, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
  const r = await (await call("POST", "/auth/request", { parent: true, name: "Mamma Ung", player: "cia UNG" })).json();
  const ak = { "X-Admin-Key": env.ADMIN_KEY };
  const adm = await (await call("GET", "/admin", null, ak)).json();
  assert.deepEqual([adm.requests[0].pid, adm.requests[0].pname, adm.requests[0].msg], [900003, "Cia Ung, 15 år", "Gäller: Cia Ung"]);
  // the page never got Cia: /events has only those shown
  assert.ok(!(await (await call("GET", "/events")).json()).members.some(m => m.pid === 900003));
  await call("POST", "/admin", { op: "approve", rid: adm.requests[0].id, code: r.code }, ak);
  assert.ok(BY_PID.has(900003));   // the yes: shown now
  const me = (await (await call("POST", "/auth/request/poll", { wait: r.wait })).json()).me;
  assert.deepEqual([me.name, me.kids], ["Mamma Ung", [900003]]);
  // a name that is no member: the request still goes to the admin, marked
  await call("POST", "/auth/request", { parent: true, name: "Pappa X", player: "Nobody Here" });
  const adm2 = await (await call("GET", "/admin", null, ak)).json();
  assert.deepEqual([adm2.requests[0].pid, adm2.requests[0].msg], [null, "Gäller: Nobody Here (hittades inte bland klubbens medlemmar)"]);
  applyMembers({ list: [] });
  assert.equal(PLAYERS.length, n0);
});

test("medlemmar: someone who leaves the club is no longer shown, their account says so; back again: their own choice again", async () => {
  _resetMemory(); _resetMembers();
  const env = { PUSH: kv(), DB: fakeD1(), ORIGIN, NOW: "2026-10-19T10:00:00Z", ADMIN_KEY: "k".repeat(32) }, n0 = PLAYERS.length;
  await membersRun(env, getter(net([])), new Date("2026-10-19T02:03:00Z"), { left: 45 });
  await setVisibility(env, 900001, "out");   // Anna said no
  const call = (m, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method: m, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
  const ak = { "X-Admin-Key": env.ADMIN_KEY };
  const bo = await (await call("POST", "/admin", { op: "add", pid: 900002 }, ak)).json();
  const tok = (await (await call("POST", "/auth/redeem", { code: bo.code })).json()).token;
  assert.equal((await (await call("GET", "/auth/me", null, { Authorization: "Bearer " + tok })).json()).me.left, undefined);
  // the next day Anna and Bo are gone from the club's list (another club)
  const saved = MEMBERS[0].participants.slice();
  MEMBERS[0].participants = saved.filter(p => p.playerId !== 900001 && p.playerId !== 900002);
  try {
    await membersRun(env, getter(net([])), new Date("2026-10-20T02:13:00Z"), { left: 45 });
    assert.ok(!BY_PID.has(900002));
    assert.ok(!membersOut().some(m => m.pid === 900002));
    const me = (await (await call("GET", "/auth/me", null, { Authorization: "Bearer " + tok })).json()).me;
    assert.equal(me.left, "2026-10-20T02:13:00.000Z");
    const adm = await (await call("GET", "/admin", null, ak)).json();
    assert.equal(adm.users.find(u => u.pid === 900002).left, "2026-10-20T02:13:00.000Z");
  } finally { MEMBERS[0].participants = saved; }
  // back a day later: Anna's no still holds; Bo shown again, the account no longer marked
  await membersRun(env, getter(net([])), new Date("2026-10-21T02:23:00Z"), { left: 45 });
  const rec = JSON.parse(env.PUSH.m.get("members"));
  assert.equal(rec.list.find(m => m.pid === 900001).vis, "out");
  assert.deepEqual(rec.gone, {});
  assert.ok(BY_PID.has(900002) && !BY_PID.has(900001));
  assert.equal((await (await call("GET", "/auth/me", null, { Authorization: "Bearer " + tok })).json()).me.left, undefined);
  applyMembers({ list: [] });
  assert.equal(PLAYERS.length, n0);
});
