// Club accounts without passwords (D1 binding DB, schema.sql). The admin makes a person and gets a one-time invite link
// (#in/<code>, 7 days); opening it on the phone gives that phone a random token (Authorization: Bearer). Only SHA-256
// hashes of codes and tokens are stored. Losing the phone: the admin revokes its devices and sends a new link.
// Roles: admin (everything), arr (arrangör: may start americanos). Without a login the app is read-only as before.
export const ORG = "nynas";
export const ROLES = ["admin", "arr"];
const INVITE_MS = 7 * 86400e3, MAX_DEVICES = 5, SEEN_MS = 3600e3, REQ_MS = 14 * 86400e3, REQ_OPEN = 30, REQ_TRIES = 5;
// the code a requesting phone shows (no 0/O, 1/I/L): "K7Q 42X"
const REQ_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const te = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
export const sha = async s => hex(await crypto.subtle.digest("SHA-256", te.encode(String(s))));
// n characters from abc, uniform (rejection sampling)
function rnd(n, abc) {
  let s = "";
  const lim = 256 - (256 % abc.length);
  while (s.length < n) for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < lim && s.length < n) s += abc[b % abc.length];
  return s;
}
const CODE_ABC = "abcdefghijkmnpqrstuvwxyz23456789", TOKEN_ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const CODE_RE = /^[a-z2-9]{20}$/, TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const rolesOf = async (env, id) => (await env.DB.prepare("SELECT role FROM roles WHERE user = ? AND org = ?").bind(id, ORG).all()).results.map(r => r.role).sort();
const log = (env, t, user, act, detail) => env.DB.prepare("INSERT INTO log (at, org, user, act, detail) VALUES (?, ?, ?, ?, ?)").bind(t, ORG, user, act, detail ? JSON.stringify(detail) : null);

// The logged-in person of a request, or null: {id, name, pid, roles}
export async function authUser(env, req, t) {
  if (!env.DB) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const hash = await sha(m[1]);
  const r = await env.DB.prepare("SELECT u.id, u.name, u.pid, d.seen FROM devices d JOIN users u ON u.id = d.user WHERE d.hash = ? AND u.disabled = 0 AND u.org = ?").bind(hash, ORG).first();
  if (!r) return null;
  if (t - r.seen > SEEN_MS) await env.DB.prepare("UPDATE devices SET seen = ? WHERE hash = ?").bind(t, hash).run();
  return meOf(env, r);
}
// {id, name, pid, roles, kids (the juniors a parent looks after), reqs (open requests, for an admin)}
async function meOf(env, u) {
  const roles = await rolesOf(env, u.id), kids = (await env.DB.prepare("SELECT pid FROM guardians WHERE user = ?").bind(u.id).all()).results.map(r => r.pid);
  const me = { id: u.id, name: u.name, pid: u.pid || null, roles, kids };
  if (roles.includes("admin")) me.reqs = (await env.DB.prepare("SELECT count(*) AS n FROM requests WHERE org = ? AND status = 'open' AND created > ?").bind(ORG, Date.now() - REQ_MS).first()).n;
  return me;
}
export const can = (u, role) => !!u && (u.roles.includes("admin") || u.roles.includes(role));

// #in/<code> -> {token, me}; the code works once
export async function redeem(env, b, t) {
  const code = String(b && b.code || "");
  if (!env.DB || !CODE_RE.test(code)) return { err: "bad code", status: 400 };
  const hash = await sha(code);
  const inv = await env.DB.prepare("SELECT i.user FROM invites i JOIN users u ON u.id = i.user WHERE i.hash = ? AND i.used IS NULL AND i.expires > ? AND u.disabled = 0").bind(hash, t).first();
  if (!inv) return { err: "invalid", status: 410 };
  // only one phone can take the code, even when two open it at the same moment
  const r = await env.DB.prepare("UPDATE invites SET used = ? WHERE hash = ? AND used IS NULL").bind(t, hash).run();
  if (!r.meta || r.meta.changes !== 1) return { err: "invalid", status: 410 };
  const token = await newDevice(env, inv.user, clean(b.label, 60) || null, t, "login");
  return { token, me: await meOf(env, await env.DB.prepare("SELECT id, name, pid FROM users WHERE id = ?").bind(inv.user).first()) };
}
// a new logged-in phone for the user (at most MAX_DEVICES: the least recently seen goes) -> its token
async function newDevice(env, user, label, t, act) {
  const token = rnd(43, TOKEN_ABC);
  const old = (await env.DB.prepare("SELECT hash FROM devices WHERE user = ? ORDER BY seen DESC").bind(user).all()).results.slice(MAX_DEVICES - 1);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices (hash, user, label, created, seen) VALUES (?, ?, ?, ?, ?)").bind(await sha(token), user, label, t, t),
    ...old.map(d => env.DB.prepare("DELETE FROM devices WHERE hash = ?").bind(d.hash)),
    log(env, t, user, act, label ? { label } : null),
  ]);
  return token;
}

// "Begär konto" in the app: POST /auth/request {pid, name, parent, msg, label} -> {wait, code}. The phone keeps wait and
// shows code; the person sends the code to the admin (WhatsApp, SMS, in person), who types it in to approve.
export async function requestAccess(env, b, t, byPid) {
  if (!env.DB) return { err: "no database", status: 503 };
  const pid = Number(b && b.pid) || null, P = pid && byPid.get(pid), parent = !!(b && b.parent);
  if (pid && !P) return { err: "unknown player", status: 400 };
  const name = parent || !P ? clean(b && b.name, 60) : P.me || P.name;
  if (!name || (parent && !pid)) return { err: "name", status: 400 };
  await env.DB.prepare("DELETE FROM requests WHERE org = ? AND created < ?").bind(ORG, t - REQ_MS).run();
  if ((await env.DB.prepare("SELECT count(*) AS n FROM requests WHERE org = ? AND status = 'open'").bind(ORG).first()).n >= REQ_OPEN) return { err: "full", status: 429 };
  const id = rnd(10, CODE_ABC), wait = rnd(43, TOKEN_ABC), code = rnd(6, REQ_ABC);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO requests (id, org, pid, name, parent, msg, label, code, wait, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ORG, pid, name, parent ? 1 : 0, clean(b && b.msg, 200) || null, clean(b && b.label, 60) || null, await sha(code), await sha(wait), t),
    log(env, t, null, "request", { id, pid, name, parent }),
  ]);
  return { id, wait, code: code.slice(0, 3) + " " + code.slice(3) };
}
// The waiting phone asks: POST /auth/request/poll {wait} -> {status: open|no|gone} or, once approved, {status: done, token, me}
export async function requestPoll(env, b, t) {
  const w = String(b && b.wait || "");
  if (!env.DB || !TOKEN_RE.test(w)) return { err: "bad", status: 400 };
  const hash = await sha(w), r = await env.DB.prepare("SELECT id, status, user, label, created FROM requests WHERE wait = ?").bind(hash).first();
  if (!r || r.status === "done" || (r.status === "open" && t - r.created > REQ_MS)) return { status: "gone" };
  if (r.status !== "ok") return { status: r.status };
  // collected once: the approved request becomes this phone's login
  const x = await env.DB.prepare("UPDATE requests SET status = 'done' WHERE id = ? AND status = 'ok'").bind(r.id).run();
  if (!x.meta || x.meta.changes !== 1) return { status: "gone" };
  const token = await newDevice(env, r.user, r.label, t, "login-request");
  return { status: "done", token, me: await meOf(env, await env.DB.prepare("SELECT id, name, pid FROM users WHERE id = ?").bind(r.user).first()) };
}
export async function requestCancel(env, b) {
  const w = String(b && b.wait || "");
  if (env.DB && TOKEN_RE.test(w)) await env.DB.prepare("DELETE FROM requests WHERE wait = ? AND status = 'open'").bind(await sha(w)).run();
  return { ok: true };
}

export async function logout(env, req) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get("Authorization") || "");
  if (m && env.DB) await env.DB.prepare("DELETE FROM devices WHERE hash = ?").bind(await sha(m[1])).run();
  return { ok: true };
}

// Admin: everyone, with roles, phones and a pending invite
export async function adminUsers(env, t) {
  const us = (await env.DB.prepare("SELECT id, name, pid, created, disabled FROM users WHERE org = ? ORDER BY name").bind(ORG).all()).results;
  const rs = (await env.DB.prepare("SELECT user, role FROM roles WHERE org = ?").bind(ORG).all()).results;
  const ds = (await env.DB.prepare("SELECT d.user, d.label, d.seen FROM devices d JOIN users u ON u.id = d.user WHERE u.org = ? ORDER BY d.seen DESC").bind(ORG).all()).results;
  const is = (await env.DB.prepare("SELECT i.user, i.expires FROM invites i JOIN users u ON u.id = i.user WHERE u.org = ? AND i.used IS NULL AND i.expires > ?").bind(ORG, t).all()).results;
  const gs = (await env.DB.prepare("SELECT g.user, g.pid FROM guardians g JOIN users u ON u.id = g.user WHERE u.org = ?").bind(ORG).all()).results;
  const rq = (await env.DB.prepare("SELECT id, pid, name, parent, msg, label, created, tries FROM requests WHERE org = ? AND status = 'open' AND created > ? ORDER BY created DESC").bind(ORG, t - REQ_MS).all()).results;
  return { requests: rq.map(r => ({ ...r, parent: !!r.parent })), users: us.map(u => ({ id: u.id, name: u.name, pid: u.pid || null, created: u.created, disabled: !!u.disabled, kids: gs.filter(g => g.user === u.id).map(g => g.pid),
    roles: rs.filter(r => r.user === u.id).map(r => r.role).sort(),
    devices: ds.filter(d => d.user === u.id).map(d => ({ label: d.label, seen: d.seen })),
    invite: (is.find(i => i.user === u.id) || {}).expires || null })) };
}
async function newInvite(env, id, t) {
  const code = rnd(20, CODE_ABC);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE user = ? AND used IS NULL").bind(id),   // the latest link is the only one that works
    env.DB.prepare("INSERT INTO invites (hash, user, created, expires) VALUES (?, ?, ?, ?)").bind(await sha(code), id, t, t + INVITE_MS),
  ]);
  return { code, expires: t + INVITE_MS };
}
const validRoles = r => [...new Set((Array.isArray(r) ? r : []).filter(x => ROLES.includes(x)))];
// POST /admin {op, ...}: add {name, pid, roles} | invite {id} | roles {id, roles} | revoke {id} | disable {id, on} | remove {id}
export async function adminOp(env, me, b, t, byPid) {
  const op = b && b.op, who = me ? me.id : "admin-key";
  if (op === "add") {
    const pid = Number(b.pid) || null, P = pid && byPid.get(pid);
    if (pid && !P) return { err: "unknown player", status: 400 };
    const name = P ? P.me || P.name : clean(b.name, 60);
    if (!name) return { err: "name", status: 400 };
    if (pid && await env.DB.prepare("SELECT id FROM users WHERE org = ? AND pid = ?").bind(ORG, pid).first()) return { err: "exists", status: 409 };
    const id = rnd(10, CODE_ABC), roles = validRoles(b.roles);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, org, name, pid, created) VALUES (?, ?, ?, ?, ?)").bind(id, ORG, name, pid, t),
      ...roles.map(r => env.DB.prepare("INSERT INTO roles (user, org, role) VALUES (?, ?, ?)").bind(id, ORG, r)),
      log(env, t, who, "add", { id, name, roles }),
    ]);
    return { id, ...(await newInvite(env, id, t)) };
  }
  if (op === "approve" || op === "reject") {
    const r = b && typeof b.rid === "string" && await env.DB.prepare("SELECT * FROM requests WHERE id = ? AND org = ? AND status = 'open' AND created > ?").bind(b.rid, ORG, t - REQ_MS).first();
    if (!r) return { err: "not found", status: 404 };
    if (op === "reject") {
      await env.DB.batch([env.DB.prepare("UPDATE requests SET status = 'no' WHERE id = ?").bind(r.id), log(env, t, who, "reject", { rid: r.id, name: r.name })]);
      return { ok: true };
    }
    // the code from the person's phone, sent to the admin some way they trust; 5 wrong and the request is closed
    if ((await sha(normCode(b.code))) !== r.code) {
      const tries = r.tries + 1;
      await env.DB.prepare("UPDATE requests SET tries = ?, status = ? WHERE id = ?").bind(tries, tries >= REQ_TRIES ? "no" : "open", r.id).run();
      return { err: tries >= REQ_TRIES ? "locked" : "code", status: 400, left: REQ_TRIES - tries };
    }
    const roles = validRoles(b.roles);
    // a player who already has an account: this phone joins it; otherwise a new account (a parent's always)
    let id = !r.parent && r.pid ? ((await env.DB.prepare("SELECT id FROM users WHERE org = ? AND pid = ?").bind(ORG, r.pid).first()) || {}).id : null;
    const q = [];
    if (!id) {
      id = rnd(10, CODE_ABC);
      q.push(env.DB.prepare("INSERT INTO users (id, org, name, pid, created) VALUES (?, ?, ?, ?, ?)").bind(id, ORG, r.name, r.parent ? null : r.pid, t));
    }
    if (r.parent) q.push(env.DB.prepare("INSERT OR IGNORE INTO guardians (user, pid) VALUES (?, ?)").bind(id, r.pid));
    q.push(...roles.map(x => env.DB.prepare("INSERT OR IGNORE INTO roles (user, org, role) VALUES (?, ?, ?)").bind(id, ORG, x)),
      env.DB.prepare("UPDATE requests SET status = 'ok', user = ? WHERE id = ?").bind(id, r.id), log(env, t, who, "approve", { rid: r.id, id, name: r.name, roles }));
    await env.DB.batch(q);
    return { ok: true, id, pid: r.pid || null };
  }
  const u = b && typeof b.id === "string" && await env.DB.prepare("SELECT id, name FROM users WHERE id = ? AND org = ?").bind(b.id, ORG).first();
  if (!u) return { err: "not found", status: 404 };
  // the admin cannot lock themselves out
  if (me && u.id === me.id && (op === "remove" || op === "disable" || (op === "roles" && !validRoles(b.roles).includes("admin")))) return { err: "self", status: 400 };
  if (op === "invite") { await log(env, t, who, "invite", { id: u.id }).run(); return newInvite(env, u.id, t); }
  if (op === "roles") {
    const roles = validRoles(b.roles);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM roles WHERE user = ? AND org = ?").bind(u.id, ORG),
      ...roles.map(r => env.DB.prepare("INSERT INTO roles (user, org, role) VALUES (?, ?, ?)").bind(u.id, ORG, r)),
      log(env, t, who, "roles", { id: u.id, roles }),
    ]);
    return { ok: true, roles };
  }
  if (op === "revoke") {
    await env.DB.batch([env.DB.prepare("DELETE FROM devices WHERE user = ?").bind(u.id), env.DB.prepare("DELETE FROM invites WHERE user = ? AND used IS NULL").bind(u.id), log(env, t, who, "revoke", { id: u.id })]);
    return { ok: true };
  }
  if (op === "disable") {
    await env.DB.batch([env.DB.prepare("UPDATE users SET disabled = ? WHERE id = ?").bind(b.on ? 1 : 0, u.id), log(env, t, who, b.on ? "disable" : "enable", { id: u.id })]);
    return { ok: true };
  }
  if (op === "remove") {
    await env.DB.batch(["devices", "invites", "roles", "guardians"].map(tb => env.DB.prepare("DELETE FROM " + tb + " WHERE user = ?").bind(u.id))
      .concat([env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id), log(env, t, who, "remove", { id: u.id, name: u.name })]));
    return { ok: true };
  }
  return { err: "bad op", status: 400 };
}
