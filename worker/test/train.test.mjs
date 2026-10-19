import test from "node:test";
import assert from "node:assert/strict";
import worker, { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";

const ORIGIN = "https://padel.holmberg.st";
const kv = () => { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) }; };
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
const bearer = t => ({ Authorization: "Bearer " + t });

test("träning: the player, a parent and a linked coach or PT log and see; nobody else, not the admin; delete, clear", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-19T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) }, ak = { "X-Admin-Key": env.ADMIN_KEY };
  const acct = async (body) => { const a = await (await call(env, "POST", "/admin", { op: "add", ...body }, ak)).json(); return { id: a.id, tok: (await (await call(env, "POST", "/auth/redeem", { code: a.code })).json()).token }; };
  const thea = await acct({ pid: 1675246 }), kian = await acct({ pid: 1680004 }), javier = await acct({ name: "Javier Castilla", roles: ["tranare"] });
  const pt = await acct({ name: "Extern PT", roles: ["pt"] }), adm = await acct({ name: "Admin", roles: ["admin"] });
  const s = { pid: 1675246, day: "2026-10-18", kind: "gym", min: 60, rpe: 6, note: "Ben" };
  assert.equal((await call(env, "POST", "/train", s)).status, 401);
  assert.equal((await call(env, "POST", "/train", s, bearer(kian.tok))).status, 403);
  assert.equal((await call(env, "POST", "/train", s, bearer(javier.tok))).status, 403);   // not linked yet
  assert.equal((await call(env, "POST", "/train", s, bearer(adm.tok))).status, 403);      // the admin sees no one's training
  let r = await (await call(env, "POST", "/train", s, bearer(thea.tok))).json();
  assert.ok(r.ok && r.id);
  // bad input
  for (const x of [{ ...s, kind: "bad" }, { ...s, min: 2 }, { ...s, rpe: 11 }, { ...s, day: "2026-11-30" }, { ...s, day: "2026-07-01" }, { ...s, day: "18/10" }])
    assert.equal((await call(env, "POST", "/train", x, bearer(thea.tok))).status, 400, JSON.stringify(x));
  // the admin links Javier and the PT to Thea
  assert.equal((await call(env, "POST", "/admin", { op: "coach", id: javier.id, pids: [1675246, 1680004] }, ak)).status, 200);
  assert.equal((await call(env, "POST", "/admin", { op: "coach", id: pt.id, pids: [1675246] }, ak)).status, 200);
  assert.equal((await call(env, "POST", "/admin", { op: "coach", id: pt.id, pids: [999] }, ak)).status, 400);
  assert.deepEqual((await (await call(env, "GET", "/auth/me", null, bearer(javier.tok))).json()).me.coach.sort(), [1675246, 1680004]);
  assert.equal((await call(env, "POST", "/train", { ...s, kind: "padel", day: "2026-10-19", rpe: 8 }, bearer(javier.tok))).status, 200);
  const g = await (await call(env, "GET", "/train?pid=1675246", null, bearer(pt.tok))).json();
  assert.deepEqual(g.sessions.map(x => [x.day, x.kind, x.min, x.rpe, x.mine]), [["2026-10-19", "padel", 60, 8, false], ["2026-10-18", "gym", 60, 6, false]]);
  assert.equal((await call(env, "GET", "/train?pid=1680004", null, bearer(pt.tok))).status, 403);
  assert.equal((await call(env, "GET", "/train?pid=1675246", null, bearer(adm.tok))).status, 403);
  assert.equal((await call(env, "GET", "/train?pid=1675246", null, bearer(kian.tok))).status, 403);
  // several at once (a coach's group view): only those one may see
  const m = await (await call(env, "GET", "/train/many?pids=1675246,1680004,999", null, bearer(javier.tok))).json();
  assert.deepEqual(Object.keys(m.sessions).sort(), ["1675246", "1680004"]);
  assert.equal(m.sessions[1675246].length, 2);
  assert.deepEqual(Object.keys((await (await call(env, "GET", "/train/many?pids=1675246,1680004", null, bearer(pt.tok))).json()).sessions), ["1675246"]);
  // delete one; the PT may not clear Thea's history, Thea may
  assert.equal((await call(env, "POST", "/train", { op: "del", id: r.id }, bearer(kian.tok))).status, 403);
  assert.equal((await call(env, "POST", "/train", { op: "del", id: r.id }, bearer(pt.tok))).status, 200);
  assert.equal((await call(env, "POST", "/train/clear", { pid: 1675246 }, bearer(pt.tok))).status, 403);
  assert.equal((await call(env, "POST", "/train/clear", { pid: 1675246 }, bearer(thea.tok))).status, 200);
  assert.deepEqual((await (await call(env, "GET", "/train?pid=1675246", null, bearer(thea.tok))).json()).sessions, []);
  // unlinked: no access again
  await call(env, "POST", "/admin", { op: "coach", id: pt.id, pids: [] }, ak);
  assert.equal((await call(env, "GET", "/train?pid=1675246", null, bearer(pt.tok))).status, 403);
});
