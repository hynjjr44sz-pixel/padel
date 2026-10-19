// Träning: sessions a player logs (padel training, gym, running, PT ...) with minutes and how hard it felt (RPE 1-10):
// minutes x RPE is the session's load. The page adds the matches it already knows (tournaments, series, americanos)
// and shows the load of the last 7 days against the last 4 weeks. Private: the player, their parents and the coaches
// or PT the admin linked to them; nobody else, not the admin either (health data, often juniors).
import { clean, log, ORG } from "./auth.js";
import { planFor } from "./coach.js";
import { notifyUsers } from "./notify.js";

export const KINDS = ["padel", "match", "gym", "lop", "pt", "fys", "annat"];
const DAY_RE = /^\d{4}-\d\d-\d\d$/, BACK_DAYS = 120;
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");

// May this account see and log for that player?
export const canTrain = (me, pid) => !!me && !!pid && (me.pid === pid || (me.kids || []).includes(pid) || (me.coach || []).includes(pid));
// The players this account trains with: own, children, coached
export const trainPids = me => me ? [...new Set([me.pid, ...(me.kids || []), ...(me.coach || [])].filter(Boolean))] : [];

// GET /train?pid=&from= -> {pid, sessions: [{id, day, kind, min, rpe, note, by, mine}]} (at most BACK_DAYS back)
export async function trainGet(env, me, pid, from, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!canTrain(me, pid)) return { err: "forbidden", status: 403 };
  const min = dayOf(t - BACK_DAYS * 864e5), f = DAY_RE.test(from || "") && from > min ? from : min;
  const rows = (await env.DB.prepare("SELECT s.id, s.day, s.kind, s.min, s.rpe, s.note, s.by, r.stars, (SELECT count(*) FROM tcomments c WHERE c.session = s.id) AS c FROM sessions s LEFT JOIN srate r ON r.session = s.id " +
    "WHERE s.org = ? AND s.pid = ? AND s.day >= ? ORDER BY s.day DESC, s.created DESC LIMIT 400").bind(ORG, pid, f).all()).results;
  return { pid, sessions: rows.map(r => ({ ...r, mine: r.by === me.id })) };
}

// POST /train {pid, day, kind, min, rpe, note, plan?, stars? (1-5, how the session was)} -> {ok, id}; {op: "del", id} removes one (whoever may see the player)
export async function trainPost(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me) return { err: "login", status: 401 };
  if (b && b.op === "del") {
    const r = typeof b.id === "string" && await env.DB.prepare("SELECT pid FROM sessions WHERE id = ? AND org = ?").bind(b.id, ORG).first();
    if (!r) return { err: "not found", status: 404 };
    if (!canTrain(me, r.pid)) return { err: "forbidden", status: 403 };
    await env.DB.batch(["plan_done", "tcomments", "srate"].map(tb => env.DB.prepare("DELETE FROM " + tb + " WHERE session = ?").bind(b.id)).concat([env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(b.id)]));
    return { ok: true };
  }
  const pid = Number(b && b.pid), day = String(b && b.day || ""), kind = String(b && b.kind || ""), mins = Math.round(Number(b && b.min)), rpe = Math.round(Number(b && b.rpe));
  if (!canTrain(me, pid)) return { err: "forbidden", status: 403 };
  // the last 60 days up to today (planning ahead comes with the coach's plans)
  if (!DAY_RE.test(day) || day > dayOf(t + 14 * 3600e3) || day < dayOf(t - 60 * 864e5)) return { err: "day", status: 400 };
  if (!KINDS.includes(kind) || !(mins >= 5 && mins <= 360) || !(rpe >= 1 && rpe <= 10)) return { err: "bad session", status: 400 };
  const n = (await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE pid = ? AND day = ?").bind(pid, day).first()).n;
  if (n >= 12) return { err: "full", status: 400 };
  // a planned session done: linked, so the coach sees the minutes, RPE and note as feedback
  const plan = b.plan ? await planFor(env, b.plan, pid) : null;
  if (b.plan && !plan) return { err: "plan", status: 400 };
  const id = rid();
  await env.DB.batch([
    ...(plan ? [env.DB.prepare("INSERT OR REPLACE INTO plan_done (plan, pid, session) VALUES (?, ?, ?)").bind(plan.id, pid, id)] : []),
    ...(b.stars >= 1 && b.stars <= 5 ? [env.DB.prepare("INSERT INTO srate (session, stars) VALUES (?, ?)").bind(id, Math.round(b.stars))] : []),
    env.DB.prepare("INSERT INTO sessions (id, org, pid, day, kind, min, rpe, note, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ORG, pid, day, kind, mins, rpe, clean(b.note, 200) || null, me.id, t),
    log(env, t, me.id, "train", { pid, day, kind }),
  ]);
  return { ok: true, id };
}

// POST /train/clear {pid}: the player (or a parent) removes all their history
export async function trainClear(env, me, b) {
  const pid = Number(b && b.pid);
  if (!me || !(me.pid === pid || (me.kids || []).includes(pid))) return { err: "forbidden", status: 403 };
  await env.DB.batch([env.DB.prepare("DELETE FROM srate WHERE session IN (SELECT id FROM sessions WHERE pid = ?)").bind(pid), env.DB.prepare("DELETE FROM tcomments WHERE pid = ?").bind(pid),
    env.DB.prepare("DELETE FROM plan_done WHERE pid = ?").bind(pid), env.DB.prepare("DELETE FROM sessions WHERE org = ? AND pid = ?").bind(ORG, pid)]);
  return { ok: true };
}

// The thread on a logged session: the coach answers, the player (or a parent) answers back. Whoever may see the player.
// GET /train/thread?id= -> {session, comments: [{id, name, text, at, mine}]}
export async function threadGet(env, me, id) {
  const s = typeof id === "string" && await env.DB.prepare("SELECT s.id, s.pid, s.day, s.kind, s.min, s.rpe, s.note, r.stars FROM sessions s LEFT JOIN srate r ON r.session = s.id WHERE s.id = ? AND s.org = ?").bind(id, ORG).first();
  if (!s) return { err: "not found", status: 404 };
  if (!canTrain(me, s.pid)) return { err: "forbidden", status: 403 };
  const c = (await env.DB.prepare("SELECT id, by, name, text, at FROM tcomments WHERE session = ? ORDER BY at").bind(s.id).all()).results;
  return { session: s, comments: c.map(x => ({ id: x.id, name: x.name, text: x.text, at: x.at, mine: x.by === me.id })) };
}
// POST /train/comment {id, text}: a notis to the other side (the player's accounts and parents, or the coaches in the thread
// and the coach whose plan it was)
export async function threadPost(env, me, b, t) {
  const s = b && typeof b.id === "string" && await env.DB.prepare("SELECT id, pid FROM sessions WHERE id = ? AND org = ?").bind(b.id, ORG).first();
  if (!s) return { err: "not found", status: 404 };
  if (!canTrain(me, s.pid)) return { err: "forbidden", status: 403 };
  const text = String(b.text || "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "").trim().slice(0, 600);
  if (!text) return { err: "text", status: 400 };
  if ((await env.DB.prepare("SELECT count(*) AS n FROM tcomments WHERE session = ?").bind(s.id).first()).n >= 100) return { err: "full", status: 400 };
  const id = rid();
  await env.DB.prepare("INSERT INTO tcomments (id, org, session, pid, by, name, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ORG, s.id, s.pid, me.id, me.name, text, t).run();
  try {
    const player = (await env.DB.prepare("SELECT id FROM users WHERE org = ? AND pid = ? UNION SELECT user FROM guardians WHERE pid = ?").bind(ORG, s.pid, s.pid).all()).results.map(r => r.id);
    let to;
    if (player.includes(me.id)) {
      const owner = await env.DB.prepare("SELECT g.owner FROM plan_done d JOIN plans p ON p.id = d.plan JOIN tgroups g ON g.id = p.gid WHERE d.session = ?").bind(s.id).first();
      const coaches = (await env.DB.prepare("SELECT DISTINCT by FROM tcomments WHERE session = ?").bind(s.id).all()).results.map(r => r.by).filter(u => !player.includes(u));
      to = [...new Set([...(owner ? [owner.owner] : []), ...coaches])];
    } else to = player;
    await notifyUsers(env, to.filter(u => u !== me.id), { title: me.name.split(" ")[0] + " om passet", body: text.slice(0, 140), url: "#traning", tag: "padel-traning-" + s.id });
  } catch (e) {}
  return { ok: true, id };
}

// GET /train/many?pids=1,2,3 -> {sessions: {pid: [{day, kind, min, rpe}]}} for a coach's group view: the last 35 days of
// each player one may see (at most 40); the others are left out
export async function trainMany(env, me, pids, t) {
  const want = [...new Set(String(pids || "").split(",").map(Number).filter(p => canTrain(me, p)))].slice(0, 40), out = {};
  if (!want.length) return { sessions: out };
  const rows = (await env.DB.prepare("SELECT pid, day, kind, min, rpe FROM sessions WHERE org = ? AND day >= ? AND pid IN (" + want.map(() => "?").join(",") + ")").bind(ORG, dayOf(t - 35 * 864e5), ...want).all()).results;
  want.forEach(p => { out[p] = []; });
  rows.forEach(r => out[r.pid].push({ day: r.day, kind: r.kind, min: r.min, rpe: r.rpe }));
  return { sessions: out };
}
