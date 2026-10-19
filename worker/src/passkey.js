// Passkeys (WebAuthn: Face ID, Touch ID, Windows Hello) for the admin: once logged in, the admin adds one on the phone;
// later that phone, or another with the same keychain, logs in with it and no link is needed. Only ES256 (what
// platform authenticators use). The public key comes from the browser (getPublicKey(): SPKI); no attestation is
// asked for, the admin adding it is already logged in. Challenges are used once and live 5 minutes.
import { meOf, newDevice, clean, log, ORG } from "./auth.js";

const CH_MS = 5 * 60e3, MAX_KEYS = 10, ES256 = -7;
const te = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const B64U_RE = /^[A-Za-z0-9_-]{1,2048}$/;
const rpIdOf = env => env.RP_ID || new URL(env.ORIGIN).hostname;
const originOk = (env, o) => o === env.ORIGIN || (env.ALLOW_LOCALHOST === "1" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

async function newChallenge(env, user, t) {
  const ch = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pkchal WHERE at < ?").bind(t - CH_MS),
    env.DB.prepare("INSERT INTO pkchal (ch, user, at) VALUES (?, ?, ?)").bind(ch, user, t),
  ]);
  return ch;
}
// the challenge in clientDataJSON, taken (once); the user it was made for ("" for a login), or null
async function takeChallenge(env, ch, t) {
  if (typeof ch !== "string" || !B64U_RE.test(ch)) return null;
  const r = await env.DB.prepare("SELECT user FROM pkchal WHERE ch = ? AND at > ?").bind(ch, t - CH_MS).first();
  const d = await env.DB.prepare("DELETE FROM pkchal WHERE ch = ?").bind(ch).run();
  if (!r || !d.meta || d.meta.changes !== 1) return null;
  return r.user || "";
}
function clientData(env, s, type) {
  let c;
  try { c = JSON.parse(new TextDecoder().decode(unb64u(s))); } catch (e) { return null; }
  return c && c.type === type && originOk(env, c.origin) && !c.crossOrigin ? c : null;
}
// ECDSA signature: DER (WebAuthn) -> r||s, 32 bytes each (WebCrypto)
export function derToRaw(der) {
  if (der[0] !== 0x30) return null;
  let i = 2;
  const part = () => {
    if (der[i] !== 0x02) return null;
    const n = der[i + 1], v = der.slice(i + 2, i + 2 + n);
    i += 2 + n;
    const x = v[0] === 0 ? v.slice(1) : v;
    if (x.length > 32) return null;
    const o = new Uint8Array(32);
    o.set(x, 32 - x.length);
    return o;
  };
  const r = part(), s = part();
  if (!r || !s) return null;
  const out = new Uint8Array(64);
  out.set(r); out.set(s, 32);
  return out;
}

// POST /auth/pk/options {add: true} (logged in, admin) | {} (a login) -> what navigator.credentials needs
export async function pkOptions(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  const rp = rpIdOf(env);
  if (b && b.add) {
    if (!me || !me.roles.includes("admin")) return { err: "forbidden", status: 403 };
    const have = (await env.DB.prepare("SELECT id FROM passkeys WHERE user = ?").bind(me.id).all()).results.map(r => r.id);
    return { challenge: await newChallenge(env, me.id, t), rp: { id: rp, name: "Nynäs Padel" }, user: { id: b64u(te.encode(me.id)), name: me.name, displayName: me.name }, exclude: have };
  }
  return { challenge: await newChallenge(env, null, t), rpId: rp };
}

// POST /auth/pk/add {id, clientDataJSON, publicKey (SPKI), alg, label} (logged in, admin)
export async function pkAdd(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me || !me.roles.includes("admin")) return { err: "forbidden", status: 403 };
  if (!b || !B64U_RE.test(b.id || "") || !B64U_RE.test(b.publicKey || "") || Number(b.alg) !== ES256) return { err: "bad key", status: 400 };
  const c = clientData(env, b.clientDataJSON, "webauthn.create");
  if (!c || (await takeChallenge(env, c.challenge, t)) !== me.id) return { err: "challenge", status: 400 };
  try { await crypto.subtle.importKey("spki", unb64u(b.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); } catch (e) { return { err: "bad key", status: 400 }; }
  if ((await env.DB.prepare("SELECT count(*) AS n FROM passkeys WHERE user = ?").bind(me.id).first()).n >= MAX_KEYS) return { err: "full", status: 400 };
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO passkeys (id, user, spki, counter, label, created) VALUES (?, ?, ?, 0, ?, ?)").bind(b.id, me.id, b.publicKey, clean(b.label, 60) || null, t),
    log(env, t, me.id, "passkey", { label: clean(b.label, 60) || null }),
  ]);
  return { ok: true };
}

// POST /auth/pk/login {id, clientDataJSON, authenticatorData, signature, label} -> {token, me}, as an invite link does
export async function pkLogin(env, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  const bad = { err: "passkey", status: 401 };
  if (!b || !B64U_RE.test(b.id || "") || !B64U_RE.test(b.authenticatorData || "") || !B64U_RE.test(b.signature || "")) return bad;
  const c = clientData(env, b.clientDataJSON, "webauthn.get");
  if (!c || (await takeChallenge(env, c.challenge, t)) !== "") return bad;
  const k = await env.DB.prepare("SELECT p.id, p.user, p.spki, p.counter FROM passkeys p JOIN users u ON u.id = p.user WHERE p.id = ? AND u.disabled = 0 AND u.org = ?").bind(b.id, ORG).first();
  if (!k) return bad;
  const ad = unb64u(b.authenticatorData);
  if (ad.length < 37) return bad;
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(rpIdOf(env))));
  if (rpHash.some((x, i) => x !== ad[i])) return bad;
  if ((ad[32] & 0x05) !== 0x05) return bad;   // user present and verified (Face ID, not just a tap)
  const n = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  if ((n || k.counter) && n <= k.counter) return bad;   // a copied authenticator (most passkeys keep 0)
  const sig = derToRaw(unb64u(b.signature));
  if (!sig) return bad;
  const cd = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64u(b.clientDataJSON)));
  const msg = new Uint8Array(ad.length + 32);
  msg.set(ad); msg.set(cd, ad.length);
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("spki", unb64u(k.spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, msg);
  } catch (e) { ok = false; }
  if (!ok) return bad;
  await env.DB.prepare("UPDATE passkeys SET counter = ?, used = ? WHERE id = ?").bind(n, t, k.id).run();
  const token = await newDevice(env, k.user, clean(b.label, 60) || null, t, "passkey-login");
  return { token, me: await meOf(env, await env.DB.prepare("SELECT id, name, pid FROM users WHERE id = ?").bind(k.user).first()) };
}

// POST /auth/pk/clear (logged in): one's own passkeys removed
export async function pkClear(env, me, t) {
  if (!env.DB || !me) return { err: "login", status: 401 };
  await env.DB.batch([env.DB.prepare("DELETE FROM passkeys WHERE user = ?").bind(me.id), log(env, t, me.id, "passkey-clear", null)]);
  return { ok: true };
}
export const pkCount = async (env, user) => env.DB ? (await env.DB.prepare("SELECT count(*) AS n FROM passkeys WHERE user = ?").bind(user).first()).n : 0;
