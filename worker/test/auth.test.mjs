import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; }
const ORIGIN = "https://padel.holmberg.st";
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
const bearer = t => ({ Authorization: "Bearer " + t });
const mkEnv = () => ({ PUSH: kv(), DB: fakeD1(), NOW: "2026-10-18T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) });
const round = [{ a: [0, 1], b: [2, 3] }], players = [{ pid: 1675246 }, { n: "B B" }, { n: "C C" }, { n: "D D" }];

test("konto: the first admin from the admin key, invite once, me, roles, americano needs arrangör", async () => {
  _resetMemory();
  const env = mkEnv();
  assert.equal((await call(env, "GET", "/admin")).status, 403);
  let r = await call(env, "POST", "/admin", { op: "add", name: "Mikael Holmberg", roles: ["admin", "boss"] }, { "X-Admin-Key": env.ADMIN_KEY });
  assert.equal(r.status, 200);
  const { code } = await r.json();
  assert.match(code, /^[a-z2-9]{20}$/);
  r = await call(env, "POST", "/auth/redeem", { code, label: "iPhone" });
  assert.equal(r.status, 200);
  const { token, me } = await r.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([me.name, me.roles], ["Mikael Holmberg", ["admin"]]);   // unknown roles dropped
  assert.equal((await call(env, "POST", "/auth/redeem", { code })).status, 410);   // once only
  // nothing secret in the database: hashes only
  assert.equal(env.DB.db.prepare("SELECT count(*) n FROM devices WHERE hash = ?").get(token).n, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) n FROM invites WHERE hash = ?").get(code).n, 0);
  assert.equal((await (await call(env, "GET", "/auth/me", null, bearer(token))).json()).me.name, "Mikael Holmberg");
  assert.equal((await call(env, "GET", "/auth/me", null, bearer("x".repeat(43)))).status, 401);
  // the admin adds Thea (a club player: the name comes from the roster) as arrangör and Kian as a player
  r = await call(env, "POST", "/admin", { op: "add", pid: 1675246, name: "fake", roles: ["arr"] }, bearer(token));
  const thea = await r.json();
  assert.equal((await call(env, "POST", "/admin", { op: "add", pid: 1675246 }, bearer(token))).status, 409);
  assert.equal((await call(env, "POST", "/admin", { op: "add", pid: 1 }, bearer(token))).status, 400);
  const kian = await (await call(env, "POST", "/admin", { op: "add", pid: 1680004 }, bearer(token))).json();
  const tt = (await (await call(env, "POST", "/auth/redeem", { code: thea.code })).json()).token;
  const kt = (await (await call(env, "POST", "/auth/redeem", { code: kian.code })).json()).token;
  const list = (await (await call(env, "GET", "/admin", null, bearer(token))).json()).users;
  assert.deepEqual(list.map(u => [u.name, u.roles.join(), u.devices.length]), [["Kian Borgström", "", 1], ["Mikael Holmberg", "admin", 1], ["Thea Holmberg Löving", "arr", 1]]);
  assert.equal((await call(env, "GET", "/admin", null, bearer(tt))).status, 403);   // arrangör is not admin
  // americano: no login 401, a player 403, arrangör 200 (and it says who started it)
  const amx = { name: "A", fmt: "americano", pts: 16, courts: 1, players, round };
  assert.equal((await call(env, "POST", "/amx", amx)).status, 401);
  assert.equal((await call(env, "POST", "/amx", amx, bearer(kt))).status, 403);
  r = await call(env, "POST", "/amx", amx, bearer(tt));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).t.by.n, "Thea Holmberg Löving");
  // Kian becomes arrangör; Thea's phones are revoked
  await call(env, "POST", "/admin", { op: "roles", id: kian.id, roles: ["arr"] }, bearer(token));
  assert.equal((await call(env, "POST", "/amx", amx, bearer(kt))).status, 200);
  await call(env, "POST", "/admin", { op: "revoke", id: thea.id }, bearer(token));
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(tt))).status, 401);
  // a disabled person is out; enabled again they are back
  await call(env, "POST", "/admin", { op: "disable", id: kian.id, on: true }, bearer(token));
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(kt))).status, 401);
  await call(env, "POST", "/admin", { op: "disable", id: kian.id, on: false }, bearer(token));
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(kt))).status, 200);
  // the admin cannot lock themselves out
  assert.equal((await call(env, "POST", "/admin", { op: "remove", id: me.id }, bearer(token))).status, 400);
  assert.equal((await call(env, "POST", "/admin", { op: "roles", id: me.id, roles: [] }, bearer(token))).status, 400);
  // removed: gone everywhere
  await call(env, "POST", "/admin", { op: "remove", id: kian.id }, bearer(token));
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(kt))).status, 401);
  assert.equal(env.DB.db.prepare("SELECT count(*) n FROM roles WHERE user = ?").get(kian.id).n, 0);
  // log out
  await call(env, "POST", "/auth/logout", null, bearer(token));
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(token))).status, 401);
});

test("konto: an invite runs out after 7 days, a new one replaces the old, at most 5 phones", async () => {
  _resetMemory();
  const env = mkEnv(), ak = { "X-Admin-Key": env.ADMIN_KEY };
  const a = await (await call(env, "POST", "/admin", { op: "add", name: "Gäst" }, ak)).json();
  env.NOW = "2026-10-25T10:00:01Z";
  assert.equal((await call(env, "POST", "/auth/redeem", { code: a.code })).status, 410);
  const b = await (await call(env, "POST", "/admin", { op: "invite", id: a.id }, ak)).json();
  const c = await (await call(env, "POST", "/admin", { op: "invite", id: a.id }, ak)).json();
  assert.equal((await call(env, "POST", "/auth/redeem", { code: b.code })).status, 410);   // replaced by c
  const toks = [(await (await call(env, "POST", "/auth/redeem", { code: c.code })).json()).token];
  for (let i = 0; i < 5; i++) {
    env.NOW = new Date(Date.parse(env.NOW) + 3600e3).toISOString();
    const x = await (await call(env, "POST", "/admin", { op: "invite", id: a.id }, ak)).json();
    toks.push((await (await call(env, "POST", "/auth/redeem", { code: x.code })).json()).token);
  }
  const ok = [];
  for (const t of toks) ok.push((await call(env, "GET", "/auth/me", null, bearer(t))).status);
  assert.deepEqual(ok, [401, 200, 200, 200, 200, 200]);   // the oldest phone dropped
  assert.equal((await call(env, "POST", "/auth/redeem", { code: "nope" })).status, 400);
});
