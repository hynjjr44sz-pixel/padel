// Test helpers: the receiving side of RFC 8291 (written independently of src/webpush.js) and key factories.
import assert from "node:assert/strict";
import { b64u } from "../src/webpush.js";

export const te = new TextEncoder(), td = new TextDecoder();
async function hkdf(salt, ikm, info, n) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
export async function decrypt(body, uaPrivate, uaPublicRaw, auth) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
  const asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
  const info = new Uint8Array([...te.encode("WebPush: info\0"), ...uaPublicRaw, ...asPub]);
  const ikm = await hkdf(auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, "last-record delimiter");
  return td.decode(plain.slice(0, end));
}
export async function makeSubscription(endpoint) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { sub: { endpoint, keys: { p256dh: b64u.enc(pub), auth: b64u.enc(auth) } }, priv: kp.privateKey, pub, auth, decrypt: body => decrypt(body, kp.privateKey, pub, auth) };
}
export async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { VAPID_PUBLIC_KEY: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)), VAPID_PRIVATE_KEY: JSON.stringify({ kty, crv, x, y, d }), verifyKey: kp.publicKey, d };
}

