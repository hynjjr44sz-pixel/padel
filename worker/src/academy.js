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
  const gs = (await env.DB.prepare("SELECT g.id, g.name, g.owner, p.shown, p.level, p.sched, p.max, p.price, p.info, (SELECT count(*) FROM tgroup_members m WHERE m.gid = g.id) AS n " +
    "FROM tgroups g LEFT JOIN tgroup_pub p ON p.gid = g.id WHERE g.org = ? ORDER BY g.name").bind(ORG).all()).results
    .filter(g => g.shown || (all && g.owner === me.id))
    .map(g => ({ id: g.id, name: g.name, shown: !!g.shown, level: g.level, sched: g.sched, max: g.max, price: g.price, info: g.info, n: g.n, ...(all && g.owner === me.id ? { mine: true } : {}) }));
  return { intro: a.intro || null, ptext: a.ptext || null, pprice: a.pprice || null, groups: gs };
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
    await env.DB.prepare("INSERT OR REPLACE INTO tgroup_pub (gid, shown, level, sched, max, price, info) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(g.id, b.shown ? 1 : 0, clean(b.level, 40) || null, clean(b.sched, 80) || null, max, clean(b.price, 80) || null, text(b.info, 600)).run();
    return { ok: true };
  }
  return { err: "bad op", status: 400 };
}
// POST /academy/interest {kind: grupp|privat, gid?, name, contact, age, msg} (anyone; at most PER_IP a day from one network)
export async function interestPost(env, b, t, ipHash) {
  if (!env.DB) return { err: "no database", status: 503 };
  const kind = b && b.kind === "privat" ? "privat" : "grupp", name = clean(b && b.name, 60), contact = clean(b && b.contact, 80);
  if (!name || !contact || contact.length < 5) return { err: "name", status: 400 };
  let gname = null;
  const gid = kind === "grupp" && typeof b.gid === "string" ? b.gid : null;
  if (gid) {
    const g = await env.DB.prepare("SELECT g.name FROM tgroups g JOIN tgroup_pub p ON p.gid = g.id WHERE g.id = ? AND p.shown = 1").bind(gid).first();
    if (!g) return { err: "group", status: 400 };
    gname = g.name;
  }
  await env.DB.prepare("DELETE FROM interest WHERE org = ? AND created < ?").bind(ORG, t - KEEP_MS).run();
  if (ipHash && (await env.DB.prepare("SELECT count(*) AS n FROM interest WHERE ip = ? AND created > ?").bind(ipHash, t - 864e5).first()).n >= PER_IP) return { err: "limit", status: 429 };
  const id = rid();
  await env.DB.prepare("INSERT INTO interest (id, org, kind, gid, name, contact, age, msg, ip, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ORG, kind, gid, name, contact, clean(b.age, 40) || null, text(b.msg, 600), ipHash || null, t).run();
  try {
    const heads = (await env.DB.prepare("SELECT user FROM roles WHERE org = ? AND role = 'tranare'").bind(ORG).all()).results.map(r => r.user);
    await notifyUsers(env, heads, { title: kind === "privat" ? "Intresse: privatlektion" : "Intresse: " + (gname || "gruppträning"), body: name + " vill veta mer. Se Träning, Grupper.", url: "#traning", tag: "padel-intresse" });
  } catch (e) {}
  return { ok: true };
}
// GET /academy/interest (a head coach) -> {list}; POST /academy/interest {id, status: ny|kontaktad} | {id, op: del}
export async function interestList(env, me) {
  if (!isHead(me)) return { err: "forbidden", status: 403 };
  const l = (await env.DB.prepare("SELECT i.id, i.kind, i.gid, g.name AS gname, i.name, i.contact, i.age, i.msg, i.created, i.status FROM interest i LEFT JOIN tgroups g ON g.id = i.gid WHERE i.org = ? ORDER BY i.created DESC LIMIT 200").bind(ORG).all()).results;
  return { list: l };
}
export async function interestMark(env, me, b, t) {
  if (!isHead(me)) return { err: "forbidden", status: 403 };
  const r = b && typeof b.id === "string" && await env.DB.prepare("SELECT id FROM interest WHERE id = ? AND org = ?").bind(b.id, ORG).first();
  if (!r) return { err: "not found", status: 404 };
  if (b.op === "del") await env.DB.prepare("DELETE FROM interest WHERE id = ?").bind(r.id).run();
  else await env.DB.batch([env.DB.prepare("UPDATE interest SET status = ? WHERE id = ?").bind(b.status === "kontaktad" ? "kontaktad" : "ny", r.id), log(env, t, me.id, "interest", { id: r.id, status: b.status })]);
  return { ok: true };
}
