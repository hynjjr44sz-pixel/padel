// Träning: sessions a player logs (padel training, gym, running, PT ...) with minutes and how hard it felt (RPE 1-10):
// minutes x RPE is the session's load. The page adds the matches it already knows (tournaments, series, americanos)
// and shows the load of the last 7 days against the last 4 weeks. Private: the player, their parents and the coaches
// or PT the admin linked to them; nobody else, not the admin either (health data, often juniors).
import { clean, log, ORG } from "./auth.js";
import { planFor } from "./coach.js";

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
  const rows = (await env.DB.prepare("SELECT id, day, kind, min, rpe, note, by FROM sessions WHERE org = ? AND pid = ? AND day >= ? ORDER BY day DESC, created DESC LIMIT 400").bind(ORG, pid, f).all()).results;
  return { pid, sessions: rows.map(r => ({ ...r, mine: r.by === me.id })) };
}

// POST /train {pid, day, kind, min, rpe, note, plan?} -> {ok, id}; {op: "del", id} removes one (whoever may see the player)
export async function trainPost(env, me, b, t) {
  if (!env.DB) return { err: "no database", status: 503 };
  if (!me) return { err: "login", status: 401 };
  if (b && b.op === "del") {
    const r = typeof b.id === "string" && await env.DB.prepare("SELECT pid FROM sessions WHERE id = ? AND org = ?").bind(b.id, ORG).first();
    if (!r) return { err: "not found", status: 404 };
    if (!canTrain(me, r.pid)) return { err: "forbidden", status: 403 };
    await env.DB.batch([env.DB.prepare("DELETE FROM plan_done WHERE session = ?").bind(b.id), env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(b.id)]);
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
    env.DB.prepare("INSERT INTO sessions (id, org, pid, day, kind, min, rpe, note, by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, ORG, pid, day, kind, mins, rpe, clean(b.note, 200) || null, me.id, t),
    log(env, t, me.id, "train", { pid, day, kind }),
  ]);
  return { ok: true, id };
}

// POST /train/clear {pid}: the player (or a parent) removes all their history
export async function trainClear(env, me, b) {
  const pid = Number(b && b.pid);
  if (!me || !(me.pid === pid || (me.kids || []).includes(pid))) return { err: "forbidden", status: 403 };
  await env.DB.batch([env.DB.prepare("DELETE FROM plan_done WHERE pid = ?").bind(pid), env.DB.prepare("DELETE FROM sessions WHERE org = ? AND pid = ?").bind(ORG, pid)]);
  return { ok: true };
}
