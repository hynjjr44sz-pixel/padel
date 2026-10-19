import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { _resetMemory } from "../src/index.js";
import { fakeD1 } from "./d1.mjs";
import { derToRaw } from "../src/passkey.js";

const ORIGIN = "https://padel.holmberg.st";
const kv = () => { const m = new Map(); return { get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) }; };
const call = (env, method, path, body, hd = {}) => worker.fetch(new Request("https://w" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "10.1.1." + Math.floor(Math.random() * 250), ...hd }, body: body ? JSON.stringify(body) : undefined }), env);
const bearer = t => ({ Authorization: "Bearer " + t });
const b64u = b => Buffer.from(b).toString("base64url");
const te = new TextEncoder();

// a phone's authenticator: P-256 key, signs authenticatorData || sha256(clientDataJSON), DER
async function phone() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = b64u(await crypto.subtle.exportKey("spki", kp.publicKey)), id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const der = raw => {
    const int = x => { let i = 0; while (i < 31 && x[i] === 0) i++; x = x.slice(i); if (x[0] & 0x80) x = Uint8Array.of(0, ...x); return [0x02, x.length, ...x]; };
    const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
    return Uint8Array.of(0x30, body.length, ...body);
  };
  return {
    id, spki,
    async get(challenge, { origin = ORIGIN, rp = "padel.holmberg.st", flags = 0x05, counter = 0, key = kp.privateKey } = {}) {
      const cdj = te.encode(JSON.stringify({ type: "webauthn.get", challenge, origin }));
      const ad = new Uint8Array(37);
      ad.set(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(rp))));
      ad[32] = flags; new DataView(ad.buffer).setUint32(33, counter);
      const msg = new Uint8Array([...ad, ...new Uint8Array(await crypto.subtle.digest("SHA-256", cdj))]);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, msg));
      return { id, clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(der(sig)), label: "iPhone" };
    },
    create: challenge => ({ id, publicKey: spki, alg: -7, label: "iPhone", clientDataJSON: b64u(te.encode(JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN }))) }),
  };
}

test("passkey: DER signature to raw", () => {
  const r = derToRaw(Uint8Array.of(0x30, 8, 0x02, 2, 0, 0x81, 0x02, 2, 1, 2));
  assert.equal(r.length, 64); assert.equal(r[31], 0x81); assert.equal(r[63], 2); assert.equal(r[62], 1);
  assert.equal(derToRaw(Uint8Array.of(0x31, 0)), null);
});

test("passkey: anyone logged in adds one (the admin here), logs in with it on a new phone; only once per challenge; wrong origin, key, flags, counter", async () => {
  _resetMemory();
  const env = { PUSH: kv(), DB: fakeD1(), NOW: "2026-10-18T10:00:00Z", ORIGIN, ADMIN_KEY: "k".repeat(32) };
  const ak = { "X-Admin-Key": env.ADMIN_KEY };
  const add = async (name, roles) => {
    const inv = await (await call(env, "POST", "/admin", { op: "add", name, roles }, ak)).json();
    return (await (await call(env, "POST", "/auth/redeem", { code: inv.code })).json()).token;
  };
  const adm = await add("Mikael", ["admin"]), arr = await add("Arr", ["arr"]);
  const ph = await phone();
  // not logged in: no adding
  assert.equal((await call(env, "POST", "/auth/pk/options", { add: true })).status, 401);
  let o = await (await call(env, "POST", "/auth/pk/options", { add: true }, bearer(adm))).json();
  assert.equal(o.rp.id, "padel.holmberg.st");
  assert.deepEqual(o.exclude, []);
  assert.equal((await call(env, "POST", "/auth/pk/add", { ...ph.create(o.challenge), alg: -257 }, bearer(adm))).status, 400);   // only ES256
  assert.equal((await call(env, "POST", "/auth/pk/add", ph.create(o.challenge), bearer(adm))).status, 200);
  assert.equal((await call(env, "POST", "/auth/pk/add", ph.create(o.challenge), bearer(adm))).status, 400);   // the challenge once
  assert.equal((await (await call(env, "GET", "/auth/me", null, bearer(adm))).json()).me.pk, 1);
  // a login: a challenge, Face ID, a token
  const login = async opt => { const c = (await (await call(env, "POST", "/auth/pk/options", {})).json()).challenge; return call(env, "POST", "/auth/pk/login", await ph.get(c, opt)); };
  let r = await login();
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.me.name, "Mikael");
  assert.equal((await call(env, "GET", "/auth/me", null, bearer(d.token))).status, 200);
  // the same answer again: no
  const c = (await (await call(env, "POST", "/auth/pk/options", {})).json()).challenge, a = await ph.get(c);
  assert.equal((await call(env, "POST", "/auth/pk/login", a)).status, 200);
  assert.equal((await call(env, "POST", "/auth/pk/login", a)).status, 401);
  // another site, another rp, no Face ID, someone else's key, an add-challenge used to log in
  assert.equal((await login({ origin: "https://evil.example" })).status, 401);
  assert.equal((await login({ rp: "evil.example" })).status, 401);
  assert.equal((await login({ flags: 0x01 })).status, 401);
  const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  assert.equal((await login({ key: other.privateKey })).status, 401);
  o = await (await call(env, "POST", "/auth/pk/options", { add: true }, bearer(adm))).json();
  assert.deepEqual(o.exclude, [ph.id]);
  assert.equal((await call(env, "POST", "/auth/pk/login", await ph.get(o.challenge))).status, 401);
  // a counting authenticator: must go up
  assert.equal((await login({ counter: 5 })).status, 200);
  assert.equal((await login({ counter: 5 })).status, 401);
  assert.equal((await login({ counter: 6 })).status, 200);
  // the admin revokes (a lost phone): the passkey goes too
  const id = (await (await call(env, "GET", "/auth/me", null, bearer(adm))).json()).me.id;
  await call(env, "POST", "/admin", { op: "revoke", id }, ak);
  assert.equal((await login({ counter: 7 })).status, 401);
  // challenges run out after 5 minutes
  const adm2 = await add("Admin 2", ["admin"]);
  o = await (await call(env, "POST", "/auth/pk/options", { add: true }, bearer(adm2))).json();
  env.NOW = "2026-10-18T10:05:01Z";
  assert.equal((await call(env, "POST", "/auth/pk/add", ph.create(o.challenge), bearer(adm2))).status, 400);
  o = await (await call(env, "POST", "/auth/pk/options", { add: true }, bearer(adm))).json();
  assert.equal((await call(env, "POST", "/auth/pk/add", (await phone()).create(o.challenge), bearer(arr))).status, 400);   // another account's challenge
  // an arrangör (any account): adds one too, and logs in with it
  const ph2 = await phone();
  o = await (await call(env, "POST", "/auth/pk/options", { add: true }, bearer(arr))).json();
  assert.equal((await call(env, "POST", "/auth/pk/add", ph2.create(o.challenge), bearer(arr))).status, 200);
  const c2 = (await (await call(env, "POST", "/auth/pk/options", {})).json()).challenge;
  assert.equal((await (await call(env, "POST", "/auth/pk/login", await ph2.get(c2))).json()).me.name, "Arr");
  // clearing one's own
  assert.equal((await call(env, "POST", "/auth/pk/clear", {}, bearer(adm2))).status, 200);
  assert.equal((await call(env, "POST", "/auth/pk/clear", {})).status, 401);
});
