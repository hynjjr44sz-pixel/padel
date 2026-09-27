import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encrypt, vapidKey, vapidJwt, send } from "../src/webpush.js";
import { te, td, makeSubscription, makeVapid } from "./helpers.mjs";

test("RFC 8291 appendix A test vector", async () => {
  const asPub = b64u.dec("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u.enc(asPub.slice(1, 33)), y: b64u.enc(asPub.slice(33)) };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const body = await encrypt("When I grow up, I want to be a watermelon",
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
    { salt: b64u.dec("DGv6ra1nlYgDCS1FRnbzlw"), localKeys: { privateKey, publicKey } });
  assert.equal(b64u.enc(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("encrypt -> decrypt round trip with our own subscription keys", async () => {
  const s = await makeSubscription("https://push.example/x");
  const msg = JSON.stringify({ title: "Thea och Cassandra vann kvartsfinalen 6-2 7-5", body: "Åäö ✓", tag: "padel-1:m2" });
  const body = await encrypt(msg, s.sub.keys.p256dh, s.sub.keys.auth);
  assert.equal(await s.decrypt(body), msg);
  const again = await encrypt(msg, s.sub.keys.p256dh, s.sub.keys.auth);
  assert.notEqual(b64u.enc(again), b64u.enc(body), "fresh salt and ephemeral key each time");
});

test("VAPID JWT is a valid ES256 signature (JWK and raw-d private keys)", async () => {
  const v = await makeVapid();
  for (const priv of [v.VAPID_PRIVATE_KEY, v.d]) {
    const key = await vapidKey(priv, v.VAPID_PUBLIC_KEY);
    const now = Date.UTC(2026, 8, 27, 12);
    const jwt = await vapidJwt("https://fcm.googleapis.com", "https://padel.holmberg.st", key, now);
    const [h, c, sig] = jwt.split(".");
    assert.deepEqual(JSON.parse(td.decode(b64u.dec(h))), { typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(td.decode(b64u.dec(c)));
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.sub, "https://padel.holmberg.st");
    assert.equal(claims.exp, now / 1000 + 12 * 3600);
    assert.equal(b64u.dec(sig).length, 64);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, v.verifyKey, b64u.dec(sig), te.encode(h + "." + c)));
  }
});

test("send(): headers and encrypted body", async () => {
  const v = await makeVapid(), s = await makeSubscription("https://fcm.googleapis.com/fcm/send/abc");
  const env = { ...v, VAPID_SUBJECT: "https://padel.holmberg.st" };
  let req;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { req = { url, init }; return new Response(null, { status: 201 }); };
  try {
    const st = await send(s.sub, { title: "T", body: "B", tag: "padel-164681:m6872156", url: "./#thea" }, env, await vapidKey(v.VAPID_PRIVATE_KEY, v.VAPID_PUBLIC_KEY));
    assert.equal(st, 201);
  } finally { globalThis.fetch = orig; }
  const h = req.init.headers;
  assert.equal(req.url, s.sub.endpoint);
  assert.match(h.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(h.Authorization.split("k=")[1], v.VAPID_PUBLIC_KEY);
  assert.equal(JSON.parse(td.decode(b64u.dec(h.Authorization.split(".")[1]))).aud, "https://fcm.googleapis.com");
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h.TTL, "3600");
  assert.equal(h.Urgency, "high");
  assert.match(h.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.deepEqual(JSON.parse(await s.decrypt(req.init.body)), { title: "T", body: "B", tag: "padel-164681:m6872156", url: "./#thea" });
});
