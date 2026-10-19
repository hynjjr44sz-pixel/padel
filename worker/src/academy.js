// Akademin: a public page about the club's academy: an intro, the training groups the head coach chooses to show (name,
// level, when, how many and how many places, price; never who is in them), private lessons; and an interest form for
// anyone (no login), which goes to the head coaches (role tranare) only: a notis and the list under Träning.
import { clean, log, ORG } from "./auth.js";
import { notifyUsers } from "./notify.js";

const PER_IP = 5, KEEP_MS = 365 * 864e5;
const text = (s, n) => String(s || "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "").trim().slice(0, n) || null;
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
const isHead = me => !!me && me.roles.includes("tranare");

// GET /academy (public)
export async function academyGet(env, me) {
  if (!env.DB) return { err: "no database", status: 503 };
  const a = (await env.DB.prepare("SELECT intro, ptext, pprice FROM academy WHERE org = ?").bind(ORG).first()) || {};
  const all = isHead(me);   // the coach sees their groups not shown too (to choose)
  const gs = (await env.DB.prepare("SELECT g.id, g.name, g.owner, p.shown, p.level, p.sched, p.max, p.price, p.info, s.dow, s.time, s.min, s.open, (SELECT count(*) FROM tgroup_members m WHERE m.gid = g.id) AS n " +
    "FROM tgroups g LEFT JOIN tgroup_pub p ON p.gid = g.id LEFT JOIN tgroup_slot s ON s.gid = g.id WHERE g.org = ? ORDER BY g.name").bind(ORG).all()).results
    .filter(g => g.shown || (all && g.owner === me.id))
    .map(g => ({ id: g.id, name: g.name, shown: !!g.shown, level: g.level, sched: g.sched, max: g.max, price: g.price, info: g.info, n: g.n,
      dow: g.dow ?? null, time: g.time || null, min: g.min || null, open: !!g.open, ...(all && g.owner === me.id ? { mine: true } : {}) }));
  const out = { intro: a.intro || null, ptext: a.ptext || null, pprice: a.pprice || null, groups: gs };
  if (all) out.swish = ((await env.DB.prepare("SELECT swish FROM academy_pay WHERE org = ?").bind(ORG).first()) || {}).swish || null;   // the coach's settings
  return out;
}
// POST /academy {op: page {intro, ptext, pprice} | group {gid, shown, level, sched, max, price, info}}: a head coach
export async function academyPost(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!isHead(me)) return { err: "forbidden", status: 403 };
  if (b && b.op === "page") {
    await env.DB.prepare("INSERT INTO academy (org, intro, ptext, pprice, updated, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(org) DO UPDATE SET intro = excluded.intro, ptext = excluded.ptext, pprice = excluded.pprice, updated = excluded.updated, by = excluded.by")
      .bind(ORG, text(b.intro, 1500), text(b.ptext, 1500), text(b.pprice, 80), t, me.id).run();
    return { ok: true };
  }
  if (b && b.op === "group") {
    const g = typeof b.gid === "string" && await env.DB.prepare("SELECT id FROM tgroups WHERE id = ? AND owner = ?").bind(b.gid, me.id).first();
    if (!g) return { err: "not found", status: 404 };
    const max = b.max ? Math.round(Number(b.max)) : null;
    if (max !== null && !(max >= 1 && max <= 99)) return { err: "max", status: 400 };
    // the fixed slot: weekday, start and length; "När" then reads e.g. "Onsdagar 19:00–20:30"
    const dow = b.dow === "" || b.dow == null ? null : Number(b.dow), time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || "") ? b.time : null, min = b.min ? Math.round(Number(b.min)) : null;
    if ((dow !== null && !(dow >= 0 && dow <= 6)) || (min !== null && !(min >= 15 && min <= 300))) return { err: "slot", status: 400 };
    let sched = clean(b.sched, 80) || null;
    if (dow !== null && time) {
      const end = min ? new Date(Date.parse("2000-01-01T" + time + ":00Z") + min * 60e3).toISOString().slice(11, 16) : null;
      sched = ["Söndagar", "Måndagar", "Tisdagar", "Onsdagar", "Torsdagar", "Fredagar", "Lördagar"][dow] + " " + time + (end ? "–" + end : "");
    }
    await env.DB.batch([env.DB.prepare("INSERT OR REPLACE INTO tgroup_pub (gid, shown, level, sched, max, price, info) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(g.id, b.shown ? 1 : 0, clean(b.level, 40) || null, sched, max, clean(b.price, 80) || null, text(b.info, 600)),
      env.DB.prepare("INSERT OR REPLACE INTO tgroup_slot (gid, dow, time, min, open) VALUES (?, ?, ?, ?, ?)").bind(g.id, dow, time, min, b.open ? 1 : 0)]);
    return { ok: true };
  }
  return { err: "bad op", status: 400 };
}
// POST /academy/interest {kind: grupp|privat|anmalan, gid?, name, contact, age, msg, pid?} (anyone; at most PER_IP a day from
// one network). anmalan: a sign-up for a group open for it; from a logged-in account for one of its players (pid), the coach
// adds the player with one tap
export async function interestPost(env, b, t, ipHash, me, canTrain) {
  if (!env.DB) return { err: "no database", status: 503 };
  const kind = b && (b.kind === "privat" || b.kind === "anmalan") ? b.kind : "grupp";
  const pid = me && b && b.pid && canTrain(me, Number(b.pid)) ? Number(b.pid) : null;
  let name = clean(b && b.name, 60), contact = clean(b && b.contact, 80);
  if (pid && !name) name = ((await env.DB.prepare("SELECT name FROM users WHERE pid = ? AND org = ?").bind(pid, ORG).first()) || {}).name || null;
  if (pid && !contact) contact = "Konto i appen: " + me.name;
  if (!name || !contact || contact.length < 5) return { err: "name", status: 400 };
  let gname = null;
  const gid = kind !== "privat" && typeof b.gid === "string" ? b.gid : null;
  if (kind === "anmalan" && !gid) return { err: "group", status: 400 };
  if (gid) {
    const g = await env.DB.prepare("SELECT g.name, s.open FROM tgroups g JOIN tgroup_pub p ON p.gid = g.id LEFT JOIN tgroup_slot s ON s.gid = g.id WHERE g.id = ? AND p.shown = 1").bind(gid).first();
    if (!g || (kind === "anmalan" && !g.open)) return { err: "group", status: 400 };
    if (pid && await env.DB.prepare("SELECT pid FROM tgroup_members WHERE gid = ? AND pid = ?").bind(gid, pid).first()) return { err: "member", status: 400 };
    gname = g.name;
  }
  await env.DB.prepare("DELETE FROM interest WHERE org = ? AND created < ?").bind(ORG, t - KEEP_MS).run();
  if (ipHash && (await env.DB.prepare("SELECT count(*) AS n FROM interest WHERE ip = ? AND created > ?").bind(ipHash, t - 864e5).first()).n >= PER_IP) return { err: "limit", status: 429 };
  const id = rid();
  await env.DB.batch([env.DB.prepare("INSERT INTO interest (id, org, kind, gid, name, contact, age, msg, ip, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ORG, kind, gid, name, contact, clean(b.age, 40) || null, text(b.msg, 600), ipHash || null, t),
    ...(pid ? [env.DB.prepare("INSERT INTO interest_pid (id, pid) VALUES (?, ?)").bind(id, pid)] : [])]);
  try {
    const heads = (await env.DB.prepare("SELECT user FROM roles WHERE org = ? AND role = 'tranare'").bind(ORG).all()).results.map(r => r.user);
    await notifyUsers(env, heads, { title: kind === "privat" ? "Intresse: privatlektion" : kind === "anmalan" ? "Anmälan: " + gname : "Intresse: " + (gname || "gruppträning"), body: name + (kind === "anmalan" ? " vill gå med i gruppen." : " vill veta mer.") + " Se Träning, Grupper.", url: "#traning", tag: "padel-intresse" });
  } catch (e) {}
  return { ok: true };
}
// GET /academy/interest (a head coach) -> {list}; POST /academy/interest {id, status: ny|kontaktad} | {id, op: del}
export async function interestList(env, me) {
  if (!isHead(me)) return { err: "forbidden", status: 403 };
  const l = (await env.DB.prepare("SELECT i.id, i.kind, i.gid, g.name AS gname, i.name, i.contact, i.age, i.msg, i.created, i.status, x.pid, (SELECT count(*) FROM tgroup_members m WHERE m.gid = i.gid AND m.pid = x.pid) AS member " +
    "FROM interest i LEFT JOIN tgroups g ON g.id = i.gid LEFT JOIN interest_pid x ON x.id = i.id WHERE i.org = ? ORDER BY i.created DESC LIMIT 200").bind(ORG).all()).results;
  return { list: l };
}
export async function interestMark(env, me, b, t) {
  if (!isHead(me)) return { err: "forbidden", status: 403 };
  const r = b && typeof b.id === "string" && await env.DB.prepare("SELECT id FROM interest WHERE id = ? AND org = ?").bind(b.id, ORG).first();
  if (!r) return { err: "not found", status: 404 };
  if (b.op === "add") {
    // a sign-up with a player: into the group (the coach's own), marked handled
    const x = await env.DB.prepare("SELECT i.gid, p.pid FROM interest i JOIN interest_pid p ON p.id = i.id JOIN tgroups g ON g.id = i.gid WHERE i.id = ? AND g.owner = ?").bind(r.id, me.id).first();
    if (!x) return { err: "not found", status: 404 };
    await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO tgroup_members (gid, pid) VALUES (?, ?)").bind(x.gid, x.pid), env.DB.prepare("UPDATE interest SET status = 'kontaktad' WHERE id = ?").bind(r.id), log(env, t, me.id, "signup-add", { gid: x.gid, pid: x.pid })]);
    return { ok: true };
  }
  if (b.op === "del") await env.DB.batch([env.DB.prepare("DELETE FROM interest_pid WHERE id = ?").bind(r.id), env.DB.prepare("DELETE FROM interest WHERE id = ?").bind(r.id)]);
  else await env.DB.batch([env.DB.prepare("UPDATE interest SET status = ? WHERE id = ?").bind(b.status === "kontaktad" ? "kontaktad" : "ny", r.id), log(env, t, me.id, "interest", { id: r.id, status: b.status })]);
  return { ok: true };
}

// Fees. A group's price is the coach's text ("1 200 kr/termin"); the amount is its first number. The app never sees a
// payment: the player says "swishad" or asks for MATCHi, the coach marks "betald" (or "gratis") after checking.
export const amountOf = p => { const m = /(\d[\d\s]*)/.exec(String(p || "")); const n = m ? Number(m[1].replace(/\s/g, "")) : 0; return n > 0 && n < 100000 ? n : null; };
const PLAYER_SET = ["swishad", "matchi", "obetald"], COACH_SET = ["swishad", "matchi", "obetald", "betald", "gratis"];
// GET /pay?pid= (the player, parents, coaches) -> {swish, fees: [{gid, gname, price, amount, status}]} for their groups with a price
// GET /pay?gid= (the group's coach) -> {fees: [{pid, status, at}]}
export async function payGet(env, me, q, canTrain) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me) return { err: "login", status: 401 };
  const swish = ((await env.DB.prepare("SELECT swish FROM academy_pay WHERE org = ?").bind(ORG).first()) || {}).swish || null;
  if (q.gid) {
    const g = await env.DB.prepare("SELECT id FROM tgroups WHERE id = ? AND owner = ?").bind(q.gid, me.id).first();
    if (!g) return { err: "forbidden", status: 403 };
    const rows = (await env.DB.prepare("SELECT m.pid, p.status, p.at FROM tgroup_members m LEFT JOIN tpay p ON p.gid = m.gid AND p.pid = m.pid WHERE m.gid = ?").bind(g.id).all()).results;
    return { swish, fees: rows.map(r => ({ pid: r.pid, status: r.status || "obetald", at: r.at || null })) };
  }
  const pid = Number(q.pid);
  if (!canTrain(me, pid)) return { err: "forbidden", status: 403 };
  const rows = (await env.DB.prepare("SELECT g.id, g.name, u.price, p.status FROM tgroup_members m JOIN tgroups g ON g.id = m.gid JOIN tgroup_pub u ON u.gid = g.id LEFT JOIN tpay p ON p.gid = g.id AND p.pid = m.pid WHERE m.pid = ? AND u.price IS NOT NULL").bind(pid).all()).results;
  return { swish, fees: rows.map(r => ({ gid: r.id, gname: r.name, price: r.price, amount: amountOf(r.price), status: r.status || "obetald" })) };
}
// POST /pay {gid, pid, status} | {gid, op: "reset"} (a new term: all but "gratis" back to not paid; the coach) | {op: "swish", swish} (the coach)
export async function payPost(env, me, b, t, canTrain) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me) return { err: "login", status: 401 };
  if (b && b.op === "swish") {
    if (!isHead(me)) return { err: "forbidden", status: 403 };
    const sw = String(b.swish || "").replace(/[^\d]/g, "");
    if (sw && !/^\d{7,12}$/.test(sw)) return { err: "swish", status: 400 };
    await env.DB.prepare("INSERT OR REPLACE INTO academy_pay (org, swish) VALUES (?, ?)").bind(ORG, sw || null).run();
    return { ok: true };
  }
  const g = b && typeof b.gid === "string" && await env.DB.prepare("SELECT id, owner FROM tgroups WHERE id = ? AND org = ?").bind(b.gid, ORG).first();
  if (!g) return { err: "not found", status: 404 };
  const coach = g.owner === me.id;
  if (b.op === "reset") {
    if (!coach) return { err: "forbidden", status: 403 };
    await env.DB.batch([env.DB.prepare("DELETE FROM tpay WHERE gid = ? AND status != 'gratis'").bind(g.id), log(env, t, me.id, "pay-reset", { gid: g.id })]);
    return { ok: true };
  }
  const pid = Number(b.pid), status = String(b.status || "");
  if (!(await env.DB.prepare("SELECT pid FROM tgroup_members WHERE gid = ? AND pid = ?").bind(g.id, pid).first())) return { err: "not found", status: 404 };
  if (!(coach ? COACH_SET : PLAYER_SET).includes(status)) return { err: "status", status: 400 };
  if (!coach) {
    if (!canTrain(me, pid)) return { err: "forbidden", status: 403 };
    const cur = ((await env.DB.prepare("SELECT status FROM tpay WHERE gid = ? AND pid = ?").bind(g.id, pid).first()) || {}).status;
    if (cur === "betald" || cur === "gratis") return { err: "done", status: 400 };   // settled by the coach
  }
  if (status === "obetald") await env.DB.prepare("DELETE FROM tpay WHERE gid = ? AND pid = ?").bind(g.id, pid).run();
  else await env.DB.prepare("INSERT OR REPLACE INTO tpay (gid, pid, status, at, by) VALUES (?, ?, ?, ?, ?)").bind(g.id, pid, status, t, me.id).run();
  if (!coach && (status === "swishad" || status === "matchi")) try {
    const gn = (await env.DB.prepare("SELECT name FROM tgroups WHERE id = ?").bind(g.id).first()).name;
    await notifyUsers(env, [g.owner], { title: status === "swishad" ? "Swishat: " + gn : "Dra från MATCHi: " + gn, body: me.name + " · bekräfta under Träning, Grupper", url: "#traning", tag: "padel-pay-" + g.id + "-" + pid });
  } catch (e) {}
  return { ok: true };
}
