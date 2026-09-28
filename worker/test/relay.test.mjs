// Live relay: the tick keeps the live draws / ties in KV "live" (written only when they changed) and GET /live serves
// them to the page (memory cache per isolate, ETag / since for unchanged polls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { tick, _resetMemory } from "../src/index.js";
import { KEEP, prune, playersOf, nextLive, parseLive, liveBody, hash } from "../src/relay.js";
import { kv } from "./helpers.mjs";

const F = n => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const EV = [{ who: "thea", me: "Thea Holmberg Löving", cls: "Damer C", classId: 164681,
  activeFrom: "2026-09-27T08:00:00+02:00", activeTo: "2026-09-27T22:00:00+02:00" }];
function net(state) {
  globalThis.fetch = async url => {
    url = String(url);
    if (url.includes("GetDrawsForStageAndStrengthAsync")) { state.rankedin++; return new Response(url.includes("drawStage=0") ? F(state.fixture) : "[]"); }
    if (url.includes("GetPlayerRatingAsync")) { state.ratings++; return new Response(JSON.stringify([{ RatingId: 65, RatingValue: 12.34 }, { RatingId: 99, RatingValue: 1 }])); }
    return new Response(null, { status: 201 });
  };
}

test("the page's KEEP list (index.html) is the worker's", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const m = /\("(Elimination [^"]+)" \+\s*"([^"]+)" \+\s*"([^"]+)" \+\s*"([^"]+)" \+\s*"([^"]+)"\)\.split/.exec(html);
  assert.ok(m, "KEEP list in index.html");
  assert.deepEqual(new Set(m.slice(1).join("").split(" ")), KEEP);
});

test("tick: KV 'live' written only when the data changed; GET /live serves it, 304 / since for unchanged polls", async () => {
  _resetMemory();
  const PUSH = kv(), state = { fixture: "dc_1031.json", rankedin: 0, ratings: 0 };
  net(state);
  const env = { PUSH, NOW: "2026-09-27T12:00:00+02:00", ORIGIN: "https://padel.holmberg.st", SK_MINUTE: "5" };
  let r = await tick(env, EV);
  assert.equal(r.relay, 1);
  const rec = parseLive(PUSH.m.get("live"));
  assert.deepEqual(Object.keys(rec.items), ["164681"]);
  const it = rec.items["164681"];
  assert.deepEqual(JSON.parse(it.d), prune([JSON.parse(F("dc_1031.json"))]), "the pruned draws, stage by stage, as the page reads them");
  assert.deepEqual(it.dr, [[0, 0]]);
  assert.ok(it.p.length >= 8 && it.p.includes(1675246), "the draw's players");
  const puts = PUSH.ops.put;
  r = await tick(env, EV);
  assert.equal(PUSH.ops.put, puts, "same data: no KV write");
  assert.equal(r.relay, undefined);

  // GET /live (no NOW: the memory cache works as in production)
  const genv = { PUSH, ORIGIN: "https://padel.holmberg.st" };
  const get = (q, h = {}) => worker.fetch(new Request("https://w/live?" + q, { headers: { Origin: "https://padel.holmberg.st", ...h } }), genv);
  _resetMemory();
  const g0 = PUSH.ops.get;
  let res = await get("ids=164681,tm999,bad!");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://padel.holmberg.st");
  const body = await res.json(), etag = res.headers.get("ETag");
  assert.deepEqual(Object.keys(body.items), ["164681"], "unknown ids are missing (the page asks RankedIn)");
  assert.deepEqual(body.items["164681"].data, JSON.parse(it.d));
  assert.equal(etag, "\"" + body.v + "\"");
  for (let i = 0; i < 50; i++) await get("ids=164681");
  assert.equal(PUSH.ops.get - g0, 1, "51 polls, one KV read (memory cache)");
  res = await get("ids=164681,tm999", { "If-None-Match": etag });
  assert.equal(res.status, 304);
  res = await get("ids=164681,tm999&since=" + body.v);
  assert.deepEqual(await res.json(), { v: body.v, same: 1 });
  assert.equal((await get("ids=")).status, 400);

  // A result comes in: the next tick writes "live" once, the version changes (after the memory cache runs out)
  state.fixture = "dc_1112.json";
  r = await tick(env, EV);
  assert.equal(r.relay, 1);
  _resetMemory();
  const b2 = await (await get("ids=164681,tm999")).json();
  assert.notEqual(b2.v, body.v);
  res = await get("ids=164681,tm999", { "If-None-Match": etag });
  assert.equal(res.status, 200);
});

test("skills of the players in live draws: fetched every 10 min when older than 3 h, in /live as {pid: {rid: skill}}", async () => {
  _resetMemory();
  const PUSH = kv(), state = { fixture: "dc_1031.json", rankedin: 0, ratings: 0 };
  net(state);
  const env = { PUSH, NOW: "2026-09-27T12:03:00+02:00", ORIGIN: "x" };   // minute 3 UTC 10:03
  let r = await tick(env, EV);
  const rec = parseLive(PUSH.m.get("live")), n = rec.items["164681"].p.length;
  assert.equal(state.ratings, Math.min(n, 20));
  assert.ok(state.rankedin + state.ratings <= 45, "within the subrequest budget");
  const first = rec.items["164681"].p[0];
  assert.deepEqual([Object.keys(rec.sk).length, rec.sk[first].r], [Math.min(n, 20), { 65: 12.34 }], "doubles ratings only");
  const body = await (await worker.fetch(new Request("https://w/live?ids=164681"), env)).json();
  assert.deepEqual(body.sk[first], { 65: 12.34 });
  const k0 = state.ratings;
  await tick({ ...env, NOW: "2026-09-27T12:13:00+02:00" }, EV);
  assert.equal(state.ratings - k0, Math.max(0, Math.min(n - 20, 20)), "only the ones not fetched yet");
  const k1 = state.ratings;
  await tick({ ...env, NOW: "2026-09-27T12:04:00+02:00" }, EV);
  assert.equal(state.ratings, k1, "not on other minutes");
});

test("nextLive: unchanged -> null; items of ended events leave; skills only for players still in a draw", () => {
  const t = new Date("2026-09-27T10:00:00Z"), prev = parseLive(null);
  const a = nextLive(prev, { "1": { data: [{ x: 1 }], p: [5] } }, { 5: { 65: 10 } }, t, new Set(["1"]));
  assert.ok(a && a.items["1"] && a.sk["5"]);
  assert.equal(nextLive(a, { "1": { data: [{ x: 1 }], p: [5] } }, {}, t, new Set(["1"])), null);
  const later = new Date(+t + 3 * 3600e3), b = nextLive(a, {}, {}, later, new Set());
  assert.deepEqual([Object.keys(b.items), Object.keys(b.sk)], [[], []]);
  assert.equal(liveBody(a, ["1"]).v, liveBody(a, ["1"]).v);
  assert.notEqual(hash("a"), hash("b"));
  assert.deepEqual(playersOf([{ Elimination: { DrawData: [[{ ChallengerParticipant: { FirstPlayer: { Id: 7, Name: "A" }, SecondPlayer: { Id: 0, Name: "Pending" } } }]] } }]), [7]);
});

test("KV budget: a change that is no result/time (e.g. a live score) waits 3 min; at 400 writes a day the relay empties", async () => {
  _resetMemory();
  const PUSH = kv(), state = { fixture: "dc_1031.json", rankedin: 0, ratings: 0 };
  net(state);
  const at = m => ({ PUSH, NOW: "2026-09-27T12:" + m + ":00+02:00", ORIGIN: "x", SK_MINUTE: "9" });
  await tick(at("00"), EV);
  const noisy = JSON.parse(F("dc_1031.json"));
  noisy[0].Elimination.DrawData[0][0].ChallengerParticipant.FirstPlayer.RatingBegin = 13.37;
  globalThis.fetch = async url => new Response(String(url).includes("drawStage=0") ? JSON.stringify(noisy) : "[]");
  let r = await tick(at("01"), EV);
  assert.equal(r.relay, undefined, "not a result: not yet");
  r = await tick(at("03"), EV);
  assert.equal(r.relay, 1, "3 min after the last write");
  assert.ok(PUSH.m.get("live").includes("13.37"));
  // the day's cap
  const rec = JSON.parse(PUSH.m.get("live"));
  PUSH.m.set("live", JSON.stringify({ ...rec, wn: 399 }));
  noisy[0].Elimination.DrawData[0][0].ChallengerParticipant.FirstPlayer.RatingBegin = 14;
  r = await tick(at("08"), EV);
  assert.deepEqual([r.relay, r.relayOff], [1, 1]);
  assert.deepEqual(JSON.parse(PUSH.m.get("live")).items, {}, "empty: the page falls back to RankedIn");
  const puts = PUSH.ops.put;
  noisy[0].Elimination.DrawData[0][0].ChallengerParticipant.FirstPlayer.RatingBegin = 15;
  r = await tick(at("12"), EV);
  assert.equal(PUSH.ops.put, puts, "no more writes today");
  r = await tick({ ...at("12"), NOW: "2026-09-28T09:10:00+02:00" }, [{ ...EV[0], activeTo: "2026-09-28T22:00:00+02:00" }]);
  assert.equal(r.relay, 1, "the next day: on again");
});

test("GET /live: 'every' hint (60 s while a match is on or soon, else 300); an isolate over LIVE_SHED calls a minute sheds", async () => {
  _resetMemory();
  const PUSH = kv(), state = { fixture: "dc_1112.json", rankedin: 0, ratings: 0 };
  net(state);
  await tick({ PUSH, NOW: "2026-09-27T12:00:00+02:00", ORIGIN: "x" }, EV);   // quarterfinals today: hot
  const env = { PUSH, ORIGIN: "x", LIVE_SHED: "3" }, get = q => worker.fetch(new Request("https://w/live?" + q), env);
  _resetMemory();
  assert.equal((await (await get("ids=164681")).json()).every, 60);
  assert.equal((await (await get("ids=tm5")).json()).every, 60, "not relayed: the page polls RankedIn anyway");
  const rec = JSON.parse(PUSH.m.get("live"));
  delete rec.items["164681"].h;
  PUSH.m.set("live", JSON.stringify(rec));
  _resetMemory();
  assert.equal((await (await get("ids=164681")).json()).every, 300, "calm: every 5 min");
  let last;
  for (let i = 0; i < 3; i++) last = await (await get("ids=164681")).json();
  assert.deepEqual(last, { shed: 1, every: 1800 });
});

test("GET /live: past the location-wide limit (LIVE_ALL, one key for everyone) the apps are told to use RankedIn", async () => {
  _resetMemory();
  const PUSH = kv(), keys = [];
  let n = 0;
  const env = { PUSH, ORIGIN: "https://padel.holmberg.st", LIVE_ALL: { async limit({ key }) { keys.push(key); return { success: ++n <= 2 }; } } };
  const get = () => worker.fetch(new Request("https://w/live?ids=164681", { headers: { Origin: "https://padel.holmberg.st", "CF-Connecting-IP": "1.2.3." + n } }), env);
  assert.equal((await (await get()).json()).shed, undefined);
  assert.equal((await (await get()).json()).shed, undefined);
  const b = await (await get()).json();
  assert.deepEqual(b, { shed: 1, every: 1800 });
  assert.ok(keys.every(k => k === "all"), "one key for every caller");
});
