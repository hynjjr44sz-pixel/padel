import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";
function kv() { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; }
const ORIGIN = "https://padel.holmberg.st";
let IPN = 0;   // each "Begär konto" from its own network unless a test says otherwise (at most 3 a day from one)
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0." + (++IPN % 250), ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
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

test("begär konto: the phone shows a code, the admin types it in, the same phone is logged in; parents; wrong codes", async () => {
  _resetMemory();
  const env = mkEnv(), ak = { "X-Admin-Key": env.ADMIN_KEY };
  let r = await call(env, "POST", "/auth/request", { pid: 1675246, name: "fake", msg: "Thea i Damlaget", label: "iPhone" });
  assert.equal(r.status, 200);
  const thea = await r.json();
  assert.match(thea.code, /^[A-HJKMNP-Z2-9]{3} [A-HJKMNP-Z2-9]{3}$/);
  assert.deepEqual(await (await call(env, "POST", "/auth/request/poll", { wait: thea.wait })).json(), { status: "open" });
  let adm = await (await call(env, "GET", "/admin", null, ak)).json();
  assert.deepEqual(adm.requests.map(x => [x.name, x.pid, x.parent, x.msg]), [["Thea Holmberg Löving", 1675246, false, "Thea i Damlaget"]]);
  assert.ok(!JSON.stringify(adm).includes(thea.code.replace(" ", "")));   // the admin never sees the code
  const rid = adm.requests[0].id;
  r = await call(env, "POST", "/admin", { op: "approve", rid, code: "AAA AAA" }, ak);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "code", left: 4 });
  // typed in lower case and without the space: fine
  r = await call(env, "POST", "/admin", { op: "approve", rid, code: thea.code.toLowerCase().replace(" ", ""), roles: ["arr"] }, ak);
  assert.equal(r.status, 200);
  r = await (await call(env, "POST", "/auth/request/poll", { wait: thea.wait })).json();
  assert.equal(r.status, "done");
  assert.deepEqual([r.me.name, r.me.pid, r.me.roles], ["Thea Holmberg Löving", 1675246, ["arr"]]);
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(r.token))).status, 200);
  assert.deepEqual(await (await call(env, "POST", "/auth/request/poll", { wait: thea.wait })).json(), { status: "gone" });   // once
  // a second phone for Thea: joins the same account
  const th2 = await (await call(env, "POST", "/auth/request", { pid: 1675246 })).json();
  adm = await (await call(env, "GET", "/admin", null, ak)).json();
  await call(env, "POST", "/admin", { op: "approve", rid: adm.requests[0].id, code: th2.code }, ak);
  r = await (await call(env, "POST", "/auth/request/poll", { wait: th2.wait })).json();
  assert.equal(r.me.id, (await (await call(env, "GET", "/admin", null, ak)).json()).users.find(u => u.pid === 1675246).id);
  assert.equal(env.DB.db.prepare("SELECT count(*) n FROM users").get().n, 1);
  // a parent for Kian: a new account of their own, looking after Kian
  assert.equal((await call(env, "POST", "/auth/request", { pid: 1680004, parent: true })).status, 400);   // needs a name
  const par = await (await call(env, "POST", "/auth/request", { pid: 1680004, parent: true, name: "Anna Borgström" })).json();
  adm = await (await call(env, "GET", "/admin", null, ak)).json();
  await call(env, "POST", "/admin", { op: "approve", rid: adm.requests[0].id, code: par.code }, ak);
  r = await (await call(env, "POST", "/auth/request/poll", { wait: par.wait })).json();
  assert.deepEqual([r.me.name, r.me.pid, r.me.kids], ["Anna Borgström", null, [1680004]]);
  // five wrong codes close it; a rejected one says no
  const x = await (await call(env, "POST", "/auth/request", { name: "Okänd" })).json();
  let xid = (await (await call(env, "GET", "/admin", null, ak)).json()).requests[0].id, last;
  for (let i = 0; i < 5; i++) last = await (await call(env, "POST", "/admin", { op: "approve", rid: xid, code: "ZZZZZZ" }, ak)).json();
  assert.deepEqual(last, { error: "locked", left: 0 });
  assert.deepEqual(await (await call(env, "POST", "/auth/request/poll", { wait: x.wait })).json(), { status: "no" });
  const y = await (await call(env, "POST", "/auth/request", { name: "Spam" })).json();
  await call(env, "POST", "/admin", { op: "reject", rid: (await (await call(env, "GET", "/admin", null, ak)).json()).requests[0].id }, ak);
  assert.deepEqual(await (await call(env, "POST", "/auth/request/poll", { wait: y.wait })).json(), { status: "no" });
  // cancelled by the phone; old ones run out after 14 days
  const z = await (await call(env, "POST", "/auth/request", { name: "Ångrar" })).json();
  await call(env, "POST", "/auth/request/cancel", { wait: z.wait });
  assert.deepEqual(await (await call(env, "POST", "/auth/request/poll", { wait: z.wait })).json(), { status: "gone" });
  const o = await (await call(env, "POST", "/auth/request", { name: "Gammal" })).json();
  env.NOW = "2026-11-02T10:00:01Z";
  assert.deepEqual(await (await call(env, "POST", "/auth/request/poll", { wait: o.wait })).json(), { status: "gone" });
  assert.equal((await (await call(env, "GET", "/admin", null, ak)).json()).requests.length, 0);
});

test("begär konto: at most 3 a day from one network; the admin's phones get a notis", async () => {
  _resetMemory();
  const env = mkEnv(), ip = { "CF-Connecting-IP": "203.0.113.9" };
  // the admin's phone: subscribed, then linked to the admin's account
  const ep = "https://push.example/admin-phone";
  const admTok = await (async () => {
    const inv = await (await call(env, "POST", "/admin", { op: "add", name: "Mikael", roles: ["admin"] }, { "X-Admin-Key": env.ADMIN_KEY })).json();
    return (await (await call(env, "POST", "/auth/redeem", { code: inv.code, label: "iPhone" })).json()).token;
  })();
  assert.equal((await call(env, "POST", "/me/push", { endpoint: ep }, bearer(admTok))).status, 404);   // not subscribed (yet)
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ep)));
  const k = "sub:" + [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  await env.PUSH.put(k, JSON.stringify({ sub: { endpoint: ep } }));
  assert.equal((await call(env, "POST", "/me/push", { endpoint: ep }, bearer(admTok))).status, 200);
  assert.deepEqual(JSON.parse(await env.PUSH.get("admsubs")), { [(await (await call(env, "GET", "/auth/me", null, bearer(admTok))).json()).me.id]: [k] });
  for (let i = 0; i < 3; i++) assert.equal((await call(env, "POST", "/auth/request", { name: "Spam " + i }, ip)).status, 200);
  const r = await call(env, "POST", "/auth/request", { name: "Spam 3" }, ip);
  assert.equal(r.status, 429);
  assert.equal((await call(env, "POST", "/auth/request", { name: "Annan" }, { "CF-Connecting-IP": "203.0.113.10" })).status, 200);
  const q = JSON.parse(await env.PUSH.get("amx:pend"));
  assert.equal(q.length, 4);
  assert.deepEqual(q[0].subs, [k]);
  assert.equal(q[0].m.title, "Ny kontoansökan");
  assert.ok(!JSON.stringify(q).includes("Spam"));   // no names in the notis
  // a day later: room again
  env.NOW = "2026-10-20T10:00:01Z";
  assert.equal((await call(env, "POST", "/auth/request", { name: "Spam 4" }, ip)).status, 200);
  // not an admin: no linking
  assert.equal((await call(env, "POST", "/me/push", { endpoint: ep })).status, 403);
});

test("konto: the admin links an account to a player profile (or none); statistics for an admin without the key", async () => {
  _resetMemory();
  const env = { ...mkEnv(), STATS_KEY: "s".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const a = await (await call(env, "POST", "/admin", { op: "add", name: "Mikael", roles: ["admin"] }, ak)).json();
  const tok = (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token;
  const b = await (await call(env, "POST", "/admin", { op: "add", pid: 1680004 }, ak)).json();
  assert.equal((await call(env, "POST", "/admin", { op: "link", id: a.id, pid: 999 }, bearer(tok))).status, 400);       // not a player
  assert.equal((await call(env, "POST", "/admin", { op: "link", id: a.id, pid: 1680004 }, bearer(tok))).status, 409);   // Kian has his own
  assert.equal((await call(env, "POST", "/admin", { op: "link", id: a.id, pid: 1675246 }, bearer(tok))).status, 200);
  assert.equal((await (await call(env, "GET", "/auth/me", null, bearer(tok))).json()).me.pid, 1675246);
  assert.equal((await call(env, "POST", "/admin", { op: "link", id: a.id, pid: null }, bearer(tok))).status, 200);
  assert.equal((await (await call(env, "GET", "/auth/me", null, bearer(tok))).json()).me.pid, null);
  assert.ok(b.id);
  // statistics: the key, or an admin's login; not an arrangör's
  assert.equal((await call(env, "GET", "/stats", null, bearer(tok))).status, 200);
  const arr = await (await call(env, "POST", "/admin", { op: "add", name: "Arr", roles: ["arr"] }, ak)).json();
  const at = (await (await call(env, "POST", "/auth/redeem", { code: arr.code })).json()).token;
  assert.equal((await call(env, "GET", "/stats", null, bearer(at))).status, 403);
  assert.equal((await call(env, "GET", "/stats")).status, 403);
});
