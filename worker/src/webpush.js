// Web Push with WebCrypto only: RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID, ES256 JWT).
const te = new TextEncoder();

export const b64u = {
  enc(buf) {
    let s = "";
    new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
};
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
};
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// RFC 8291 §3-4: one record, rs 4096. Returns the full aes128gcm body.
export async function encrypt(payload, p256dh, auth, { salt, localKeys } = {}) {
  const ua = b64u.dec(p256dh), secret = b64u.dec(auth);
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const local = localKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(secret, ecdh, cat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const plain = cat(typeof payload === "string" ? te.encode(payload) : payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  return cat(header, asPub, ct);
}

// VAPID_PRIVATE_KEY: a JWK (JSON) or the raw 32-byte d in base64url; VAPID_PUBLIC_KEY: raw 65-byte point, base64url.
export async function vapidKey(privateKey, publicKey) {
  let jwk;
  if (String(privateKey).trim().startsWith("{")) jwk = JSON.parse(privateKey);
  else {
    const pub = b64u.dec(publicKey);
    jwk = { kty: "EC", crv: "P-256", d: String(privateKey).trim(), x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)) };
  }
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
export async function vapidJwt(aud, subject, key, now = Date.now()) {
  const enc = o => b64u.enc(te.encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned));
  return unsigned + "." + b64u.enc(sig);
}

// Topic: max 32 chars of the URL-safe base64 alphabet, so hash the tag.
async function topic(tag) {
  return b64u.enc((await crypto.subtle.digest("SHA-256", te.encode(tag))).slice(0, 24));
}

// Sends one message. Returns the push service's HTTP status (0 on network error, -1 when the subscription's keys
// cannot be used: encryption failed). jwts: optional cache {aud: jwt, "#tag": topic} shared by the sends of one tick.
export async function send(sub, msg, env, key, jwts = {}) {
  const aud = new URL(sub.endpoint).origin;
  const jwt = await (jwts[aud] = jwts[aud] || vapidJwt(aud, env.VAPID_SUBJECT, key));
  // One aes128gcm record holds 3993 bytes of plaintext; keep well inside it.
  let text = JSON.stringify(msg);
  if (te.encode(text).length > 3000) text = JSON.stringify({ ...msg, body: String(msg.body || "").slice(0, 600) + "…" });
  let body, tp;
  try {
    body = await encrypt(text, sub.keys.p256dh, sub.keys.auth);
    const tk = "#" + (msg.tag || "padel");
    tp = await (jwts[tk] = jwts[tk] || topic(msg.tag || "padel"));
  } catch (e) {
    return -1;
  }
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST", body,
      headers: {
        "Authorization": "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY,
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        "TTL": "3600", "Urgency": "high", "Topic": tp
      }
    });
    return res.status;
  } catch (e) {
    return 0;
  }
}
