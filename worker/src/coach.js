// Träning, fas 2: a head coach's (tranare) training groups and assistant coaches, the club's exercise library (slag,
// övningar, strategi, fys; a YouTube clip each when there is a good one), and plans: a session ahead for a group or one
// player, with exercises. The player marks a plan done by logging it (train.js: the minutes, RPE and note are the
// feedback the coach sees). Who sees what:
//   a head coach: their groups, members' training (auth.js: me.coach), plans, the library, picks assistants
//   an assistant: the library, their coaches' groups and plans; not the players' own training
//   a PT: their linked players' training and plans, the library
//   a player (and parents): their own plans, with the exercises in them
import { clean, log, ORG } from "./auth.js";
import { KINDS, canTrain } from "./train.js";
import { notifyUsers } from "./notify.js";

export const CATS = ["slag", "ovningar", "strategi", "fys"];
const LEVELS = ["alla", "nyborjare", "medel", "avancerad"];
const DAY_RE = /^\d{4}-\d\d-\d\d$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/, YT_RE = /^[A-Za-z0-9_-]{11}$/;
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
const isHead = me => !!me && me.roles.includes("tranare");
export const isLib = me => !!me && (me.roles.includes("tranare") || me.roles.includes("pt") || (me.assist || []).length > 0);
// A YouTube link in any form -> the video id
export function ytId(s) {
  s = String(s || "").trim();
  if (YT_RE.test(s)) return s;
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}

// The groups this account works with: own (a head coach) or their coaches' (an assistant)
async function myGroups(env, me) {
  const owners = [...(isHead(me) ? [me.id] : []), ...(me.assist || [])];
  if (!owners.length) return [];
  const gs = (await env.DB.prepare("SELECT id, owner, name FROM tgroups WHERE org = ? AND owner IN (" + owners.map(() => "?").join(",") + ") ORDER BY name").bind(ORG, ...owners).all()).results;
  const ms = gs.length ? (await env.DB.prepare("SELECT gid, pid FROM tgroup_members WHERE gid IN (" + gs.map(() => "?").join(",") + ")").bind(...gs.map(g => g.id)).all()).results : [];
  return gs.map(g => ({ ...g, own: g.owner === me.id, pids: ms.filter(m => m.gid === g.id).map(m => m.pid) }));
}
const canGroup = async (env, me, gid) => (await myGroups(env, me)).find(g => g.id === gid) || null;

// GET /coach -> {groups, assistants, accounts}
export async function coachGet(env, me) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!isLib(me)) return { err: "forbidden", status: 403 };
  const out = { groups: await myGroups(env, me), head: isHead(me) };
  if (isHead(me)) {
    out.assistants = (await env.DB.prepare("SELECT u.id, u.name FROM assistants a JOIN users u ON u.id = a.user WHERE a.coach = ? ORDER BY u.name").bind(me.id).all()).results;
    // whom one can make an assistant: club accounts (names only)
    out.accounts = (await env.DB.prepare("SELECT id, name FROM users WHERE org = ? AND disabled = 0 AND id != ? ORDER BY name").bind(ORG, me.id).all()).results;
  }
  return out;
}
// POST /coach {op: group {id?, name, pids} | group-del {id} | assist {users}}: a head coach
export async function coachPost(env, me, b, t, byPid) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!isHead(me)) return { err: "forbidden", status: 403 };
  const op = b && b.op;
  if (op === "group") {
    const name = clean(b.name, 60), pids = [...new Set((Array.isArray(b.pids) ? b.pids : []).map(Number))].slice(0, 80);
    if (!name) return { err: "name", status: 400 };
    if (pids.some(p => !byPid.has(p))) return { err: "unknown player", status: 400 };
    let id = typeof b.id === "string" ? b.id : null;
    if (id && !(await env.DB.prepare("SELECT id FROM tgroups WHERE id = ? AND owner = ?").bind(id, me.id).first())) return { err: "not found", status: 404 };
    const q = [];
    if (id) q.push(env.DB.prepare("UPDATE tgroups SET name = ? WHERE id = ?").bind(name, id), env.DB.prepare("DELETE FROM tgroup_members WHERE gid = ?").bind(id));
    else { id = rid(); q.push(env.DB.prepare("INSERT INTO tgroups (id, org, owner, name, created) VALUES (?, ?, ?, ?, ?)").bind(id, ORG, me.id, name, t)); }
    q.push(...pids.map(p => env.DB.prepare("INSERT INTO tgroup_members (gid, pid) VALUES (?, ?)").bind(id, p)), log(env, t, me.id, "group", { id, name, n: pids.length }));
    await env.DB.batch(q);
    return { ok: true, id };
  }
  if (op === "group-del") {
    const g = typeof b.id === "string" && await env.DB.prepare("SELECT id FROM tgroups WHERE id = ? AND owner = ?").bind(b.id, me.id).first();
    if (!g) return { err: "not found", status: 404 };
    await env.DB.batch([env.DB.prepare("DELETE FROM tgroup_members WHERE gid = ?").bind(g.id), env.DB.prepare("DELETE FROM plans WHERE gid = ?").bind(g.id), env.DB.prepare("DELETE FROM tgroups WHERE id = ?").bind(g.id)]);
    return { ok: true };
  }
  if (op === "assist") {
    const users = [...new Set((Array.isArray(b.users) ? b.users : []).filter(x => typeof x === "string" && x !== me.id))].slice(0, 30);
    if (users.length) {
      const ok = (await env.DB.prepare("SELECT id FROM users WHERE org = ? AND id IN (" + users.map(() => "?").join(",") + ")").bind(ORG, ...users).all()).results.map(r => r.id);
      if (ok.length !== users.length) return { err: "unknown account", status: 400 };
    }
    await env.DB.batch([env.DB.prepare("DELETE FROM assistants WHERE coach = ?").bind(me.id), ...users.map(u => env.DB.prepare("INSERT INTO assistants (coach, user) VALUES (?, ?)").bind(me.id, u)), log(env, t, me.id, "assist", { n: users.length })]);
    return { ok: true, users };
  }
  return { err: "bad op", status: 400 };
}

// GET /lib -> {ex: [...]}
export async function libGet(env, me) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!isLib(me)) return { err: "forbidden", status: 403 };
  const ex = (await env.DB.prepare("SELECT id, cat, topic, title, body, yt, level, min, by, updated FROM exercises WHERE org = ? ORDER BY cat, topic, title").bind(ORG).all()).results;
  return { ex: ex.map(x => ({ ...x, mine: x.by === me.id })) };
}
// POST /lib {op: save {id?, cat, topic, title, body, yt (link or id), level, min} | del {id}}: anyone with the library;
// changing or removing someone else's exercise takes a head coach
export async function libPost(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!isLib(me)) return { err: "forbidden", status: 403 };
  const old = b && typeof b.id === "string" ? await env.DB.prepare("SELECT id, by FROM exercises WHERE id = ? AND org = ?").bind(b.id, ORG).first() : null;
  if (b && b.id && !old) return { err: "not found", status: 404 };
  if (old && old.by !== me.id && !isHead(me)) return { err: "forbidden", status: 403 };
  if (b && b.op === "del") {
    if (!old) return { err: "not found", status: 404 };
    await env.DB.prepare("DELETE FROM exercises WHERE id = ?").bind(old.id).run();
    return { ok: true };
  }
  const title = clean(b && b.title, 80), cat = String(b && b.cat || ""), level = LEVELS.includes(b && b.level) ? b.level : "alla";
  const yt = b && b.yt ? ytId(b.yt) : null, min = b && b.min ? Math.round(Number(b.min)) : null;
  if (!title || !CATS.includes(cat)) return { err: "bad exercise", status: 400 };
  if (b.yt && !yt) return { err: "youtube", status: 400 };
  if (min !== null && !(min >= 1 && min <= 180)) return { err: "min", status: 400 };
  const body = String(b.body || "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "").trim().slice(0, 2000) || null, topic = clean(b.topic, 40) || null;
  const id = old ? old.id : rid();
  if (old) await env.DB.prepare("UPDATE exercises SET cat = ?, topic = ?, title = ?, body = ?, yt = ?, level = ?, min = ?, updated = ? WHERE id = ?").bind(cat, topic, title, body, yt, level, min, t, id).run();
  else await env.DB.prepare("INSERT INTO exercises (id, org, cat, topic, title, body, yt, level, min, by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ORG, cat, topic, title, body, yt, level, min, me.id, t, t).run();
  return { ok: true, id };
}

// The plans one may change: a group's (its coach or their assistants), one player's (their coach or PT)
async function canPlan(env, me, gid, pid) {
  if (gid) return !!(await canGroup(env, me, gid));
  return !!pid && (me.roles.includes("tranare") || me.roles.includes("pt")) && (me.coach || []).includes(pid);
}
async function withEx(env, plans) {
  const ids = [...new Set(plans.flatMap(p => { try { return JSON.parse(p.ex || "[]"); } catch (e) { return []; } }))].slice(0, 200);
  const ex = ids.length ? (await env.DB.prepare("SELECT id, cat, topic, title, body, yt, level, min FROM exercises WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all()).results : [];
  const by = new Map(ex.map(x => [x.id, x]));
  return plans.map(p => { let l = []; try { l = JSON.parse(p.ex || "[]"); } catch (e) {} return { ...p, ex: l.map(i => by.get(i)).filter(Boolean) }; });
}
// GET /plans?pid=&from= (a player's: own and their groups') | ?gid=&from= (a group's, with every member's feedback)
export async function plansGet(env, me, q, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me) return { err: "login", status: 401 };
  const from = DAY_RE.test(q.from || "") ? q.from : dayOf(t - 21 * 864e5), to = dayOf(t + 70 * 864e5);
  if (q.gid) {
    const g = await canGroup(env, me, q.gid);
    if (!g) return { err: "forbidden", status: 403 };
    const plans = (await env.DB.prepare("SELECT id, gid, pid, day, time, kind, min, title, note, ex FROM plans WHERE org = ? AND gid = ? AND day >= ? AND day <= ? ORDER BY day, time").bind(ORG, g.id, from, to).all()).results;
    const done = plans.length ? (await env.DB.prepare("SELECT d.plan, d.pid, d.session, s.min, s.rpe, s.note, r.stars, (SELECT count(*) FROM tcomments c WHERE c.session = d.session) AS c FROM plan_done d JOIN sessions s ON s.id = d.session LEFT JOIN srate r ON r.session = d.session " +
      "WHERE d.plan IN (" + plans.map(() => "?").join(",") + ")").bind(...plans.map(p => p.id)).all()).results : [];
    return { group: g, plans: (await withEx(env, plans)).map(p => ({ ...p, done: done.filter(d => d.plan === p.id).map(d => ({ pid: d.pid, session: d.session, min: d.min, rpe: d.rpe, note: d.note, stars: d.stars || null, c: d.c })) })) };
  }
  const pid = Number(q.pid);
  if (!canTrain(me, pid)) return { err: "forbidden", status: 403 };
  const gids = (await env.DB.prepare("SELECT gid FROM tgroup_members WHERE pid = ?").bind(pid).all()).results.map(r => r.gid);
  const plans = (await env.DB.prepare("SELECT p.id, p.gid, p.pid, p.day, p.time, p.kind, p.min, p.title, p.note, p.ex, g.name AS gname FROM plans p LEFT JOIN tgroups g ON g.id = p.gid WHERE p.org = ? AND p.day >= ? AND p.day <= ? AND (p.pid = ?" +
    (gids.length ? " OR p.gid IN (" + gids.map(() => "?").join(",") + ")" : "") + ") ORDER BY p.day, p.time").bind(ORG, from, to, pid, ...gids).all()).results;
  const done = plans.length ? (await env.DB.prepare("SELECT plan, session FROM plan_done WHERE pid = ? AND plan IN (" + plans.map(() => "?").join(",") + ")").bind(pid, ...plans.map(p => p.id)).all()).results : [];
  return { pid, plans: (await withEx(env, plans)).map(p => ({ ...p, done: (done.find(d => d.plan === p.id) || {}).session || null })) };
}
// POST /plans {op: save {id?, gid | pid, day, time, kind, min, title, note, ex} | del {id}}
export async function plansPost(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me) return { err: "login", status: 401 };
  const old = b && typeof b.id === "string" ? await env.DB.prepare("SELECT id, gid, pid FROM plans WHERE id = ? AND org = ?").bind(b.id, ORG).first() : null;
  if (b && b.id && !old) return { err: "not found", status: 404 };
  if (old && !(await canPlan(env, me, old.gid, old.pid))) return { err: "forbidden", status: 403 };
  if (b && b.op === "del") {
    if (!old) return { err: "not found", status: 404 };
    await env.DB.batch([env.DB.prepare("DELETE FROM plan_done WHERE plan = ?").bind(old.id), env.DB.prepare("DELETE FROM plans WHERE id = ?").bind(old.id)]);
    return { ok: true };
  }
  const gid = old ? old.gid : (typeof b.gid === "string" && b.gid ? b.gid : null), pid = old ? old.pid : (gid ? null : Number(b.pid) || null);
  if (!old && !(await canPlan(env, me, gid, pid))) return { err: "forbidden", status: 403 };
  const day = String(b.day || ""), time = b.time ? String(b.time) : null, kind = String(b.kind || ""), min = Math.round(Number(b.min)), title = clean(b.title, 80);
  if (!DAY_RE.test(day) || day < dayOf(t - 30 * 864e5) || day > dayOf(t + 365 * 864e5) || (time && !TIME_RE.test(time))) return { err: "day", status: 400 };
  if (!KINDS.includes(kind) || !(min >= 5 && min <= 360) || !title) return { err: "bad plan", status: 400 };
  const ex = [...new Set((Array.isArray(b.ex) ? b.ex : []).filter(x => typeof x === "string"))].slice(0, 20);
  if (ex.length && (await env.DB.prepare("SELECT count(*) AS n FROM exercises WHERE org = ? AND id IN (" + ex.map(() => "?").join(",") + ")").bind(ORG, ...ex).first()).n !== ex.length) return { err: "exercise", status: 400 };
  const note = String(b.note || "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "").trim().slice(0, 1000) || null, id = old ? old.id : rid();
  if (old) await env.DB.prepare("UPDATE plans SET day = ?, time = ?, kind = ?, min = ?, title = ?, note = ?, ex = ? WHERE id = ?").bind(day, time, kind, min, title, note, JSON.stringify(ex), id).run();
  else {
    await env.DB.batch([env.DB.prepare("INSERT INTO plans (id, org, gid, pid, day, time, kind, min, title, note, ex, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ORG, gid, pid, day, time, kind, min, title, note, JSON.stringify(ex), me.id, t),
      log(env, t, me.id, "plan", { id, gid, pid, day })]);
    // a notis to the players (their own accounts and their parents'), for a session from today on
    if (day >= dayOf(t)) try {
      const pids = gid ? (await env.DB.prepare("SELECT pid FROM tgroup_members WHERE gid = ?").bind(gid).all()).results.map(r => r.pid) : [pid];
      const gname = gid ? ((await env.DB.prepare("SELECT name FROM tgroups WHERE id = ?").bind(gid).first()) || {}).name : null;
      if (pids.length) {
        const users = (await env.DB.prepare("SELECT id FROM users WHERE org = ? AND pid IN (" + pids.map(() => "?").join(",") + ") UNION SELECT user FROM guardians WHERE pid IN (" + pids.map(() => "?").join(",") + ")").bind(ORG, ...pids, ...pids).all()).results.map(r => r.id).filter(u => u !== me.id);
        const W = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"], d = new Date(day + "T12:00:00Z");
        await notifyUsers(env, users, { title: "Nytt pass: " + title, body: [W[d.getUTCDay()] + " " + d.getUTCDate() + "/" + (d.getUTCMonth() + 1) + (time ? " " + time : ""), min + " min", gname].filter(Boolean).join(" · "), url: "#traning", tag: "padel-plan-" + id });
      }
    } catch (e) {}
  }
  return { ok: true, id };
}
// Is plan `id` one of this player's (own, or their group's)? For marking it done (train.js)
export async function planFor(env, id, pid) {
  const p = typeof id === "string" && await env.DB.prepare("SELECT id, gid, pid FROM plans WHERE id = ? AND org = ?").bind(id, ORG).first();
  if (!p) return null;
  if (p.pid === pid) return p;
  return p.gid && await env.DB.prepare("SELECT gid FROM tgroup_members WHERE gid = ? AND pid = ?").bind(p.gid, pid).first() ? p : null;
}
