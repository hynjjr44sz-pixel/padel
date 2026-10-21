// "Godkänn datorn": a computer in the hall (the TV, nobody logged in) may start americanos once someone allowed to (an
// arrangör or admin) scans its QR code with a logged-in phone and says yes. The computer asks for a request (a code in
// the QR, a secret only it knows), polls, and gets a hall token for 12 hours: it starts americanos in the approver's name
// and nothing else. KV "hall:req:<code>" (10 min), "hall:<sha of the token>" (12 h).
import { sha, can, log } from "./auth.js";
import qrcode from "./vendor/qrcode.js";

const REQ_TTL = 600, HALL_TTL = 12 * 3600, CODE_RE = /^[a-z2-9]{8}(?:[a-z2-9]{2})?$/, SECRET_RE = /^[a-f0-9]{32}$/;
const rnd = (n, abc) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => abc[b % abc.length]).join("");

// POST /auth/hall/start -> {code, secret}
export async function hallStart(env) {
  // the code is also typed in the app (shown as ABCD-EFGH)
  const code = rnd(8, "abcdefghijkmnpqrstuvwxyz23456789"), secret = rnd(32, "0123456789abcdef");
  await env.PUSH.put("hall:req:" + code, JSON.stringify({ sh: await sha(secret), ok: null }), { expirationTtl: REQ_TTL });
  return { code, secret, ttl: REQ_TTL };
}
// GET /auth/hall/qr?code= -> the QR code (SVG) of the page's approval link
export function hallQr(env, code) {
  if (!CODE_RE.test(code || "")) return null;
  const q = qrcode(0, "M");
  q.addData(env.ORIGIN + "/#hall/" + code);
  q.make();
  const n = q.getModuleCount(), m = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += "M" + (c + m) + " " + (r + m) + "h1v1h-1z";
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * m) + " " + (n + 2 * m) + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#0A1733"/></svg>';
}
// POST /auth/hall/ok {code} (a logged-in arrangör or admin) -> {ok}
export async function hallOk(env, me, b, t) {
  if (!can(me, "arr")) return { err: me ? "role" : "login", status: me ? 403 : 401 };
  const code = b && b.code;
  const r = CODE_RE.test(code || "") && JSON.parse((await env.PUSH.get("hall:req:" + code)) || "null");
  if (!r) return { err: "expired", status: 404 };
  r.ok = { user: me.id, name: me.name };
  await env.PUSH.put("hall:req:" + code, JSON.stringify(r), { expirationTtl: REQ_TTL });
  await log(env, t, me.id, "hall-ok", null).run();
  return { ok: true };
}
// POST /auth/hall/poll {code, secret} -> {wait} | {token, by, exp}
export async function hallPoll(env, b, t) {
  const code = b && b.code, secret = b && b.secret;
  if (!CODE_RE.test(code || "") || !SECRET_RE.test(secret || "")) return { err: "bad", status: 400 };
  const r = JSON.parse((await env.PUSH.get("hall:req:" + code)) || "null");
  if (!r || r.sh !== await sha(secret)) return { err: "expired", status: 404 };
  if (!r.ok) return { wait: true };
  await env.PUSH.delete("hall:req:" + code);
  const token = rnd(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), exp = t + HALL_TTL * 1000;
  await env.PUSH.put("hall:" + await sha(token), JSON.stringify({ user: r.ok.user, name: r.ok.name, exp }), { expirationTtl: HALL_TTL });
  return { token, by: r.ok.name, exp };
}
// the X-Hall header -> {user, name} while valid
export async function hallOf(env, req, t) {
  const tok = req.headers.get("X-Hall");
  if (!tok || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return null;
  const h = JSON.parse((await env.PUSH.get("hall:" + await sha(tok))) || "null");
  return h && h.exp > t ? h : null;
}
// POST /auth/hall/end (X-Hall): the computer gives it back
export async function hallEnd(env, req) {
  const tok = req.headers.get("X-Hall");
  if (tok && /^[A-Za-z0-9_-]{43}$/.test(tok)) await env.PUSH.delete("hall:" + await sha(tok));
  return { ok: true };
}
